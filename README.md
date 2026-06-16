# LazyLoad

Turn a screenshot of your homework into an editable task list and a calendar.
Upload a screenshot (Canvas, Google Classroom, WebAssign, a worksheet, anything),
Gemini extracts the assignments, you review/fix them, and LazyLoad builds a
schedule you can export to your calendar.

Stack: Vite + React + TypeScript, with a serverless function that calls the
Gemini API (vision + structured outputs).

## Setup

```sh
npm install
cp .env.example .env   # then add your GEMINI_API_KEY
```

Get a key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) — Gemini 3.5 Flash has a free tier (rate-limited), which is what this defaults to. No payment method required to get started, unlike Claude.

Environment variables (see [.env.example](.env.example)):

| Var | Where | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | backend | Your Gemini API key. Never commit it. |
| `EXTRACT_MODEL` | backend | Override the extraction model. Defaults to `gemini-3.5-flash` (free tier). Bump to a paid/Pro model for accuracy. |
| `VITE_USE_MOCK` | frontend | `true` uses built-in mock tasks instead of calling the API — develop the UI without spending tokens. |

## Testing extraction (fastest feedback)

Run the real extraction against a screenshot file — no Vercel or browser needed.
This is the quickest way to check whether the model reads your screenshots
correctly:

```sh
npm run extract -- path/to/screenshot.png

# try a different model on the same screenshot (check ai.google.dev/gemini-api/docs/models for current IDs):
EXTRACT_MODEL=gemini-3.1-pro-preview npm run extract -- path/to/screenshot.png
```

It prints the extracted tasks as JSON plus the model used and elapsed time.
Reads `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) from your environment or `.env`.

## Running the app

```sh
# UI only, with mock data (no API calls):
VITE_USE_MOCK=true npm run dev          # http://localhost:5173

# Full app including the real /api/extract function:
npm i -g vercel
vercel dev
```

Note: the plain Vite dev server (`npm run dev`) does **not** execute the
`/api` serverless function — use `vercel dev` to exercise real extraction in
the browser, or the `npm run extract` CLI above.

## Project layout

```
api/
  extract.ts          serverless HTTP handler (thin wrapper)
  _extract-core.ts    shared Gemini extraction logic (vision + structured output)
scripts/
  extract.ts          local CLI tester (reuses _extract-core)
src/
  pages/              Home, Upload, Review, Schedule
  components/         Navbar, UploadBox, TaskCard
  context/            TaskContext (shares tasks across pages)
  services/api.ts     calls /api/extract (or mock when VITE_USE_MOCK=true)
  types/Task.ts       calendar-ready task shape
```

## Build

```sh
npm run build
```
