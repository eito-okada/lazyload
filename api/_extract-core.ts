// Shared extraction logic used by both the serverless handler (api/extract.ts)
// and the local CLI tester (scripts/extract.ts). Files prefixed with "_" are not
// treated as routes by Vercel.
import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";

// Swap the model without touching code: set EXTRACT_MODEL in the env.
// Defaults to Gemini 3.5 Flash — supports vision + structured output and has
// a free tier (rate-limited), which fits testing on a budget. Bump to a Pro
// model later if accuracy on real screenshots needs it.
export const MODEL = process.env.EXTRACT_MODEL ?? "gemini-3.5-flash";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // ~5MB cap on the decoded image
export const ALLOWED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type MediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

export interface ExtractedTask {
  id: string;
  title: string;
  subject?: string;
  dueDate?: string;
  startTime?: string;
  estimatedMinutes?: number;
  priority: "high" | "medium" | "low";
}

// Gemini's responseSchema uses its own Schema format (Type enum, uppercase),
// not standard JSON Schema — hand-written here rather than derived from zod
// to avoid a casing/shape mismatch with what the API expects.
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    tasks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "The assignment name" },
          subject: { type: Type.STRING, nullable: true, description: "Class or subject, if shown" },
          dueDate: {
            type: Type.STRING,
            nullable: true,
            description: "Absolute due date as YYYY-MM-DD, resolved from today's date. null if none shown.",
          },
          startTime: {
            type: Type.STRING,
            nullable: true,
            description:
              "The due TIME as HH:MM in 24-hour format — the deadline time, not a suggested work-start time. " +
              "Homework trackers often show a time next to or below the due date, e.g. 'Due 10:00 PM', " +
              "'11:59pm', '23:59', or 'by 9:00 AM'. Always capture it here when present. " +
              "Use null only when no time accompanies the due date.",
          },
          estimatedMinutes: {
            type: Type.INTEGER,
            nullable: true,
            description: "Rough effort estimate in minutes, or null",
          },
          priority: { type: Type.STRING, enum: ["high", "medium", "low"] },
        },
        required: ["title", "priority"],
      },
    },
  },
  required: ["tasks"],
};

// Light validation pass over the parsed JSON — responseSchema constrains the
// shape but this catches anything that slips through (e.g. malformed JSON).
const ExtractedTasksSchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string(),
      subject: z.string().nullable().optional(),
      dueDate: z.string().nullable().optional(),
      startTime: z.string().nullable().optional(),
      estimatedMinutes: z.number().int().nullable().optional(),
      priority: z.enum(["high", "medium", "low"]),
    }),
  ),
});

// Reads GEMINI_API_KEY or GOOGLE_API_KEY from env automatically.
const ai = new GoogleGenAI({});

/** Run Gemini vision extraction on a base64-encoded screenshot. */
export async function extractTasksFromImage(
  imageBase64: string,
  mediaType: MediaType,
): Promise<ExtractedTask[]> {
  const today = new Date().toISOString().slice(0, 10);

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      { inlineData: { mimeType: mediaType, data: imageBase64 } },
      {
        text:
          `Today is ${today}. Extract every assignment, homework, or task visible in this screenshot. ` +
          `Convert all relative dates ("tomorrow", "Friday", "next week") to absolute YYYY-MM-DD dates ` +
          `based on today's date. If no due date is shown for a task, use null for dueDate. ` +
          `Separately, look for a due TIME next to or below the date (e.g. "10:00 PM", "11:59pm", ` +
          `"by 9:00 AM") and put it in startTime as 24-hour HH:MM — don't skip this just because a ` +
          `date was already found. Use null for startTime only if no time is shown. ` +
          `Infer priority from due date proximity and wording.`,
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema,
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error("Extraction returned no structured result");
  }

  const parsed = ExtractedTasksSchema.parse(JSON.parse(text));

  return parsed.tasks.map((t, i) => ({
    id: `${Date.now()}-${i}`,
    title: t.title,
    subject: t.subject ?? undefined,
    dueDate: t.dueDate ?? undefined,
    startTime: t.startTime ?? undefined,
    estimatedMinutes: t.estimatedMinutes ?? undefined,
    priority: t.priority,
  }));
}
