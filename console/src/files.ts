/**
 * Takes a file out of the company's files and saves it on this device.
 *
 * The API answers with the bytes in base64 inside JSON, like every answer it
 * gives, and this decodes them and offers them as a download -- as an
 * octet stream whatever the file is, never with a kind the server named, so
 * the browser saves it and does not draw it. Nothing is kept in the browser
 * and nothing is opened from it: no window, no navigation to the saved file.
 */
import { api } from './api.ts';

export async function saveCompanyFile(companyId: string, path: string): Promise<void> {
  const file = await api('GET', `/api/companies/${companyId}/files/download?path=${encodeURIComponent(path)}`) as { name: string; data: string };
  const raw = atob(file.data);
  const bytes = new Uint8Array(raw.length);
  for (let at = 0; at < raw.length; at += 1) bytes[at] = raw.charCodeAt(at);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.rel = 'noopener';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
