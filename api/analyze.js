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
    signal: AbortSignal.timeout(25000)
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
      ['Opening attention & curiosity', 15, 'Do the first 3 seconds give a real reason to keep watching?'],
      ['Emotional resonance & relatability', 15, 'Does it make the viewer feel something real or see themselves in it?'],
      ['Retention & narrative progression', 15, 'Does every section earn the next few seconds of attention?'],
      ['Novelty & distinctiveness', 10, 'Is there an unexpected angle, demo, or combination vs the usual feed?'],
      ['Shareability', 15, 'Is there a clear reason someone would send this to another person?'],
      ['Payoff & satisfaction', 10, 'Does the ending deliver what the opening promised?'],
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
    '',
    'VOICE',
    'Write like a smart college friend explaining it plainly. Short sentences. Zero jargon, zero marketing-speak. Never use em-dashes; use commas, periods, or colons instead. Be specific every time - never say "make it more engaging" without saying exactly how.',
    '',
    'SCORING - use these dimensions, in order. Score each 0-10 against what the best creators do, not effort. Most real videos land at 3-7 per dimension.',
    dimLines,
    '',
    'overall_score = round(SUM(weight x score / 10)). It must be consistent with your dimension scores.',
    'Bands: 90-100 exceptional, among the best in a competitive feed for this goal. 80-89 strong, minor polish left. 70-79 promising, meaningful gaps to fix. 60-69 mixed, several fixes would help a lot. 40-59 weak for this goal, substantial rework needed. 0-39 fundamentally misaligned, rethink the concept.',
    'If the goal is conversion but the video has no identifiable offer or action, say the goal is underspecified instead of failing it.',
    '',
    'FORMAT COMPARISON',
    'Identify this video\'s format in a few words (e.g. "30-second recipe tutorial", "talking-head finance tip", "product demo"). Then give 2-3 comparisons against the proven patterns top videos in this exact format use. Patterns only: never name specific videos, creators, view counts, or statistics, and never present a pattern as a real video you watched. For each comparison: pattern = the proven pattern; this_video = what this video does instead, with a timestamp or quote; gap = what the difference costs this goal, naming the dimension it hits.',
    '',
    'CONCISENESS',
    '1-2 sentences per text field. Whole response under ~2500 words. Specific beats long.',
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

async function gradeWithGemini(brief, frames, transcript, model) {
  var parts = [{ text: buildPrompt(brief, transcript, true) }];
  frames.slice(0, 12).forEach(function (f) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: f } });
  });
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
    ':generateContent?key=' + process.env.GEMINI_API_KEY;
  var reqBody = JSON.stringify({
    contents: [{ parts: parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.7, maxOutputTokens: 6000 }
  });
  // Retry transient 503/429 (free-tier demand spikes) with backoff before giving up on this model.
  var waits = [4000], attempt = 0, r, errBody;
  while (true) {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: reqBody,
      signal: AbortSignal.timeout(35000)
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
      'nvidia/nemotron-3.5-super-vl:free,thinkingmachines/inkling:free,dots-studio/dots-3-note-preview:free').split(',');
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
    signal: AbortSignal.timeout(35000)
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
      max_tokens: 6000,
      messages: [
        { role: 'system', content: 'You are a short-form video coach. Respond with ONLY valid JSON, no markdown.' },
        { role: 'user', content: buildPrompt(brief, transcript, false) }
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
function clamp10(n) { n = Math.round(Number(n)); return isNaN(n) ? 5 : Math.max(0, Math.min(10, n)); }
function str(x, cap) { x = (x == null ? '' : String(x)); return cap ? x.slice(0, cap) : x; }

function sanitizeReport(r) {
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
  return {
    overall_score: clamp(r.overall_score),
    score_band: str(r.score_band, 120),
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
