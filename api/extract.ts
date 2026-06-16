import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

// Swap the model without touching code: set EXTRACT_MODEL in the host env.
// Defaults to the cheapest vision+structured-output model. Bump to
// "claude-sonnet-4-6" or "claude-opus-4-8" if accuracy needs it.
const MODEL = process.env.EXTRACT_MODEL ?? "claude-haiku-4-5";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // ~5MB cap on the decoded image
const ALLOWED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

const ExtractedTasks = z.object({
  tasks: z.array(
    z.object({
      title: z.string().describe("The assignment name"),
      subject: z.string().nullable().describe("Class or subject, if shown"),
      dueDate: z
        .string()
        .nullable()
        .describe("Absolute due date as YYYY-MM-DD, resolved from today's date. null if none shown."),
      startTime: z
        .string()
        .nullable()
        .describe("Start time as HH:MM (24h) only if a specific time is shown, else null"),
      estimatedMinutes: z
        .number()
        .int()
        .nullable()
        .describe("Rough effort estimate in minutes, or null"),
      priority: z.enum(["high", "medium", "low"]),
    }),
  ),
});

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { imageBase64, mediaType } = req.body ?? {};

  if (typeof imageBase64 !== "string" || typeof mediaType !== "string") {
    return res.status(400).json({ error: "imageBase64 and mediaType are required" });
  }
  if (!ALLOWED_MEDIA_TYPES.includes(mediaType as (typeof ALLOWED_MEDIA_TYPES)[number])) {
    return res.status(400).json({ error: `Unsupported media type: ${mediaType}` });
  }
  // base64 inflates by ~4/3; estimate decoded size before sending upstream.
  if ((imageBase64.length * 3) / 4 > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: "Image too large (max ~5MB)" });
  }

  const today = new Date().toISOString().slice(0, 10);

  try {
    const result = await client.messages.parse({
      model: MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType as "image/png", data: imageBase64 },
            },
            {
              type: "text",
              text:
                `Today is ${today}. Extract every assignment, homework, or task visible in this screenshot. ` +
                `Convert all relative dates ("tomorrow", "Friday", "next week") to absolute YYYY-MM-DD dates ` +
                `based on today's date. If no due date is shown for a task, use null. ` +
                `Infer priority from due date proximity and wording.`,
            },
          ],
        },
      ],
      output_config: { format: zodOutputFormat(ExtractedTasks) },
    });

    const parsed = result.parsed_output;
    if (!parsed) {
      return res.status(502).json({ error: "Extraction returned no structured result" });
    }

    // Map the schema shape (nullable fields) onto the app's Task shape (optional fields).
    const tasks = parsed.tasks.map((t, i) => ({
      id: `${Date.now()}-${i}`,
      title: t.title,
      subject: t.subject ?? undefined,
      dueDate: t.dueDate ?? undefined,
      startTime: t.startTime ?? undefined,
      estimatedMinutes: t.estimatedMinutes ?? undefined,
      priority: t.priority,
    }));

    return res.status(200).json({ tasks });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error(`Anthropic API error ${err.status}:`, err.message);
      return res.status(502).json({ error: "Extraction service error" });
    }
    console.error("Unexpected error in /api/extract:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
