import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireUser, serviceClient, HttpError } from "../_supabase.js";

// Remove the user's stored Gmail credentials (stops all future scanning). The
// dedup ledger is left in place so reconnecting doesn't re-scan old mail.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { userId } = await requireUser(req);
    const db = serviceClient();
    const { error } = await db.from("gmail_credentials").delete().eq("user_id", userId);
    if (error) throw new Error(error.message);
    return res.status(200).json({ connected: false });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error("Unexpected error in /api/gmail/disconnect:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
