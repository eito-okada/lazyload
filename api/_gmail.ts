import { serviceClient } from "./_supabase.js";
import { refreshAccessToken } from "./_google.js";
import { extractTasksFromText, type ExtractedTask } from "./_extract-core.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
// Overlaps the hourly cron window generously; the dedup ledger keeps re-scans cheap.
const SEARCH_QUERY = "newer_than:7d in:inbox";
const MAX_MESSAGES_PER_SCAN = 25;
const MAX_BODY_CHARS = 20_000;

export interface ScanResult {
  scanned: number; // new messages fed to the model this run
  suggested: number; // suggestions staged for the user to review
  skipped: number; // messages already in the dedup ledger
  error?: string;
}

// ── Gmail REST calls ────────────────────────────────────────────────────────

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  snippet?: string;
  payload?: GmailPart & { headers?: { name: string; value: string }[] };
}

export interface MessageContent {
  /** Full text fed to the model: "Subject: …\n\n<body>". */
  text: string;
  /** Raw From header, e.g. "Jane Doe <jane@uni.edu>". */
  from: string;
  subject: string;
  /** Gmail's short preview line, stored for display next to the suggestion. */
  snippet: string;
}

/** IDs of recent inbox messages (most recent first), capped. */
export async function listRecentMessageIds(accessToken: string): Promise<string[]> {
  const url = `${GMAIL_BASE}/messages?maxResults=${MAX_MESSAGES_PER_SCAN}&q=${encodeURIComponent(SEARCH_QUERY)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`Gmail list failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { messages?: { id: string }[] };
  return (json.messages ?? []).map((m) => m.id);
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Depth-first walk of the MIME tree collecting text, preferring text/plain. */
function extractBody(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts?.length) {
    const plain = part.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) return decodeBase64Url(plain.body.data);
    return part.parts.map(extractBody).filter(Boolean).join("\n");
  }
  // Fall back to HTML (crudely stripped) only when there's no plain alternative.
  if (part.mimeType === "text/html" && part.body?.data) {
    return decodeBase64Url(part.body.data).replace(/<[^>]+>/g, " ");
  }
  return "";
}

/** Fetch one message: model text (size-capped), subject, and Gmail's snippet. */
export async function getMessageContent(accessToken: string, id: string): Promise<MessageContent> {
  const res = await fetch(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail get failed (${res.status}): ${await res.text()}`);
  }
  const msg = (await res.json()) as GmailMessage;
  const header = (name: string) =>
    msg.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  const subject = header("subject");
  const from = header("from");
  const body = extractBody(msg.payload).trim().slice(0, MAX_BODY_CHARS);
  return {
    text: `From: ${from}\nSubject: ${subject}\n\n${body}`,
    from,
    subject,
    snippet: msg.snippet ?? "",
  };
}

// ── Mapping: ExtractedTask → tasks row ────────────────────────────────────────

function extractedToRow(
  userId: string,
  messageId: string,
  source: MessageContent,
  t: ExtractedTask,
): Record<string, unknown> {
  const isEvent = t.kind === "event";
  return {
    user_id: userId,
    message_id: messageId,
    email_from: source.from || null,
    email_subject: source.subject || null,
    email_snippet: source.snippet || null,
    title: t.title,
    subject: t.subject ?? null,
    priority: t.priority ?? "medium",
    kind: t.kind,
    due_date: isEvent ? null : t.dueDate ?? null,
    due_time: isEvent ? null : t.dueTime ?? null,
    estimated_minutes: isEvent ? null : t.estimatedMinutes ?? null,
    start_at: isEvent ? t.startAt ?? null : null,
    end_at: isEvent ? t.endAt ?? null : null,
    all_day: isEvent ? t.allDay ?? false : false,
    location: isEvent ? t.location ?? null : null,
  };
}

// ── Scan core (shared by /scan and /scan-all) ─────────────────────────────────

/**
 * Read one user's recent inbox, turn genuine deadlines/events into tasks, and
 * record processed message ids so they're never re-extracted. Records
 * last_scan_at / last_scan_error. Never throws — returns a ScanResult.
 */
export async function scanUser(userId: string): Promise<ScanResult> {
  const db = serviceClient();
  const result: ScanResult = { scanned: 0, suggested: 0, skipped: 0 };

  const { data: cred, error: credErr } = await db
    .from("gmail_credentials")
    .select("refresh_token")
    .eq("user_id", userId)
    .maybeSingle();
  if (credErr) {
    result.error = `Failed to load credentials: ${credErr.message}`;
    return result;
  }
  if (!cred) {
    result.error = "not_connected";
    return result;
  }

  try {
    const accessToken = await refreshAccessToken(cred.refresh_token);
    const ids = await listRecentMessageIds(accessToken);

    // Filter out messages we've already processed (dedup ledger).
    const { data: seenRows, error: seenErr } = await db
      .from("gmail_scanned_messages")
      .select("message_id")
      .eq("user_id", userId)
      .in("message_id", ids.length ? ids : ["__none__"]);
    if (seenErr) throw new Error(`Failed to load scan ledger: ${seenErr.message}`);
    const seen = new Set((seenRows ?? []).map((r) => r.message_id));
    const newIds = ids.filter((id) => !seen.has(id));
    result.skipped = ids.length - newIds.length;

    for (const id of newIds) {
      const content = await getMessageContent(accessToken, id);
      const extracted = await extractTasksFromText(content.text);
      result.scanned++;

      if (extracted.length) {
        const rows = extracted.map((t) => extractedToRow(userId, id, content, t));
        const { error: insErr } = await db.from("gmail_suggestions").insert(rows);
        if (insErr) throw new Error(`Failed to stage suggestions: ${insErr.message}`);
        result.suggested += rows.length;
      }

      // Mark processed regardless of whether it yielded items, so empty emails
      // aren't re-scanned each hour.
      const { error: ledgerErr } = await db
        .from("gmail_scanned_messages")
        .insert({ user_id: userId, message_id: id });
      if (ledgerErr) throw new Error(`Failed to update scan ledger: ${ledgerErr.message}`);
    }

    await db
      .from("gmail_credentials")
      .update({
        last_scan_at: new Date().toISOString(),
        last_scan_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
    await db
      .from("gmail_credentials")
      .update({ last_scan_error: message, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
  }

  return result;
}
