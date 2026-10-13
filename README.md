# Content Rater — $0 version

Free AI video grading for content creators. Upload a video, get a report card:
**Creative quality** + **Goal alignment** scores, per-dimension notes (hook, visuals,
pacing, audio, platform fit, on-screen text), prioritized fixes, strengths,
timestamped notes, and hook rewrites. No predicted-performance score — we don't
fake what we can't know.

**Every tier is free:** Vercel (hosting), Supabase (auth + database), Gemini +
Groq free-tier AI APIs. $0/month to run at launch scale.

## How it works

1. User signs in with Google (Supabase Auth).
2. **Creative Brief first** — primary goal (required), platforms multi-select
   (required), intended viewer, optional niche/offer. Only context the video
   itself can't provide.
3. **Add video** — the *browser* extracts ~12 JPEG frames (canvas, ≤640px) and
   encodes the first 90s of audio to 16kHz WAV. Nothing heavy runs on the server.
4. `POST /api/analyze` — server verifies the Supabase JWT, checks the daily quota
   (3/day UTC), sends audio to Groq Whisper (free), sends frames + transcript +
   brief to Gemini Flash (free) for strict-JSON grading.
5. **Fallback chain:** if Gemini 429s/errors, retry once, then Groq chat completes
   a transcript+brief-only grade flagged `visual_analysis_unavailable`.
6. Report saved to Supabase; history view lists past grades.

API keys live **only** in Vercel env vars (server-side). The browser never sees
them. `/api/config` exposes only the public-safe Supabase anon key + URL.

## Project layout

```
index.html      landing + app (no build step, dark theme)
styles.css
app.js          auth, brief, browser-side frame/audio extraction, report render
api/analyze.js  quota check -> Whisper -> Gemini grading -> fallback -> save
api/quota.js    { remaining, limit } for today (UTC)
api/history.js  user's recent reports
api/config.js   public-safe Supabase URL + anon key
vercel.json     function timeout config
.env.example    env var names (no real values)
schema.sql      usage + reports tables (+ RLS)
DEPLOY.md       click-by-click setup for a non-coder
```

## Honest limits

- **Not testable without keys:** the live AI calls (Whisper transcription, Gemini
  grading, Groq fallback) need the real `GEMINI_API_KEY` / `GROQ_API_KEY` and a
  Supabase project. Everything else (UI flow, extraction, rendering) runs without them.
- **Free-tier caps:** Gemini free ≈ 15 req/min, ~500–1,500 req/day (Oct 2026);
  Groq free ≈ 30 req/min, ~1K req/day. One video ≈ 2 calls → ~250 videos/day
  capacity. Per-user cap is 3/day so one user can't eat the pool.
- **Limits change without notice.** The 429 fallback chain is the mitigation; if a
  provider retires a model, update `GEMINI_MODEL` in `api/analyze.js` (currently
  `gemini-2.5-flash`) and the Groq model name.
- **Privacy:** Google's free tier may use prompts to improve its products. The
  landing page discloses "Videos are processed by free-tier AI (Google/Groq)."
- **Quota races:** concurrent double-clicks could slip one extra grade past the
  counter; acceptable for v1.
- **Payloads:** Vercel serverless bodies cap at ~4.5MB; the browser keeps total
  payload ≈ 3.5MB (12 frames + 90s WAV).
