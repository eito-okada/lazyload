import { supabase } from '../lib/supabase';

// Client for the server-side Google Calendar sync endpoints. Every call carries
// the current Supabase access token so the serverless function can identify the
// user; the Google refresh token / client secret stay on the server.

export interface SyncStatus {
  connected: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('You must be signed in.');
  return { Authorization: `Bearer ${token}` };
}

async function parseError(res: Response, fallback: string): Promise<never> {
  const body = await res.json().catch(() => ({}));
  throw new Error(body.error ?? `${fallback} (${res.status})`);
}

export async function getStatus(): Promise<SyncStatus> {
  const res = await fetch('/api/google/status', { headers: await authHeader() });
  if (!res.ok) await parseError(res, 'Failed to load status');
  return res.json();
}

export async function syncNow(): Promise<SyncResult> {
  const res = await fetch('/api/google/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  });
  if (!res.ok) await parseError(res, 'Sync failed');
  return res.json();
}

export async function disconnect(): Promise<void> {
  const res = await fetch('/api/google/disconnect', {
    method: 'POST',
    headers: await authHeader(),
  });
  if (!res.ok) await parseError(res, 'Failed to disconnect');
}
