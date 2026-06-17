import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireUser, HttpError } from "../_supabase";
import { scanUser } from "../_gmail";

// On-demand "Scan inbox now". Reads the user's recent inbox and creates tasks.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { userId } = await requireUser(req);
    const result = await scanUser(userId);
    if (result.error === "not_connected") {
      return res.status(409).json({ error: "Gmail not connected" });
    }
    if (result.error) {
      return res.status(502).json({ error: result.error });
    }
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error("Unexpected error in /api/gmail/scan:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
