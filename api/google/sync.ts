import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireUser, HttpError } from "../_supabase";
import { syncUser } from "../_google";

// Push the authenticated user's items to Google Calendar now.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { userId } = await requireUser(req);
    const { timeZone } = req.body ?? {};
    const result = await syncUser(userId, typeof timeZone === "string" ? timeZone : undefined);
    if (result.error === "not_connected") {
      return res.status(409).json({ error: "Google Calendar not connected" });
    }
    if (result.error) {
      return res.status(502).json({ error: result.error, ...result });
    }
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error("Unexpected error in /api/google/sync:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
