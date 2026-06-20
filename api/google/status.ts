import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireUser, serviceClient, HttpError } from "../_supabase.js";

// Report whether the user has connected Google Calendar, plus last sync info.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { userId } = await requireUser(req);
    const db = serviceClient();
    const { data, error } = await db
      .from("google_credentials")
      .select("last_sync_at, last_sync_error, last_import_at, last_import_error")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return res.status(200).json({
      connected: !!data,
      lastSyncAt: data?.last_sync_at ?? null,
      lastError: data?.last_sync_error ?? null,
      lastImportAt: data?.last_import_at ?? null,
      lastImportError: data?.last_import_error ?? null,
    });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error("Unexpected error in /api/google/status:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
