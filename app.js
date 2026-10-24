/* Content Rater frontend: no build step, plain JS */
(function () {
  'use strict';

  var sb = null;            // supabase client
  var session = null;
  var brief = null;         // { goal, platforms[], viewer, niche, offer }
  var prepared = null;      // { frames:[b64...], audioB64, audioFormat, fileName, duration }
  var lastReport = null;    // last rendered report (for download)
  var lastBrief = null;
  var reportFrames = null;  // { frames:[b64...], duration } for the filmstrip (fresh grades only)

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- boot ---------------- */
  async function boot() {
    var cfgRes = await fetch('/api/config');
    if (!cfgRes.ok) { document.body.innerHTML = '<p style="padding:40px">Server not configured yet. See DEPLOY.md</p>'; return; }
    var cfg = await cfgRes.json();
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

    var sess = await sb.auth.getSession();
    session = sess.data.session || null;
    sb.auth.onAuthStateChange(function (_ev, s) {
      var wasIn = !!session;
      session = s || null;
      if (!!session !== wasIn) render();  // sign in/out: full reset
      else if (session) refreshQuota();   // token refresh (e.g. tab regains focus): keep current step
    });
    render();
    initReveals();
  }

  function authHeader() {
    return session ? { 'Authorization': 'Bearer ' + session.access_token } : {};
  }

  /* ---------------- views ---------------- */
  function show(id) {
    ['view-landing', 'view-app'].forEach(function (v) { $(v).classList.toggle('hidden', v !== id); });
  }
  function showPane(id) {
    closeFrameViewer();
    ['pane-brief', 'pane-upload', 'pane-report', 'pane-history'].forEach(function (p) {
      $(p).classList.toggle('hidden', p !== id);
    });
    var step = { 'pane-brief': 1, 'pane-upload': 2, 'pane-report': 3, 'pane-history': 0 }[id];
    [1, 2, 3].forEach(function (n) { $('step-' + n).classList.toggle('active', n === step); });
    window.scrollTo(0, 0);
  }

  function render() {
    document.body.classList.toggle('app-light', !!session);
    if (!session) { show('view-landing'); return; }
    show('view-app');
    showPane('pane-brief');
    refreshQuota();
  }

  /* ---------------- auth modal (login / signup) ---------------- */
  var authMode = 'login';

  function openAuth(mode) {
    setAuthTab(mode === 'signup' ? 'signup' : 'login');
    $('auth-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    setTimeout(function () { var f = $('auth-email'); if (f) f.focus(); }, 60);
  }
  function closeAuth() {
    if (!$('auth-modal')) return;
    $('auth-modal').classList.add('hidden');
    document.body.style.overflow = '';
  }
  function setAuthTab(mode) {
    authMode = mode;
    document.querySelectorAll('.auth-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === mode);
    });
    $('btn-email-submit').textContent = mode === 'signup' ? 'Create account' : 'Log in';
    $('auth-note').textContent = mode === 'signup' ? '3 video grades a day \u2013 no credit card required.' : 'Welcome back.';
    $('auth-error').classList.add('hidden');
    $('auth-success').classList.add('hidden');
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAuth();
  });

  document.addEventListener('submit', function (e) {
    if (e.target.id !== 'email-auth-form') return;
    e.preventDefault();
    (async function () {
      var email = $('auth-email').value.trim();
      var pw = $('auth-password').value;
      var err = $('auth-error'), ok = $('auth-success');
      err.classList.add('hidden'); ok.classList.add('hidden');
      if (!email || pw.length < 6) {
        err.textContent = 'Enter your email and a password (6+ characters).';
        err.classList.remove('hidden');
        return;
      }
      $('btn-email-submit').disabled = true;
      try {
        if (authMode === 'signup') {
          var r = await sb.auth.signUp({ email: email, password: pw });
          if (r.error) throw r.error;
          if (r.data && r.data.session) {
            closeAuth(); // confirm-email off: straight in, the auth listener renders the app
          } else {
            ok.textContent = 'Account created. Check your email for a confirmation link, then log in.';
            ok.classList.remove('hidden');
          }
        } else {
          var r2 = await sb.auth.signInWithPassword({ email: email, password: pw });
          if (r2.error) throw r2.error;
          closeAuth();
        }
      } catch (e2) {
        err.textContent = e2.message || 'Something went wrong.';
        err.classList.remove('hidden');
      }
      $('btn-email-submit').disabled = false;
    })();
  });

  /* ---------------- score demo card loop (landing) ---------------- */
  (function () {
    var card = document.getElementById('score-demo');
    if (card) {
      var nums = card.querySelectorAll('.score-num');
      var bars = card.querySelectorAll('.score-demo-bar i');
      var line = card.querySelector('.score-demo-line');
      function playDemo() {
        nums.forEach(function (n) { n.textContent = '0'; });
        bars.forEach(function (b) { b.style.width = '0'; });
        card.classList.remove('is-live');
        void card.offsetWidth;
        requestAnimationFrame(function () {
          bars.forEach(function (b) { b.style.width = b.getAttribute('data-w') + '%'; });
          nums.forEach(function (n) {
            var target = parseInt(n.getAttribute('data-target'), 10), t0 = null;
            function tick(t) {
              if (!t0) t0 = t;
              var p = Math.min((t - t0) / 1500, 1);
              n.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
              if (p < 1) requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
          });
          setTimeout(function () { card.classList.add('is-live'); }, 80);
        });
      }
      playDemo();
      setInterval(playDemo, 7500);
    }
    /* stat count-up */
    var sc = document.getElementById('stat-count');
    if (sc) {
      var t0 = null;
      function tick(t) {
        if (!t0) t0 = t;
        var p = Math.min((t - t0) / 1100, 1);
        sc.textContent = Math.round(3 * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(tick);
      }
      setTimeout(function () { requestAnimationFrame(tick); }, 500);
    }
  })();

  /* ---------------- auth buttons ---------------- */
  document.addEventListener('click', function (e) {
    if (e.target.closest('#btn-google-modal')) {
      sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
    }
    var opener = e.target.closest('[data-auth-open]');
    if (opener) openAuth(opener.getAttribute('data-auth-open'));
    if (e.target.closest('#auth-close') || e.target.id === 'auth-modal') closeAuth();
    var tab = e.target.closest('.auth-tab');
    if (tab) setAuthTab(tab.getAttribute('data-tab'));
    if (e.target.closest('#btn-signout')) { sb.auth.signOut(); }
    if (e.target.closest('#btn-history')) { loadHistory(); }
    if (e.target.closest('#btn-back-main')) { showPane(brief ? 'pane-upload' : 'pane-brief'); }
    if (e.target.closest('#btn-retry-grade')) { showPane('pane-brief'); }
    if (e.target.closest('#btn-goto-history')) { loadHistory(); }
    if (e.target.closest('#btn-back-brief')) { showPane('pane-brief'); }
    if (e.target.closest('#btn-new')) { resetUpload(); showPane('pane-upload'); }
    if (e.target.closest('#btn-download')) { downloadReport(); }
  });

  /* ---------------- brief ---------------- */
  var selectedGoal = null;
  document.addEventListener('click', function (e) {
    var card = e.target.closest('.goal-card');
    if (!card) return;
    document.querySelectorAll('.goal-card').forEach(function (c) { c.classList.remove('selected'); });
    card.classList.add('selected');
    selectedGoal = card.getAttribute('data-goal');
    $('offer-field').classList.toggle('hidden', selectedGoal !== 'conversion');
  });

  $('btn-to-upload').addEventListener('click', function () {
    var platforms = Array.prototype.map.call(
      document.querySelectorAll('#platform-checks input:checked'), function (i) { return i.value; });
    var err = $('brief-error');
    if (!selectedGoal) { err.textContent = 'Pick a primary goal first.'; err.classList.remove('hidden'); return; }
    if (!platforms.length) { err.textContent = 'Pick at least one platform.'; err.classList.remove('hidden'); return; }
    err.classList.add('hidden');
    brief = {
      goal: selectedGoal,
      platforms: platforms,
      viewer: $('in-viewer').value.trim(),
      niche: $('in-niche').value.trim(),
      offer: $('in-offer').value.trim(),
      results: $('in-results').value.trim()
    };
    renderBriefSummary();
    showPane('pane-upload');
  });

  function renderBriefSummary() {
    var labels = { virality: 'Virality', conversion: 'Conversion', growth: 'Growth', engagement: 'Engagement' };
    $('brief-summary').innerHTML =
      '<strong>Goal:</strong> ' + esc(labels[brief.goal] || brief.goal) +
      ' &nbsp;·&nbsp; <strong>Platforms:</strong> ' + esc(brief.platforms.join(', ')) +
      (brief.viewer ? ' &nbsp;·&nbsp; <strong>Viewer:</strong> ' + esc(brief.viewer) : '') +
      (brief.niche ? ' &nbsp;·&nbsp; <strong>Niche:</strong> ' + esc(brief.niche) : '');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- quota ---------------- */
  async function refreshQuota() {
    try {
      var r = await fetch('/api/quota', { headers: authHeader() });
      if (!r.ok) return;
      var q = await r.json();
      $('quota-pill').textContent = q.remaining + ' of ' + q.limit + ' free grades left today';
      var tip = $('quota-tip');
      if (tip) {
        var now = new Date();
        var reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        tip.textContent = 'Resets at ' + reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '. Back to ' + q.limit + ' free grades';
      }
    } catch (e) { /* offline */ }
  }

  /* ---------------- video prep (browser-side) ---------------- */
  var dropzone = $('dropzone'), fileInput = $('file-input');

  dropzone.addEventListener('click', function () { fileInput.click(); });
  ['dragover', 'dragenter'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove('drag'); });
  });
  dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
  });

  function setProgress(pct, text) {
    $('extract-progress').classList.remove('hidden');
    $('progress-fill').style.width = pct + '%';
    $('progress-text').textContent = text;
  }

  async function handleFile(file) {
    var err = $('upload-error'); err.classList.add('hidden');
    $('btn-analyze').classList.add('hidden');
    if (!/^video\//.test(file.type) && !/\.(mp4|mov|webm)$/i.test(file.name)) {
      err.textContent = 'Please choose an MP4, MOV or WebM video.'; err.classList.remove('hidden'); return;
    }
    $('file-name').textContent = file.name; $('file-name').classList.remove('hidden');
    setProgress(5, 'Reading video…');
    try {
      prepared = await prepareVideo(file, setProgress);
      setProgress(100, 'Ready to grade.');
      $('btn-analyze').classList.remove('hidden');
    } catch (e2) {
      err.textContent = 'Could not read that video: ' + (e2.message || e2);
      err.classList.remove('hidden');
      $('extract-progress').classList.add('hidden');
    }
  }

  function resetUpload() {
    prepared = null; lastReport = null;
    $('file-name').classList.add('hidden');
    $('extract-progress').classList.add('hidden');
    $('btn-analyze').classList.add('hidden');
    $('report-body').innerHTML = '';
    $('report-actions').classList.add('hidden');
    fileInput.value = '';
    refreshQuota();
  }

  function prepareVideo(file, onProg) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.preload = 'auto';
      video.src = url;
      video.onloadedmetadata = function () {
        var duration = video.duration || 0;
        if (!duration || !isFinite(duration)) { URL.revokeObjectURL(url); reject(new Error('No duration found.')); return; }
        extractFrames(video, duration, onProg).then(function (frames) {
          onProg(70, 'Extracting audio…');
          return extractAudio(file, Math.min(duration, 180)).then(function (audio) {
            URL.revokeObjectURL(url);
            resolve({ frames: frames, audioB64: audio.b64, audioFormat: audio.format, fileName: file.name, duration: duration });
          });
        }).catch(function (e) { URL.revokeObjectURL(url); reject(e); });
      };
      video.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Video could not be decoded.')); };
    });
  }

  function extractFrames(video, duration, onProg) {
    return new Promise(function (resolve) {
      var N = 12, frames = [], i = 0;
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      function next() {
        if (i >= N) { resolve(frames); return; }
        var t = duration * (i + 0.5) / N;
        onProg(5 + Math.round(60 * i / N), 'Grabbing frame ' + (i + 1) + ' of ' + N + '…');
        var onSeek = function () {
          video.removeEventListener('seeked', onSeek);
          var scale = Math.min(1, 480 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          frames.push(canvas.toDataURL('image/jpeg', 0.6).split(',')[1]);
          i++; next();
        };
        video.addEventListener('seeked', onSeek);
        video.currentTime = Math.min(t, duration - 0.1);
      }
      next();
    });
  }

  // Decode audio, downmix to 16kHz mono. With the lamejs encoder loaded, encode
  // MP3 (about 8x smaller than WAV, so up to 3 minutes fits the upload limit).
  // Without it, keep the original behavior: WAV capped at 60 seconds. If MP3
  // encoding ever throws, re-render 60s of WAV so a grade can still go through.
  function extractAudio(file, maxSec) {
    return new Promise(function (resolve, reject) {
      var useMp3 = typeof lamejs !== 'undefined' && !!lamejs.Mp3Encoder;
      var cap = useMp3 ? maxSec : Math.min(maxSec, 60);
      var targetRate = 16000;
      var decoded = null;
      function render(secs) {
        var offline = new OfflineAudioContext(1, Math.ceil(Math.min(decoded.duration, secs) * targetRate), targetRate);
        var src = offline.createBufferSource(); src.buffer = decoded;
        src.connect(offline.destination); src.start(0);
        return offline.startRendering();
      }
      var reader = new FileReader();
      reader.onload = function () {
        var AC = window.AudioContext || window.webkitAudioContext;
        var ac = new AC();
        ac.decodeAudioData(reader.result).then(function (buf) {
          decoded = buf;
          return render(cap);
        }).then(function (rendered) {
          if (!useMp3) { resolve({ b64: encodeWAV(rendered), format: 'wav' }); return; }
          try { resolve({ b64: encodeMP3(rendered), format: 'mp3' }); }
          catch (eEnc) {
            render(60).then(function (r2) { resolve({ b64: encodeWAV(r2), format: 'wav' }); }).catch(reject);
          }
        }).catch(reject);
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  function encodeMP3(audioBuffer) {
    var data = audioBuffer.getChannelData(0);
    var enc = new lamejs.Mp3Encoder(1, audioBuffer.sampleRate, 32);
    var parts = [];
    for (var i = 0; i < data.length; i += 1152) {
      var chunk = data.subarray(i, i + 1152);
      var i16 = new Int16Array(chunk.length);
      for (var j = 0; j < chunk.length; j++) {
        var s = Math.max(-1, Math.min(1, chunk[j]));
        i16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      var out = enc.encodeBuffer(i16);
      if (out.length) parts.push(out);
    }
    var tail = enc.flush();
    if (tail.length) parts.push(tail);
    var total = 0; parts.forEach(function (p) { total += p.length; });
    var bytes = new Uint8Array(total), off = 0;
    parts.forEach(function (p) { bytes.set(p, off); off += p.length; });
    var bin = '';
    for (var k = 0; k < bytes.length; k += 8192) {
      bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 8192));
    }
    return btoa(bin);
  }

  function encodeWAV(audioBuffer) {
    var numCh = 1, sampleRate = audioBuffer.sampleRate;
    var data = audioBuffer.getChannelData(0);
    var buffer = new ArrayBuffer(44 + data.length * 2);
    var v = new DataView(buffer);
    function wstr(off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }
    wstr(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, numCh, true); v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * numCh * 2, true); v.setUint16(32, numCh * 2, true);
    v.setUint16(34, 16, true); wstr(36, 'data'); v.setUint32(40, data.length * 2, true);
    for (var i = 0; i < data.length; i++) {
      var s = Math.max(-1, Math.min(1, data[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    // base64
    var bytes = new Uint8Array(buffer), bin = '';
    for (var j = 0; j < bytes.length; j += 8192) {
      bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 8192));
    }
    return btoa(bin);
  }

  /* ---------------- analyze (async jobs: submit, then poll the ticket) ---------------- */
  function sleepMs(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function setLoadingText(t) { var el = $('loading-text'); if (el) el.textContent = t; }

  async function runAnalysis() {
    if (!prepared || !brief) return;
    var err = $('upload-error'); err.classList.add('hidden');
    showPane('pane-report');
    $('report-body').innerHTML = '';
    $('report-actions').classList.add('hidden');
    $('report-loading').classList.remove('hidden');
    setLoadingText('Sending your video…');
    try {
      var r = await fetch('/api/analyze', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()),
        body: JSON.stringify({ mode: 'submit', brief: brief, frames: prepared.frames, audioB64: prepared.audioB64, audioFormat: prepared.audioFormat || 'wav', fileName: prepared.fileName })
      });
      var data = await r.json().catch(function () { return {}; });
      if (r.status === 429 && data.error === 'daily_limit') {
        $('report-loading').classList.add('hidden');
        $('report-body').innerHTML = '<div class="report-section"><h3>Daily limit reached</h3><p style="color:var(--muted);font-size:14px">You\'ve used your 3 free grades today. Come back tomorrow.</p></div>';
        return;
      }
      if (r.status === 429 && data.error === 'too_many_requests') {
        $('report-loading').classList.add('hidden');
        $('report-body').innerHTML = '<div class="report-section"><h3>Lots of requests right now</h3><p style="color:var(--muted);font-size:14px">Give it a few seconds and try again. Your free grade was not used.</p><button class="btn btn-primary" id="btn-retry-grade" style="margin-top:14px">Try again</button></div>';
        return;
      }
      if (r.status === 413) {
        $('report-loading').classList.add('hidden');
        $('report-body').innerHTML = '<div class="report-section"><h3>That video is too large to process</h3><p style="color:var(--muted);font-size:14px">The frames and audio from this clip are bigger than our upload limit. Try a shorter clip (about a minute or less) and it should go through.</p></div>';
        return;
      }
      if (!r.ok || !data.jobId) throw new Error(data.error || ('Server error ' + r.status));

      var result = await pollJob(data.jobId);
      $('report-loading').classList.add('hidden');
      if (result.timeout) {
        $('report-body').innerHTML = '<div class="report-section"><h3>Still grading</h3><p style="color:var(--muted);font-size:14px">This one is taking longer than usual. The grade keeps running in the background even if you leave, and it will appear in your History when it finishes.</p><button class="btn btn-primary" id="btn-goto-history" style="margin-top:14px">Check History</button></div>';
        return;
      }
      if (result.failed) {
        $('report-body').innerHTML = '<div class="report-section"><h3>Grading took too long</h3><p style="color:var(--muted);font-size:14px">The AI services are running slow right now, so this grade timed out. Your free grade was not used. Wait a minute and try again.</p><button class="btn btn-primary" id="btn-retry-grade" style="margin-top:14px">Try again</button></div>';
        return;
      }
      lastReport = result.report; lastBrief = brief;
      reportFrames = prepared ? { frames: prepared.frames, duration: prepared.duration } : null;
      renderReport(result.report);
      $('report-actions').classList.remove('hidden');
      refreshQuota();
    } catch (e) {
      $('report-loading').classList.add('hidden');
      $('report-body').innerHTML = '<div class="report-section"><h3>Something went wrong</h3><p style="color:var(--muted);font-size:14px">' + esc(e.message) + '</p></div>';
    }
  }

  async function pollJob(jobId) {
    var started = Date.now();
    var netFails = 0;
    while (Date.now() - started < 8 * 60 * 1000) {
      await sleepMs(4000);
      var r;
      try {
        r = await fetch('/api/analyze?job=' + encodeURIComponent(jobId), { headers: authHeader() });
      } catch (e) {
        if (++netFails >= 5) throw e;
        continue;
      }
      var d = await r.json().catch(function () { return {}; });
      if (r.status === 401) throw new Error('Your session expired. Sign in again to see the result in History.');
      if (!r.ok) {
        if (++netFails >= 5) throw new Error(d.error || ('Server error ' + r.status));
        continue;
      }
      netFails = 0;
      if (d.status === 'done') return { report: d.report, transcript: d.transcript };
      if (d.status === 'failed') return { failed: true };
      setLoadingText(d.status === 'queued'
        ? 'In line… your grade starts in a moment.'
        : 'BennettIQ is grading your video… this can take a minute or two. It keeps going even if you close this tab, and the finished grade lands in your History.');
    }
    return { timeout: true };
  }
  $('btn-analyze').addEventListener('click', runAnalysis);

  /* ---------------- report render ---------------- */
  function scoreClass(n) { return n >= 75 ? 'score-good' : (n >= 50 ? 'score-mid' : 'score-low'); }

  function animateScores() {
    var els = document.querySelectorAll('#report-body .val[data-score]');
    els.forEach(function (el) {
      var target = parseInt(el.getAttribute('data-score'), 10) || 0;
      var start = null, dur = 1100;
      function tick(ts) {
        if (!start) start = ts;
        var p = Math.min(1, (ts - start) / dur);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased);
        if (p < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  function initReveals() {
    var els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.1 });
    els.forEach(function (el) { io.observe(el); });
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }

  function framesStripHtml(rf) {
    var fr = rf.frames, n = fr.length, dur = rf.duration || 0, h = '', i, t;
    h += '<div class="report-section"><h3>Frames analyzed</h3>' +
      '<p class="frames-sub">' + n + ' frames reviewed across the full video</p><div class="frames-strip">';
    for (i = 0; i < n; i++) {
      t = dur ? (dur * (i + 0.5) / n) : 0;
      h += '<div class="frame-thumb" data-idx="' + i + '" role="button" tabindex="0" aria-label="View frame ' + (i + 1) + ' larger"><img src="data:image/jpeg;base64,' + fr[i] +
        '" alt="Frame ' + (i + 1) + ' of ' + n + '" loading="lazy"><span>' + fmtTime(t) + '</span></div>';
    }
    return h + '</div></div>';
  }

  function chipTimes(str) {
    return esc(str == null ? '' : str).replace(/(\d{1,3}:\d{2})/g, '<span class="tchip">$1</span>');
  }

  function dimRing(d) {
    var pct = Math.max(0, Math.min(10, Number(d.score) || 0)) * 10;
    var cls = scoreClass(pct);
    return '<svg class="score-ring" viewBox="0 0 44 44" aria-hidden="true">' +
      '<circle class="ring-bg" cx="22" cy="22" r="18"/>' +
      '<circle class="ring-fg ' + cls + '" cx="22" cy="22" r="18" pathLength="100"' +
      ' stroke-dasharray="100 100" stroke-dashoffset="' + (100 - pct).toFixed(1) + '"/>' +
      '<text x="22" y="27" text-anchor="middle" class="ring-num">' + d.score + '</text></svg>';
  }

  function openFrameViewer(idx) {
    if (!reportFrames || !reportFrames.frames || !reportFrames.frames.length) return;
    var n = reportFrames.frames.length;
    idx = Math.max(0, Math.min(n - 1, idx || 0));
    var overlay = $('frame-viewer');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'frame-viewer';
      overlay.className = 'frame-viewer hidden';
      overlay.innerHTML = '<div class="fv-backdrop"></div><div class="fv-box">' +
        '<button class="fv-close" aria-label="Close">✕</button>' +
        '<button class="fv-prev" aria-label="Previous frame">‹</button>' +
        '<img class="fv-img" alt="Video frame enlarged">' +
        '<button class="fv-next" aria-label="Next frame">›</button>' +
        '<div class="fv-cap"></div></div>';
      document.body.appendChild(overlay);
      overlay.querySelector('.fv-close').addEventListener('click', closeFrameViewer);
      overlay.querySelector('.fv-backdrop').addEventListener('click', closeFrameViewer);
      overlay.querySelector('.fv-prev').addEventListener('click', function (e) { e.stopPropagation(); stepFrame(-1); });
      overlay.querySelector('.fv-next').addEventListener('click', function (e) { e.stopPropagation(); stepFrame(1); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeFrameViewer(); });
    }
    overlay.dataset.idx = idx;
    renderFrameViewer();
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  function renderFrameViewer() {
    var overlay = $('frame-viewer');
    if (!overlay || !reportFrames || !reportFrames.frames) return;
    var fr = reportFrames.frames, n = fr.length;
    var idx = Math.max(0, Math.min(n - 1, parseInt(overlay.dataset.idx || '0', 10) || 0));
    var dur = reportFrames.duration || 0;
    overlay.querySelector('.fv-img').src = 'data:image/jpeg;base64,' + fr[idx];
    overlay.querySelector('.fv-cap').textContent = 'Frame ' + (idx + 1) + ' of ' + n +
      (dur ? '  ·  ' + fmtTime(dur * (idx + 0.5) / n) : '');
  }
  function stepFrame(d) {
    var overlay = $('frame-viewer');
    if (!overlay || !reportFrames || !reportFrames.frames) return;
    var n = reportFrames.frames.length;
    var idx = (parseInt(overlay.dataset.idx || '0', 10) + d + n) % n;
    overlay.dataset.idx = idx;
    renderFrameViewer();
  }
  function closeFrameViewer() {
    var overlay = $('frame-viewer');
    if (overlay) overlay.classList.add('hidden');
    document.body.style.overflow = '';
  }

  function goalScoreLabel() {
    var g = (lastBrief && lastBrief.goal) || 'virality';
    return { virality: 'Virality score', conversion: 'Conversion score', growth: 'Growth score', engagement: 'Engagement score' }[g] || 'Overall score';
  }

  $('report-body').addEventListener('click', function (e) {
    var head = e.target.closest('.dim-head');
    if (head) {
      var card = head.closest('.dim-card');
      if (card) {
        var isOpen = card.classList.toggle('open');
        head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      }
      return;
    }
    var th = e.target.closest('.frame-thumb');
    if (th && th.dataset.idx != null) openFrameViewer(parseInt(th.dataset.idx, 10));
  });
  $('report-body').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var th = e.target.closest('.frame-thumb');
    if (th && th.dataset.idx != null) { e.preventDefault(); openFrameViewer(parseInt(th.dataset.idx, 10)); }
  });

  // Reports saved before the October 2026 rubric change can still contain
  // two retired dimensions; hide them so old reports match the current
  // breakdown. The saved data itself is never modified.
  var RETIRED_DIMS = ['novelty & distinctiveness', 'payoff & satisfaction'];
  function visibleDims(rep) {
    return (rep.dimensions || []).filter(function (d) {
      return RETIRED_DIMS.indexOf(String(d.name || '').toLowerCase()) === -1;
    });
  }

  /* ------- reference videos: curated, verified examples -------
     Rules for this library: every entry was opened and checked by hand, and
     its title and creator were confirmed against the platform's own data
     before it was added. Never add an entry from memory or a guess. An
     honest empty state beats a fabricated example. */
  var REFERENCE_VIDEOS = [
    { platform: 'TikTok', title: 'The “Dreams” skateboard video', creator: 'Nathan Apodaca (@doggface208)', url: 'https://www.tiktok.com/@doggface208/video/6876424174374426374', thumb: '', formats: ['vlog', 'music', 'lifestyle', 'authentic moment', 'day in the life'], goals: ['virality', 'engagement', 'growth'],
      technique: 'One continuous shot that feels completely unproduced: a man coasting on a skateboard, drinking cranberry juice straight from the bottle, lip-syncing to Fleetwood Mac. No cuts, no pitch, no effects, just a mood the viewer understands instantly.',
      why: 'It is the clearest proof on the platform that effectiveness is not production value. If your video leans on authenticity, timing, or a feeling rather than polish, this is the reference point.',
      adapt: 'The transferable pattern: one simple moment, a sound the audience already loves, and a clear feeling delivered in the first two seconds.',
      avoid: 'Do not copy the surface (the juice, the skateboard, this song). The context made it work: an ordinary guy on a work break, radiating unbothered calm at a moment everyone needed it. The lesson is the feeling, not the props.' }
  ];

  function matchReferences(rep) {
    if (!REFERENCE_VIDEOS.length) return [];
    var fmt = ((rep.format_comparison || {}).format || '').toLowerCase();
    var plat = brief && brief.platforms && brief.platforms[0] ? brief.platforms[0].toLowerCase() : '';
    var goal = brief && brief.goal ? brief.goal : '';
    var scored = REFERENCE_VIDEOS.map(function (v) {
      var sc = 0;
      var anchored = false;
      if (plat && v.platform.toLowerCase() === plat) { sc += 2; anchored = true; }
      if (goal && v.goals.indexOf(goal) !== -1) { sc += 2; anchored = true; }
      v.formats.forEach(function (f) { if (fmt && fmt.indexOf(f.toLowerCase()) !== -1) sc += 2; });
      return { v: v, sc: sc, anchored: anchored };
    }).filter(function (x) { return x.anchored && x.sc >= 3; });
    scored.sort(function (a, b) { return b.sc - a.sc; });
    return scored.slice(0, 3).map(function (x) { return x.v; });
  }

  function referenceHtml(rep) {
    var picks = matchReferences(rep);
    var html = '<div class="report-section"><h3>Learn from real video examples</h3>';
    if (!picks.length) {
      return html + '<p class="frames-sub">Reference videos for this format are on the way. This library is hand-picked and verified, so it grows format by format rather than all at once.</p></div>';
    }
    html += '<p class="frames-sub">Real videos that use this format well. Study the technique, do not copy the video: what worked for them is a pattern to adapt, not a result anyone can promise you.</p>';
    picks.forEach(function (v) {
      html += '<div class="ref-card">' +
        (v.thumb ? '<a class="ref-thumb" href="' + esc(v.url) + '" target="_blank" rel="noopener"><img src="' + esc(v.thumb) + '" alt="" loading="lazy"></a>' : '') +
        '<div class="ref-body">' +
          '<p class="ref-title"><a href="' + esc(v.url) + '" target="_blank" rel="noopener">' + esc(v.title) + '</a></p>' +
          '<p class="ref-meta">' + esc(v.creator) + ' · ' + esc(v.platform) + '</p>' +
          (v.technique ? '<p class="fmt-row"><strong>Technique:</strong> ' + esc(v.technique) + '</p>' : '') +
          (v.why ? '<p class="fmt-row"><strong>Why it is relevant to yours:</strong> ' + esc(v.why) + '</p>' : '') +
          (v.adapt ? '<p class="fmt-row"><strong>Worth adapting:</strong> ' + esc(v.adapt) + '</p>' : '') +
          (v.avoid ? '<p class="fmt-row"><strong>Do not copy blindly:</strong> ' + esc(v.avoid) + '</p>' : '') +
        '</div></div>';
    });
    return html + '</div>';
  }

  function renderReport(rep) {
    var html = '';
    if (rep.visual_analysis_unavailable) {
      var diag = rep.vision_error ? ' <span class="fallback-diag">Error: ' + String(rep.vision_error).replace(/</g, '&lt;') + '</span>' : '';
      html += '<div class="fallback-note">Visual analysis was temporarily unavailable, so this grade was done from the transcript and your brief only. Frames were skipped this time.' + diag + '</div>';
    }
    html += '<div class="report-head"><span class="take-star" aria-hidden="true">\u2726</span><div><h3>Your video grade</h3><p>' +
      esc(rep.score_band || '') + '</p></div></div>';
    html += '<div class="score-row single"><div class="score-card hero-score"><div class="num ' + scoreClass(rep.overall_score) +
      '"><span class="val" data-score="' + rep.overall_score + '">0</span><span class="of">/100</span></div><div class="lbl">' +
      esc(goalScoreLabel()) + '</div></div></div>';
    if (rep.video_summary) html += '<p class="rep-summary">' + esc(rep.video_summary) + '</p>';
    if (rep.objective_statement) html += '<p class="rep-obj">' + esc(rep.objective_statement) + '</p>';

    if (!rep.visual_analysis_unavailable && reportFrames && reportFrames.frames && reportFrames.frames.length) {
      html += framesStripHtml(reportFrames);
    }

    var dims = visibleDims(rep);
    if (dims.length) {
      html += '<div class="report-section"><h3>Breakdown</h3><p class="frames-sub">Tap a row to expand the details.</p>';
      var weakest = 0;
      dims.forEach(function (d, i) { if (Number(d.score) < Number(dims[weakest].score)) weakest = i; });
      dims.forEach(function (d, i) {
        html += '<div class="dim-card' + (i === weakest ? ' open' : '') + '">' +
          '<button class="dim-head" aria-expanded="' + (i === weakest) + '">' + dimRing(d) +
          '<span class="dim-title"><span class="dim-name">' + esc(d.name) + '</span>' +
          '<span class="weight-pill">' + d.weight + '% of score</span></span>' +
          '<span class="dim-chev" aria-hidden="true">›</span></button>' +
          '<div class="dim-body">' +
          (d.evidence ? '<p class="dim-ev"><strong>Seen:</strong> ' + chipTimes(d.evidence) + '</p>' : '') +
          '<div class="procon">' +
            (d.pro ? '<div class="pro"><strong>\u2713 Working:</strong> ' + esc(d.pro) + '</div>' : '') +
            (d.con ? '<div class="con"><strong>\u2717 Hurting:</strong> ' + esc(d.con) + '</div>' : '') +
          '</div>' +
          (d.improvement ? '<p class="dim-fix"><strong>Fix:</strong> ' + esc(d.improvement) + '</p>' : '') +
        '</div></div>';
      });
      html += '</div>';
    }

    var fc = rep.format_comparison || {};
    if (fc.comparisons && fc.comparisons.length) {
      html += '<div class="report-section"><h3>How top videos in this format do it</h3>' +
        (fc.format ? '<p class="frames-sub">Your format: ' + esc(fc.format) + '. Patterns only, no specific videos, because what matters is the gap between your footage and what works.</p>' : '');
      fc.comparisons.forEach(function (c) {
        html += '<div class="fmt-card">' +
          (c.pattern ? '<p class="fmt-row"><strong>Top videos:</strong> ' + esc(c.pattern) + '</p>' : '') +
          (c.this_video ? '<p class="fmt-row"><strong>Yours:</strong> ' + chipTimes(c.this_video) + '</p>' : '') +
          (c.gap ? '<p class="fmt-gap"><strong>The gap:</strong> ' + esc(c.gap) + '</p>' : '') +
        '</div>';
      });
      html += '</div>';
    }

    html += referenceHtml(rep);

    var hk = rep.hook || {};
    if (hk.verdict || hk.strongest || hk.weakest || hk.alternative) {
      html += '<div class="report-section"><h3>Hook analysis</h3>' +
        (hk.verdict ? '<p>' + esc(hk.verdict) + '</p>' : '') +
        (hk.strongest ? '<p><strong>Strongest moment:</strong> ' + esc(hk.strongest) + '</p>' : '') +
        (hk.weakest ? '<p><strong>Biggest weakness:</strong> ' + esc(hk.weakest) + '</p>' : '') +
        (hk.alternative ? '<div class="hook-rw">\u201c' + esc(hk.alternative) + '\u201d</div>' : '') +
      '</div>';
    }

    if (rep.retention_map && rep.retention_map.length) {
      html += '<div class="report-section"><h3>Retention map</h3>' +
        rep.retention_map.map(function (m) {
          return '<div class="tl"><time>' + esc(m.t || '') + '</time>' + chipTimes(m.note || '') + '</div>';
        }).join('') + '</div>';
    }

    if (rep.psychology && rep.psychology.length) {
      html += '<div class="report-section"><h3>What\u2019s going on psychologically</h3>' +
        rep.psychology.map(function (p) {
          return '<div class="psy"><span class="psy-mark ' + (p.helping ? 'good' : 'bad') + '">' +
            (p.helping ? '\u2713' : '\u2717') + '</span><div><strong>' + esc(p.principle) +
            '</strong><p>' + esc(p.explanation) + '</p></div></div>';
        }).join('') + '</div>';
    }

    if (rep.top_improvements && rep.top_improvements.length) {
      html += '<div class="report-section"><h3>Top fixes</h3>';
      rep.top_improvements.forEach(function (t, i) {
        html += '<div class="fix-card"><div class="fix-num">' + (i + 1) + '</div><div>' +
          '<strong>' + esc(t.change) + '</strong>' +
          (t.where ? '<p class="fix-where">' + esc(t.where) + '</p>' : '') +
          (t.why ? '<p>' + esc(t.why) + '</p>' : '') +
          (t.example ? '<p class="fix-ex"><strong>Try:</strong> ' + esc(t.example) + '</p>' : '') +
        '</div></div>';
      });
      html += '</div>';
    }

    if (rep.alt_version) html += '<div class="report-section"><h3>Alternative version</h3><p>' + esc(rep.alt_version) + '</p></div>';
    if (rep.limitations) html += '<p class="rep-limits">' + esc(rep.limitations) + '</p>';

    var v = rep.verdict || {};
    if (v.strengths || v.weakness || v.priority) {
      html += '<div class="report-section verdict"><h3>Final verdict</h3>' +
        (v.strengths ? '<p><strong>Doing well:</strong> ' + esc(v.strengths) + '</p>' : '') +
        (v.weakness ? '<p><strong>Biggest weakness:</strong> ' + esc(v.weakness) + '</p>' : '') +
        (v.priority ? '<p class="verdict-priority"><strong>Do this first:</strong> ' + esc(v.priority) + '</p>' : '') +
      '</div>';
    }

    $('report-body').innerHTML = html;
    animateScores();
  }

  function downloadReport() {
    if (!lastReport) return;
    var r = lastReport, b = lastBrief || {};
    var md = '# BennettIQ report\n\n' +
      'Goal: ' + (b.goal || '-') + ' | Platforms: ' + (b.platforms || []).join(', ') + '\n\n' +
      '## Score\n' + r.overall_score + '/100: ' + (r.score_band || '') + '\n\n';
    if (r.video_summary) md += r.video_summary + '\n\n';
    if (r.objective_statement) md += r.objective_statement + '\n\n';
    var mdims = visibleDims(r);
    if (mdims.length) {
      md += '## Breakdown\n';
      mdims.forEach(function (d) {
        md += '### ' + d.name + ': ' + d.score + '/10 (' + d.weight + '% weight)\n' +
          '- Seen: ' + d.evidence + '\n- Working: ' + d.pro + '\n- Hurting: ' + d.con + '\n- Fix: ' + d.improvement + '\n\n';
      });
    }
    var hk = r.hook || {};
    if (hk.verdict) md += '## Hook analysis\n' + hk.verdict + '\n- Strongest: ' + hk.strongest + '\n- Weakest: ' + hk.weakest + '\n- Alternative: "' + hk.alternative + '"\n\n';
    if (r.retention_map && r.retention_map.length) md += '## Retention map\n' + r.retention_map.map(function (m) { return '- [' + m.t + '] ' + m.note; }).join('\n') + '\n\n';
    if (r.psychology && r.psychology.length) md += '## Psychology\n' + r.psychology.map(function (p) { return '- ' + (p.helping ? '[+] ' : '[-] ') + p.principle + ': ' + p.explanation; }).join('\n') + '\n\n';
    if (r.top_improvements && r.top_improvements.length) md += '## Top fixes\n' + r.top_improvements.map(function (t, i) { return (i + 1) + '. ' + t.change + ' (' + t.where + ')\n   Why: ' + t.why + '\n   Try: ' + t.example; }).join('\n') + '\n\n';
    var fc2 = r.format_comparison || {};
    if (fc2.comparisons && fc2.comparisons.length) {
      md += '## How top videos in this format do it\n';
      if (fc2.format) md += 'Format: ' + fc2.format + '\n\n';
      fc2.comparisons.forEach(function (c) {
        md += '- Top videos: ' + c.pattern + '\n  Yours: ' + c.this_video + '\n  The gap: ' + c.gap + '\n';
      });
      md += '\n';
    }

    if (r.alt_version) md += '## Alternative version\n' + r.alt_version + '\n\n';
    if (r.limitations) md += '## Limitations\n' + r.limitations + '\n\n';
    var v = r.verdict || {};
    md += '## Final verdict\n- Doing well: ' + v.strengths + '\n- Biggest weakness: ' + v.weakness + '\n- Do this first: ' + v.priority + '\n';
    var blob = new Blob([md], { type: 'text/markdown' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bennett-report.md';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ---------------- history ---------------- */
  async function loadHistory() {
    showPane('pane-history');
    var list = $('history-list');
    list.innerHTML = '<p class="empty">Loading…</p>';
    try {
      var r = await fetch('/api/history', { headers: authHeader() });
      var items = await r.json();
      if (!items.length) { list.innerHTML = '<p class="empty">No grades yet. Grade your first video!</p>'; return; }
      list.innerHTML = items.map(function (it, idx) {
        var d = new Date(it.created_at).toLocaleString();
        var b = it.brief || {}, rep = it.report || {};
        var thumb = rep.thumbnail
          ? '<img class="hist-thumb" src="data:image/jpeg;base64,' + rep.thumbnail + '" alt="" loading="lazy">'
          : '<div class="hist-thumb hist-ph">' + (rep.overall_score != null ? rep.overall_score : '–') + '</div>';
        return '<div class="hist-item" data-idx="' + idx + '">' + thumb +
          '<div class="hist-main"><div class="d">' + esc(d) + '</div>' +
          '<div class="g">' + esc(b.goal || '-') + ' · ' + esc((b.platforms || []).join(', ')) + '</div>' +
          '<div class="s">Score ' + (rep.overall_score != null ? rep.overall_score : '–') + '/100</div></div></div>';
      }).join('');
      list.querySelectorAll('.hist-item').forEach(function (el) {
        el.addEventListener('click', function () {
          var it = items[parseInt(el.getAttribute('data-idx'), 10)];
          lastReport = it.report; lastBrief = it.brief;
          reportFrames = null;
          renderReport(it.report);
          $('report-actions').classList.remove('hidden');
          $('report-loading').classList.add('hidden');
          showPane('pane-report');
        });
      });
    } catch (e) {
      list.innerHTML = '<p class="empty">Could not load history.</p>';
    }
  }

  boot();
})();
