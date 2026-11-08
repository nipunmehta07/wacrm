'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  countAudience,
  resolveAudienceContacts,
  type AudienceConfig,
} from '@/lib/broadcast-audience';
import { createClient } from '@/lib/supabase/client';
import { Contact, MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Send,
  Loader2,
  Users,
  Save,
  Search,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

function getInitials(name?: string): string {
  if (!name || !name.trim()) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
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

  const [recipients, setRecipients] = useState<Contact[]>([]);
  const [loadingRecipients, setLoadingRecipients] = useState(true);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 10;

  useEffect(() => {
    let active = true;

    async function loadData() {
      setLoadingReach(true);
      setLoadingRecipients(true);
      setRecipientError(null);

      const supabase = createClient();

      try {
        const count = await countAudience(supabase, audience);
        if (active && count !== null) {
          setEstimatedReach(count);
        }
      } catch (err) {
        console.error('Failed to count audience:', err);
      } finally {
        if (active) setLoadingReach(false);
      }

      try {
        const contacts = await resolveAudienceContacts(
          supabase,
          audience,
          async (rows) =>
            rows.map(
              (r, i) =>
                ({
                  id: `csv-${i}`,
                  name: r.name || '',
                  phone: r.phone,
                  user_id: '',
                  account_id: '',
                  created_at: '',
                  updated_at: '',
                } as Contact),
            ),
        );
        if (active) {
          setRecipients(contacts);
          setEstimatedReach((prev) => (prev > 0 ? prev : contacts.length));
        }
      } catch (err) {
        if (active) {
          console.error('Failed to resolve audience contacts:', err);
          setRecipientError(
            err instanceof Error ? err.message : 'Failed to load recipients list',
          );
        }
      } finally {
        if (active) setLoadingRecipients(false);
      }
    }

    loadData();

    return () => {
      active = false;
    };
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  const filteredRecipients = useMemo(() => {
    if (!searchQuery.trim()) return recipients;
    const q = searchQuery.toLowerCase().trim();
    return recipients.filter((c) => {
      const nameMatch = c.name?.toLowerCase().includes(q);
      const phoneMatch =
        c.phone?.toLowerCase().includes(q) ||
        Boolean(c.phone_normalized && c.phone_normalized.includes(q));
      const emailMatch = c.email?.toLowerCase().includes(q);
      const companyMatch = c.company?.toLowerCase().includes(q);
      return Boolean(nameMatch || phoneMatch || emailMatch || companyMatch);
    });
  }, [recipients, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredRecipients.length / PAGE_SIZE));
  const currentRecipients = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredRecipients.slice(start, start + PAGE_SIZE);
  }, [filteredRecipients, currentPage]);

  const startIndex =
    filteredRecipients.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const endIndex = Math.min(currentPage * PAGE_SIZE, filteredRecipients.length);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t('scheduleSend.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          {t('scheduleSend.broadcastName')}
        </label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">
          {t('scheduleSend.summary')}
        </p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">
              {t('scheduleSend.template')}
            </p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              {t('scheduleSend.audience')}
            </p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              {t('scheduleSend.estimatedReach')}
            </p>
            <div className="flex items-center gap-1.5">
              {loadingReach && loadingRecipients ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">
                    {estimatedReach.toLocaleString()}
                  </p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              {t('scheduleSend.language')}
            </p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* Recipients Preview */}
      <div className="rounded-xl border border-border bg-card/50 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 bg-muted/20">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-medium text-foreground">
              {t('scheduleSend.recipientsTitle')}
            </h3>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {loadingRecipients ? (
                <Loader2 className="inline h-3 w-3 animate-spin" />
              ) : (
                recipients.length
              )}
            </span>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              placeholder={t('scheduleSend.recipientsSearchPlaceholder')}
              className="h-8 pl-8 text-xs border-border bg-background placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {loadingRecipients ? (
          <div className="flex h-36 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <p className="text-sm">{t('scheduleSend.loadingRecipients')}</p>
          </div>
        ) : recipientError ? (
          <div className="flex h-28 flex-col items-center justify-center gap-1.5 text-center px-4">
            <AlertCircle className="h-5 w-5 text-destructive" />
            <p className="text-sm text-destructive">{recipientError}</p>
          </div>
        ) : recipients.length === 0 ? (
          <div className="flex h-28 flex-col items-center justify-center gap-1.5 text-center px-4">
            <Users className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {t('scheduleSend.noRecipientsFound')}
            </p>
          </div>
        ) : filteredRecipients.length === 0 ? (
          <div className="flex h-28 flex-col items-center justify-center gap-1.5 text-center px-4">
            <Search className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {t('scheduleSend.noRecipientsMatch')}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground text-xs w-[40%]">
                    {t('scheduleSend.recipientColName')}
                  </TableHead>
                  <TableHead className="text-muted-foreground text-xs w-[35%]">
                    {t('scheduleSend.recipientColPhone')}
                  </TableHead>
                  <TableHead className="text-muted-foreground text-xs w-[25%]">
                    {t('scheduleSend.recipientColDetails')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {currentRecipients.map((contact, index) => {
                  const displayName =
                    contact.name?.trim() || t('scheduleSend.unnamedContact');
                  const initials = getInitials(contact.name);
                  const details = contact.company || contact.email || '-';

                  return (
                    <TableRow
                      key={contact.id || `${contact.phone}-${index}`}
                      className="border-border"
                    >
                      <TableCell className="py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar size="sm" className="size-7 shrink-0">
                            <AvatarFallback className="bg-primary/10 text-primary text-[11px] font-medium">
                              {initials}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {displayName}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="py-2.5 font-mono text-xs text-foreground/85">
                        {contact.phone || '-'}
                      </TableCell>
                      <TableCell className="py-2.5 text-xs text-muted-foreground truncate max-w-[180px]">
                        {details}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {filteredRecipients.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground bg-muted/10">
            <div>
              {t('scheduleSend.showingRecipients', {
                start: startIndex,
                end: endIndex,
                total: filteredRecipients.length,
              })}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="px-1 text-xs">
                  {t('scheduleSend.pageIndicator', {
                    page: currentPage,
                    pages: totalPages,
                  })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() =>
                    setCurrentPage((p) => Math.min(totalPages, p + 1))
                  }
                  disabled={currentPage === totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">
                {t('scheduleSend.sending')}
              </p>
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
                  disabled={!name.trim() || isProcessing}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                />
              }
            >
              <Send className="h-4 w-4" />
              {t('scheduleSend.sendNow')}
            </DialogTrigger>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">
                  {t('scheduleSend.confirmTitle')}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  {t.rich('scheduleSend.confirmDesc', {
                    count: estimatedReach,
                    template: template.name,
                    b: (chunks) => (
                      <span className="font-medium text-popover-foreground">
                        {chunks}
                      </span>
                    ),
                  })}
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
