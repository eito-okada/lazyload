// Local extraction tester — runs the real Gemini extraction against a screenshot
// file without needing Vercel or the browser. Reuses the exact logic the
// serverless function uses, so what you see here is what the app will get.
//
// Usage:
//   npm run extract -- path/to/screenshot.png
//   EXTRACT_MODEL=gemini-3.5-flash npm run extract -- path/to/screenshot.png
// Reads GEMINI_API_KEY (or GOOGLE_API_KEY) from the environment or a local .env file.
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";

// Load .env (if present) before importing the core module — the Gemini
// client reads GEMINI_API_KEY/GOOGLE_API_KEY at construction time. Minimal, dependency-free.
function loadEnvFile(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const EXT_TO_MEDIA: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

async function main() {
  loadEnvFile();

  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npm run extract -- path/to/screenshot.png");
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    console.error("GEMINI_API_KEY is not set. Add it to your env or .env and retry.");
    process.exit(1);
  }

  const ext = extname(filePath).toLowerCase();
  const mediaType = EXT_TO_MEDIA[ext];
  if (!mediaType) {
    console.error(`Unsupported file type "${ext}". Use png, jpg, gif, or webp.`);
    process.exit(1);
  }

  // Imported after validation so the Gemini client (constructed at module
  // load) only runs once we know the key is present.
  const { extractTasksFromImage, MODEL } = await import("../api/_extract-core");

  const imageBase64 = readFileSync(filePath).toString("base64");

  console.error(`Extracting with model: ${MODEL} …`);
  const startedAt = Date.now();
  const tasks = await extractTasksFromImage(imageBase64, mediaType);
  const elapsedMs = Date.now() - startedAt;

  console.log(JSON.stringify(tasks, null, 2));
  console.error(`\n${tasks.length} task(s) in ${(elapsedMs / 1000).toFixed(1)}s.`);
}

main().catch((err) => {
  console.error("Extraction failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
