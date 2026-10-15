/* POST /api/analyze — grade one video.
   Body: { brief, frames:[base64 jpeg...], audioB64 (base64 wav), fileName }
   Steps: verify Supabase JWT -> check daily quota (3/day UTC) -> Groq Whisper
   transcript -> Gemini vision grading -> fallback chain -> save report -> return.
   No API key ever leaves the server. */
'use strict';

var MAX_DAILY = 3;
var GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
var GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
var GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash']; // vision grading, tried in order (Google gates 2.5 models to past users only)
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
    signal: AbortSignal.timeout(30000)
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
    '',
    'COACHING FRAMEWORKS - use these by name in your feedback:',
    'HOOK ARCHETYPES (the first 1-3 seconds decide everything):',
    '1. Pattern interrupt: something visually or verbally unexpected in second 0-1 that breaks the scroll.',
    '2. Open loop: start a question or promise a payoff, then delay the answer ("wait for the last rep").',
    '3. Bold or negative claim: "Stop doing X", "You are wasting your time if...".',
    '4. Numbered promise: "3 mistakes killing your gains".',
    '5. Direct question: say the viewer\'s exact pain out loud.',
    '6. In-medias-res: start mid-action. Zero intro, zero greeting.',
    '7. Relatable POV: "POV: you just started lifting and...".',
    'A great hook makes a specific promise to a specific viewer in under 3 seconds. A greeting ("hey guys") is not a hook.',
    'PACING: cut or change something every 1-3 seconds; no dead air over half a second; front-load the value; end in a way that loops or teases part 2.',
    'VISUALS: face or action in frame 1; 9:16 filled with no black bars; captions burned in and readable on a phone screen; light on the subject\'s face.',
    'AUDIO: voice clearly above the music; a hook sound in the first second; trending audio helps reach, original audio builds brand.',
    'CTA MODELS: direct ("follow for part 2"), value exchange ("comment PLAN and I\'ll send my split"), loop ("watch again to catch it").',
    '',
    'SCORING RUBRIC (be honest - most videos score 30-60):',
    '85+: exceptional, would stand out in a competitive feed. 60-84: solid with clear gaps. 40-59: average and forgettable. Below 40: fundamental problems.',
    'Judge each dimension against what the best creators do, not against effort.',
    '',
    'Score honestly on 0-100. Be specific and blunt. Never predict views or virality.',
    'In "fixes", name the exact framework to apply and give a concrete rewrite or example - never generic advice.',
    'In "hook_rewrites", write 3 opening lines, each using a DIFFERENT archetype from the list above.',
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
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: f } });
  });
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
    ':generateContent?key=' + process.env.GEMINI_API_KEY;
  var reqBody = JSON.stringify({
    contents: [{ parts: parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.7, maxOutputTokens: 4096 }
  });
  // Retry transient 503/429 (free-tier demand spikes) with backoff before giving up on this model.
  var waits = [4000], attempt = 0, r, errBody;
  while (true) {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: reqBody,
      signal: AbortSignal.timeout(20000)
    });
    if (r.ok) break;
    errBody = '';
    try { errBody = (await r.text()).slice(0, 300); } catch (e0) {}
    if ((r.status === 503 || r.status === 429) && attempt < waits.length) {
      console.error('gemini [' + model + '] transient ' + r.status + ', retrying in ' + waits[attempt] + 'ms');
      await sleep(waits[attempt++]);
      continue;
    }
    throw new Error('gemini ' + r.status + ' ' + errBody);
  }
  var j = await r.json();
  var text = j.candidates && j.candidates[0] && j.candidates[0].content &&
    j.candidates[0].content.parts && j.candidates[0].content.parts[0] &&
    j.candidates[0].content.parts[0].text;
  if (!text) throw new Error('gemini empty ' + JSON.stringify(j).slice(0, 300));
  return sanitizeReport(JSON.parse(text));
}

/* ---------- fallback chain: try models in order, log each failure ---------- */
async function gradeWithFallbackChain(brief, frames, transcript) {
  var lastErr = null, visionErr = null, i, report;
  for (i = 0; i < GEMINI_MODELS.length; i++) {
    try {
      return await gradeWithGemini(brief, frames, transcript, GEMINI_MODELS[i]);
    } catch (e) {
      console.error('gemini failed [' + GEMINI_MODELS[i] + ']:', e && e.message);
      lastErr = e;
      visionErr = e;
      await sleep(1200);
    }
  }
  // OpenRouter free vision models (needs OPENROUTER_API_KEY in Vercel env). Skipped if unset.
  if (process.env.OPENROUTER_API_KEY) {
    var orModels = (process.env.OPENROUTER_VISION_MODEL ||
      'dots-studio/dots-3-note-preview:free,inclusionai/ling-3.0-flash-vl:free').split(',');
    for (i = 0; i < orModels.length; i++) {
      try {
        return await gradeWithOpenRouterVision(brief, frames, transcript, orModels[i].trim());
      } catch (e3) {
        console.error('openrouter vision failed [' + orModels[i] + ']:', e3 && e3.message);
        lastErr = e3;
        visionErr = e3;
        await sleep(1200);
      }
    }
  }
  for (i = 0; i < GROQ_FALLBACK_MODELS.length; i++) {
    try {
      report = await gradeWithGroqFallback(brief, transcript, GROQ_FALLBACK_MODELS[i]);
      report.visual_analysis_unavailable = true;
      if (visionErr) report.vision_error = String(visionErr.message || visionErr).slice(0, 300);
      return report;
    } catch (e2) {
      console.error('groq fallback failed [' + GROQ_FALLBACK_MODELS[i] + ']:', e2 && e2.message);
      lastErr = e2;
      await sleep(1200);
    }
  }
  throw lastErr || new Error('all_grading_models_failed');
}

/* ---------- vision grading via OpenRouter free models (OpenAI-compatible) ---------- */
async function gradeWithOpenRouterVision(brief, frames, transcript, model) {
  var content = [{ type: 'text', text: buildPrompt(brief, transcript) }];
  frames.slice(0, 12).forEach(function (f) {
    content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + f } });
  });
  var r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY,
      'HTTP-Referer': 'https://theviewmaxxing.vercel.app',
      'X-Title': 'BennettIQ'
    },
    body: JSON.stringify({
      model: model,
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: 'You are a short-form video coach. Respond with ONLY valid JSON, no markdown.' },
        { role: 'user', content: content }
      ]
    }),
    signal: AbortSignal.timeout(25000)
  });
  if (!r.ok) {
    var errBody = '';
    try { errBody = (await r.text()).slice(0, 300); } catch (e0) {}
    throw new Error('openrouter ' + r.status + ' ' + errBody);
  }
  var j = await r.json();
  var text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text) throw new Error('openrouter empty ' + JSON.stringify(j).slice(0, 300));
  return sanitizeReport(JSON.parse(text));
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
