import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ApiError } from "@google/genai";
import { writePlanText, type PlanItemInput } from "./_plan-core";

const MAX_ITEMS = 50;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items (non-empty array) is required" });
  }
  if (items.length > MAX_ITEMS) {
    return res.status(413).json({ error: `Too many items (max ${MAX_ITEMS})` });
  }
  if (!items.every((it) => it && typeof it.id === "string" && typeof it.title === "string")) {
    return res.status(400).json({ error: "each item needs an id and title" });
  }

  try {
    const result = await writePlanText(items as PlanItemInput[]);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`Gemini API error ${err.status}:`, err.message);
      return res.status(502).json({ error: "Planner service error" });
    }
    console.error("Unexpected error in /api/plan:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
