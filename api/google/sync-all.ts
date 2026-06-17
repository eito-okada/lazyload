import type { VercelRequest, VercelResponse } from "@vercel/node";
import { serviceClient } from "../_supabase";
import { syncUser } from "../_google";

// Background cron entry: sync every connected user. Guarded by CRON_SECRET so it
// can't be triggered by the public. Vercel cron sends the secret as a header
// (configured via vercel.json + the CRON_SECRET env var).
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
    const { data: creds, error } = await db.from("google_credentials").select("user_id, time_zone");
    if (error) throw new Error(error.message);

    let users = 0;
    let created = 0;
    let updated = 0;
    let deleted = 0;
    const errors: string[] = [];
    for (const cred of creds ?? []) {
      users++;
      const r = await syncUser(cred.user_id, cred.time_zone ?? undefined);
      created += r.created;
      updated += r.updated;
      deleted += r.deleted;
      if (r.error) errors.push(`${cred.user_id}: ${r.error}`);
    }
    return res.status(200).json({ users, created, updated, deleted, errors });
  } catch (err) {
    console.error("Unexpected error in /api/google/sync-all:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
