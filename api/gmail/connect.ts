import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireUser, serviceClient, HttpError } from "../_supabase";

// Store (or refresh) the user's Gmail refresh token, server-side only. Kept
// separate from google_credentials so the calendar and gmail scopes/tokens
// never collide.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { userId } = await requireUser(req);
    const { refreshToken } = req.body ?? {};
    if (typeof refreshToken !== "string" || !refreshToken) {
      return res.status(400).json({ error: "refreshToken is required" });
    }
    const db = serviceClient();
    const { error } = await db.from("gmail_credentials").upsert(
      {
        user_id: userId,
        refresh_token: refreshToken,
        last_scan_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(error.message);
    return res.status(200).json({ connected: true });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error("Unexpected error in /api/gmail/connect:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
