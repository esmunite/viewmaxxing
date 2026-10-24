/* POST /api/analyze — grade one video.
   Body: { brief, frames:[base64 jpeg...], audioB64 (base64 mp3, or wav), audioFormat, fileName }
   Steps: verify Supabase JWT -> check daily quota (3/day UTC) -> Groq Whisper
   transcript -> Gemini vision grading -> fallback chain -> save report -> return.
   No API key ever leaves the server. */
'use strict';

// Vercel's free plan allows 300s functions (raised from 60s in 2025; this file pinned 60s by config for a long time, which caused most of the timeout errors). Track elapsed time and bail to faster
// fallbacks instead of hanging until we get killed (which surfaces as a 504).
// The budget is per-request: t0 is captured in the handler and threaded through.
// A module-level clock goes stale because Vercel reuses warm containers, which made
// every guard skip every model on repeat visits (fake "timeout" on all videos).
function msLeft(t0) { return 255000 - (Date.now() - t0); } // grading-only budget; transcribe + auth + save sit outside it, total stays under the 300s cap
function canAfford(t0, ms) { return msLeft(t0) > ms + 2000; }

/* ---------- rate limiting (best-effort, per container) ----------
   The 3/day quota only counts SAVED grades, so without this a bad actor could
   burn shared AI quota on endless failed attempts. These caps count attempts.
   State is deliberately cross-request (that is what a limiter is); it lives in
   this container's memory, so it is a strong speed bump, not a global wall.
   The durable global layer is Vercel Firewall rate limiting (dashboard). */
var rlHits = new Map(); // key -> [attempt timestamps]
function rlAllow(key, limit, windowMs) {
  var now = Date.now();
  var arr = (rlHits.get(key) || []).filter(function (t) { return now - t < windowMs; });
  if (arr.length >= limit) { rlHits.set(key, arr); return false; }
  arr.push(now); rlHits.set(key, arr);
  if (rlHits.size > 5000) rlHits.clear(); // crude memory guard
  return true;
}
function clientIp(req) {
  var xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

var MAX_DAILY = 3;
var GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
var GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
var GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash']; // vision grading, tried in order; attempts after the first run in fast mode (low thinking) so a stalled flagship cannot eat the whole budget
var GROQ_FALLBACK_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b']; // transcript-only, tried in order (the old Llama models were shut down for free accounts in Aug 2026; the repeat of 20b is a deliberate last-chance retry)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!rlAllow('ip:' + clientIp(req), 30, 10 * 60 * 1000))
    return res.status(429).json({ error: 'too_many_requests' });
  try {
    var user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    if (!rlAllow('user:' + user.id, 12, 60 * 60 * 1000))
      return res.status(429).json({ error: 'too_many_requests' });

    var body = req.body || {};
    var brief = body.brief, frames = body.frames || [], audioB64 = body.audioB64;
    var audioFormat = body.audioFormat === 'mp3' ? 'mp3' : 'wav'; // older clients send no format and mean wav
    if (!brief || !brief.goal || !(brief.platforms || []).length)
      return res.status(400).json({ error: 'brief_required' });
    if (!audioB64) return res.status(400).json({ error: 'audio_required' });

    var day = new Date().toISOString().slice(0, 10); // UTC day
    var used = await getUsage(user.id, day);
    if (used >= MAX_DAILY) return res.status(429).json({ error: 'daily_limit' });

    // 1) Transcribe (Groq Whisper, free tier). If it fails or times out, grade from
    //    the frames and brief alone rather than failing the whole request.
    var transcript = '';
    try { transcript = await transcribe(audioB64, audioFormat); }
    catch (eT) { console.error('transcribe failed, grading without transcript:', eT && eT.message ? eT.message : eT); }

    // 2) Grade: Gemini models first (full vision), then Groq chat models (transcript-only)
    var t0 = Date.now();
    var report = await gradeWithFallbackChain(t0, brief, frames, transcript);

    // 3) Save + increment quota
    // Keep one mid-video frame as a thumbnail so the creator can recognize
    // this video in their history. The frames were sent for grading anyway;
    // this adds no new data collection, just retention of a single frame.
    if (frames && frames.length) report.thumbnail = frames[Math.floor(frames.length / 2)];
    await saveReport(user.id, brief, report);
    await setUsage(user.id, day, used + 1);

    return res.status(200).json({ report: report, transcript: transcript });
  } catch (e) {
    console.error('analyze failed:', e && e.message);
    return res.status(500).json({ error: 'analysis_failed' });
  }
};

module.exports.config = { maxDuration: 300 };

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
async function transcribe(audioB64, format) {
  var form = new FormData();
  var isMp3 = format === 'mp3';
  form.append('file', new Blob([Buffer.from(audioB64, 'base64')], { type: isMp3 ? 'audio/mpeg' : 'audio/wav' }), isMp3 ? 'audio.mp3' : 'audio.wav');
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
/* ---------- objective rubrics: dimensions, weights, plain-English guidance ---------- */
var OBJECTIVE_RUBRICS = {
  virality: {
    label: 'Virality', goalLine: 'get watched, shared, and rewatched',
    dimensions: [
      ['Opening attention & curiosity', 20, 'Do the first 3 seconds give a real reason to keep watching: curiosity, specificity, or an unexpected angle that makes the familiar feel new?'],
      ['Emotional resonance & relatability', 20, 'Does it make the viewer feel something real or see themselves in it?'],
      ['Retention & narrative progression', 20, 'Does every section earn the next few seconds of attention, and does the ending deliver what the opening promised?'],
      ['Shareability', 20, 'Is there a clear reason someone would send this to another person?'],
      ['Rewatchability', 5, 'Loop, reveal, or density that rewards watching twice?'],
      ['Audience & platform fit', 10, 'Right crowd, right platform conventions?'],
      ['Clarity & comprehension', 5, 'Can the intended viewer get the premise instantly?']
    ]
  },
  conversion: {
    label: 'Conversion', goalLine: 'move a relevant viewer to take a defined action',
    dimensions: [
      ['Audience & problem fit', 15, 'Are the right viewer and their real problem obvious?'],
      ['Value proposition & benefits', 15, 'Are outcomes promised clearly, not just features listed?'],
      ['Demonstration & evidence', 15, 'Is it shown working, with believable proof?'],
      ['Credibility & trust', 10, 'Are claims specific and believable rather than hype?'],
      ['Objection handling', 10, 'Are doubts, cost, or risks addressed?'],
      ['Persuasive sequence', 10, 'Does each beat make the next step feel natural?'],
      ['Call to action', 15, 'Is there one clear next step that is easy to take?'],
      ['Clarity & friction reduction', 5, 'No confusion, distractions, or competing messages?'],
      ['Platform & offer fit', 5, 'Does the offer suit the platform and format?']
    ]
  },
  growth: {
    label: 'Growth', goalLine: 'earn new followers from the right audience',
    dimensions: [
      ['Audience specificity', 10, 'Is it obvious who this is for?'],
      ['Immediate viewer value', 15, 'Does this video alone deliver something useful, funny, or moving?'],
      ['Creator differentiation', 10, 'Is there a recognizable voice, angle, or format?'],
      ['Niche relevance', 15, 'Will it attract people likely to care about future posts?'],
      ['Repeatable future value', 15, 'Does it imply more good stuff is coming?'],
      ['Personality & credibility', 10, 'Real point of view, believable creator?'],
      ['Follow motivation', 15, 'Is there a reason to follow beyond this one video?'],
      ['Clarity & platform fit', 10, 'Clean execution that fits the platform?']
    ]
  },
  engagement: {
    label: 'Engagement', goalLine: 'earn comments, saves, shares, and real interaction',
    dimensions: [
      ['Emotional resonance', 15, 'Does it make the viewer feel something worth reacting to?'],
      ['Personal relevance', 10, 'Does it connect to their life, tastes, or problems?'],
      ['Discussion potential', 15, 'Is there a real question or disagreement worth commenting on?'],
      ['Participation & prompt quality', 10, 'Is it easy and natural to join in?'],
      ['Save value', 10, 'Is there information worth revisiting later?'],
      ['Share value', 10, 'Worth sending to entertain or inform someone?'],
      ['Community identity', 10, 'Does it make a specific group feel seen?'],
      ['Authenticity', 10, 'Does the interaction feel natural, not bait?'],
      ['Clarity & platform fit', 10, 'Is the message clear and suited to the platform?']
    ]
  }
};

var PLATFORM_LENS = {
  tiktok: 'premise clear in 1 second, feels native rather than adsy, curiosity plus payoff, series potential',
  instagram: 'polished visuals, save and share value, fits a Reels feed and the creator profile',
  youtube: 'instant premise, efficient storytelling, replay value; long-form must keep the title and thumbnail promise',
  facebook: 'broadly relatable, emotional, shareable in feed, works for total strangers',
  x: 'one sharp point, watchable muted, quotable, gives a reason to repost or reply',
  snapchat: 'raw and fast, vertical-first, personality over polish',
  paidads: 'treat as conversion: clarity, proof, and CTA beat platform trends'
};

function normPlatform(p) {
  p = (p || '').toLowerCase();
  if (p.indexOf('instagram') > -1) return 'instagram';
  if (p.indexOf('youtube') > -1) return 'youtube';
  if (p.indexOf('tiktok') > -1) return 'tiktok';
  if (p.indexOf('facebook') > -1) return 'facebook';
  if (p === 'x') return 'x';
  if (p.indexOf('snapchat') > -1) return 'snapchat';
  if (p.indexOf('paid') > -1) return 'paidads';
  return 'tiktok';
}

function buildPrompt(brief, transcript, hasFrames) {
  var goal = (brief.goal || 'virality').toLowerCase();
  var rubric = OBJECTIVE_RUBRICS[goal] || OBJECTIVE_RUBRICS.virality;
  var plats = (brief.platforms || []).join(', ') || 'TikTok';
  var primaryPlat = (brief.platforms || ['TikTok'])[0];
  var platLens = PLATFORM_LENS[normPlatform(primaryPlat)];
  var dimLines = rubric.dimensions.map(function (d, i) {
    return (i + 1) + '. ' + d[0] + ' (weight ' + d[1] + '%) - ' + d[2];
  }).join('\n');
  var lines = [
    'You are an AI video performance strategist. Judge this video ONLY on how well its observable creative choices serve the creator\'s stated goal. Be rigorous, evidence-based, and blunt. Never predict views, virality, sales, or follower counts.',
    '',
    'CREATOR BRIEF',
    '- Goal: ' + rubric.label + ' (' + rubric.goalLine + ')',
    '- Platform(s): ' + plats,
    brief.viewer ? '- Intended viewer: ' + brief.viewer : '',
    brief.niche ? '- Niche: ' + brief.niche : '',
    brief.offer ? '- Product/offer: ' + brief.offer : '',
    brief.results ? '- Creator-reported results (shared by the creator, not independently verified): ' + brief.results : '',
    '',
    'TRANSCRIPT',
    transcript || '(no speech detected)',
    '',
    'FRAMES',
    hasFrames
      ? '12 video frames are attached in order. Use them for all visual judgments.'
      : 'No frames were provided. Grade from the transcript and brief only, and say so clearly in limitations and the visuals-related dimension. Never claim you saw visuals.',
    '',
    'HOW TO THINK (lenses, not laws)',
    '- Hook: do the first 1-3 seconds earn attention through clarity, curiosity, or specificity? Loudness is not a hook.',
    '- Retention: does each section earn the next few seconds? Call out dead air, repetition, and slow payoffs with timestamps.',
    '- Platform (' + primaryPlat + '): ' + platLens + '.',
    '- Psychology: only name principles you can tie to something observable - curiosity gap, cognitive fluency, emotional relevance, narrative transportation, payoff vs expectation, social identity, credibility, friction. Never claim brain chemistry was measured.',
    '- Never invent timestamps, quotes, or visual details. If evidence is missing, say so and score provisionally rather than guessing.',
    '- One strong feature never hides a critical failure: flag bottlenecks (unclear offer, misleading opening, missing payoff, absent CTA) separately.',
    '- Effectiveness beats polish: judge every production choice by whether it helps or obstructs the goal for this audience. Authentic, spontaneous, imperfect, or trend-based content can be the strategy itself, not a flaw.',
    '- Familiar formats and trends are legitimate creative choices. Judge the execution and the fit, never the mere fact that a format is common.',
    '',
    'VOICE',
    'Write like a smart college friend explaining it plainly. Short sentences. Zero jargon, zero marketing-speak. Never use em-dashes; use commas, periods, or colons instead. Be specific every time - never say "make it more engaging" without saying exactly how.',
    '',
    'SCORING - use these dimensions, in order. Score each 0-10 with these anchors: 9-10 = as strong as the best content in this feed for this goal; 7-8 = clearly working, minor gaps; 5-6 = functional but ordinary, leaks attention or impact; 3-4 = actively working against the goal; 0-2 = broken or missing. A genuinely strong video earns 7s and 8s; do not cluster scores at 5 out of caution. If the evidence says a dimension works, the number must say so too.',
    dimLines,
    'The dimensions array in your JSON MUST contain exactly ' + rubric.dimensions.length + ' entries, one per dimension above, in the same order. Never stop after the first few. Also fill every other section of the JSON; an empty or shortened report is a failed response.',
    '',
    'overall_score = round(SUM(weight x score / 10)). It must be consistent with your dimension scores.',
    'Bands: 90-100 exceptional, among the best in a competitive feed for this goal. 80-89 strong, minor polish left. 70-79 promising, meaningful gaps to fix. 60-69 mixed, several fixes would help a lot. 40-59 weak for this goal, substantial rework needed. 0-39 fundamentally misaligned, rethink the concept.',
    'If the goal is conversion but the video has no identifiable offer or action, say the goal is underspecified instead of failing it.',
    '',
    'CALIBRATION - read before scoring:',
    '- Judge effectiveness for THIS goal and THIS audience, not resemblance to polished marketing. Basic editing, minimal effects, plain lighting, casual delivery, and unconventional pacing are not weaknesses by themselves; a production flaw only counts when it actually obstructs the goal (speech you cannot understand, text you cannot read, genuine confusion).',
    '- Weigh every weakness by magnitude and relevance to the goal. A minor issue costs a little, never a lot. Do not deduct for each missing best practice: content can succeed through relatability, humor, timing, emotion, provocation, identity, or a familiar format executed well, and the scores must credit what is working, not only what is missing.',
    '- Think strengths first: identify what is effective and why it may work on this audience before listing improvements, and keep the fixes to the 2-3 that matter most. Speculation is not evidence; never score down for a weakness you cannot tie to something observable in the frames or transcript.',
    brief.results ? '- This video has creator-reported results (see brief). Treat demonstrated performance as real evidence that its choices worked for its audience: explain what likely drove the result, do not penalize unconventional choices that demonstrably worked, and still give honest improvements. Never present the creator numbers as verified by you, and never guarantee future results.' : '',
    '- Any psychology you cite is a plausible mechanism, not a measured outcome. Where a judgment is uncertain, say so in limitations instead of scoring as if it were certain.',
    '',
    'FORMAT COMPARISON',
    'Identify this video\'s format in a few words (e.g. "30-second recipe tutorial", "talking-head finance tip", "product demo"). Then give exactly 2 comparisons against the proven patterns top videos in this exact format use. Patterns only: never name specific videos, creators, view counts, or statistics, and never present a pattern as a real video you watched. For each comparison: pattern = the proven pattern; this_video = what this video does instead, with a timestamp or quote; gap = what the difference costs this goal, naming the dimension it hits.',
    '',
    'CONCISENESS',
    '1-2 sentences per text field. Whole response under ~2500 words. Specific beats long. Psychology: at most 4 entries. Retention map: at most 8 entries.',
    '',
    'Respond with ONLY this JSON (no markdown, no extra text):',
    '{',
    ' "overall_score": <0-100>,',
    ' "score_band": "<short band label, e.g. \'Promising execution with meaningful areas to refine\'>",',
    ' "video_summary": "<2-3 sentences: what the video is, who it is for, what it wants>",',
    ' "objective_statement": "<1-2 sentences: what success looks like for this goal on this platform>",',
    ' "dimensions": [',
    '   {"name": "<exact dimension name from the list>", "score": <0-10>, "weight": <percent>, "evidence": "<timestamp, quote, or observed detail>", "pro": "<what is working>", "con": "<what is hurting>", "improvement": "<one concrete fix>"}',
    ' ],',
    ' "hook": {"verdict": "<1-2 sentences on the opening>", "strongest": "<best opening moment>", "weakest": "<biggest opening weakness>", "alternative": "<one rewritten opening line that keeps the idea>"},',
    ' "retention_map": [{"t": "0:03", "note": "<what happens here and whether it earns continued watching>"}],',
    ' "psychology": [{"principle": "<name>", "helping": true, "explanation": "<tie it to an observable choice>"}],',
    ' "top_improvements": [{"change": "<what to change>", "where": "<where in the video>", "why": "<why it matters for the goal>", "example": "<concrete example>"}],',
    ' "format_comparison": {"format": "<the video\'s format in a few words>", "comparisons": [{"pattern": "<what top videos in this format do>", "this_video": "<what this video does instead, with timestamp>", "gap": "<what the difference costs, tied to a dimension>"}]},',
    ' "alt_version": "<one meaningfully different creative approach that keeps the core idea>",',
    ' "limitations": "<what you could not observe and how it limits confidence>",',
    ' "verdict": {"strengths": "<what it does well>", "weakness": "<most important weakness>", "priority": "<single highest-priority change>"}',
    '}'
  ];
  return lines.filter(Boolean).join('\n');
}

async function gradeWithGemini(t0, brief, frames, transcript, model, fast) {
  var parts = [{ text: buildPrompt(brief, transcript, true) }];
  frames.slice(0, 12).forEach(function (f) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: f } });
  });
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
    ':generateContent?key=' + process.env.GEMINI_API_KEY;
  var genCfg = { responseMimeType: 'application/json', temperature: 0.7, maxOutputTokens: 6000 };
  if (fast) genCfg.thinkingConfig = { thinkingLevel: 'low' }; // fallback attempts trade depth for speed; assertComplete still enforces a full report
  var reqBody = JSON.stringify({ contents: [{ parts: parts }], generationConfig: genCfg });
  // One attempt per model; timeout is sized to the time actually left, reserving
  // ~45s so the transcript-only fallback always gets its own window afterwards.
  var gemTimeout = Math.max(15000, Math.min(fast ? 60000 : 90000, msLeft(t0) - 45000));
  var r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: reqBody,
    signal: AbortSignal.timeout(gemTimeout)
  });
  if (!r.ok) {
    var errBody = '';
    try { errBody = (await r.text()).slice(0, 300); } catch (e0) {}
    throw new Error('gemini ' + r.status + ' ' + errBody);
  }
  var j = await r.json();
  var text = j.candidates && j.candidates[0] && j.candidates[0].content &&
    j.candidates[0].content.parts && j.candidates[0].content.parts[0] &&
    j.candidates[0].content.parts[0].text;
  if (!text) throw new Error('gemini empty ' + JSON.stringify(j).slice(0, 300));
  return assertComplete(sanitizeReport(JSON.parse(text), brief && brief.goal), brief);
}

/* ---------- fallback chain: try models in order, log each failure ---------- */
async function gradeWithFallbackChain(t0, brief, frames, transcript) {
  var lastErr = null, visionErrs = [], i, report;
  for (i = 0; i < GEMINI_MODELS.length; i++) {
    if (i === 0 ? msLeft(t0) < 30000 : !canAfford(t0, 60000)) { console.error('skipping gemini [' + GEMINI_MODELS[i] + ']: budget low'); break; }
    try {
      return await gradeWithGemini(t0, brief, frames, transcript, GEMINI_MODELS[i], i > 0);
    } catch (e) {
      console.error('gemini failed [' + GEMINI_MODELS[i] + ']:', e && e.message);
      lastErr = e;
      visionErrs.push(GEMINI_MODELS[i] + ': ' + String((e && e.message) || e).slice(0, 90));
      await sleep(700);
    }
  }
  // OpenRouter free vision models (needs OPENROUTER_API_KEY in Vercel env). Skipped if unset.
  if (process.env.OPENROUTER_API_KEY) {
    var orModels = (process.env.OPENROUTER_VISION_MODEL ||
      'nvidia/nemotron-3.5-super-vl:free,thinkingmachines/inkling:free,dots-studio/dots-3-note-preview:free').split(',');
    for (i = 0; i < orModels.length; i++) {
      if (i === 0 ? msLeft(t0) < 30000 : !canAfford(t0, 60000)) { console.error('skipping openrouter [' + orModels[i] + ']: budget low'); break; }
      try {
        return await gradeWithOpenRouterVision(t0, brief, frames, transcript, orModels[i].trim());
      } catch (e3) {
        console.error('openrouter vision failed [' + orModels[i] + ']:', e3 && e3.message);
        lastErr = e3;
        visionErrs.push(orModels[i].trim() + ': ' + String((e3 && e3.message) || e3).slice(0, 90));
        await sleep(700);
      }
    }
  }
  for (i = 0; i < GROQ_FALLBACK_MODELS.length; i++) {
    if (msLeft(t0) < 20000) { console.error('skipping groq [' + GROQ_FALLBACK_MODELS[i] + ']: budget low'); break; } // transcript-only fallback is fast (~5-12s typical)
    try {
      report = await gradeWithGroqFallback(t0, brief, transcript, GROQ_FALLBACK_MODELS[i]);
      report.visual_analysis_unavailable = true;
      if (visionErrs.length) report.vision_error = visionErrs.join(' \u00b7 ').slice(0, 300);
      return report;
    } catch (e2) {
      console.error('groq fallback failed [' + GROQ_FALLBACK_MODELS[i] + ']:', e2 && e2.message);
      lastErr = e2;
      await sleep(700);
    }
  }
  if (msLeft(t0) > 10000) {
    try {
      console.error('salvage attempt: final groq try with remaining budget');
      var salvaged = await gradeWithGroqFallback(t0, brief, transcript, GROQ_FALLBACK_MODELS[0]);
      salvaged.visual_analysis_unavailable = true;
      if (visionErrs.length) salvaged.vision_error = visionErrs.join(' \u00b7 ').slice(0, 300);
      return salvaged;
    } catch (eS) { lastErr = eS; }
  }
  throw lastErr || new Error('all_grading_models_failed');
}

/* ---------- vision grading via OpenRouter free models (OpenAI-compatible) ---------- */
async function gradeWithOpenRouterVision(t0, brief, frames, transcript, model) {
  var content = [{ type: 'text', text: buildPrompt(brief, transcript, true) }];
  frames.slice(0, 12).forEach(function (f) {
    content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + f } });
  });
  var r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY,
      'HTTP-Referer': 'https://bennettiq.vercel.app',
      'X-Title': 'BennettIQ'
    },
    body: JSON.stringify({
      model: model,
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_tokens: 6000,
      messages: [
        { role: 'system', content: 'You are a short-form video coach. Respond with ONLY valid JSON, no markdown.' },
        { role: 'user', content: content }
      ]
    }),
    signal: AbortSignal.timeout(Math.max(15000, Math.min(90000, msLeft(t0) - 45000)))
  });
  if (!r.ok) {
    var errBody = '';
    try { errBody = (await r.text()).slice(0, 300); } catch (e0) {}
    throw new Error('openrouter ' + r.status + ' ' + errBody);
  }
  var j = await r.json();
  var text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text) throw new Error('openrouter empty ' + JSON.stringify(j).slice(0, 300));
  return assertComplete(sanitizeReport(JSON.parse(text), brief && brief.goal), brief);
}

/* ---------- fallback: Groq chat, transcript + brief only ---------- */
async function gradeWithGroqFallback(t0, brief, transcript, model) {
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
      max_tokens: 6000,
      messages: [
        { role: 'system', content: 'You are a short-form video coach. Respond with ONLY valid JSON, no markdown.' },
        { role: 'user', content: buildPrompt(brief, transcript, false) }
      ]
    }),
    signal: AbortSignal.timeout(Math.max(10000, Math.min(60000, msLeft(t0) - 15000)))
  });
  if (!r.ok) throw new Error('groq ' + r.status);
  var j = await r.json();
  var text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text) throw new Error('groq empty');
  return assertComplete(sanitizeReport(JSON.parse(text), brief && brief.goal), brief);
}

/* A report missing rubric dimensions is a failed attempt, not a grade: the chain
   moves on to the next model instead of showing the user a partial breakdown. */
function assertComplete(report, brief) {
  var rubric = OBJECTIVE_RUBRICS[((brief && brief.goal) || 'virality').toLowerCase()] || OBJECTIVE_RUBRICS.virality;
  var need = rubric.dimensions.length;
  var got = report.dimensions ? report.dimensions.length : 0;
  if (got < need) throw new Error('incomplete report: ' + got + ' of ' + need + ' dimensions');
  return report;
}

/* ---------- helpers ---------- */
function clamp(n) { n = Math.round(Number(n)); return isNaN(n) ? 50 : Math.max(0, Math.min(100, n)); }
function clamp10(n) { n = Math.round(Number(n)); return isNaN(n) ? 5 : Math.max(0, Math.min(10, n)); }
function str(x, cap) { x = (x == null ? '' : String(x)); return cap ? x.slice(0, cap) : x; }

var SCORE_BANDS = [
  [90, 'Exceptional, among the best in a competitive feed for this goal'],
  [80, 'Strong, minor polish left'],
  [70, 'Promising, meaningful gaps to fix'],
  [60, 'Mixed, several fixes would help a lot'],
  [40, 'Weak for this goal, substantial rework needed'],
  [0, 'Fundamentally misaligned, rethink the concept']
];
function bandFor(score) {
  for (var i = 0; i < SCORE_BANDS.length; i++) if (score >= SCORE_BANDS[i][0]) return SCORE_BANDS[i][1];
  return SCORE_BANDS[SCORE_BANDS.length - 1][1];
}

function sanitizeReport(r, goal) {
  r = r || {};
  var dims = Array.isArray(r.dimensions) ? r.dimensions.slice(0, 10).map(function (d) {
    d = d || {};
    return {
      name: str(d.name, 80),
      score: clamp10(d.score),
      weight: Math.max(0, parseInt(d.weight, 10) || 0),
      evidence: str(d.evidence, 500),
      pro: str(d.pro, 500),
      con: str(d.con, 500),
      improvement: str(d.improvement, 500)
    };
  }) : [];
  var hook = r.hook || {};
  var verdict = r.verdict || {};
  // Scoring integrity: when the dimensions line up with the goal's rubric,
  // recompute the overall score from the canonical weights and derive the
  // band from it, so the headline numbers can never contradict the breakdown.
  var overall = clamp(r.overall_score);
  var band = str(r.score_band, 120);
  var rubric = OBJECTIVE_RUBRICS[String(goal || '').toLowerCase()];
  if (rubric && dims.length === rubric.dimensions.length) {
    var wtotal = 0;
    dims.forEach(function (d, i) {
      d.name = rubric.dimensions[i][0];
      d.weight = rubric.dimensions[i][1];
      wtotal += d.weight * d.score / 10;
    });
    overall = Math.round(wtotal);
    band = bandFor(overall);
  }
  return {
    overall_score: overall,
    score_band: band,
    video_summary: str(r.video_summary, 600),
    objective_statement: str(r.objective_statement, 400),
    dimensions: dims,
    hook: {
      verdict: str(hook.verdict, 500),
      strongest: str(hook.strongest, 500),
      weakest: str(hook.weakest, 500),
      alternative: str(hook.alternative, 500)
    },
    retention_map: Array.isArray(r.retention_map) ? r.retention_map.slice(0, 12).map(function (m) {
      m = m || {}; return { t: str(m.t, 12), note: str(m.note, 400) };
    }) : [],
    psychology: Array.isArray(r.psychology) ? r.psychology.slice(0, 6).map(function (p) {
      p = p || {}; return { principle: str(p.principle, 80), helping: !!p.helping, explanation: str(p.explanation, 400) };
    }) : [],
    top_improvements: Array.isArray(r.top_improvements) ? r.top_improvements.slice(0, 3).map(function (t) {
      t = t || {}; return { change: str(t.change, 400), where: str(t.where, 200), why: str(t.why, 400), example: str(t.example, 400) };
    }) : [],
    format_comparison: (function () {
      var fc = r.format_comparison || {};
      return {
        format: str(fc.format, 120),
        comparisons: Array.isArray(fc.comparisons) ? fc.comparisons.slice(0, 3).map(function (c) {
          c = c || {}; return { pattern: str(c.pattern, 400), this_video: str(c.this_video, 400), gap: str(c.gap, 400) };
        }) : []
      };
    })(),
    alt_version: str(r.alt_version, 800),
    limitations: str(r.limitations, 600),
    verdict: {
      strengths: str(verdict.strengths, 600),
      weakness: str(verdict.weakness, 600),
      priority: str(verdict.priority, 600)
    }
  };
}
function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
