/* Content Rater — frontend (no build step, plain JS) */
(function () {
  'use strict';

  var sb = null;            // supabase client
  var session = null;
  var brief = null;         // { goal, platforms[], viewer, niche, offer }
  var prepared = null;      // { frames:[b64...], audioB64, fileName, duration }
  var lastReport = null;    // last rendered report (for download)
  var lastBrief = null;

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
    ['pane-brief', 'pane-upload', 'pane-report', 'pane-history'].forEach(function (p) {
      $(p).classList.toggle('hidden', p !== id);
    });
    var step = { 'pane-brief': 1, 'pane-upload': 2, 'pane-report': 3, 'pane-history': 0 }[id];
    [1, 2, 3].forEach(function (n) { $('step-' + n).classList.toggle('active', n === step); });
    window.scrollTo(0, 0);
  }

  function render() {
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
            ok.textContent = 'Account created — check your email for a confirmation link, then log in.';
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
      offer: $('in-offer').value.trim()
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
          return extractAudio(file, Math.min(duration, 90)).then(function (audioB64) {
            URL.revokeObjectURL(url);
            resolve({ frames: frames, audioB64: audioB64, fileName: file.name, duration: duration });
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
          var scale = Math.min(1, 640 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          frames.push(canvas.toDataURL('image/jpeg', 0.65).split(',')[1]);
          i++; next();
        };
        video.addEventListener('seeked', onSeek);
        video.currentTime = Math.min(t, duration - 0.1);
      }
      next();
    });
  }

  // Decode audio, downmix to 16kHz mono, encode WAV. Caps at maxSec seconds.
  function extractAudio(file, maxSec) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var AC = window.AudioContext || window.webkitAudioContext;
        var ac = new AC();
        ac.decodeAudioData(reader.result).then(function (buf) {
          var targetRate = 16000;
          var offline = new OfflineAudioContext(1, Math.ceil(Math.min(buf.duration, maxSec) * targetRate), targetRate);
          var src = offline.createBufferSource(); src.buffer = buf;
          src.connect(offline.destination); src.start(0);
          return offline.startRendering();
        }).then(function (rendered) {
          resolve(encodeWAV(rendered));
        }).catch(reject);
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
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

  /* ---------------- analyze ---------------- */
  $('btn-analyze').addEventListener('click', async function () {
    if (!prepared || !brief) return;
    var err = $('upload-error'); err.classList.add('hidden');
    showPane('pane-report');
    $('report-body').innerHTML = '';
    $('report-actions').classList.add('hidden');
    $('report-loading').classList.remove('hidden');
    try {
      var r = await fetch('/api/analyze', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()),
        body: JSON.stringify({ brief: brief, frames: prepared.frames, audioB64: prepared.audioB64, fileName: prepared.fileName })
      });
      var data = await r.json().catch(function () { return {}; });
      $('report-loading').classList.add('hidden');
      if (r.status === 429 && data.error === 'daily_limit') {
        $('report-body').innerHTML = '<div class="report-section"><h3>Daily limit reached</h3><p style="color:var(--muted);font-size:14px">You\'ve used your 3 free grades today. Come back tomorrow.</p></div>';
        return;
      }
      if (!r.ok) throw new Error(data.error || ('Server error ' + r.status));
      lastReport = data.report; lastBrief = brief;
      renderReport(data.report);
      $('report-actions').classList.remove('hidden');
      refreshQuota();
    } catch (e) {
      $('report-loading').classList.add('hidden');
      $('report-body').innerHTML = '<div class="report-section"><h3>Something went wrong</h3><p style="color:var(--muted);font-size:14px">' + esc(e.message) + '</p></div>';
    }
  });

  /* ---------------- report render ---------------- */
  function scoreClass(n) { return n >= 75 ? 'score-good' : (n >= 50 ? 'score-mid' : 'score-low'); }

  function bennettTake(avg) {
    if (avg >= 85) return 'Exceptional. This one is ready — protect what is working and test the hook rewrites below.';
    if (avg >= 60) return 'Solid foundation. Work the fix list top-down and this climbs fast.';
    if (avg >= 40) return 'Average right now — which means big upside. Start with fix #1.';
    return 'Rough cut, honest grade. Work the fix list in order, then re-upload and watch the scores move.';
  }

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

  function renderReport(rep) {
    var dims = rep.dimensions || {};
    var dimNames = { hook: 'Hook', visuals: 'Visuals', pacing: 'Pacing', audio: 'Audio', platform_fit: 'Platform fit', on_screen_text: 'On-screen text' };
    var html = '';
    if (rep.visual_analysis_unavailable) {
      html += '<div class="fallback-note">Visual analysis was temporarily unavailable, so this grade was done from the transcript and your brief only. Frames were skipped this time.</div>';
    }
    html += '<div class="score-row">' +
      '<div class="score-card"><div class="num ' + scoreClass(rep.creative_quality) + '"><span class="val" data-score="' + rep.creative_quality + '">0</span><span class="of">/100</span></div><div class="lbl">Creative quality</div></div>' +
      '<div class="score-card"><div class="num ' + scoreClass(rep.goal_alignment) + '"><span class="val" data-score="' + rep.goal_alignment + '">0</span><span class="of">/100</span></div><div class="lbl">Goal alignment</div></div></div>';
    html = '<div class="bennett-take"><span class="take-star" aria-hidden="true">✦</span><div><h3>Bennett\'s take</h3><p>' +
      bennettTake(Math.round(((rep.creative_quality || 0) + (rep.goal_alignment || 0)) / 2)) +
      '</p></div></div>' + html;

    html += '<div class="report-section"><h3>Breakdown</h3>';
    Object.keys(dimNames).forEach(function (k) {
      if (dims[k]) html += '<div class="dim"><div class="dim-name">' + dimNames[k] + '</div><div class="dim-note">' + esc(dims[k]) + '</div></div>';
    });
    html += '</div>';

    if (rep.fixes && rep.fixes.length) {
      html += '<div class="report-section"><h3>Fix first</h3><ol>' +
        rep.fixes.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ol></div>';
    }
    if (rep.strengths && rep.strengths.length) {
      html += '<div class="report-section"><h3>What\'s working</h3><ul>' +
        rep.strengths.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul></div>';
    }
    if (rep.timeline_notes && rep.timeline_notes.length) {
      html += '<div class="report-section"><h3>Timeline notes</h3>' +
        rep.timeline_notes.map(function (t) {
          return '<div class="tl"><time>' + esc(t.time || '') + '</time>' + esc(t.note || '') + '</div>';
        }).join('') + '</div>';
    }
    if (rep.hook_rewrites && rep.hook_rewrites.length) {
      html += '<div class="report-section"><h3>Hook rewrites to try</h3>' +
        rep.hook_rewrites.map(function (h) { return '<div class="hook-rw">“' + esc(h) + '”</div>'; }).join('') + '</div>';
    }
    $('report-body').innerHTML = html;
    animateScores();
  }

  function downloadReport() {
    if (!lastReport) return;
    var r = lastReport, b = lastBrief || {};
    var md = '# Bennett report\n\n' +
      'Goal: ' + (b.goal || '-') + ' | Platforms: ' + (b.platforms || []).join(', ') + '\n\n' +
      '## Scores\n- Creative quality: ' + r.creative_quality + '/100\n- Goal alignment: ' + r.goal_alignment + '/100\n\n';
    var dn = { hook: 'Hook', visuals: 'Visuals', pacing: 'Pacing', audio: 'Audio', platform_fit: 'Platform fit', on_screen_text: 'On-screen text' };
    md += '## Breakdown\n';
    Object.keys(dn).forEach(function (k) { if (r.dimensions && r.dimensions[k]) md += '### ' + dn[k] + '\n' + r.dimensions[k] + '\n\n'; });
    if (r.fixes && r.fixes.length) md += '## Fix first\n' + r.fixes.map(function (f, i) { return (i + 1) + '. ' + f; }).join('\n') + '\n\n';
    if (r.strengths && r.strengths.length) md += '## What\'s working\n' + r.strengths.map(function (f) { return '- ' + f; }).join('\n') + '\n\n';
    if (r.timeline_notes && r.timeline_notes.length) md += '## Timeline notes\n' + r.timeline_notes.map(function (t) { return '- [' + (t.time || '') + '] ' + (t.note || ''); }).join('\n') + '\n\n';
    if (r.hook_rewrites && r.hook_rewrites.length) md += '## Hook rewrites to try\n' + r.hook_rewrites.map(function (h) { return '- "' + h + '"'; }).join('\n') + '\n';
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
        return '<div class="hist-item" data-idx="' + idx + '"><div class="d">' + esc(d) + '</div>' +
          '<div class="g">' + esc(b.goal || '-') + ' · ' + esc((b.platforms || []).join(', ')) + '</div>' +
          '<div class="s">Creative ' + (rep.creative_quality != null ? rep.creative_quality : '–') +
          ' · Alignment ' + (rep.goal_alignment != null ? rep.goal_alignment : '–') + '</div></div>';
      }).join('');
      list.querySelectorAll('.hist-item').forEach(function (el) {
        el.addEventListener('click', function () {
          var it = items[parseInt(el.getAttribute('data-idx'), 10)];
          lastReport = it.report; lastBrief = it.brief;
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
