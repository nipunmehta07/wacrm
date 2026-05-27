import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';

// Initialize service client
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const conversationId = formData.get('conversation_id') as string;
    const file = formData.get('file') as File;

    if (!conversationId || !file) {
      return NextResponse.json({ error: 'Missing conversation context or payload' }, { status: 400 });
    }

    // 1. Fetch configurations to retrieve Meta credentials
    const { data: conv } = await supabaseAdmin
      .from('conversations')
      .select('user_id, contact:contacts(phone)')
      .eq('id', conversationId)
      .single();

    const { data: config } = await supabaseAdmin
      .from('whatsapp_config')
      .select('access_token, phone_number_id')
      .eq('user_id', conv?.user_id)
      .single();

    // NEW: Safely extract contact object from the inferred array or object structure
    const contactData = Array.isArray(conv?.contact) ? conv.contact[0] : (conv?.contact as any);
    const recipientPhone = contactData?.phone;

    if (!config || !recipientPhone) {
      return NextResponse.json({ error: 'WhatsApp active account configuration missing or invalid contact' }, { status: 404 });
    }

    // Decrypt access token (match your internal encryption helper layout)
    // ✅ FIXED: Safely decrypt ciphertext to parse the authentic credentials string
    const accessToken = decrypt(config.access_token);

    // 2. Stream Binary to Meta Media Upload Endpoint
    const metaUploadForm = new FormData();
    metaUploadForm.append('file', file);
    metaUploadForm.append('type', file.type);
    metaUploadForm.append('messaging_product', 'whatsapp');

    const metaUploadRes = await fetch(
      `https://graph.facebook.com/v18.0/${config.phone_number_id}/media`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: metaUploadForm,
      }
    );

    const uploadData = await metaUploadRes.json();
    if (!metaUploadRes.ok || !uploadData.id) {
      throw new Error(uploadData.error?.message || 'Meta asset upload step rejected');
    }

    const mediaId = uploadData.id;
    const isImage = file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf';
    const contentType = isImage ? 'image' : isPdf ? 'document' : 'document';

    // 3. Command Meta to Deliver Media ID to Recipient
    const messagePayload: Record<string, any> = {
      messaging_product: 'whatsapp',
      to: recipientPhone,
      type: contentType,
    };

    if (contentType === 'image') {
      messagePayload.image = { id: mediaId };
    } else {
      messagePayload.document = { id: mediaId, filename: file.name };
    }

    const sendRes = await fetch(
      `https://graph.facebook.com/v18.0/${config.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(messagePayload),
      }
    );

    const sendData = await sendRes.json();
    if (!sendRes.ok) throw new Error(sendData.error?.message || 'Media delivery rejected');

    // 4. Save Record in Supabase
    const { data: insertedMsg, error: dbErr } = await supabaseAdmin
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_type: 'agent',
        content_type: contentType,
        content_text: contentType === 'document' ? file.name : null,
        media_url: `/api/whatsapp/media/${mediaId}`, // Points to your internal storage lookup proxy
        message_id: sendData.messages?.[0]?.id || `msg-${Date.now()}`,
        status: 'sent',
      })
      .select()
      .single();

    return NextResponse.json({ success: true, message: insertedMsg });
  } catch (error: any) {
    console.error('Outbound media handler error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}