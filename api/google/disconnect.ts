import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireUser, serviceClient, HttpError } from "../_supabase.js";

// Remove the user's stored Google credentials (stops all future sync).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { userId } = await requireUser(req);
    const db = serviceClient();
    const { error } = await db.from("google_credentials").delete().eq("user_id", userId);
    if (error) throw new Error(error.message);
    return res.status(200).json({ connected: false });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error("Unexpected error in /api/google/disconnect:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
