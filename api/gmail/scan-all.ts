import type { VercelRequest, VercelResponse } from "@vercel/node";
import { serviceClient } from "../_supabase";
import { scanUser } from "../_gmail";

// Background cron entry: scan every Gmail-connected user's inbox. Guarded by
// CRON_SECRET so it can't be triggered by the public (same pattern as the
// calendar sync-all cron).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.CRON_SECRET;
  const provided =
    req.headers["x-cron-secret"] ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined);
  if (!secret || provided !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const db = serviceClient();
    const { data: creds, error } = await db.from("gmail_credentials").select("user_id");
    if (error) throw new Error(error.message);

    let users = 0;
    let suggested = 0;
    let scanned = 0;
    const errors: string[] = [];
    for (const cred of creds ?? []) {
      users++;
      const r = await scanUser(cred.user_id);
      suggested += r.suggested;
      scanned += r.scanned;
      if (r.error) errors.push(`${cred.user_id}: ${r.error}`);
    }
    return res.status(200).json({ users, scanned, suggested, errors });
  } catch (err) {
    console.error("Unexpected error in /api/gmail/scan-all:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
