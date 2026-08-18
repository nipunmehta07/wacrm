'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Users, Save, ChevronDown, ChevronUp, Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';

const PREVIEW_LIMIT = 100;

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
  customField?: {
    fieldId: string;
    operator: 'is' | 'is_not' | 'contains';
    value: string;
  };
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  headerImageUrl: string;
  onHeaderImageUrlChange: (url: string) => void;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  headerImageUrl,
  onHeaderImageUrlChange,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  // Recipient preview
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewContacts, setPreviewContacts] = useState<{ name: string | null; phone: string }[]>([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const needsHeaderImageUrl =
    template.header_type === 'image' && !template.header_media_url?.trim();
  const trimmedHeaderImageUrl = headerImageUrl.trim();
  const headerImageUrlError =
    trimmedHeaderImageUrl && !isValidHttpUrl(trimmedHeaderImageUrl)
      ? 'Enter a valid public image URL starting with http:// or https://.'
      : null;
  const hasRequiredHeaderImageUrl =
    !needsHeaderImageUrl || Boolean(trimmedHeaderImageUrl);
  const canSend = Boolean(
    name.trim() &&
    !isProcessing &&
    hasRequiredHeaderImageUrl &&
    !headerImageUrlError,
  );

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const fetchPreview = useCallback(async () => {
    if (previewLoaded) return;
    setLoadingPreview(true);
    try {
      const supabase = createClient();

      if (audience.type === 'csv' && audience.csvContacts) {
        setPreviewContacts(
          audience.csvContacts.slice(0, PREVIEW_LIMIT).map((c) => ({
            name: c.name ?? null,
            phone: c.phone,
          }))
        );
      } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
        // Reuse the same RPC the contacts page uses
        const { data } = await supabase.rpc('filter_contacts_by_tags', {
          p_tag_ids: audience.tagIds,
          p_search: null,
          p_limit: PREVIEW_LIMIT,
          p_offset: 0,
        });
        const rows = (data ?? []) as { contact: { name: string | null; phone: string }; total_count: number }[];
        setPreviewContacts(rows.map((r) => ({ name: r.contact.name, phone: r.contact.phone })));
      } else if (audience.type === 'all') {
        const { data } = await supabase
          .from('contacts')
          .select('name, phone')
          .order('created_at', { ascending: false })
          .limit(PREVIEW_LIMIT);
        setPreviewContacts((data ?? []).map((c) => ({ name: c.name, phone: c.phone })));
      } else if (audience.type === 'custom_field' && audience.customField?.fieldId && audience.customField.value) {
        const { fieldId, operator, value } = audience.customField;
        let q = supabase
          .from('contact_custom_values')
          .select('contact_id')
          .eq('custom_field_id', fieldId);
        if (operator === 'is') q = q.eq('value', value);
        else if (operator === 'is_not') q = q.neq('value', value);
        else q = q.ilike('value', `%${value}%`);
        const { data: cvRows } = await q;
        const ids = (cvRows ?? []).map((r) => r.contact_id).slice(0, PREVIEW_LIMIT);
        if (ids.length > 0) {
          const { data } = await supabase
            .from('contacts')
            .select('name, phone')
            .in('id', ids)
            .limit(PREVIEW_LIMIT);
          setPreviewContacts((data ?? []).map((c) => ({ name: c.name, phone: c.phone })));
        }
      }
      setPreviewLoaded(true);
    } finally {
      setLoadingPreview(false);
    }
  }, [audience, previewLoaded]);

  function togglePreview() {
    const next = !previewOpen;
    setPreviewOpen(next);
    if (next) fetchPreview();
  }

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {template.header_type === 'image' && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Header Image URL
          </label>
          <Input
            value={headerImageUrl}
            onChange={(e) => onHeaderImageUrlChange(e.target.value)}
            placeholder={
              template.header_media_url
                ? 'Optional override for this broadcast'
                : 'https://example.com/image.jpg'
            }
            className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Meta needs a public image link for image-header templates.
          </p>
          {headerImageUrlError && (
            <p className="mt-1 text-xs text-red-400">{headerImageUrlError}</p>
          )}
        </div>
      )}

      {/* Recipient Preview */}
      <div className="rounded-xl border border-border bg-card/50 overflow-hidden">
        <button
          type="button"
          onClick={togglePreview}
          className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-primary" />
            Preview Recipients
            {!loadingReach && (
              <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                {estimatedReach.toLocaleString()}
              </span>
            )}
          </div>
          {previewOpen ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </button>

        {previewOpen && (
          <div className="border-t border-border">
            {loadingPreview ? (
              <div className="flex items-center justify-center gap-2 py-8">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">Loading contacts…</span>
              </div>
            ) : previewContacts.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">No contacts found for this audience.</p>
            ) : (
              <>
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-card/95 backdrop-blur-sm">
                      <tr className="border-b border-border">
                        <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">#</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Name</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Phone</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewContacts.map((c, i) => (
                        <tr key={c.phone + i} className="border-b border-border/50 last:border-0 hover:bg-muted/30">
                          <td className="px-4 py-2 text-xs text-muted-foreground">{i + 1}</td>
                          <td className="px-4 py-2 text-foreground">
                            {c.name || <span className="italic text-muted-foreground">Unnamed</span>}
                          </td>
                          <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{c.phone}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {estimatedReach > PREVIEW_LIMIT && (
                  <p className="border-t border-border px-4 py-2 text-center text-xs text-muted-foreground">
                    Showing first {PREVIEW_LIMIT} of {estimatedReach.toLocaleString()} contacts
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Estimated Reach</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Language</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">{t('scheduleSend.sending')}</p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={!canSend}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            <Send className="h-4 w-4" />
            {t('scheduleSend.sendNow')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">Confirm Broadcast</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                You are about to send this broadcast to{' '}
                <span className="font-medium text-popover-foreground">{estimatedReach.toLocaleString()}</span>{' '}
                contacts using the{' '}
                <span className="font-medium text-popover-foreground">{template.name}</span> template.
                This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                className="border-border text-muted-foreground"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  onSend();
                }}
                disabled={!canSend}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Send className="h-4 w-4" />
                {t('scheduleSend.sendNow')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>
    </div>
  );
}
