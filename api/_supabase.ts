import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest } from "@vercel/node";
import WebSocket from "ws";

// Service-role client: bypasses RLS, so it can read/write the service-role-only
// google_credentials / google_deletions tables. NEVER expose this key (or a
// client built from it) to the browser.
export function serviceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: WebSocket },
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Authenticate the caller by their Supabase JWT (Authorization: Bearer <token>).
// Returns the authenticated user's id, or throws HttpError(401).
export async function requireUser(req: VercelRequest): Promise<{ userId: string }> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    throw new HttpError(401, "Missing bearer token");
  }
  const { data, error } = await serviceClient().auth.getUser(token);
  if (error || !data.user) {
    throw new HttpError(401, "Invalid or expired token");
  }
  return { userId: data.user.id };
}
