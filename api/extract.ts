import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ApiError } from "@google/genai";
import {
  extractTasksFromImage,
  ALLOWED_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  type MediaType,
} from "./_extract-core";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { imageBase64, mediaType } = req.body ?? {};

  if (typeof imageBase64 !== "string" || typeof mediaType !== "string") {
    return res.status(400).json({ error: "imageBase64 and mediaType are required" });
  }
  if (!ALLOWED_MEDIA_TYPES.includes(mediaType as MediaType)) {
    return res.status(400).json({ error: `Unsupported media type: ${mediaType}` });
  }
  // base64 inflates by ~4/3; estimate decoded size before sending upstream.
  if ((imageBase64.length * 3) / 4 > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: "Image too large (max ~5MB)" });
  }

  try {
    const tasks = await extractTasksFromImage(imageBase64, mediaType as MediaType);
    return res.status(200).json({ tasks });
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`Gemini API error ${err.status}:`, err.message);
      return res.status(502).json({ error: "Extraction service error" });
    }
    console.error("Unexpected error in /api/extract:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
