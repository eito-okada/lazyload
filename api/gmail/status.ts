import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireUser, serviceClient, HttpError } from "../_supabase";

// Report whether the user has connected Gmail, plus last scan info.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { userId } = await requireUser(req);
    const db = serviceClient();
    const { data, error } = await db
      .from("gmail_credentials")
      .select("last_scan_at, last_scan_error")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return res.status(200).json({
      connected: !!data,
      lastScanAt: data?.last_scan_at ?? null,
      lastError: data?.last_scan_error ?? null,
    });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error("Unexpected error in /api/gmail/status:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
