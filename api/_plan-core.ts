// Shared logic for /api/plan: turn a computed schedule (blocks the algorithm
// already placed) into short, action-guiding text. The algorithm decides WHEN;
// Gemini only writes the human-facing "what to actually do" label. Files
// prefixed with "_" are not treated as routes by Vercel.
import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";

export const MODEL = process.env.EXTRACT_MODEL ?? "gemini-3.1-flash-lite";

/** One scheduled work block the client wants guiding text for. */
export interface PlanItemInput {
  id: string;
  title: string;
  subject?: string;
  priority?: "high" | "medium" | "low";
  durationMin: number;
  /** When this block starts, human-readable, e.g. "Tue 5:00 PM". */
  startLabel: string;
  /** Deadline hint, e.g. "due Fri". */
  dueLabel?: string;
  /** Session i of n, when the task was split across days. */
  part?: { index: number; total: number };
}

export interface PlanText {
  id: string;
  actionText: string;
}

export interface PlanTextResult {
  items: PlanText[];
  summary: string;
}

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: "Echo back the block id verbatim." },
          actionText: {
            type: Type.STRING,
            description:
              "A short, concrete, imperative instruction telling the person exactly what to start doing in this block. " +
              "Start with a verb (Draft, Outline, Review, Practice, Read, Finish…). Max ~9 words. " +
              "No time/date (that's shown separately). For a split session, reflect the partial scope " +
              '(e.g. "Outline first 3 body paragraphs").',
          },
        },
        required: ["id", "actionText"],
      },
    },
    summary: {
      type: Type.STRING,
      description:
        "One short, warm, encouraging sentence framing the whole plan (max ~16 words). No emoji.",
    },
  },
  required: ["items", "summary"],
};

const ResultSchema = z.object({
  items: z.array(z.object({ id: z.string(), actionText: z.string() })),
  summary: z.string(),
});

const ai = new GoogleGenAI({});

/** Ask Gemini for an action label per block + a one-line plan summary. */
export async function writePlanText(items: PlanItemInput[]): Promise<PlanTextResult> {
  const lines = items.map((it) => {
    const part = it.part ? ` [session ${it.part.index} of ${it.part.total}]` : "";
    const subj = it.subject ? ` (${it.subject})` : "";
    const due = it.dueLabel ? `, ${it.dueLabel}` : "";
    return `- id=${it.id}: "${it.title}"${subj}${part} — ${it.durationMin} min at ${it.startLabel}${due}, priority ${it.priority ?? "medium"}`;
  });

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        text:
          `You are a friendly productivity coach helping someone follow a study/work plan. ` +
          `Below is a list of time blocks already scheduled for them. For EACH block, write a short, ` +
          `concrete instruction that tells them exactly what to start doing — turn a vague title into an ` +
          `actionable first step. Start with a verb, keep it under ~9 words, and don't restate the time or date. ` +
          `When a block is one session of several, make the scope partial and specific. ` +
          `Also write one short, encouraging summary sentence for the whole plan.\n\n` +
          `Return an item for every id below, echoing the id exactly.\n\n` +
          `--- BLOCKS ---\n${lines.join("\n")}`,
      },
    ],
    config: { responseMimeType: "application/json", responseSchema },
  });

  const text = response.text;
  if (!text) throw new Error("Planner returned no text");
  return ResultSchema.parse(JSON.parse(text));
}
