import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireUser, serviceClient, HttpError } from "../_supabase.js";

// Store (or refresh) the user's Google refresh token, server-side only.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { userId } = await requireUser(req);
    const { refreshToken, timeZone } = req.body ?? {};
    if (typeof refreshToken !== "string" || !refreshToken) {
      return res.status(400).json({ error: "refreshToken is required" });
    }
    const db = serviceClient();
    const { error } = await db.from("google_credentials").upsert(
      {
        user_id: userId,
        refresh_token: refreshToken,
        time_zone: typeof timeZone === "string" ? timeZone : null,
        last_sync_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(error.message);
    return res.status(200).json({ connected: true });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error("Unexpected error in /api/google/connect:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
