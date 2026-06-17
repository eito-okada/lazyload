// Shared extraction logic used by both the serverless handler (api/extract.ts)
// and the local CLI tester (scripts/extract.ts). Files prefixed with "_" are not
// treated as routes by Vercel.
import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";

// Swap the model without touching code: set EXTRACT_MODEL in the env.
// Defaults to Gemini 3.5 Flash — supports vision + structured output and has
// a free tier (rate-limited), which fits testing on a budget. Bump to a Pro
// model later if accuracy on real screenshots needs it.
export const MODEL = process.env.EXTRACT_MODEL ?? "gemini-3.1-flash-lite";

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
  kind: "task" | "event";
  title: string;
  subject?: string;
  priority: "high" | "medium" | "low";
  // task fields (kind === "task")
  dueDate?: string;          // YYYY-MM-DD
  dueTime?: string;          // HH:MM 24h
  estimatedMinutes?: number;
  // event fields (kind === "event")
  startDate?: string;        // YYYY-MM-DD
  startTime?: string;        // HH:MM 24h
  endDate?: string;          // YYYY-MM-DD (may equal startDate for same-day events)
  endTime?: string;          // HH:MM 24h
  allDay?: boolean;
  location?: string;
  // assembled from above by the mapping step — matches frontend Task type
  startAt?: string;          // ISO datetime e.g. "2026-06-17T09:00"
  endAt?: string;
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
          kind: {
            type: Type.STRING,
            enum: ["task", "event"],
            description:
              '"task" for homework/assignments/deadlines. "event" for classes, meetings, office hours, or any item that occupies a time span.',
          },
          title: { type: Type.STRING, description: "The assignment or event name" },
          subject: { type: Type.STRING, nullable: true, description: "Class or subject, if shown" },
          priority: { type: Type.STRING, enum: ["high", "medium", "low"] },
          // task fields
          dueDate: {
            type: Type.STRING,
            nullable: true,
            description:
              'TASK ONLY. Absolute due date as YYYY-MM-DD, resolved from today\'s date. null if no due date shown.',
          },
          dueTime: {
            type: Type.STRING,
            nullable: true,
            description:
              'TASK ONLY. Due time as HH:MM in 24-hour format. Capture it when shown next to the due date ' +
              '("Due 10:00 PM", "11:59pm", "by 9:00 AM"). null if no time shown.',
          },
          estimatedMinutes: {
            type: Type.INTEGER,
            nullable: true,
            description: "TASK ONLY. Rough effort estimate in minutes, or null",
          },
          // event fields
          startDate: {
            type: Type.STRING,
            nullable: true,
            description: "EVENT ONLY. Event start date as YYYY-MM-DD.",
          },
          startTime: {
            type: Type.STRING,
            nullable: true,
            description: "EVENT ONLY. Event start time as HH:MM 24h. null if all-day.",
          },
          endDate: {
            type: Type.STRING,
            nullable: true,
            description:
              "EVENT ONLY. Event end date as YYYY-MM-DD. Often the same as startDate for same-day events.",
          },
          endTime: {
            type: Type.STRING,
            nullable: true,
            description: "EVENT ONLY. Event end time as HH:MM 24h. null if all-day.",
          },
          allDay: {
            type: Type.BOOLEAN,
            nullable: true,
            description: "EVENT ONLY. true when the event occupies a full day with no specific time.",
          },
          location: {
            type: Type.STRING,
            nullable: true,
            description: "EVENT ONLY. Room number, building, or URL if visible.",
          },
        },
        required: ["kind", "title", "priority"],
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
      kind: z.enum(["task", "event"]).default("task"),
      title: z.string(),
      subject: z.string().nullable().optional(),
      priority: z.enum(["high", "medium", "low"]),
      // task
      dueDate: z.string().nullable().optional(),
      dueTime: z.string().nullable().optional(),
      estimatedMinutes: z.number().int().nullable().optional(),
      // event
      startDate: z.string().nullable().optional(),
      startTime: z.string().nullable().optional(),
      endDate: z.string().nullable().optional(),
      endTime: z.string().nullable().optional(),
      allDay: z.boolean().nullable().optional(),
      location: z.string().nullable().optional(),
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
          `Today is ${today}. Look at this screenshot and extract two types of items:\n\n` +
          `1. Tasks/homework (kind="task"): assignments, homework, or any item with a deadline. ` +
          `Extract dueDate (YYYY-MM-DD, resolved from today), dueTime (HH:MM 24h — capture it ` +
          `when shown, e.g. "Due 10:00 PM", "11:59pm", "by 9 AM"), estimatedMinutes, and ` +
          `priority inferred from urgency and due-date proximity.\n\n` +
          `2. Events (kind="event"): classes, lectures, meetings, office hours, lab sessions, ` +
          `or any item that occupies a time span. Extract startDate/startTime and endDate/endTime ` +
          `(YYYY-MM-DD and HH:MM 24h). Set allDay=true when no specific time is shown. ` +
          `Extract location (room, building, URL) if visible.\n\n` +
          `Convert all relative dates ("tomorrow", "Friday", "next week") to absolute YYYY-MM-DD ` +
          `using today's date. Omit task fields for events and event fields for tasks.`,
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

  return parsed.tasks.map((t, i) => {
    const id = `${Date.now()}-${i}`;
    const base = {
      id,
      kind: t.kind,
      title: t.title,
      subject: t.subject ?? undefined,
      priority: t.priority,
    } as const;

    if (t.kind === "event") {
      const startAt = t.startDate
        ? `${t.startDate}T${t.startTime ?? "00:00"}`
        : undefined;
      const endAt = t.endDate
        ? `${t.endDate}T${t.endTime ?? "23:59"}`
        : undefined;
      return {
        ...base,
        startAt,
        endAt,
        allDay: t.allDay ?? undefined,
        location: t.location ?? undefined,
      };
    } else {
      return {
        ...base,
        dueDate: t.dueDate ?? undefined,
        dueTime: t.dueTime ?? undefined,
        estimatedMinutes: t.estimatedMinutes ?? undefined,
      };
    }
  });
}
