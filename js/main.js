/*
 * Fısıltı — panel orkestrasyonu.
 * Katmanlar: CSInterface (Premiere köprüsü) + FisiltiWhisper (Node) + FisiltiCaptions (saf mantık).
 * Zaman birimleri: transkript state'i SANİYE (sequence zamanı), captions.js MİLİSANİYE ister.
 */
(function () {
  'use strict';

  var cs = new CSInterface();
  var W = window.FisiltiWhisper;
  var C = window.FisiltiCaptions;
  var EXT_PATH = cs.getSystemPath(SystemPath.EXTENSION);

  var $ = function (id) { return document.getElementById(id); };

  /* ================= durum ================= */
  var S = {
    env: null,                 // getEnv sonucu
    segments: [],              // [{t0,t1,text,words:[{t0,t1,text}]}] saniye cinsinden
    liveMode: false,           // transkripsiyon canlı akarken true
    offsetSec: 0,
    proc: null,                // aktif whisper süreci
    overlayProc: null,
    downloads: {},             // key -> download handle
    ffmpegDl: null,            // aktif ffmpeg indirmesi
    updateDl: null,            // aktif güncelleme indirmesi
    pendingUpdate: null,       // checkUpdate sonucu (yeni sürüm varsa)
    pollTimer: null,
    lastPlayheadSec: 0,        // "+ Satır" playhead konumuna ekler
    currentSegIdx: -1,
    programmaticScrollUntil: 0,
    userScrollUntil: 0,
    scrollSeekTimer: null,
    search: { q: '', hits: [], idx: -1 },
    replaceUndo: null, // son bul-değiştir işleminin geri alma kaydı
    settings: null,
    busy: false
  };

  var DEFAULT_SETTINGS = {
    whisperPath: '', ffmpegPath: '',
    threads: 6, pollMs: 250, vad: false,
    language: 'tr', translate: false,
    prompt: '',    // whisper --prompt: özel isim / terim sözlüğü
    modelFile: 'ggml-large-v3-turbo.bin',
    range: 'sequence',
    style: null,   // stil inputları ayrıca saklanır
    caps: null
  };

  /* ================= yardımcılar ================= */
  function status(msg, kind) {
    var bar = $('status-bar');
    // setBusy'nin 'working' sınıfını ezme — spinner animasyonu korunur
    bar.className = (kind || '') + (S.busy ? ' working' : '');
    $('status-text').textContent = msg;
  }
  function progress(pct) {
    var wrap = $('main-progress-wrap');
    if (pct === null) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    $('main-progress').style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function fmtTime(sec) {
    sec = Math.max(0, sec);
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    var h = Math.floor(m / 60); m = m % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (h ? h + ':' : '') + p(m) + ':' + p(s);
  }
  function fmtBytes(b) {
    if (b > 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b > 1e6) return Math.round(b / 1e6) + ' MB';
    return Math.round(b / 1e3) + ' KB';
  }

  // Panel → ExtendScript güvenli köprü (double-stringify)
  function callHost(fn, payload, cb) {
    var arg = (payload === undefined) ? '' : JSON.stringify(JSON.stringify(payload));
    cs.evalScript('$._fst.' + fn + '(' + arg + ')', function (res) {
      if (typeof EvalScript_ErrMessage !== 'undefined' && res === EvalScript_ErrMessage) {
        if (cb) cb({ ok: false, error: 'ExtendScript hatası (' + fn + ')' });
        return;
      }
      var parsed;
      try { parsed = JSON.parse(res); } catch (e) { parsed = { ok: false, error: 'Yanıt çözülemedi: ' + res }; }
      if (cb) cb(parsed);
    });
  }

  /* ================= tema ================= */
  function toHex(color, delta) {
    function ch(v) {
      var c = Math.max(0, Math.min(255, Math.floor(delta === undefined ? v : v + delta)));
      var h = c.toString(16);
      return h.length === 1 ? '0' + h : h;
    }
    return '#' + ch(color.red) + ch(color.green) + ch(color.blue);
  }
  function applyTheme(skin) {
    try {
      var bg = skin.panelBackgroundColor.color;
      var root = document.documentElement.style;
      root.setProperty('--bg', toHex(bg));
      root.setProperty('--bg-panel', toHex(bg, 8));
      root.setProperty('--bg-input', toHex(bg, -10));
      root.setProperty('--bg-hover', toHex(bg, 16));
      root.setProperty('--border', toHex(bg, 24));
    } catch (e) {}
  }

  /* ================= ayarlar ================= */
  function settingsPath() { return W.pathx.join(W.APP_DIR, 'settings.json'); }
  function loadSettings() {
    var s = W.readJsonSafe(settingsPath()) || {};
    S.settings = Object.assign({}, DEFAULT_SETTINGS, s);
    if (!S.settings.whisperPath) S.settings.whisperPath = W.detectWhisper() || '';
    if (!S.settings.ffmpegPath) S.settings.ffmpegPath = W.detectFfmpeg() || '';
  }
  function saveSettings() {
    // Stil ve bölümleme inputlarını da içeri al
    S.settings.style = readStyle();
    S.settings.caps = readCapOpts();
    W.writeJson(settingsPath(), S.settings);
  }

  /* ================= ortam ================= */
  function refreshEnv(cb) {
    callHost('getEnv', undefined, function (res) {
      if (res.ok) {
        S.env = res;
        if (res.seq) {
          $('seq-info').textContent = res.seq.name + ' · ' + (Math.round(res.seq.fps * 100) / 100) + ' fps · ' +
            res.seq.width + '×' + res.seq.height + ' · ' + fmtTime(res.seq.durationSec);
          maybeLoadSavedTranscript(res.seq.id);
        } else {
          $('seq-info').textContent = 'aktif sequence yok';
        }
        try { updatePreview(); } catch (ePv) {} // önizleme oranı sequence'a göre
      } else {
        $('seq-info').textContent = 'Premiere\'e ulaşılamadı';
      }
      if (cb) cb(res);
    });
  }

  /* ================= transkript kalıcılığı ================= */
  function transcriptFile(seqId) { return W.pathx.join(W.TRANSCRIPTS_DIR, seqId.replace(/[^\w-]/g, '_') + '.json'); }
  // seqIdOverride: transkripsiyon sırasında sequence değişirse kayıt yine de
  // işin BAŞLADIĞI sequence'ın dosyasına gider (yanlış dosyayı ezme koruması)
  function persistTranscript(seqIdOverride) {
    var id = seqIdOverride || (S.env && S.env.seq && S.env.seq.id);
    if (!id) return;
    // boş liste de yazılır — son satırın silinmesi kalıcı olmalı
    W.writeJson(transcriptFile(id), { segments: S.segments, savedAt: Date.now() });
  }
  function maybeLoadSavedTranscript(seqId) {
    if (S.segments.length || S.liveMode || S.busy) return;
    var data = W.readJsonSafe(transcriptFile(seqId));
    if (data && data.segments && data.segments.length) {
      S.segments = data.segments;
      renderTranscript();
      status(S.segments.length + ' segment (kayıttan yüklendi)', 'ok');
    }
  }

  /* ================= transkript görünümü ================= */
  function renderTranscript() {
    var box = $('transcript');
    if (!S.segments.length) {
      box.innerHTML = '<div class="empty">Henüz transkript yok.</div>';
      return;
    }
    var html = S.segments.map(function (seg, i) {
      return '<div class="seg" data-i="' + i + '">' +
        '<div class="seg-time" title="Çift tıkla: zamanı düzenle">' + fmtTime(seg.t0) + '</div>' +
        '<div class="seg-text">' + segTextHtml(seg) + '</div>' +
        '<button class="seg-add" title="Altına yeni satır ekle">+</button>' +
        '</div>';
    }).join('');
    box.innerHTML = html;
    S.currentSegIdx = -1;
  }
  function segTextHtml(seg) {
    if (seg.words && seg.words.length && $('opt-wordhl').checked) {
      return seg.words.map(function (w, wi) {
        return '<span class="w" data-w="' + wi + '">' + escapeHtml(w.text) + '</span>';
      }).join(' ');
    }
    return escapeHtml(seg.text);
  }
  function appendLiveSegment(seg, idx) {
    var box = $('transcript');
    if (idx === 0) box.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'seg';
    div.setAttribute('data-i', idx);
    div.innerHTML = '<div class="seg-time">' + fmtTime(seg.t0) + '</div>' +
      '<div class="seg-text">' + escapeHtml(seg.text) + '</div>';
    box.appendChild(div);
    // canlı akışta en alta kaydır
    S.programmaticScrollUntil = Date.now() + 600;
    box.scrollTop = box.scrollHeight;
  }

  function findSegIdx(sec) {
    var lo = 0, hi = S.segments.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (S.segments[mid].t0 <= sec) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best >= 0 && sec > S.segments[best].t1 + 1.5) return -1; // segment aralığında değil
    return best;
  }

  function highlightPlayhead(sec) {
    var idx = findSegIdx(sec);
    var box = $('transcript');
    if (idx !== S.currentSegIdx) {
      var prev = box.querySelector('.seg.current');
      if (prev) prev.classList.remove('current');
      S.currentSegIdx = idx;
      if (idx >= 0) {
        var el = box.querySelector('.seg[data-i="' + idx + '"]');
        if (el) {
          el.classList.add('current');
          if ($('opt-follow').checked && Date.now() > S.userScrollUntil) {
            S.programmaticScrollUntil = Date.now() + 700;
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        }
      }
    }
    // kelime vurgusu (başka segmentlerde kalan bayat vurguyu da temizle)
    box.querySelectorAll('.w.spoken').forEach(function (el) {
      var segEl = el.closest('.seg');
      if (!segEl || +segEl.getAttribute('data-i') !== idx) el.classList.remove('spoken');
    });
    if (idx >= 0 && $('opt-wordhl').checked) {
      var seg = S.segments[idx];
      if (seg.words && seg.words.length) {
        var el2 = box.querySelector('.seg[data-i="' + idx + '"]');
        if (el2) {
          var spans = el2.querySelectorAll('.w');
          for (var i = 0; i < seg.words.length; i++) {
            var on = sec >= seg.words[i].t0 && (i === seg.words.length - 1 || sec < seg.words[i + 1].t0);
            if (spans[i]) spans[i].classList.toggle('spoken', on && sec <= seg.t1);
          }
        }
      }
    }
  }

  /* ================= playhead poll ================= */
  var lastSeqId = null;
  function startPolling() {
    stopPolling();
    S.pollTimer = setInterval(function () {
      cs.evalScript('$._fst.poll()', function (res) {
        if (!res || res === 'EvalScript error.') return;
        var parts = res.split('|');
        if (parts.length !== 2) return;
        if (parts[0] !== lastSeqId) {
          var first = (lastSeqId === null);
          lastSeqId = parts[0];
          // İlk poll'da (panel yeni açıldı) diskten yüklenen transkripti silme;
          // canlı transkripsiyon sürerken de listeye dokunma.
          if (!first && !S.liveMode) {
            S.segments = [];
            renderTranscript();
            refreshEnv();
          }
          return;
        }
        var sec = Number(parts[1]) / 254016000000;
        S.lastPlayheadSec = sec;
        if (S.segments.length && !S.liveMode) highlightPlayhead(sec);
      });
    }, S.settings.pollMs || 250);
  }
  function stopPolling() { if (S.pollTimer) clearInterval(S.pollTimer); S.pollTimer = null; }

  function seek(sec) {
    callHost('seek', { sec: sec }, function () {});
  }

  /* ================= transkript etkileşimleri ================= */
  function wireTranscript() {
    var box = $('transcript');

    box.addEventListener('click', function (ev) {
      var segEl = ev.target.closest('.seg');
      if (!segEl) return;
      if (ev.target.isContentEditable) return;
      if (ev.target.closest('.tc-edit')) return; // zaman düzenleme inputları seek yapmasın
      if (ev.target.closest('.seg-add')) {
        addLineAfter(+segEl.getAttribute('data-i'));
        return;
      }
      var seg = S.segments[+segEl.getAttribute('data-i')];
      if (!seg) return;
      // kelimeye tıklandıysa kelimenin zamanına git
      var wEl = ev.target.closest('.w');
      if (wEl && seg.words) {
        var w = seg.words[+wEl.getAttribute('data-w')];
        if (w) { seek(w.t0); return; }
      }
      seek(seg.t0);
    });

    box.addEventListener('dblclick', function (ev) {
      var timeEl = ev.target.closest('.seg-time');
      if (timeEl && !timeEl.querySelector('input')) {
        openTimeEditor(timeEl.closest('.seg'));
        return;
      }
      var textEl = ev.target.closest('.seg-text');
      if (!textEl) return;
      var segEl = textEl.closest('.seg');
      openTextEditor(+segEl.getAttribute('data-i'));
    });

    box.addEventListener('keydown', function (ev) {
      if (ev.target.isContentEditable && ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); }
      if (ev.target.isContentEditable && ev.key === 'Escape') {
        ev.target.removeAttribute('contenteditable');
        renderTranscript();
      }
    }, true);

    box.addEventListener('blur', function (ev) {
      if (!ev.target.isContentEditable) return;
      var textEl = ev.target;
      var segEl = textEl.closest('.seg');
      var i = +segEl.getAttribute('data-i');
      var seg = S.segments[i];
      textEl.removeAttribute('contenteditable');
      var newText = textEl.textContent.trim();
      if (seg && !newText) {
        // boş bırakılan satır silinir (yeni eklenen satırdan vazgeçme dahil)
        S.segments.splice(i, 1);
        persistTranscript();
        status('Satır silindi.', '');
      } else if (seg && newText !== seg.text) {
        setSegmentText(i, newText);
        persistTranscript();
      }
      renderTranscript();
      if (S.search.q) runSearch(); // arama vurguları ve sayaç bayat kalmasın
      updateCaptionStats();
    }, true);

    // scroll-to-seek + takip bastırma
    box.addEventListener('scroll', function () {
      var now = Date.now();
      if (now < S.programmaticScrollUntil) return;
      S.userScrollUntil = now + 1500;
      if (!$('opt-scrollseek').checked || !S.segments.length || S.liveMode) return;
      clearTimeout(S.scrollSeekTimer);
      S.scrollSeekTimer = setTimeout(function () {
        var mid = box.getBoundingClientRect().top + box.clientHeight / 2;
        var els = box.querySelectorAll('.seg');
        var bestEl = null, bestDist = 1e9;
        for (var i = 0; i < els.length; i++) {
          var r = els[i].getBoundingClientRect();
          var d = Math.abs((r.top + r.bottom) / 2 - mid);
          if (d < bestDist) { bestDist = d; bestEl = els[i]; }
        }
        if (bestEl) {
          var seg = S.segments[+bestEl.getAttribute('data-i')];
          if (seg && +bestEl.getAttribute('data-i') !== S.currentSegIdx) seek(seg.t0);
        }
      }, 260);
    });
  }

  /* ================= segment metni ================= */
  // Segment metnini değiştirir; kelime zamanlarını segment aralığına yeniden
  // dağıtır (drift önleme). Kaydetmez — çağıran persistTranscript() yapar.
  function setSegmentText(i, newText) {
    var seg = S.segments[i];
    if (!seg) return;
    seg.text = newText;
    var est = C.estimateWords({ t0: seg.t0 * 1000, t1: seg.t1 * 1000, text: newText });
    seg.words = est.map(function (w) { return { t0: w.t0 / 1000, t1: w.t1 / 1000, text: w.text }; });
  }

  function openTextEditor(i) {
    var textEl = $('transcript').querySelector('.seg[data-i="' + i + '"] .seg-text');
    var seg = S.segments[i];
    if (!textEl || !seg) return;
    textEl.textContent = seg.text; // düz metne çevir (kelime span'ları olmadan)
    textEl.setAttribute('contenteditable', 'true');
    textEl.focus();
    document.execCommand('selectAll', false, null);
  }

  /* ================= satır ekleme & zaman düzenleme ================= */
  // "1:23.4", "01:23,4", "83.2", "0:01:23.500" gibi biçimleri saniyeye çevirir
  function parseTc(str) {
    str = String(str || '').trim().replace(',', '.');
    if (!str) return null;
    var parts = str.split(':');
    if (parts.length > 3) return null;
    var sec = 0;
    for (var i = 0; i < parts.length; i++) {
      if (!/^\d+(\.\d+)?$/.test(parts[i])) return null;
      sec = sec * 60 + parseFloat(parts[i]);
    }
    return sec;
  }
  function fmtTc(sec) {
    sec = Math.max(0, sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    var s = Math.round((sec % 60) * 10) / 10;
    var sTxt = (s < 10 ? '0' : '') + s.toFixed(1);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (h ? h + ':' + p(m) : String(m)) + ':' + sTxt;
  }

  // Yalnız BU satırın zamanını değiştirir — diğer satırlar yerinde kalır
  // (tümünü kaydırmak için Altyazı sekmesindeki "Zaman kaydırma" var).
  function applySegTime(i, t0, t1) {
    var seg = S.segments[i];
    if (!seg) return;
    var old0 = seg.t0, old1 = seg.t1;
    if (seg.words && seg.words.length && old1 > old0) {
      // kelime zamanlarını yeni aralığa oransal taşı
      var k = (t1 - t0) / (old1 - old0);
      seg.words.forEach(function (w) {
        w.t0 = t0 + (w.t0 - old0) * k;
        w.t1 = t0 + (w.t1 - old0) * k;
      });
    }
    seg.t0 = t0; seg.t1 = t1;
    S.segments.sort(function (a, b) { return a.t0 - b.t0; }); // sırası değişmiş olabilir
    renderTranscript();
    persistTranscript();
    updateCaptionStats();
    if (S.search.q) runSearch();
    status('Zaman güncellendi: ' + fmtTc(t0) + ' – ' + fmtTc(t1), 'ok');
  }

  function openTimeEditor(segEl) {
    if (!segEl) return;
    var i = +segEl.getAttribute('data-i');
    var seg = S.segments[i];
    var timeEl = segEl.querySelector('.seg-time');
    if (!seg || !timeEl) return;
    timeEl.classList.add('tc-edit');
    timeEl.removeAttribute('title');
    timeEl.innerHTML = '<input class="tc-in" title="Başlangıç" value="' + fmtTc(seg.t0) + '">' +
      '<input class="tc-in" title="Bitiş" value="' + fmtTc(seg.t1) + '">';
    var ins = timeEl.querySelectorAll('input');
    var done = false;
    function commit() {
      if (done) return; done = true;
      var t0 = parseTc(ins[0].value), t1 = parseTc(ins[1].value);
      if (t0 === null || t1 === null || t1 <= t0) {
        status('Geçersiz zaman — örnek: 1:23.4, bitiş > başlangıç olmalı.', 'error');
        renderTranscript();
        return;
      }
      applySegTime(i, t0, t1);
    }
    function cancel() {
      if (done) return; done = true;
      renderTranscript();
    }
    timeEl.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    });
    timeEl.addEventListener('focusout', function () {
      // odak iki input'un da dışına çıktıysa kaydet
      setTimeout(function () {
        if (!done && timeEl.isConnected && !timeEl.contains(document.activeElement)) commit();
      }, 0);
    });
    ins[0].focus(); ins[0].select();
  }

  function insertSegment(at, t0, t1) {
    S.segments.splice(at, 0, { t0: t0, t1: t1, text: '', words: null });
    renderTranscript();
    var el = $('transcript').querySelector('.seg[data-i="' + at + '"]');
    if (el) {
      S.programmaticScrollUntil = Date.now() + 700;
      el.scrollIntoView({ block: 'center' });
    }
    openTextEditor(at); // boş bırakılırsa blur satırı geri siler
  }
  function addLineAfter(i) {
    var cur = S.segments[i];
    if (!cur) return;
    var next = S.segments[i + 1];
    var t0 = cur.t1 + 0.05;
    var t1 = next ? Math.min(t0 + 2, Math.max(t0 + 0.5, next.t0 - 0.05)) : t0 + 2;
    insertSegment(i + 1, t0, t1);
  }
  function addLineAtPlayhead() {
    if (S.liveMode) return;
    var t0 = Math.max(0, S.lastPlayheadSec || 0);
    var at = 0;
    while (at < S.segments.length && S.segments[at].t0 <= t0) at++;
    var next = S.segments[at];
    var t1 = next ? Math.min(t0 + 2, Math.max(t0 + 0.5, next.t0 - 0.05)) : t0 + 2;
    insertSegment(at, t0, t1);
  }

  /* ================= arama ================= */
  function runSearch() {
    var q = $('search-box').value.trim();
    S.search.q = q; S.search.hits = []; S.search.idx = -1;
    var box = $('transcript');
    // temiz sayfadan başla: önceki aramanın <b> işaretleri ve bozulmuş kelime
    // span'ları kalmasın
    renderTranscript();
    if (!q) { $('search-count').textContent = ''; return; }
    var ql = q.toLocaleLowerCase('tr');
    S.segments.forEach(function (seg, i) {
      if (seg.text.toLocaleLowerCase('tr').indexOf(ql) !== -1) S.search.hits.push(i);
    });
    // vurgulama: eşleşen segmentlerin metnini <b> ile işaretle
    S.search.hits.forEach(function (i) {
      var el = box.querySelector('.seg[data-i="' + i + '"]');
      if (!el) return;
      el.classList.add('search-hit');
      var textEl = el.querySelector('.seg-text');
      var seg = S.segments[i];
      var t = seg.text, tl = t.toLocaleLowerCase('tr');
      var out = '', pos = 0, hit;
      while ((hit = tl.indexOf(ql, pos)) !== -1) {
        out += escapeHtml(t.slice(pos, hit)) + '<b>' + escapeHtml(t.slice(hit, hit + q.length)) + '</b>';
        pos = hit + q.length;
      }
      out += escapeHtml(t.slice(pos));
      textEl.innerHTML = out;
    });
    $('search-count').textContent = S.search.hits.length ? S.search.hits.length + ' eşleşme' : 'eşleşme yok';
    if (S.search.hits.length) gotoHit(0);
  }
  function gotoHit(dir) {
    if (!S.search.hits.length) return;
    S.search.idx = (S.search.idx + dir + S.search.hits.length) % S.search.hits.length;
    if (dir === 0) S.search.idx = 0;
    var i = S.search.hits[S.search.idx];
    var el = $('transcript').querySelector('.seg[data-i="' + i + '"]');
    if (el) {
      S.programmaticScrollUntil = Date.now() + 700;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    $('search-count').textContent = (S.search.idx + 1) + '/' + S.search.hits.length;
  }

  /* ================= bul-değiştir ================= */
  // Büyük/küçük harf duyarsız (tr), aramayla aynı eşleşme kuralı.
  // Tek seviye geri alma: son değiştirme işleminden önceki segment metinleri.
  function replaceInText(text, q, rep) {
    var tl = text.toLocaleLowerCase('tr'), ql = q.toLocaleLowerCase('tr');
    var out = '', pos = 0, hit, n = 0;
    while ((hit = tl.indexOf(ql, pos)) !== -1) {
      out += text.slice(pos, hit) + rep;
      pos = hit + q.length; n++;
    }
    out += text.slice(pos);
    return { text: out, n: n };
  }
  function replaceSegments(indices) {
    var q = $('search-box').value.trim();
    var rep = $('replace-box').value;
    if (!q) { status('Önce aranacak kelimeyi yaz.', 'error'); return; }
    if (!indices.length) { status('Eşleşme yok.', 'error'); return; }
    var undo = [], total = 0;
    indices.forEach(function (i) {
      var seg = S.segments[i];
      if (!seg) return;
      var r = replaceInText(seg.text, q, rep);
      var t = r.text.replace(/\s{2,}/g, ' ').trim(); // boş değiştirmede çift boşluk kalmasın
      if (!r.n || !t || t === seg.text) return;       // segmenti tamamen boşaltma
      undo.push({ i: i, text: seg.text, words: seg.words });
      setSegmentText(i, t);
      total += r.n;
    });
    if (!undo.length) { status('Değişen bir şey yok.', 'error'); return; }
    S.replaceUndo = undo;
    persistTranscript();
    runSearch(); // yeniden tarar, vurguları ve sayacı tazeler
    updateCaptionStats();
    $('btn-replace-undo').style.display = '';
    status(total + ' yerde "' + q + '" → "' + rep + '" değiştirildi (' + undo.length + ' segment).', 'ok');
  }
  function replaceCurrent() {
    if (!S.search.hits.length) { runSearch(); }
    if (!S.search.hits.length) { status('Eşleşme yok.', 'error'); return; }
    var idx = S.search.idx < 0 ? 0 : S.search.idx;
    replaceSegments([S.search.hits[idx]]);
    // runSearch sıfırladı; kaldığımız yerden devam et
    if (S.search.hits.length) {
      S.search.idx = Math.min(idx, S.search.hits.length) - 1;
      gotoHit(1);
    }
  }
  function replaceAll() {
    if (!S.search.hits.length) runSearch();
    replaceSegments(S.search.hits.slice());
  }
  function replaceUndo() {
    var undo = S.replaceUndo;
    if (!undo || !undo.length) return;
    undo.forEach(function (u) {
      var seg = S.segments[u.i];
      if (!seg) return;
      seg.text = u.text; seg.words = u.words;
    });
    S.replaceUndo = null;
    persistTranscript();
    runSearch();
    updateCaptionStats();
    $('btn-replace-undo').style.display = 'none';
    status(undo.length + ' segment geri alındı.', 'ok');
  }

  /* ================= transkripsiyon akışı ================= */
  function setBusy(b) {
    S.busy = b;
    $('btn-transcribe').disabled = b;
    $('btn-cancel').style.display = b ? '' : 'none';
    $('status-bar').classList.toggle('working', b);
  }

  function startTranscription() {
    if (S.busy) return;
    if (!W.available) { status('Node köprüsü yok: ' + (W.reason || ''), 'error'); return; }
    // busy bayrağı HEMEN kalkar — async callback'i bekleyen çift tıklama
    // ikinci bir whisper süreci başlatamaz
    setBusy(true);

    refreshEnv(function (env) {
      if (!env.ok || !env.seq) { setBusy(false); status('Aktif sequence yok — Premiere\'de bir sequence aç.', 'error'); return; }
      var jobSeqId = env.seq.id;

      var modelFile = $('model-select').value;
      var modelPath = modelFile ? W.findModelFile(modelFile) : null;
      if (!modelPath) { setBusy(false); status('Model seç ya da Modeller sekmesinden indir.', 'error'); switchTab('models-page'); return; }

      var mode = $('transcribe-range').value;
      if (mode === 'inout' && (env.seq.inSec === null || env.seq.outSec === null || env.seq.outSec <= env.seq.inSec)) {
        setBusy(false); status('In–Out aralığı tanımlı değil.', 'error'); return;
      }

      S.settings.modelFile = modelFile;
      S.settings.range = mode;
      S.settings.language = $('lang-select').value;
      S.settings.translate = $('opt-translate').checked;
      saveSettings();

      setBusy(true);
      status('Ses dışa aktarılıyor… (Premiere bu sırada kısa süre meşgul olur)');
      progress(null);

      var wavPath = W.pathx.join(W.CACHE_DIR, 'audio_' + Date.now() + '.wav');
      var eprPath = W.pathx.join(EXT_PATH, 'payloads', 'WAV_Mono_16bit_16kHz.epr');

      callHost('exportAudio', { outPath: wavPath, eprPath: eprPath, mode: mode }, function (res) {
        if (!res.ok) { setBusy(false); status('Ses dışa aktarılamadı: ' + res.error, 'error'); return; }

        S.offsetSec = res.offsetSec || 0;
        S.segments = [];
        S.liveMode = true;
        renderTranscript();
        status('Transkripsiyon çalışıyor… (canlı akış)');
        progress(0);

        var segCount = 0;
        S.proc = W.transcribe({
          wavPath: res.outPath,
          modelPath: modelPath,
          whisperPath: S.settings.whisperPath,
          language: S.settings.language,
          translate: S.settings.translate,
          threads: S.settings.threads,
          vad: S.settings.vad,
          vadModelPath: W.findVadModel(),
          prompt: S.settings.prompt || ''
        }, {
          onSegment: function (seg) {
            var s = { t0: S.offsetSec + seg.t0 / 1000, t1: S.offsetSec + seg.t1 / 1000, text: seg.text, words: null };
            S.segments.push(s);
            appendLiveSegment(s, segCount++);
            status('Transkripsiyon… ' + segCount + ' segment');
          },
          onProgress: function (pct) { progress(pct); },
          onDone: function (result) {
            S.proc = null;
            S.liveMode = false;
            // Kesin sonuç: JSON'dan segment + kelime zamanları
            var finalSegs = [];
            (result.json.transcription || []).forEach(function (rawSeg) {
              var text = String(rawSeg.text || '').trim();
              if (!text) return;
              var words = C.wordsFromWhisperJson({ transcription: [rawSeg] })
                .map(function (w) { return { t0: S.offsetSec + w.t0 / 1000, t1: S.offsetSec + w.t1 / 1000, text: w.text }; });
              finalSegs.push({
                t0: S.offsetSec + rawSeg.offsets.from / 1000,
                t1: S.offsetSec + rawSeg.offsets.to / 1000,
                text: text,
                words: words.length ? words : null
              });
            });
            // Whisper'ın erken başlattığı segmentleri ses enerjisine göre hizala
            // (wav'a göre ms; sequence offset'i düşülüp geri eklenir)
            if (finalSegs.length) {
              try {
                var prof = W.wavRms(res.outPath, 50);
                if (prof) {
                  var rel = finalSegs.map(function (sg) {
                    return {
                      t0: Math.round((sg.t0 - S.offsetSec) * 1000), t1: Math.round((sg.t1 - S.offsetSec) * 1000), text: sg.text,
                      words: sg.words ? sg.words.map(function (w) { return { t0: Math.round((w.t0 - S.offsetSec) * 1000), t1: Math.round((w.t1 - S.offsetSec) * 1000), text: w.text }; }) : null
                    };
                  });
                  var snapped = C.snapToSpeech(rel, prof.rms, prof.winMs);
                  finalSegs = snapped.map(function (sg) {
                    return {
                      t0: S.offsetSec + sg.t0 / 1000, t1: S.offsetSec + sg.t1 / 1000, text: sg.text,
                      words: sg.words ? sg.words.map(function (w) { return { t0: S.offsetSec + w.t0 / 1000, t1: S.offsetSec + w.t1 / 1000, text: w.text }; }) : null
                    };
                  });
                }
              } catch (eSnap) { /* hizalama isteğe bağlı; sessizce atla */ }
            }
            if (finalSegs.length) S.segments = finalSegs;
            renderTranscript();
            persistTranscript(jobSeqId);
            updateCaptionStats();
            setBusy(false);
            progress(null);
            var lang = result.json.result && result.json.result.language;
            status(S.segments.length + ' segment hazır' + (lang ? ' · dil: ' + lang : ''), 'ok');
          },
          onError: function (msg) {
            S.proc = null; S.liveMode = false;
            setBusy(false); progress(null);
            status(msg, 'error');
          },
          onCancel: function () {
            S.proc = null; S.liveMode = false;
            setBusy(false); progress(null);
            status('Durduruldu. ' + S.segments.length + ' segment alındı.', '');
            if (S.segments.length) { renderTranscript(); persistTranscript(jobSeqId); }
          }
        });
      });
    });
  }

  /* ================= altyazı üretimi ================= */
  function readStyle() {
    return {
      fontFamily: $('st-font').value,
      fontSizePct: parseFloat($('st-size').value),
      textColor: $('st-color').value,
      bold: $('st-bold').checked,
      italic: $('st-italic').checked,
      uppercase: $('st-upper').checked,
      outlineEnabled: $('st-outline-on').checked,
      outlineColor: $('st-outline-color').value,
      outlineWidth: parseFloat($('st-outline-w').value),
      backgroundEnabled: $('st-bg-on').checked,
      backgroundColor: $('st-bg-color').value,
      backgroundAlpha: parseFloat($('st-bg-alpha').value),
      position: $('st-pos').value,
      marginVPct: isNaN(parseFloat($('st-margin').value)) ? 6 : parseFloat($('st-margin').value),
      karaoke: $('st-karaoke').checked,
      karaokeColor: $('st-karaoke-color').value
    };
  }
  function readCapOpts() {
    return {
      wordMode: $('cap-mode').value === 'word',
      maxCharsPerLine: parseInt($('cap-maxchars').value, 10) || 42,
      maxLines: parseInt($('cap-maxlines').value, 10) || 2,
      maxDurMs: (parseFloat($('cap-maxdur').value) || 6) * 1000,
      minDurMs: (parseFloat($('cap-mindur').value) || 1) * 1000,
      gapSplitMs: (parseFloat($('cap-gap').value) || 1) * 1000,
      splitOnPunct: $('cap-punct').checked,
      splitOnSegment: $('cap-splitseg').checked,
      maxCps: parseInt($('cap-maxcps').value, 10) || 21,
      uppercase: $('st-upper').checked
    };
  }

  // Kullanıcının "Zaman kaydırma" değeri (sn, ± olabilir). Kaydedilmez — proje
  // bazlı bir düzeltmedir, panel yeniden açılınca 0'a döner.
  function readOffsetMs() { return Math.round((parseFloat($('cap-offset').value) || 0) * 1000); }

  // capOverrides: overlay gibi tuvale bağlı çıktılar için bölümleme ayarını ezer
  function buildBlocks(capOverrides) {
    if (!S.segments.length) return [];
    var off = readOffsetMs();
    var sh = function (ms) { return Math.max(0, ms + off); };
    var msSegs = S.segments.map(function (s) {
      return {
        t0: sh(Math.round(s.t0 * 1000)), t1: sh(Math.round(s.t1 * 1000)), text: s.text,
        words: s.words ? s.words.map(function (w) {
          return { t0: sh(Math.round(w.t0 * 1000)), t1: sh(Math.round(w.t1 * 1000)), text: w.text };
        }) : null
      };
    });
    var opts = readCapOpts();
    if (capOverrides) Object.keys(capOverrides).forEach(function (k) { opts[k] = capOverrides[k]; });
    return C.buildCaptions(msSegs, opts);
  }

  // Gerçek metin ölçümü (CEP = Chromium): canvas measureText, libass'ın
  // kullanacağı sistem fontuyla ölçer. Kestirimden çok daha isabetli.
  var _measureCtx = null;
  function measurePx(text, fontPx, st) {
    try {
      if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
      _measureCtx.font = (st.italic ? 'italic ' : '') + (st.bold ? '700 ' : '400 ') +
        fontPx + 'px "' + st.fontFamily + '", sans-serif';
      return _measureCtx.measureText(st.uppercase ? String(text).toLocaleUpperCase('tr') : String(text)).width;
    } catch (e) { return String(text).length * fontPx * 0.55; }
  }

  // Overlay için: satır uzunluğunu sequence genişliği + yazı boyutuna göre sınırla
  function overlayCapOverrides(seq, st) {
    if (!seq || !seq.width || !seq.height) return null;
    var fontPx = seq.height * st.fontSizePct / 100;
    var usable = seq.width * 0.9;
    // ortalama karakter genişliği: örnek Türkçe pangram üstünden
    var sample = 'Pijamalı hasta yağız şoföre çabucak güvendi. 0123456789';
    var avg = measurePx(sample, fontPx, st) / sample.length;
    var fit = Math.max(4, Math.floor(usable / avg));
    var user = parseInt($('cap-maxchars').value, 10) || 42;
    return fit < user ? { maxCharsPerLine: fit } : null;
  }

  function updateCaptionStats() {
    var blocks = buildBlocks();
    if (!blocks.length) { $('caption-stats').textContent = 'Önce transkript üret.'; return; }
    var maxCps = readCapOpts().maxCps;
    var warn = blocks.filter(function (b) { return b.cps > maxCps; }).length;
    var avg = blocks.reduce(function (a, b) { return a + b.cps; }, 0) / blocks.length;
    $('caption-stats').textContent = blocks.length + ' blok · ortalama ' + (Math.round(avg * 10) / 10) +
      ' CPS' + (warn ? ' · ' + warn + ' blok ' + maxCps + ' CPS üstünde ⚠' : ' · hız uygun ✓');
  }

  function updatePreview() {
    var st = readStyle();
    var pv = $('style-preview');
    var cap = pv.querySelector('.pv-caption');
    // tuval: sequence oranında (dikey video → dik kutu); bilinmiyorsa 16:9
    var seq = S.env && S.env.seq;
    var aspect = (seq && seq.width && seq.height) ? seq.width / seq.height : 16 / 9;
    var outerW = (pv.parentNode.clientWidth || 400) - 20;
    var H = Math.round(Math.min(260, Math.max(110, outerW / aspect)));
    var Wpx = Math.round(H * aspect);
    if (Wpx > outerW) { Wpx = outerW; H = Math.round(Wpx / aspect); }
    pv.style.height = H + 'px'; pv.style.width = Wpx + 'px';
    var fontPx = Math.max(6, H * st.fontSizePct / 100);
    var scale = H / 720;
    cap.style.fontFamily = st.fontFamily;
    cap.style.fontSize = fontPx + 'px';
    cap.style.fontWeight = st.bold ? '700' : '400';
    cap.style.fontStyle = st.italic ? 'italic' : 'normal';
    cap.style.color = st.textColor;
    cap.style.textTransform = st.uppercase ? 'uppercase' : 'none';
    var o = Math.max(0.5, st.outlineWidth * scale);
    cap.style.textShadow = (st.outlineEnabled && st.outlineWidth > 0) ?
      ('-' + o + 'px 0 ' + st.outlineColor + ', ' + o + 'px 0 ' + st.outlineColor +
       ', 0 -' + o + 'px ' + st.outlineColor + ', 0 ' + o + 'px ' + st.outlineColor) : 'none';
    if (st.backgroundEnabled) {
      var m = /^#?(..)(..)(..)$/.exec(st.backgroundColor);
      cap.style.background = m ? 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' +
        parseInt(m[3], 16) + ',' + st.backgroundAlpha + ')' : st.backgroundColor;
    } else cap.style.background = 'none';
    cap.style.top = ''; cap.style.bottom = ''; cap.style.transform = 'translateX(-50%)';
    var mv = (st.marginVPct / 100) * H;
    if (st.position === 'top') cap.style.top = mv + 'px';
    else if (st.position === 'middle') { cap.style.top = '50%'; cap.style.transform = 'translate(-50%,-50%)'; }
    else cap.style.bottom = mv + 'px';
    // metin: transkript varsa gerçek ilk blok (overlay sığdırmasıyla), yoksa örnek
    var lines = ['Böyle görünecek —', 'altyazı önizlemesi'];
    if (S.segments.length) {
      try {
        var b0 = buildBlocks(overlayCapOverrides(seq, st))[0];
        if (b0 && b0.lines.length) lines = b0.lines;
      } catch (e) {}
    }
    var html = lines.map(function (l, i) {
      var words = l.split(' ').map(escapeHtml);
      if (st.karaoke && i === 0 && words.length) words[0] = '<span style="color:' + st.karaokeColor + '">' + words[0] + '</span>';
      return words.join(' ');
    }).join('<br>');
    cap.innerHTML = html;
    $('preview-meta').textContent = seq && seq.width ? seq.width + '×' + seq.height + ' · yazı ' + Math.round(seq.height * st.fontSizePct / 100) + 'px' : '';
  }

  function ensureBlocksOrWarn() {
    var blocks = buildBlocks();
    if (!blocks.length) { status('Önce transkript üret.', 'error'); switchTab('transcribe-page'); return null; }
    return blocks;
  }

  /* ================= stil → Premiere ================= */
  var PS = window.FisiltiPrStyle;

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
  }
  function uuid4() {
    var h = '0123456789abcdef', out = '';
    for (var i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) { out += '-'; continue; }
      if (i === 14) { out += '4'; continue; }
      var r = Math.floor(Math.random() * 16);
      if (i === 19) r = (r & 3) | 8;
      out += h[r];
    }
    return out;
  }

  // Panelin o anki stilinden Premiere metin stili üretir, yerel stil deposuna
  // yazar ve projeye import etmeyi dener. cb(name|null, hata)
  function exportStyleToPremiere(cb) {
    if (!PS) { if (cb) cb(null, 'prstyle.js yüklenmedi'); return; }
    var seq = S.env && S.env.seq;
    var H = (seq && seq.height) || 1080;
    var st = readStyle();
    var map = W.loadFontMap();
    function go(fontMap) {
      var ps = W.resolvePostScriptName(st.fontFamily, st.bold, st.italic, fontMap) || st.fontFamily;
      var blob = PS.buildBlob({
        font: ps,
        size: Math.max(8, Math.round(H * st.fontSizePct / 100)),
        fill: hexToRgb(st.textColor),
        strokeW: Math.round(st.outlineWidth * (H / 720) * 10) / 10,
        stroke: hexToRgb(st.outlineColor),
        c17: hexToRgb(st.backgroundColor),
        f12: Math.round((st.backgroundAlpha != null ? st.backgroundAlpha : 1) * 100),
        b11: st.backgroundEnabled ? 1 : 0
      });
      var b64 = PS.toBase64(blob);
      // ad: içerik aynıysa mevcut adı kullan; değilse boştaki ilk "Fisilti N"
      var name = null;
      for (var n = 1; n < 50; n++) {
        var cand = n === 1 ? 'Fisilti' : 'Fisilti ' + n;
        var existing = W.readTextFile(W.pathx.join(W.PR_STYLES_DIR, cand + '.prtextstyle'));
        if (existing === null) { name = cand; break; }
        if (existing.replace(/\s/g, '').indexOf(b64) !== -1) { // aynı stil zaten kayıtlı
          if (cb) cb(cand, null, true);
          return;
        }
      }
      if (!name) { if (cb) cb(null, 'stil deposu dolu (Fisilti 1-49)'); return; }
      var tpl = W.readTextFile(W.pathx.join(EXT_PATH, 'payloads', 'style_template.prtextstyle'));
      if (!tpl) { if (cb) cb(null, 'style_template.prtextstyle bulunamadı'); return; }
      var doc = PS.makePrtextstyle(tpl, name, blob, uuid4);
      var outPath = W.pathx.join(W.PR_STYLES_DIR, name + '.prtextstyle');
      try { W.writeTextFile(outPath, doc); } catch (e) { if (cb) cb(null, String(e)); return; }
      // projeye de import etmeyi dene (başarısızlık önemli değil — yerel stil yazıldı)
      callHost('importFile', { path: outPath }, function (res) {
        if (cb) cb(name, null, false, !!(res && res.ok && res.added > 0));
      });
    }
    if (map) go(map);
    else {
      status('Font listesi çıkarılıyor (ilk sefer, ~15 sn)…');
      W.buildFontMap(function (m) { go(m); });
    }
  }

  function saveStyleToPremiere() {
    setBusy(true);
    exportStyleToPremiere(function (name, err2, already, imported) {
      setBusy(false);
      if (err2) { status('Stil kaydedilemedi: ' + err2, 'error'); return; }
      if (already) status('Bu stil zaten kayıtlı: "' + name + '" — caption seç → Özellikler > Track Style ▾ / stil tarayıcısından uygula.', 'ok');
      else status('Stil "' + name + '" Premiere\'e kaydedildi' + (imported ? ' (projeye de eklendi)' : '') + ' — caption seç → Özellikler > Track Style ▾ menüsünden seç.', 'ok');
    });
  }

  function addCaptionTrack() {
    var blocks = ensureBlocksOrWarn();
    if (!blocks) return;
    var srt = C.toSRT(blocks);
    var p = W.pathx.join(W.CACHE_DIR, 'fisilti_' + Date.now() + '.srt');
    W.writeFile(p, srt, true); // UTF-8 BOM — Premiere Türkçe karakterler için ister
    // stil arka planda Premiere'e taşınır — caption track eklemeyi bekletmez
    exportStyleToPremiere(function (name) {
      if (name) status('Caption track + stil hazır: Track Style ▾ → "' + name + '".', 'ok');
    });
    status('Caption track ekleniyor…');
    callHost('importSrtAsCaptions', { srtPath: p, startAtSec: 0 }, function (res) {
      if (res.ok) status('Caption track eklendi ✓ Stil: caption\'ı seç → Özellikler (Properties) panelinde Track Style.', 'ok');
      else status('Caption track eklenemedi: ' + res.error, 'error');
    });
  }

  function addOverlay() {
    if (!S.env || !S.env.seq) { status('Sequence bilgisi yok.', 'error'); return; }
    if (!S.settings.ffmpegPath && !W.detectFfmpeg()) {
      status('Stilli overlay için ffmpeg gerekli — Ayarlar sekmesindeki İndir düğmesiyle tek tıkla kur.', 'error');
      switchTab('settings-page');
      return;
    }
    var seq = S.env.seq;
    var st = readStyle();
    var blocks = buildBlocks(overlayCapOverrides(seq, st));
    if (!blocks.length) { status('Önce transkript üret.', 'error'); switchTab('transcribe-page'); return; }
    // tek kelime bile sığmıyorsa libass saramaz — yazı boyutunu düşürmesini iste
    var fontPx = seq.height * st.fontSizePct / 100, usable = seq.width * 0.9;
    var worstPx = 0, worstWord = '';
    blocks.forEach(function (b) {
      b.lines.forEach(function (l) {
        String(l).split(/\s+/).forEach(function (w) {
          var px = measurePx(w, fontPx, st);
          if (px > worstPx) { worstPx = px; worstWord = w; }
        });
      });
    });
    if (worstPx > usable) {
      var maxPct = Math.floor(st.fontSizePct * (usable / worstPx) * 10) / 10;
      status('Yazı bu sequence (' + seq.width + '×' + seq.height + ') için büyük: "' + worstWord + '" sığmıyor. Boyutu en çok %' + maxPct + ' yap.', 'error');
      return;
    }
    var ass = C.toASS(blocks, st, seq.width, seq.height);
    var assPath = W.pathx.join(W.CACHE_DIR, 'fisilti_' + Date.now() + '.ass');
    W.writeFile(assPath, ass, false);
    // .mov proje medyası olur — cache'e değil kalıcı overlays klasörüne
    var outPath = W.pathx.join(W.OVERLAYS_DIR, 'fisilti_overlay_' + Date.now() + '.mov');
    var durSec = blocks[blocks.length - 1].t1 / 1000 + 0.3;

    setBusy(true);
    status('Overlay render ediliyor (ProRes 4444 + alfa)…');
    progress(0);
    S.overlayProc = W.renderOverlay({
      ffmpegPath: S.settings.ffmpegPath,
      assPath: assPath, width: seq.width, height: seq.height,
      fps: seq.fps, durationSec: durSec, outPath: outPath
    }, {
      onProgress: function (pct) { progress(pct); },
      onDone: function (movPath) {
        S.overlayProc = null;
        status('Overlay sequence\'e ekleniyor…');
        callHost('importOverlay', { path: movPath, atSec: 0 }, function (res) {
          setBusy(false); progress(null);
          if (res.ok) status('Stilli overlay V' + res.track + ' kanalına eklendi ✓', 'ok');
          else status('Overlay eklenemedi: ' + res.error, 'error');
        });
      },
      onError: function (msg) { S.overlayProc = null; setBusy(false); progress(null); status(msg, 'error'); },
      onCancel: function () { S.overlayProc = null; setBusy(false); progress(null); status('Overlay render durduruldu.', ''); }
    });
  }

  /* ================= dışa aktarma ================= */
  function saveAs(defaultName, content, withBom) {
    try {
      var res = window.cep.fs.showSaveDialogEx('Kaydet', '', null, defaultName);
      if (res && res.data) {
        W.writeFile(res.data, content, !!withBom);
        status('Kaydedildi: ' + res.data, 'ok');
        return;
      }
      if (res && res.err === 0) return; // kullanıcı vazgeçti
    } catch (e) {}
    // geri düşüş: Desktop'a yaz
    var p = W.pathx.join(W.pathx.join(process.env.HOME || '~', 'Desktop'), defaultName);
    W.writeFile(p, content, !!withBom);
    W.openInFinder(p);
    status('Masaüstüne kaydedildi: ' + defaultName, 'ok');
  }

  function exportFormat(kind) {
    var blocks = ensureBlocksOrWarn();
    if (!blocks) return;
    var base = (S.env && S.env.seq ? S.env.seq.name.replace(/[^\wçğıöşüÇĞİÖŞÜ-]+/g, '_') : 'fisilti');
    if (kind === 'srt') saveAs(base + '.srt', C.toSRT(blocks), true);
    else if (kind === 'vtt') saveAs(base + '.vtt', C.toVTT(blocks), false);
    else if (kind === 'txt') saveAs(base + '.txt', C.toTXT(blocks), false);
    else if (kind === 'csv') saveAs(base + '.csv', C.toCSV(blocks), true);
    else if (kind === 'ass') {
      var seq = (S.env && S.env.seq) || { width: 1920, height: 1080 };
      saveAs(base + '.ass', C.toASS(blocks, readStyle(), seq.width, seq.height), false);
    }
  }

  function addMarkers() {
    if (!S.segments.length) { status('Önce transkript üret.', 'error'); return; }
    var markers = S.segments.map(function (s) {
      return { startSec: s.t0, endSec: s.t1, name: s.text.slice(0, 40), comment: s.text };
    });
    callHost('addMarkers', { markers: markers }, function (res) {
      if (res.ok) status(res.added + ' marker eklendi ✓', 'ok');
      else status('Marker eklenemedi: ' + res.error, 'error');
    });
  }

  /* ================= modeller sekmesi ================= */
  function renderModels() {
    var list = $('model-list');
    var models = W.listModels();
    list.innerHTML = models.map(function (m) {
      var stateHtml;
      if (S.downloads[m.key]) {
        stateHtml = '<div class="progress"><div id="dl-' + m.key + '" style="width:0%"></div></div>' +
          '<button class="btn small danger" data-cancel="' + m.key + '">İptal</button>';
      } else if (m.installed) {
        stateHtml = (m.deletable ? '<button class="btn small danger" data-del="' + m.key + '">Sil</button>' : '<span class="hint">harici</span>');
      } else {
        stateHtml = '<button class="btn small primary" data-dl="' + m.key + '">İndir</button>';
      }
      return '<div class="model-item' + (m.installed ? ' installed' : '') + '">' +
        '<div class="m-info"><div class="m-name">' + m.key + '</div>' +
        '<div class="m-meta">' + fmtBytes(m.bytes) + ' · ' + m.note + (m.path ? '<br>' + m.path : '') + '</div></div>' +
        stateHtml + '</div>';
    }).join('');
    populateModelSelect(models);
  }

  function populateModelSelect(models) {
    models = models || W.listModels();
    var sel = $('model-select');
    var installed = models.filter(function (m) { return m.installed && !m.isVad; });
    if (!installed.length) {
      sel.innerHTML = '<option value="">model yok — Modeller sekmesi</option>';
      return;
    }
    sel.innerHTML = installed.map(function (m) {
      return '<option value="' + m.file + '">' + m.key + '</option>';
    }).join('');
    if (installed.some(function (m) { return m.file === S.settings.modelFile; })) sel.value = S.settings.modelFile;
  }

  function wireModels() {
    $('model-list').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      var key = b.getAttribute('data-dl') || b.getAttribute('data-del') || b.getAttribute('data-cancel');
      var entry = W.CATALOG.concat([W.VAD_MODEL]).filter(function (m) { return m.key === key; })[0];
      if (!entry) return;

      if (b.hasAttribute('data-dl')) {
        S.downloads[key] = W.downloadModel(entry, {
          onProgress: function (pct) {
            var bar = $('dl-' + key);
            if (bar) bar.style.width = pct + '%';
          },
          onDone: function () { delete S.downloads[key]; renderModels(); status(key + ' indirildi ✓', 'ok'); },
          onError: function (msg) { delete S.downloads[key]; renderModels(); status(msg, 'error'); },
          onCancel: function () { delete S.downloads[key]; renderModels(); }
        });
        renderModels();
      } else if (b.hasAttribute('data-del')) {
        W.deleteModel(entry.file);
        renderModels();
        status(key + ' silindi', '');
      } else if (b.hasAttribute('data-cancel')) {
        if (S.downloads[key]) S.downloads[key].cancel();
        delete S.downloads[key];
        renderModels();
      }
    });
  }

  /* ================= sekmeler & ayarlar ================= */
  function switchTab(pageId) {
    document.querySelectorAll('#tabs button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === pageId);
    });
    document.querySelectorAll('.tab-page').forEach(function (p) {
      p.classList.toggle('active', p.id === pageId);
    });
    if (pageId === 'models-page') renderModels();
    if (pageId === 'caption-page') { updatePreview(); updateCaptionStats(); }
  }

  function wireSettings() {
    $('set-whisper-path').value = S.settings.whisperPath;
    $('set-ffmpeg-path').value = S.settings.ffmpegPath;
    $('set-threads').value = S.settings.threads;
    $('set-poll').value = S.settings.pollMs;
    $('opt-vad').checked = !!S.settings.vad;

    $('set-whisper-path').addEventListener('change', function () { S.settings.whisperPath = this.value.trim(); saveSettings(); });
    $('set-ffmpeg-path').addEventListener('change', function () { S.settings.ffmpegPath = this.value.trim(); saveSettings(); });
    $('set-threads').addEventListener('change', function () { S.settings.threads = parseInt(this.value, 10) || 6; saveSettings(); });
    function normPrompt(v) {
      // satır sonlarını ve fazla virgülleri tek biçime getir: "a, b, c"
      return v.split(/[\n,]+/).map(function (x) { return x.trim(); }).filter(Boolean).join(', ');
    }
    $('set-prompt').addEventListener('input', function () { S.settings.prompt = normPrompt(this.value); saveSettings(); });
    $('set-prompt').addEventListener('change', function () { this.value = S.settings.prompt = normPrompt(this.value); saveSettings(); });
    $('set-poll').addEventListener('change', function () {
      S.settings.pollMs = Math.max(100, parseInt(this.value, 10) || 250);
      saveSettings(); startPolling();
    });
    $('opt-vad').addEventListener('change', function () {
      S.settings.vad = this.checked;
      if (this.checked && !W.findVadModel()) {
        status('VAD modeli inmemiş — Modeller sekmesinden indir.', 'error');
      }
      saveSettings();
    });
    $('btn-detect-whisper').addEventListener('click', function () {
      var p = W.detectWhisper();
      if (p) { $('set-whisper-path').value = p; S.settings.whisperPath = p; saveSettings(); status('Bulundu: ' + p, 'ok'); }
      else status('whisper-cli bulunamadı — eklentiyle gömülü gelir; paketi yeniden kurmayı dene.', 'error');
    });
    $('btn-detect-ffmpeg').addEventListener('click', function () {
      var p = W.detectFfmpeg();
      if (p) { $('set-ffmpeg-path').value = p; S.settings.ffmpegPath = p; saveSettings(); status('Bulundu: ' + p, 'ok'); }
      else status('ffmpeg bulunamadı — yandaki İndir düğmesi statik derlemeyi kurar (brew gerekmez).', 'error');
    });
    $('btn-install-ffmpeg').addEventListener('click', function () {
      var btn = this;
      if (S.ffmpegDl) { // ikinci tıklama: iptal
        S.ffmpegDl.cancel(); S.ffmpegDl = null;
        btn.textContent = 'İndir'; progress(null);
        status('ffmpeg indirmesi iptal edildi.', '');
        return;
      }
      btn.textContent = 'İptal';
      status('ffmpeg indiriliyor… (statik derleme — brew/Xcode gerekmez)');
      progress(0);
      S.ffmpegDl = W.downloadFfmpeg({
        onProgress: progress,
        onDone: function (p) {
          S.ffmpegDl = null; btn.textContent = 'İndir'; progress(null);
          $('set-ffmpeg-path').value = p; S.settings.ffmpegPath = p; saveSettings();
          status('ffmpeg kuruldu ✓ ' + p, 'ok');
        },
        onError: function (msg) { S.ffmpegDl = null; btn.textContent = 'İndir'; progress(null); status(msg, 'error'); },
        onCancel: function () { S.ffmpegDl = null; btn.textContent = 'İndir'; progress(null); }
      });
    });
    $('btn-clear-cache').addEventListener('click', function () {
      var n = W.cleanCache();
      status(n + ' geçici dosya silindi', 'ok');
    });
    $('btn-open-logs').addEventListener('click', function () { W.openInFinder(W.LOG_DIR); });

    var v = W.versions();
    var ver = W.currentVersion();
    $('debug-info').innerHTML = (ver ? 'Fısıltı ' + escapeHtml(ver) + ' · ' : '') +
      'Node ' + escapeHtml(v.node || '?') +
      (v.whisper ? ' · ' + escapeHtml(v.whisper) : '') +
      '<br>Eklenti: ' + escapeHtml(EXT_PATH);
  }

  /* ================= sürüm denetimi & güncelleme ================= */
  function checkForUpdate(auto) {
    $('update-info').textContent = 'Denetleniyor…';
    W.checkUpdate(function (res) {
      if (!res) {
        $('update-info').textContent = auto ? '—' : 'Denetlenemedi — ağ bağlantısını kontrol et.';
        return;
      }
      if (res.newer && W.isDevInstall()) {
        // dev kurulum: reddedecek düğme göstermenin anlamı yok
        $('update-info').textContent = 'Yeni sürüm: ' + res.latest + ' — geliştirici kurulumu, git pull ile güncelle.';
        $('btn-do-update').style.display = 'none';
      } else if (res.newer) {
        S.pendingUpdate = res;
        $('update-info').textContent = 'Yeni sürüm var: ' + res.latest + ' (kurulu: ' + res.current + ')';
        $('btn-do-update').style.display = '';
        if (auto) status('Yeni sürüm var: ' + res.latest + ' — Ayarlar sekmesinden Güncelle', 'ok');
      } else {
        $('update-info').textContent = 'Güncel (' + res.current + ')';
        $('btn-do-update').style.display = 'none';
      }
    });
  }
  function wireUpdate() {
    $('btn-check-update').addEventListener('click', function () { checkForUpdate(false); });
    $('btn-do-update').addEventListener('click', function () {
      if (!S.pendingUpdate || S.updateDl) return;
      var btn = this;
      btn.disabled = true;
      status('Güncelleme indiriliyor: ' + S.pendingUpdate.latest + '…');
      progress(0);
      S.updateDl = W.selfUpdate(S.pendingUpdate.url, {
        onProgress: progress,
        onDone: function (ver) {
          S.updateDl = null; btn.disabled = false; progress(null);
          $('update-info').textContent = 'Kuruldu: ' + ver + ' — paneli kapatıp aç.';
          $('btn-do-update').style.display = 'none';
          status('Güncellendi → ' + ver + ' ✓ Paneli kapatıp açınca yeni sürüm çalışır.', 'ok');
        },
        onError: function (msg) {
          S.updateDl = null; btn.disabled = false; progress(null);
          $('update-info').textContent = msg;
          status(msg, 'error');
        },
        onCancel: function () { S.updateDl = null; btn.disabled = false; progress(null); }
      });
    });
  }

  /* ================= renk seçici =================
   * CEP'in CEF'i <input type="color"> için sistem penceresini açmıyor. Native
   * input'u değer taşıyıcı + renk örneği olarak tutuyoruz; tıklayınca kendi
   * popover'ımız açılıyor (palet + hex). Değer değişince 'input' olayı
   * tetiklenir, böylece mevcut dinleyiciler (önizleme, ayar kaydı) aynen çalışır. */
  var COLOR_PRESETS = [
    '#FFFFFF', '#F2F2F2', '#BFBFBF', '#808080', '#404040', '#000000',
    '#FFD400', '#FFB000', '#FF7A00', '#FF3B30', '#E0005A', '#B400B4',
    '#7B3FE4', '#3478F6', '#00A3FF', '#00C2A8', '#34C759', '#8DD600',
    '#FFF3B0', '#FFD6A5', '#FFADAD', '#CDB4FF', '#A0E7FF', '#B9FBC0'
  ];
  function normalizeHex(v) {
    v = String(v || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(v)) v = v.replace(/(.)/g, '$1$1');
    if (!/^[0-9a-f]{6}$/i.test(v)) return null;
    return '#' + v.toUpperCase();
  }
  function wireColorPickers() {
    var pop = document.createElement('div');
    pop.id = 'color-pop';
    pop.style.display = 'none';
    pop.innerHTML = '<div class="swatches"></div>' +
      '<button class="btn small" id="color-pop-eye" title="Ekranın herhangi bir yerinden renk örnekle">Damlalık — ekrandan seç</button>' +
      '<div class="hexrow"><input type="text" id="color-pop-hex" maxlength="7" spellcheck="false">' +
      '<button class="btn small" id="color-pop-ok">Tamam</button></div>';
    document.body.appendChild(pop);
    var sw = pop.querySelector('.swatches');
    COLOR_PRESETS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'swatch'; b.style.background = c; b.title = c;
      b.setAttribute('data-c', c);
      sw.appendChild(b);
    });
    var hex = $('color-pop-hex');
    var target = null;

    function apply(v, close) {
      var h = normalizeHex(v);
      if (!h || !target) return;
      if (target.value.toUpperCase() !== h) {
        target.value = h;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }
      hex.value = h;
      if (close) hide();
    }
    function show(input) {
      target = input;
      hex.value = String(input.value || '#FFFFFF').toUpperCase();
      pop.style.display = '';
      // hedefin altına; sağ/alt kenardan taşarsa içeri çek
      var r = input.getBoundingClientRect();
      var left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8);
      var top = r.bottom + 4;
      if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 4);
      pop.style.left = Math.max(8, left) + 'px';
      pop.style.top = top + 'px';
      setTimeout(function () { hex.focus(); hex.select(); }, 0);
    }
    function hide() { pop.style.display = 'none'; target = null; }

    document.querySelectorAll('input[type="color"]').forEach(function (input) {
      input.addEventListener('click', function (ev) {
        ev.preventDefault(); // native pencere (CEP'te açılmıyor) yerine bizimki
        if (target === input) { hide(); return; }
        show(input);
      });
    });
    // Damlalık: gömülü sistem örnekleyicisi (NSColorSampler) — imleçte büyüteç
    // lupu açılır, tıklanan pikseli verir. (Chromium EyeDropper API'si bilerek
    // kullanılmıyor: CEP'in CEF'inde yüzeyi olsa da arayüzü yok — promise asılı
    // kalıyor; çalışsaydı da yalnız panelin kendi içinden örnekleyebilirdi.)
    var picking = false;
    $('color-pop-eye').addEventListener('click', function () {
      var tgt = target;
      if (!tgt || picking) return;
      picking = true;
      status('Damlalık açık — ekranda istediğin renge tıkla (Esc: vazgeç).', '');
      W.pickColorNative(tgt.value, function (hex) {
        picking = false;
        if (!hex) { status('hazır'); return; } // iptal
        target = tgt; // seçim sırasında popover kapanmış olabilir — hedefi geri bağla
        apply(hex, true);
        status('Renk uygulandı: ' + hex, 'ok');
      });
    });

    sw.addEventListener('click', function (ev) {
      var b = ev.target.closest('.swatch');
      if (b) apply(b.getAttribute('data-c'), true);
    });
    hex.addEventListener('input', function () { apply(hex.value, false); });
    hex.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); apply(hex.value, true); }
      if (ev.key === 'Escape') hide();
    });
    $('color-pop-ok').addEventListener('click', function () { apply(hex.value, true); });
    document.addEventListener('mousedown', function (ev) {
      if (pop.style.display === 'none') return;
      if (pop.contains(ev.target) || ev.target === target) return;
      hide();
    });
  }

  function restoreStyleInputs() {
    var st = S.settings.style, cp2 = S.settings.caps;
    if (st) {
      $('st-font').value = st.fontFamily || 'Helvetica Neue';
      $('st-size').value = st.fontSizePct || 5.2;
      $('st-color').value = st.textColor || '#FFFFFF';
      $('st-bold').checked = st.bold !== false;
      $('st-italic').checked = !!st.italic;
      $('st-upper').checked = !!st.uppercase;
      $('st-outline-on').checked = st.outlineEnabled !== false;
      $('st-outline-color').value = st.outlineColor || '#000000';
      $('st-outline-w').value = (st.outlineWidth != null) ? st.outlineWidth : 2;
      $('st-bg-on').checked = st.backgroundEnabled !== false;
      $('st-bg-color').value = st.backgroundColor || '#000000';
      $('st-bg-alpha').value = (st.backgroundAlpha != null) ? st.backgroundAlpha : 0.55;
      $('st-pos').value = st.position || 'bottom';
      $('st-margin').value = st.marginVPct || 6;
      $('st-karaoke').checked = !!st.karaoke;
      $('st-karaoke-color').value = st.karaokeColor || '#FFD400';
      $('st-size-val').textContent = $('st-size').value;
    }
    if (cp2) {
      $('cap-mode').value = cp2.wordMode ? 'word' : 'sentence';
      $('cap-maxchars').value = cp2.maxCharsPerLine || 42;
      $('cap-maxlines').value = cp2.maxLines || 2;
      $('cap-maxdur').value = (cp2.maxDurMs || 6000) / 1000;
      $('cap-mindur').value = (cp2.minDurMs || 1000) / 1000;
      $('cap-gap').value = (cp2.gapSplitMs || 1000) / 1000;
      $('cap-punct').checked = cp2.splitOnPunct !== false;
      $('cap-splitseg').checked = cp2.splitOnSegment !== false;
      $('cap-maxcps').value = cp2.maxCps || 21;
    }
    $('lang-select').value = S.settings.language || 'tr';
    $('opt-translate').checked = !!S.settings.translate;
    $('transcribe-range').value = S.settings.range || 'sequence';
    $('set-prompt').value = S.settings.prompt || '';
  }

  /* ================= başlangıç ================= */
  function init() {
    if (!C) {
      status('captions.js yüklenemedi (FisiltiCaptions yok) — paneli yeniden yükle.', 'error');
      return;
    }
    if (!W || !W.available) {
      status('Node köprüsü başlatılamadı' + (W && W.reason ? ': ' + W.reason : '') , 'error');
      return;
    }

    // tema
    try {
      applyTheme(cs.getHostEnvironment().appSkinInfo);
      cs.addEventListener(CSInterface.THEME_COLOR_CHANGED_EVENT, function () {
        try { applyTheme(JSON.parse(window.__adobe_cep__.getHostEnvironment()).appSkinInfo); } catch (e) {}
      });
    } catch (e) {}

    loadSettings();
    restoreStyleInputs();
    wireTranscript();
    wireModels();
    wireSettings();
    wireUpdate();
    wireColorPickers();

    // sekmeler
    document.querySelectorAll('#tabs button').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
    });

    // ana butonlar
    $('btn-transcribe').addEventListener('click', startTranscription);
    $('btn-cancel').addEventListener('click', function () {
      if (S.proc) S.proc.cancel();
      if (S.overlayProc) S.overlayProc.cancel();
    });
    $('btn-refresh').addEventListener('click', function () { refreshEnv(); });
    $('btn-add-line').addEventListener('click', addLineAtPlayhead);
    $('btn-add-markers').addEventListener('click', addMarkers);
    $('btn-make-captions').addEventListener('click', addCaptionTrack);
    $('btn-style-to-premiere').addEventListener('click', saveStyleToPremiere);
    $('btn-make-overlay').addEventListener('click', addOverlay);
    $('btn-export-srt').addEventListener('click', function () { exportFormat('srt'); });
    $('btn-export-vtt').addEventListener('click', function () { exportFormat('vtt'); });
    $('btn-export-txt').addEventListener('click', function () { exportFormat('txt'); });
    $('btn-export-csv').addEventListener('click', function () { exportFormat('csv'); });
    $('btn-export-ass').addEventListener('click', function () { exportFormat('ass'); });

    // arama
    $('search-box').addEventListener('input', runSearch);
    $('btn-search-prev').addEventListener('click', function () { gotoHit(-1); });
    $('btn-search-next').addEventListener('click', function () { gotoHit(1); });
    $('btn-replace-one').addEventListener('click', replaceCurrent);
    $('btn-replace-all').addEventListener('click', replaceAll);
    $('btn-replace-undo').addEventListener('click', replaceUndo);
    $('replace-box').addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      if (ev.metaKey || ev.ctrlKey) replaceAll(); else replaceCurrent();
    });

    // kelime vurgusu görünümü değişince yeniden çiz
    $('opt-wordhl').addEventListener('change', renderTranscript);

    // stil inputları → önizleme + kalıcılık
    ['st-font', 'st-size', 'st-color', 'st-bold', 'st-italic', 'st-upper', 'st-outline-on',
     'st-outline-color', 'st-outline-w', 'st-bg-on', 'st-bg-color', 'st-bg-alpha', 'st-pos',
     'st-margin', 'st-karaoke', 'st-karaoke-color'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        updatePreview();
        if (id === 'st-size') $('st-size-val').textContent = $('st-size').value;
        saveSettings();
      });
    });
    $('cap-offset').addEventListener('input', function () { updateCaptionStats(); updatePreview(); });
    ['cap-mode', 'cap-maxchars', 'cap-maxlines', 'cap-maxdur', 'cap-mindur', 'cap-gap',
     'cap-punct', 'cap-splitseg', 'cap-maxcps'].forEach(function (id) {
      $(id).addEventListener('input', function () { updateCaptionStats(); saveSettings(); });
    });

    // Premiere olayları
    callHost('registerEvents', undefined, function () {});
    cs.addEventListener('com.ofb.fisilti.seqChanged', function () { refreshEnv(); });

    // kapanışta çocuk süreçleri öldür
    window.addEventListener('beforeunload', function () {
      if (S.proc) S.proc.cancel();
      if (S.overlayProc) S.overlayProc.cancel();
      if (S.ffmpegDl) S.ffmpegDl.cancel();
      if (S.updateDl) S.updateDl.cancel();
      Object.keys(S.downloads).forEach(function (k) { S.downloads[k].cancel(); });
    });

    populateModelSelect();
    refreshEnv();
    startPolling();
    updatePreview();
    // bağımlılık kontrolü: ffmpeg yalnız stilli overlay için gerekir
    if (!S.settings.ffmpegPath && !W.detectFfmpeg()) {
      status('hazır — ffmpeg eksik (stilli overlay için): Ayarlar sekmesinden tek tıkla İndir', '');
    } else {
      status('hazır');
    }
    // sessiz sürüm denetimi — yalnız yeni sürüm varsa ses çıkarır
    setTimeout(function () { checkForUpdate(true); }, 3000);
  }

  // localhost:8090 debug konsolu için küçük kanca (üretimde zararsız)
  window.__fisilti = { S: S, renderTranscript: renderTranscript, runSearch: runSearch,
    replaceCurrent: replaceCurrent, replaceAll: replaceAll, replaceUndo: replaceUndo,
    wireColorPickers: wireColorPickers };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
