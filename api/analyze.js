/* POST /api/analyze â€” grade one video.
   Body: { brief, frames:[base64 jpeg...], audioB64 (base64 wav), fileName }
   Steps: verify Supabase JWT -> check daily quota (3/day UTC) -> Groq Whisper
   transcript -> Gemini vision grading -> fallback chain -> save report -> return.
   No API key ever leaves the server. */
'use strict';

var MAX_DAILY = 3;
var GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
var GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
var GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']; // vision grading, tried in order
var GROQ_FALLBACK_MODELS = ['openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile']; // transcript-only, tried in order

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    var user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    var body = req.body || {};
    var brief = body.brief, frames = body.frames || [], audioB64 = body.audioB64;
    if (!brief || !brief.goal || !(brief.platforms || []).length)
      return res.status(400).json({ error: 'brief_required' });
    if (!audioB64) return res.status(400).json({ error: 'audio_required' });

    var day = new Date().toISOString().slice(0, 10); // UTC day
    var used = await getUsage(user.id, day);
    if (used >= MAX_DAILY) return res.status(429).json({ error: 'daily_limit' });

    // 1) Transcribe (Groq Whisper, free tier)
    var transcript = await transcribe(audioB64);

    // 2) Grade: Gemini models first (full vision), then Groq chat models (transcript-only)
    var report = await gradeWithFallbackChain(brief, frames, transcript);

    // 3) Save + increment quota
    await saveReport(user.id, brief, report);
    await setUsage(user.id, day, used + 1);

    return res.status(200).json({ report: report, transcript: transcript });
  } catch (e) {
    console.error('analyze failed:', e && e.message);
    return res.status(500).json({ error: 'analysis_failed' });
  }
};

module.exports.config = { maxDuration: 60 };

/* ---------- auth ---------- */
async function getUser(req) {
  var h = req.headers.authorization || '';
  var token = h.indexOf('Bearer ') === 0 ? h.slice(7) : null;
  if (!token) return null;
  var r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) return null;
  var j = await r.json();
  return j && j.id ? j : null;
}

/* ---------- quota + storage (Supabase REST, service role) ---------- */
function sbHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  };
}
async function getUsage(userId, day) {
  var r = await fetch(
    process.env.SUPABASE_URL + '/rest/v1/usage?user_id=eq.' + encodeURIComponent(userId) +
    '&day=eq.' + day + '&select=count',
    { headers: sbHeaders(), signal: AbortSignal.timeout(10000) }
  );
  if (!r.ok) return 0;
  var rows = await r.json();
  return rows.length ? rows[0].count : 0;
}
async function setUsage(userId, day, count) {
  // upsert on (user_id, day)
  await fetch(process.env.SUPABASE_URL + '/rest/v1/usage?on_conflict=user_id,day', {
    method: 'POST',
    headers: Object.assign(sbHeaders(), { Prefer: 'resolution=merge-duplicates' }),
    body: JSON.stringify({ user_id: userId, day: day, count: count }),
    signal: AbortSignal.timeout(10000)
  });
}
async function saveReport(userId, brief, report) {
  await fetch(process.env.SUPABASE_URL + '/rest/v1/reports', {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({ user_id: userId, brief: brief, report: report }),
    signal: AbortSignal.timeout(10000)
  });
}

/* ---------- transcription: Groq Whisper (free tier) ---------- */
async function transcribe(audioB64) {
  var form = new FormData();
  form.append('file', new Blob([Buffer.from(audioB64, 'base64')], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  var r = await fetch(GROQ_WHISPER_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
    body: form,
    signal: AbortSignal.timeout(45000)
  });
  if (!r.ok) throw new Error('whisper ' + r.status);
  var j = await r.json();
  return j.text || '';
}

/* ---------- grading: Gemini (free tier) ---------- */
function buildPrompt(brief, transcript) {
  var goalHints = {
    virality: 'maximize reach and shares',
    conversion: 'drive sales and leads',
    growth: 'gain followers',
    engagement: 'earn comments and saves'
  };
  return [
    'You are a short-form video coach. Grade the attached video frames and transcript.',
    'CREATOR BRIEF (context the video cannot show):',
    '- Primary goal: ' + brief.goal + ' (' + (goalHints[brief.goal] || '') + ')',
    '- Platforms: ' + (brief.platforms || []).join(', '),
    brief.viewer ? '- Intended viewer: ' + brief.viewer : '',
    brief.niche ? '- Niche: ' + brief.niche : '',
    brief.offer ? '- Product/offer: ' + brief.offer : '',
    'TRANSCRIPT:', transcript || '(no speech detected)',
    'Score honestly on 0-100. Be specific and blunt. Never predict views or virality.',
    'Respond with ONLY this JSON (no markdown, no extra text):',
    '{',
    ' "creative_quality": <0-100: hook strength, editing, storytelling, presentation>,',
    ' "goal_alignment": <0-100: how well the video serves the stated goal, platforms and viewer>,',
    ' "dimensions": {',
    '   "hook": "<2 sentences on the first 1-3 seconds>",',
    '   "visuals": "<framing, lighting, visual variety>",',
    '   "pacing": "<cuts, dead air, momentum>",',
    '   "audio": "<clarity, music/sfx, levels>",',
    '   "platform_fit": "<fit for the chosen platforms>",',
    '   "on_screen_text": "<captions readability and placement>"',
    ' },',
    ' "fixes": ["<most important fix>", "<2nd>", "<3rd>"],',
    ' "strengths": ["<what is working>"],',
    ' "timeline_notes": [{"time": "0:03", "note": "<timestamped observation>"}],',
    ' "hook_rewrites": ["<3 alternative opening lines>"]',
    '}'
  ].filter(Boolean).join('\n');
}

async function gradeWithGemini(brief, frames, transcript, model) {
  var parts = [{ text: buildPrompt(brief, transcript) }];
  frames.slice(0, 12).forEach(function (f) {
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: f } });
  });
  var r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model +
    ':generateContent?key=' + process.env.GEMINI_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.7, maxOutputTokens: 4096 }
      }),
      signal: AbortSignal.timeout(50000)
    }
  );
  if (!r.ok) throw new Error('gemini ' + r.status);
  var j = await r.json();
  var text = j.candidates && j.candidates[0] && j.candidates[0].content &&
    j.candidates[0].content.parts && j.candidates[0].content.parts[0] &&
    j.candidates[0].content.parts[0].text;
  if (!text) throw new Error('gemini empty');
  return sanitizeReport(JSON.parse(text));
}

/* ---------- fallback chain: try models in order, log each failure ---------- */
async function gradeWithFallbackChain(brief, frames, transcript) {
  var lastErr = null, i, report;
  for (i = 0; i < GEMINI_MODELS.length; i++) {
    try {
      return await gradeWithGemini(brief, frames, transcript, GEMINI_MODELS[i]);
    } catch (e) {
      console.error('gemini failed [' + GEMINI_MODELS[i] + ']:', e && e.message);
      lastErr = e;
      await sleep(1200);
    }
  }
  for (i = 0; i < GROQ_FALLBACK_MODELS.length; i++) {
    try {
      report = await gradeWithGroqFallback(brief, transcript, GROQ_FALLBACK_MODELS[i]);
      report.visual_analysis_unavailable = true;
      return report;
    } catch (e2) {
      console.error('groq fallback failed [' + GROQ_FALLBACK_MODELS[i] + ']:', e2 && e2.message);
      lastErr = e2;
      await sleep(1200);
    }
  }
  throw lastErr || new Error('all_grading_models_failed');
}

/* ---------- fallback: Groq chat, transcript + brief only ---------- */
async function gradeWithGroqFallback(brief, transcript, model) {
  var r = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.GROQ_API_KEY
    },
    body: JSON.stringify({
      model: model,
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_tokens: 3000,
      messages: [
        { role: 'system', content: 'You are a short-form video coach. Respond with ONLY valid JSON, no markdown.' },
        { role: 'user', content: buildPrompt(brief, transcript) + '\nNOTE: no video frames were available; grade from the transcript and brief only, and say so in the visuals dimension.' }
      ]
    }),
    signal: AbortSignal.timeout(50000)
  });
  if (!r.ok) throw new Error('groq ' + r.status);
  var j = await r.json();
  var text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text) throw new Error('groq empty');
  return sanitizeReport(JSON.parse(text));
}

/* ---------- helpers ---------- */
function clamp(n) { n = Math.round(Number(n)); return isNaN(n) ? 50 : Math.max(0, Math.min(100, n)); }
function sanitizeReport(r) {
  r = r || {};
  return {
    creative_quality: clamp(r.creative_quality),
    goal_alignment: clamp(r.goal_alignment),
    dimensions: r.dimensions || {},
    fixes: Array.isArray(r.fixes) ? r.fixes.slice(0, 5) : [],
    strengths: Array.isArray(r.strengths) ? r.strengths.slice(0, 5) : [],
    timeline_notes: Array.isArray(r.timeline_notes) ? r.timeline_notes.slice(0, 10) : [],
    hook_rewrites: Array.isArray(r.hook_rewrites) ? r.hook_rewrites.slice(0, 5) : []
  };
}
function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
