'use client';

import { useState, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Upload, FileText, Loader2, CheckCircle, XCircle } from 'lucide-react';

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

interface ParsedRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  tags?: string[];
}

function parseCSV(text: string): ParsedRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headerLine = lines[0];
  const headers = headerLine.split(',').map((h) => h.trim().toLowerCase().replace(/["']/g, ''));

  // Smarter fuzzy matching for all columns
  const phoneIdx = headers.findIndex(h => h.includes('phone') || h.includes('mobile') || h.includes('whatsapp') || h.includes('number'));
  if (phoneIdx === -1) return [];

  const emailIdx = headers.findIndex(h => h.includes('email'));
  const companyIdx = headers.findIndex(h => h.includes('company') || h.includes('organization') || h.includes('business'));
  const nameIdx = headers.findIndex(h => (h.includes('name') && !h.includes('company')) || h.includes('first') || h.includes('contact'));
  const tagsIdx = headers.findIndex(h => h.includes('tag') || h.includes('label'));

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Simple CSV parse (handles quoted fields)
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());

    const phone = values[phoneIdx]?.replace(/["']/g, '').trim();
    if (!phone) continue;

    rows.push({
      phone,
      name: nameIdx >= 0 ? values[nameIdx]?.replace(/["']/g, '').trim() || undefined : undefined,
      email: emailIdx >= 0 ? values[emailIdx]?.replace(/["']/g, '').trim() || undefined : undefined,
      company: companyIdx >= 0 ? values[companyIdx]?.replace(/["']/g, '').trim() || undefined : undefined,
      tags: tagsIdx >= 0 && values[tagsIdx] ? values[tagsIdx].replace(/["']/g, '').split(/[,|;]/).map(t => t.trim()).filter(Boolean) : undefined,
    });
  }

  return rows;
}

export function ImportModal({ open, onOpenChange, onImported }: ImportModalProps) {
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; failed: number } | null>(null);

  function reset() {
    setFile(null);
    setParsedRows([]);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(open: boolean) {
    if (!open) reset();
    onOpenChange(open);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    setResult(null);

    const text = await selected.text();
    const rows = parseCSV(text);

    if (rows.length === 0) {
      toast.error('No valid rows found. Ensure CSV has a "phone" column header.');
      setParsedRows([]);
      return;
    }

    setParsedRows(rows);
  }

  async function handleImport() {
    if (parsedRows.length === 0) return;
    setImporting(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('Not authenticated');

      let imported = 0;
      let failed = 0;

      // Batch insert in chunks of 50
      const chunkSize = 50;
      for (let i = 0; i < parsedRows.length; i += chunkSize) {
        const chunk = parsedRows.slice(i, i + chunkSize);
        const rows = chunk.map((row) => ({
          user_id: user.id,
          phone: row.phone,
          name: row.name || null,
          email: row.email || null,
          company: row.company || null,
        }));

        let successfulContacts: { id: string; phone: string }[] = [];

        // Attempt bulk insert
        const { data, error } = await supabase
          .from('contacts')
          .insert(rows)
          .select('id, phone');

        if (error) {
          // Fallback to individual inserts if batch fails
          for (const row of rows) {
            const { data: singleData, error: singleErr } = await supabase
              .from('contacts')
              .insert(row)
              .select('id, phone')
              .single();
              
            if (singleErr) {
              failed++;
            } else if (singleData) {
              imported++;
              successfulContacts.push(singleData);
            }
          }
        } else if (data) {
          imported += data.length;
          successfulContacts = data;
        }

        // --- Process Tags for Successful Contacts ---
        if (successfulContacts.length > 0) {
          try {
            // Collect all unique tags in this chunk
            const allTagsSet = new Set<string>();
            chunk.forEach(r => r.tags?.forEach(t => allTagsSet.add(t.trim())));
            const uniqueTags = Array.from(allTagsSet).filter(Boolean);

            if (uniqueTags.length > 0) {
              // Get existing tags from database
              const { data: existingTags } = await supabase
                .from('tags')
                .select('id, name');
                
              const existingTagsMap = new Map((existingTags || []).map(t => [t.name.toLowerCase(), t.id]));
              const missingTags = uniqueTags.filter(t => !existingTagsMap.has(t.toLowerCase()));

              let allDbTags = [...(existingTags || [])];

              // Insert any tags that don't exist yet
              if (missingTags.length > 0) {
                const tagsToInsert = missingTags.map(t => ({
                  name: t,
                  color: '#8b5cf6', // Default violet color
                  user_id: user.id
                }));
                
                const { data: newTags, error: tagErr } = await supabase
                  .from('tags')
                  .insert(tagsToInsert)
                  .select('id, name');
                  
                // Fallback if schema doesn't use user_id on tags table
                if (tagErr && tagErr.message.includes('user_id')) {
                   const fallbackTags = missingTags.map(t => ({ name: t, color: '#8b5cf6' }));
                   const { data: fallbackNew } = await supabase.from('tags').insert(fallbackTags).select('id, name');
                   if (fallbackNew) allDbTags = [...allDbTags, ...fallbackNew];
                } else if (newTags) {
                  allDbTags = [...allDbTags, ...newTags];
                }
              }

              // Update the map with newly created tags
              allDbTags.forEach(t => existingTagsMap.set(t.name.toLowerCase(), t.id));

              // Map tags to their respective contact IDs
              const contactTagsToInsert: { contact_id: string; tag_id: string }[] = [];
              for (const contact of successfulContacts) {
                const originalRow = chunk.find(r => r.phone === contact.phone);
                if (originalRow && originalRow.tags) {
                  for (const tagName of originalRow.tags) {
                    const tagId = existingTagsMap.get(tagName.trim().toLowerCase());
                    if (tagId) {
                      contactTagsToInsert.push({
                        contact_id: contact.id,
                        tag_id: tagId
                      });
                    }
                  }
                }
              }

              // Bulk insert relations into contact_tags
              if (contactTagsToInsert.length > 0) {
                await supabase.from('contact_tags').insert(contactTagsToInsert);
              }
            }
          } catch (tagError) {
            console.error('Non-fatal error importing tags:', tagError);
            // Swallowing error so the main contact import succeeds even if linking fails
          }
        }
      }

      setResult({ imported, failed });
      if (imported > 0) {
        toast.success(`${imported} contact${imported !== 1 ? 's' : ''} imported`);
        onImported();
      }
      if (failed > 0) {
        toast.error(`${failed} contact${failed !== 1 ? 's' : ''} failed to import`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Import failed';
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  const preview = parsedRows.slice(0, 5);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-700 text-slate-200 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-white">Import Contacts</DialogTitle>
          <DialogDescription className="text-slate-400">
            Upload a CSV file. A &quot;phone&quot; column is required. Optional columns:
            name, email, company, tags (comma separated).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div
            onClick={() => fileInputRef.current?.click()}
            className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-700 p-6 cursor-pointer hover:border-violet-500/50 transition-colors"
          >
            {file ? (
              <>
                <FileText className="size-8 text-violet-400" />
                <p className="text-sm text-slate-300">{file.name}</p>
                <p className="text-xs text-slate-500">
                  {parsedRows.length} row{parsedRows.length !== 1 ? 's' : ''} detected
                </p>
              </>
            ) : (
              <>
                <Upload className="size-8 text-slate-500" />
                <p className="text-sm text-slate-400">
                  Click to upload CSV file
                </p>
                <p className="text-xs text-slate-500">
                  Matches: phone, name, email, company, tags
                </p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="hidden"
          />

          {preview.length > 0 && !result && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Preview (first {preview.length} rows)
              </p>
              <div className="rounded-lg border border-slate-700 overflow-hidden overflow-x-auto">
                <table className="w-full text-xs min-w-max">
                  <thead>
                    <tr className="bg-slate-800">
                      <th className="px-3 py-1.5 text-left text-slate-400 font-medium">Phone</th>
                      <th className="px-3 py-1.5 text-left text-slate-400 font-medium">Name</th>
                      <th className="px-3 py-1.5 text-left text-slate-400 font-medium">Email</th>
                      <th className="px-3 py-1.5 text-left text-slate-400 font-medium">Company</th>
                      <th className="px-3 py-1.5 text-left text-slate-400 font-medium">Tags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row, i) => (
                      <tr key={i} className="border-t border-slate-700/50">
                        <td className="px-3 py-1.5 text-slate-300">{row.phone}</td>
                        <td className="px-3 py-1.5 text-slate-300">{row.name || '-'}</td>
                        <td className="px-3 py-1.5 text-slate-300">{row.email || '-'}</td>
                        <td className="px-3 py-1.5 text-slate-300">{row.company || '-'}</td>
                        <td className="px-3 py-1.5 text-slate-300">{row.tags?.join(', ') || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {parsedRows.length > 5 && (
                <p className="text-xs text-slate-500">
                  ...and {parsedRows.length - 5} more rows
                </p>
              )}
            </div>
          )}

          {result && (
            <div className="rounded-lg border border-slate-700 p-4 space-y-2">
              <p className="text-sm font-medium text-white">Import Complete</p>
              <div className="flex items-center gap-4">
                {result.imported > 0 && (
                  <div className="flex items-center gap-1.5 text-violet-400 text-sm">
                    <CheckCircle className="size-4" />
                    {result.imported} imported
                  </div>
                )}
                {result.failed > 0 && (
                  <div className="flex items-center gap-1.5 text-red-400 text-sm">
                    <XCircle className="size-4" />
                    {result.failed} failed
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="bg-slate-900 border-slate-700">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-slate-700 text-slate-300 hover:bg-slate-800"
          >
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button
              type="button"
              disabled={parsedRows.length === 0 || importing}
              onClick={handleImport}
              className="bg-violet-600 hover:bg-violet-700 text-white"
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              Import {parsedRows.length > 0 ? `${parsedRows.length} Contacts` : ''}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}