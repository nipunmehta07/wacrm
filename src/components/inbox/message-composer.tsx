"use client";

import { useState, useRef, useCallback, KeyboardEvent } from "react";
import { Send, LayoutTemplate, Paperclip, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ReplyQuote } from "./reply-quote";
import { toast } from "sonner";

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

interface MessageComposerProps {
  conversationId: string;
  sessionExpired: boolean;
  onSend: (text: string, replyToId?: string) => void;
  onOpenTemplates: () => void;
  // NEW: Callback triggered when media uploads successfully
  onMediaSent?: () => void; 
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
}

export function MessageComposer({
  conversationId,
  sessionExpired,
  onSend,
  onOpenTemplates,
  onMediaSent,
  replyTo,
  onClearReply,
}: MessageComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || sessionExpired) return;

    setSending(true);
    try {
      onSend(trimmed, replyTo?.id);
      setText("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } {
      setSending(false);
    }
  }, [text, sending, sessionExpired, onSend, replyTo?.id]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      adjustHeight();
    },
    [adjustHeight]
  );

  // NEW: Handles Media Selection and Upload Stream
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const targetFile = e.target.files?.[0];
    if (!targetFile) return;

    // Optional constraint checking: cap individual attachments at 16MB
    if (targetFile.size > 16 * 1024 * 1024) {
      toast.error("File size limits exceeded (Max 16MB supported)");
      return;
    }

    setUploadingMedia(true);
    const mediaFormData = new FormData();
    mediaFormData.append('conversation_id', conversationId);
    mediaFormData.append('file', targetFile);

    try {
      const res = await fetch('/api/whatsapp/send-media', {
        method: 'POST',
        body: mediaFormData
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Server upload failed');

      toast.success(`${targetFile.name} transmitted successfully.`);
      if (onMediaSent) onMediaSent();
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Failed to dispatch file attachment");
    } finally {
      setUploadingMedia(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="border-t border-slate-800 bg-slate-900 p-3">
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}
      {sessionExpired && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-400">
            24-hour session expired. Use a template to re-engage.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-400 hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="mr-1 h-3 w-3" />
            Templates
          </Button>
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* Hidden File Picker Input Layer */}
        <input 
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept="image/*,application/pdf"
          className="hidden"
        />

        {/* Dynamic Media Trigger Button */}
        <Button
          variant="ghost"
          size="sm"
          disabled={sessionExpired || uploadingMedia}
          className="h-9 w-9 shrink-0 p-0 text-slate-400 hover:text-white"
          onClick={() => fileInputRef.current?.click()}
          title="Attach PDF or Image"
        >
          {uploadingMedia ? (
            <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
          ) : (
            <Paperclip className="h-4 w-4" />
          )}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-9 shrink-0 p-0 text-slate-400 hover:text-white"
          onClick={onOpenTemplates}
          title="Send template"
        >
          <LayoutTemplate className="h-4 w-4" />
        </Button>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={
            sessionExpired
              ? "Session expired - use a template"
              : "Type a message... (Shift+Enter for new line)"
          }
          disabled={sessionExpired || uploadingMedia}
          rows={1}
          className={cn(
            "flex-1 resize-none rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition-colors focus:border-violet-500/50",
            (sessionExpired || uploadingMedia) && "cursor-not-allowed opacity-50"
          )}
        />

        <Button
          size="sm"
          className="h-9 w-9 shrink-0 bg-violet-600 p-0 hover:bg-violet-500 disabled:opacity-40"
          disabled={!text.trim() || sessionExpired || sending || uploadingMedia}
          onClick={handleSend}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>

      <p className="mt-1 pl-22 text-[10px] text-slate-600">
        Type &apos;/&apos; for quick replies
      </p>
    </div>
  );
}