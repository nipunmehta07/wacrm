import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'
import type { TemplateButton, TemplateSampleValues } from '@/types'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * Sync message templates from Meta → local message_templates table.
 *
 * The local catalog stores Meta's status enum verbatim (APPROVED /
 * PENDING / REJECTED / PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION)
 * so the edit / resubmit / delete flows can distinguish recoverable
 * states (PAUSED) from terminal ones (DISABLED) and so webhook events
 * land 1:1 without a translation table.
 *
 * Locally-created templates (no Meta counterpart) are NOT deleted —
 * they remain visible so the user can notice drift and clean up.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

interface MetaButton {
  type: string
  text: string
  url?: string
  phone_number?: string
  example?: string[] | string
}

interface MetaTemplateComponent {
  type: string
  text?: string
  format?: string
  buttons?: MetaButton[]
  example?: {
    header_text?: string[]
    header_handle?: string[]
    body_text?: string[][]
  }
}

interface MetaTemplate {
  id: string
  name: string
  language: string
  status: string
  category: string
  components?: MetaTemplateComponent[]
  quality_score?: { score?: string } | string
}

function normalizeCategory(
  meta: string,
): 'Marketing' | 'Utility' | 'Authentication' {
  const upper = meta.toUpperCase()
  if (upper === 'UTILITY') return 'Utility'
  if (upper === 'AUTHENTICATION') return 'Authentication'
  return 'Marketing'
}

function normalizeQualityScore(
  raw: MetaTemplate['quality_score'],
): 'GREEN' | 'YELLOW' | 'RED' | null {
  const score =
    typeof raw === 'string' ? raw : raw?.score ? String(raw.score) : null
  if (!score) return null
  const upper = score.toUpperCase()
  return upper === 'GREEN' || upper === 'YELLOW' || upper === 'RED'
    ? (upper as 'GREEN' | 'YELLOW' | 'RED')
    : null
}

function parseButtons(metaButtons: MetaButton[] | undefined): TemplateButton[] {
  if (!metaButtons?.length) return []
  const out: TemplateButton[] = []
  for (const b of metaButtons) {
    switch (b.type?.toUpperCase()) {
      case 'QUICK_REPLY':
        out.push({ type: 'QUICK_REPLY', text: b.text })
        break
      case 'URL':
        out.push({
          type: 'URL',
          text: b.text,
          url: b.url ?? '',
          example: Array.isArray(b.example) ? b.example[0] : b.example,
        })
        break
      case 'PHONE_NUMBER':
        out.push({
          type: 'PHONE_NUMBER',
          text: b.text,
          phone_number: b.phone_number ?? '',
        })
        break
      case 'COPY_CODE':
        out.push({
          type: 'COPY_CODE',
          text: b.text,
          example: Array.isArray(b.example) ? b.example[0] ?? '' : b.example ?? '',
        })
        break
      // OTP, FLOW, etc — out of scope for v1; drop silently.
    }
  }
  return out
}

function extractSampleValues(
  body: MetaTemplateComponent | undefined,
  header: MetaTemplateComponent | undefined,
): TemplateSampleValues | null {
  // Meta returns body_text as a 2D array — one row per example set.
  // We take the first row (most templates have exactly one).
  const bodySample = body?.example?.body_text?.[0]
  const headerSample = header?.example?.header_text
  if (!bodySample?.length && !headerSample?.length) return null
  const sv: TemplateSampleValues = {}
  if (bodySample?.length) sv.body = bodySample
  if (headerSample?.length) sv.header = headerSample
  return sv
}

/**
 * Attempt to resolve the real WhatsApp Business Account ID (WABA ID)
 * from Meta if the provided ID was a Business Portfolio ID, Phone Number ID,
 * or if it can be discovered from the access token or business edges.
 */
async function resolveActualWabaId(
  candidateId: string | null,
  accessToken: string,
): Promise<string | null> {
  const headers = { Authorization: `Bearer ${accessToken}` }

  // 1. If candidateId is provided, check if it is a Business Portfolio ID
  // that owns WhatsApp Business Accounts:
  if (candidateId) {
    for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
      try {
        const res = await fetch(
          `${META_API_BASE}/${encodeURIComponent(candidateId)}/${edge}?fields=id,name`,
          { headers },
        )
        if (res.ok) {
          const body = (await res.json()) as { data?: { id?: string; name?: string }[] }
          if (body?.data?.length && body.data[0].id) {
            return body.data[0].id.trim()
          }
        }
      } catch {
        // continue
      }
    }
  }

  // 2. Try debug_token with App Secret if configured, or with access token
  try {
    const authQuery =
      process.env.META_APP_ID && process.env.META_APP_SECRET
        ? `access_token=${encodeURIComponent(process.env.META_APP_ID)}%7C${encodeURIComponent(process.env.META_APP_SECRET)}`
        : `access_token=${encodeURIComponent(accessToken)}`

    const res = await fetch(
      `${META_API_BASE}/debug_token?input_token=${encodeURIComponent(accessToken)}&${authQuery}`,
      { headers },
    )
    if (res.ok) {
      const json = (await res.json()) as {
        data?: {
          granular_scopes?: { scope?: string; target_ids?: string[] }[]
        }
      }
      const scopes = json?.data?.granular_scopes
      if (Array.isArray(scopes)) {
        const mgmt = scopes.find(
          (s) =>
            s.scope === 'whatsapp_business_management' || s.scope === 'whatsapp_business_messaging',
        )
        if (mgmt?.target_ids?.length && typeof mgmt.target_ids[0] === 'string') {
          return mgmt.target_ids[0].trim()
        }
      }
    }
  } catch {
    // continue
  }

  // 3. Try checking businesses associated with the token: /me/businesses
  try {
    const res = await fetch(`${META_API_BASE}/me/businesses?fields=id,name`, { headers })
    if (res.ok) {
      const json = (await res.json()) as { data?: { id?: string }[] }
      if (json?.data?.length) {
        for (const biz of json.data) {
          if (biz.id && biz.id !== candidateId) {
            const waba = await resolveActualWabaId(biz.id, accessToken)
            if (waba) return waba
          }
        }
      }
    }
  } catch {
    // continue
  }

  return null
}

export async function POST() {
  try {
    // Syncing rewrites the account-wide template catalog, which is
    // settings-class data: `canEditSettings` and the message_templates
    // insert/update RLS policies (migration 017) both require 'admin'.
    // Resolving account_id off the profile only proved membership.
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`whatsapp-admin:${userId}`, RATE_LIMITS.whatsappAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            t('common.whatsappNotConfiguredConnect'),
        },
        { status: 400 },
      )
    }

    let activeWabaId = config.waba_id?.trim() || null
    const phoneNumberId = config.phone_number_id?.trim() || null
    const accessToken = decrypt(config.access_token)

    // Detect missing WABA ID or accidental duplicate of Phone Number ID
    if (!activeWabaId || (phoneNumberId && activeWabaId === phoneNumberId)) {
      const discovered = await resolveActualWabaId(activeWabaId, accessToken)
      if (discovered && discovered !== phoneNumberId) {
        activeWabaId = discovered
        await supabase
          .from('whatsapp_config')
          .update({ waba_id: discovered })
          .eq('account_id', accountId)
      } else if (!activeWabaId) {
        return NextResponse.json(
          {
            error: t('common.wabaIdMissing'),
          },
          { status: 400 },
        )
      } else {
        return NextResponse.json(
          {
            error:
              `Your WABA ID in Settings (${activeWabaId}) matches your Phone Number ID. ` +
              `Message templates belong to your WhatsApp Business Account ID (WABA ID), not your Phone Number ID. ` +
              `Please find your WABA ID in Meta Business Suite → WhatsApp Manager (Account tools) and update it in Settings → WhatsApp Config.`,
          },
          { status: 400 },
        )
      }
    }

    const metaTemplates: MetaTemplate[] = []
    let includeQualityScore = true
    let nextUrl:
      | string
      | null = `${META_API_BASE}/${activeWabaId}/message_templates?limit=100&fields=id,name,language,status,category,components,quality_score`
    const PAGE_CAP = 20
    let pageCount = 0

    while (nextUrl && pageCount < PAGE_CAP) {
      pageCount++
      let metaRes: Response = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (!metaRes.ok) {
        let metaBody: {
          error?: {
            message?: string
            code?: number
            error_subcode?: number
            error_user_msg?: string
            error_data?: { details?: string }
          }
        } | null = null

        try {
          metaBody = await metaRes.json()
        } catch {
          // response wasn't JSON
        }

        console.error('[templates/sync] Meta API error:', metaBody ?? metaRes.status)

        const errObj = metaBody?.error
        const errCode = errObj?.code
        const errMsg = errObj?.message || ''

        // If the request failed with Code 100 / Invalid parameter while requesting quality_score,
        // retry the query without quality_score:
        if (
          pageCount === 1 &&
          includeQualityScore &&
          (errCode === 100 || /invalid parameter/i.test(errMsg))
        ) {
          console.warn('[templates/sync] Retrying without quality_score parameter...')
          includeQualityScore = false
          nextUrl = `${META_API_BASE}/${activeWabaId}/message_templates?limit=100&fields=id,name,language,status,category,components`
          metaRes = await fetch(nextUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
          })
          if (metaRes.ok) {
            metaBody = null
          } else {
            try {
              metaBody = await metaRes.json()
            } catch {}
          }
        }

        // If still failing with Code 100 / Invalid parameter, attempt WABA ID auto-recovery
        if (
          !metaRes.ok &&
          (metaBody?.error?.code === 100 || /invalid parameter/i.test(metaBody?.error?.message || ''))
        ) {
          const discovered = await resolveActualWabaId(activeWabaId, accessToken)
          if (discovered && discovered !== activeWabaId) {
            console.warn(`[templates/sync] Attempting discovered WABA ID ${discovered} instead of ${activeWabaId}...`)
            const retryUrl = `${META_API_BASE}/${discovered}/message_templates?limit=100&fields=id,name,language,status,category,components`
            const retryRes = await fetch(retryUrl, {
              headers: { Authorization: `Bearer ${accessToken}` },
            })
            if (retryRes.ok) {
              activeWabaId = discovered
              await supabase
                .from('whatsapp_config')
                .update({ waba_id: discovered })
                .eq('account_id', accountId)
              metaRes = retryRes
              metaBody = null
            }
          }
        }

        if (!metaRes.ok) {
          const finalErr = metaBody?.error
          const finalCode = finalErr?.code
          const finalMsg = finalErr?.message || t('templates.metaApiStatus', { status: metaRes.status })
          const finalDetails = finalErr?.error_data?.details || finalErr?.error_user_msg || ''

          let detailedError = finalMsg
          if (finalDetails) {
            detailedError = `${finalMsg}: ${finalDetails}`
          }

          if (finalCode === 100 || /invalid parameter/i.test(finalMsg)) {
            detailedError =
              `Meta returned an Invalid Parameter error for ID "${activeWabaId}". ` +
              `This typically occurs when "${activeWabaId}" is a Business Portfolio ID (Business Manager ID) or Phone Number ID rather than a WhatsApp Business Account ID (WABA ID). ` +
              `\n\nTo fix this:\n` +
              `1. Go to Meta Business Settings (business.facebook.com/settings).\n` +
              `2. In the left navigation, click Accounts → WhatsApp accounts.\n` +
              `3. Select your WhatsApp account and copy the ID shown directly under its name.\n` +
              `4. Paste it into Settings → WhatsApp Config → WhatsApp Business Account ID.\n` +
              `5. Ensure your System User has Full Control permissions assigned to this WhatsApp account.`
          }

          return NextResponse.json({ error: detailedError }, { status: 502 })
        }
      }

      const metaBody: {
        data?: MetaTemplate[]
        paging?: { next?: string }
      } = await metaRes.json()
      if (metaBody.data) metaTemplates.push(...metaBody.data)
      nextUrl = metaBody.paging?.next ?? null
    }

    let inserted = 0
    let updated = 0
    const errors: { name: string; language: string; message: string }[] = []

    for (const t of metaTemplates) {
      const body = (t.components ?? []).find((c) => c.type === 'BODY')
      const header = (t.components ?? []).find((c) => c.type === 'HEADER')
      const footer = (t.components ?? []).find((c) => c.type === 'FOOTER')
      const buttons = (t.components ?? []).find((c) => c.type === 'BUTTONS')

      const parsedButtons = parseButtons(buttons?.buttons)
      const sampleValues = extractSampleValues(body, header)

      const headerFormat = header?.format?.toUpperCase()
      const headerType =
        headerFormat === 'TEXT' ||
        headerFormat === 'IMAGE' ||
        headerFormat === 'VIDEO' ||
        headerFormat === 'DOCUMENT'
          ? headerFormat.toLowerCase()
          : null

      const row = {
        // Account tenancy. account_id is NOT NULL on message_templates
        // post-017, so an INSERT without it errors.
        account_id: accountId,
        name: t.name,
        category: normalizeCategory(t.category),
        language: t.language,
        header_type: headerType,
        header_content: header?.text ?? null,
        header_handle: header?.example?.header_handle?.[0] ?? null,
        body_text: body?.text ?? '',
        footer_text: footer?.text ?? null,
        buttons: parsedButtons.length ? parsedButtons : null,
        sample_values: sampleValues,
        status: normalizeStatus(t.status),
        meta_template_id: t.id,
        quality_score: normalizeQualityScore(t.quality_score),
        updated_at: new Date().toISOString(),
      }

      const { data: matches, error: lookupErr } = await supabase
        .from('message_templates')
        .select('id')
        .eq('account_id', accountId)
        .eq('name', t.name)
        .eq('language', t.language)
        .order('updated_at', { ascending: false })
        .order('id')
        .limit(1)
      const existing = matches?.[0]

      if (lookupErr) {
        errors.push({
          name: t.name,
          language: t.language,
          message: lookupErr.message,
        })
        continue
      }

      if (existing?.id) {
        const { error: updErr } = await supabase
          .from('message_templates')
          .update(row)
          .eq('id', existing.id)
        if (updErr) {
          errors.push({
            name: t.name,
            language: t.language,
            message: updErr.message,
          })
        } else {
          updated++
        }
      } else {
        const { error: insErr } = await supabase
          .from('message_templates')
          .insert({ ...row, user_id: userId })
        if (insErr) {
          errors.push({
            name: t.name,
            language: t.language,
            message: insErr.message,
          })
        } else {
          inserted++
        }
      }
    }

    return NextResponse.json({
      success: errors.length === 0,
      total: metaTemplates.length,
      inserted,
      updated,
      errors,
      truncated: pageCount >= PAGE_CAP && nextUrl !== null,
    })
  } catch (error) {
    // Auth failures map to 401/403 rather than being folded into the
    // generic 500 below, which surfaces `error.message` as a sync failure.
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError
    ) {
      return toErrorResponse(error)
    }
    console.error('Error syncing WhatsApp templates:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : t('templates.syncFailed'),
      },
      { status: 500 },
    )
  }
}
