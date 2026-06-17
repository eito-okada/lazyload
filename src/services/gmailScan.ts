import { supabase } from '../lib/supabase';

// Client for the server-side Gmail scan endpoints. Every call carries the
// current Supabase access token so the serverless function can identify the
// user; the Gmail refresh token stays on the server.

export interface GmailStatus {
  connected: boolean;
  lastScanAt: string | null;
  lastError: string | null;
}

export interface ScanResult {
  scanned: number;
  suggested: number;
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

export async function getStatus(): Promise<GmailStatus> {
  const res = await fetch('/api/gmail/status', { headers: await authHeader() });
  if (!res.ok) await parseError(res, 'Failed to load status');
  return res.json();
}

export async function scanNow(): Promise<ScanResult> {
  const res = await fetch('/api/gmail/scan', {
    method: 'POST',
    headers: await authHeader(),
  });
  if (!res.ok) await parseError(res, 'Scan failed');
  return res.json();
}

export async function disconnect(): Promise<void> {
  const res = await fetch('/api/gmail/disconnect', {
    method: 'POST',
    headers: await authHeader(),
  });
  if (!res.ok) await parseError(res, 'Failed to disconnect');
}
