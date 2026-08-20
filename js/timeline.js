/*
 * Fısıltı — zaman çizelgesi: segmentleri bar olarak çizer; gövdeden sürükle=taşı,
 * kenardan sürükle=başlangıç/bitiş ayarı. Arkada ses enerjisi (dalga formu),
 * playhead çizgisi, tıkla=sardır. Saf yardımcılar (zaman↔piksel, sürükleme
 * matematiği, enerji sıkıştırma) dışarı açıktır ve Node ile test edilir.
 *
 * main.js bağlantısı:
 *   FisiltiTimeline.init(ctx)  — ctx: { container, getSegments, getEnergy,
 *     getDuration, isBusy, onSeek, onChange(i,t0,t1), onSelect(i), onEditText(i) }
 *   FisiltiTimeline.rebuild()  — segmentler değişince
 *   FisiltiTimeline.tick(sec)  — playhead her poll'da
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FisiltiTimeline = api;
}(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var MIN_DUR = 0.2;   // sn — bir bar bundan kısa olamaz
  var MIN_PPS = 4, MAX_PPS = 240;

  /* ---------------- saf yardımcılar ---------------- */
  function timeToX(sec, pps) { return sec * pps; }
  function xToTime(x, pps) { return pps > 0 ? x / pps : 0; }
  function clampPps(pps) { return Math.max(MIN_PPS, Math.min(MAX_PPS, pps)); }

  // mode: 'move' | 'left' | 'right' — dxSec kadar sürüklemenin sonucu
  function resolveDrag(mode, t0, t1, dxSec) {
    if (mode === 'move') {
      var shift = Math.max(dxSec, -t0); // 0'ın soluna taşma yok
      return { t0: t0 + shift, t1: t1 + shift };
    }
    if (mode === 'left') {
      return { t0: Math.min(t1 - MIN_DUR, Math.max(0, t0 + dxSec)), t1: t1 };
    }
    // right
    return { t0: t0, t1: Math.max(t0 + MIN_DUR, t1 + dxSec) };
  }

  // wavRms profili → kalıcılığa uygun küçük enerji dizisi (0-100 tam sayı).
  // Normalizasyon 98. yüzdeliğe göre: tek bir patlama tüm dalgayı ezmesin.
  function compactEnergy(prof, offsetSec) {
    if (!prof || !prof.rms || !prof.rms.length) return null;
    var src = prof.rms, half = [];
    for (var i = 0; i + 1 < src.length; i += 2) half.push((src[i] + src[i + 1]) / 2);
    if (!half.length) half = src.slice();
    var sorted = half.slice().sort(function (a, b) { return a - b; });
    var ref = sorted[Math.floor(sorted.length * 0.98)] || 1;
    if (ref <= 0) ref = 1;
    var rms = half.map(function (v) { return Math.min(100, Math.round(v / ref * 100)); });
    return { offsetSec: offsetSec || 0, winMs: prof.winMs * 2, rms: rms };
  }

  // Etiket adımı: ekranda ~80px'e bir zaman etiketi düşecek şekilde yuvarlak adım
  function gridStep(pps) {
    var steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    for (var i = 0; i < steps.length; i++) if (steps[i] * pps >= 80) return steps[i];
    return 600;
  }

  /* ---------------- durum ---------------- */
  var ctx = null;
  var el = { scroll: null, content: null, canvas: null, playhead: null };
  var pps = 30;
  var drag = null;            // { mode, idx, startX, startT0, startT1, moved, barEl }
  var userScrollUntil = 0;    // kullanıcı elle kaydırdıysa takip bastırılır
  var progScroll = false;
  var lastSec = 0;
  var rafPending = false;

  function fmtT(sec) {
    sec = Math.max(0, sec);
    var m = Math.floor(sec / 60), s = sec - m * 60;
    var h = Math.floor(m / 60); m = m % 60;
    var sTxt = (s < 10 ? '0' : '') + s.toFixed(1);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (h ? h + ':' + p(m) : String(m)) + ':' + sTxt;
  }

  function duration() {
    var d = (ctx.getDuration && ctx.getDuration()) || 0;
    var segs = ctx.getSegments() || [];
    if (segs.length) d = Math.max(d, segs[segs.length - 1].t1 + 5);
    return Math.max(d, 30);
  }

  /* ---------------- kurulum ---------------- */
  function init(c) {
    ctx = c;
    var host = ctx.container;
    host.innerHTML = '<div class="tl-scroll"><div class="tl-content">' +
      '<canvas class="tl-canvas"></canvas>' +
      '<div class="tl-playhead"></div>' +
      '</div></div>';
    el.scroll = host.querySelector('.tl-scroll');
    el.content = host.querySelector('.tl-content');
    el.canvas = host.querySelector('.tl-canvas');
    el.playhead = host.querySelector('.tl-playhead');

    el.scroll.addEventListener('scroll', function () {
      if (!progScroll) userScrollUntil = Date.now() + 1500;
      scheduleDraw();
    });
    // Alt/⌘ + tekerlek: imleç altındaki zamanı sabit tutarak yakınlaştır
    el.scroll.addEventListener('wheel', function (ev) {
      if (!ev.altKey && !ev.metaKey) return;
      ev.preventDefault();
      var rect = el.scroll.getBoundingClientRect();
      var anchorT = xToTime(el.scroll.scrollLeft + (ev.clientX - rect.left), pps);
      setZoom(pps * (ev.deltaY < 0 ? 1.25 : 0.8), anchorT, ev.clientX - rect.left);
    }, { passive: false });

    el.scroll.addEventListener('mousedown', onMouseDown);
    el.scroll.addEventListener('dblclick', function (ev) {
      var bar = ev.target.closest('.tl-bar');
      if (bar && ctx.onEditText) ctx.onEditText(+bar.getAttribute('data-i'));
    });
    window.addEventListener('resize', scheduleDraw);
    rebuild();
  }

  function setZoom(next, anchorT, anchorX) {
    var np = clampPps(next);
    if (np === pps) return;
    if (anchorT === undefined) { // görünür merkez sabit kalsın
      anchorX = el.scroll.clientWidth / 2;
      anchorT = xToTime(el.scroll.scrollLeft + anchorX, pps);
    }
    pps = np;
    layout();
    progScroll = true;
    el.scroll.scrollLeft = Math.max(0, timeToX(anchorT, pps) - anchorX);
    progScroll = false;
    scheduleDraw();
  }
  function zoomIn() { setZoom(pps * 1.5); }
  function zoomOut() { setZoom(pps / 1.5); }

  /* ---------------- bar üretimi ---------------- */
  function layout() {
    el.content.style.width = Math.ceil(timeToX(duration(), pps)) + 'px';
    var segs = ctx.getSegments() || [];
    var bars = el.content.querySelectorAll('.tl-bar');
    for (var i = 0; i < bars.length; i++) {
      var seg = segs[+bars[i].getAttribute('data-i')];
      if (seg) positionBar(bars[i], seg.t0, seg.t1);
    }
    positionPlayhead();
  }
  function positionBar(bar, t0, t1) {
    bar.style.left = timeToX(t0, pps) + 'px';
    bar.style.width = Math.max(2, timeToX(t1 - t0, pps)) + 'px';
  }
  function positionPlayhead() {
    el.playhead.style.left = timeToX(lastSec, pps) + 'px';
  }

  function rebuild() {
    if (!ctx) return;
    var old = el.content.querySelectorAll('.tl-bar');
    for (var k = old.length - 1; k >= 0; k--) old[k].parentNode.removeChild(old[k]);
    var segs = ctx.getSegments() || [];
    var frag = document.createDocumentFragment();
    for (var i = 0; i < segs.length; i++) {
      var b = document.createElement('div');
      b.className = 'tl-bar';
      b.setAttribute('data-i', i);
      b.innerHTML = '<div class="tl-h l"></div><span class="tl-label"></span><div class="tl-h r"></div>';
      b.querySelector('.tl-label').textContent = segs[i].text || '';
      b.title = fmtT(segs[i].t0) + ' – ' + fmtT(segs[i].t1) + '\n' + (segs[i].text || '');
      positionBar(b, segs[i].t0, segs[i].t1);
      frag.appendChild(b);
    }
    el.content.appendChild(frag);
    layout();
    scheduleDraw();
  }

  /* ---------------- sürükleme ---------------- */
  function onMouseDown(ev) {
    if (ev.button !== 0) return;
    if (ctx.isBusy && ctx.isBusy()) return;
    var bar = ev.target.closest('.tl-bar');
    var mode = null;
    if (bar) {
      if (ev.target.classList.contains('tl-h')) mode = ev.target.classList.contains('l') ? 'left' : 'right';
      else mode = 'move';
    }
    var rect = el.scroll.getBoundingClientRect();
    drag = {
      mode: mode,
      idx: bar ? +bar.getAttribute('data-i') : -1,
      barEl: bar || null,
      startX: ev.clientX,
      startT0: 0, startT1: 0,
      moved: false,
      emptyT: xToTime(el.scroll.scrollLeft + (ev.clientX - rect.left), pps)
    };
    if (bar) {
      var seg = (ctx.getSegments() || [])[drag.idx];
      if (!seg) { drag = null; return; }
      drag.startT0 = seg.t0; drag.startT1 = seg.t1;
      bar.classList.add('dragging');
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    ev.preventDefault();
  }
  function onMouseMove(ev) {
    if (!drag) return;
    var dx = ev.clientX - drag.startX;
    if (Math.abs(dx) > 3) drag.moved = true;
    if (!drag.barEl || !drag.moved) return;
    var r = resolveDrag(drag.mode, drag.startT0, drag.startT1, xToTime(dx, pps));
    drag.curT0 = r.t0; drag.curT1 = r.t1;
    positionBar(drag.barEl, r.t0, r.t1);
    drag.barEl.title = fmtT(r.t0) + ' – ' + fmtT(r.t1);
  }
  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    var d = drag; drag = null;
    if (!d) return;
    if (d.barEl) d.barEl.classList.remove('dragging');
    if (d.barEl && d.moved && d.curT0 !== undefined) {
      if (ctx.onChange) ctx.onChange(d.idx, d.curT0, d.curT1); // sort+persist+rebuild main.js'te
      return;
    }
    if (!d.moved) {
      if (d.barEl) {
        if (ctx.onSeek) ctx.onSeek(d.startT0);
        if (ctx.onSelect) ctx.onSelect(d.idx);
      } else if (ctx.onSeek) {
        ctx.onSeek(Math.max(0, d.emptyT));
      }
    }
  }

  /* ---------------- playhead ---------------- */
  function tick(sec) {
    if (!ctx) return;
    lastSec = sec;
    positionPlayhead();
    // görünür alanda tut (takip aç + kullanıcı kaydırmıyor + sürükleme yok)
    var follow = ctx.getFollow ? ctx.getFollow() : true;
    if (follow && !drag && Date.now() > userScrollUntil) {
      var x = timeToX(sec, pps), sl = el.scroll.scrollLeft, w = el.scroll.clientWidth;
      if (x < sl + 10 || x > sl + w - 10) {
        progScroll = true;
        el.scroll.scrollLeft = Math.max(0, x - w * 0.3);
        progScroll = false;
        scheduleDraw();
      }
    }
    // aktif barı vurgula
    var segs = ctx.getSegments() || [];
    var bars = el.content.querySelectorAll('.tl-bar');
    for (var i = 0; i < bars.length; i++) {
      var seg = segs[+bars[i].getAttribute('data-i')];
      bars[i].classList.toggle('cur', !!seg && sec >= seg.t0 && sec <= seg.t1);
    }
  }

  /* ---------------- çizim (grid + dalga formu) ---------------- */
  function scheduleDraw() {
    if (rafPending) return;
    rafPending = true;
    (window.requestAnimationFrame || setTimeout)(function () { rafPending = false; draw(); });
  }
  function draw() {
    if (!ctx || !el.canvas) return;
    var w = el.scroll.clientWidth, h = el.scroll.clientHeight;
    if (w < 2 || h < 2) return;
    var dpr = window.devicePixelRatio || 1;
    if (el.canvas.width !== w * dpr) { el.canvas.width = w * dpr; el.canvas.style.width = w + 'px'; }
    if (el.canvas.height !== h * dpr) { el.canvas.height = h * dpr; el.canvas.style.height = h + 'px'; }
    var sl = el.scroll.scrollLeft;
    el.canvas.style.left = sl + 'px'; // canvas görünür pencereyi kaplar
    var g = el.canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    var css = window.getComputedStyle(document.documentElement);
    var dimC = (css.getPropertyValue('--text-dim') || '#8a8a8a').trim();
    var borderC = (css.getPropertyValue('--border') || '#3a3a3a').trim();

    // dalga formu
    var en = ctx.getEnergy && ctx.getEnergy();
    if (en && en.rms && en.rms.length) {
      g.fillStyle = borderC;
      var winSec = en.winMs / 1000;
      var i0 = Math.max(0, Math.floor((xToTime(sl, pps) - en.offsetSec) / winSec));
      var i1 = Math.min(en.rms.length, Math.ceil((xToTime(sl + w, pps) - en.offsetSec) / winSec) + 1);
      for (var i = i0; i < i1; i++) {
        var x = timeToX(en.offsetSec + i * winSec, pps) - sl;
        var bw = Math.max(1, winSec * pps - 0.5);
        var bh = Math.max(1, (en.rms[i] / 100) * (h - 16));
        g.fillRect(x, h - bh, bw, bh);
      }
    }

    // zaman ızgarası + etiketler
    var step = gridStep(pps);
    var t0 = Math.floor(xToTime(sl, pps) / step) * step;
    var tEnd = xToTime(sl + w, pps);
    g.strokeStyle = borderC;
    g.fillStyle = dimC;
    g.font = '9px sans-serif';
    for (var t = t0; t <= tEnd; t += step) {
      var gx = timeToX(t, pps) - sl;
      g.globalAlpha = 0.5;
      g.beginPath(); g.moveTo(gx, 12); g.lineTo(gx, h); g.stroke();
      g.globalAlpha = 1;
      g.fillText(fmtT(t).replace(/\.0$/, ''), gx + 3, 9);
    }
  }

  return {
    init: init, rebuild: rebuild, tick: tick,
    zoomIn: zoomIn, zoomOut: zoomOut,
    redraw: scheduleDraw,
    // saf yardımcılar (test için)
    timeToX: timeToX, xToTime: xToTime, clampPps: clampPps,
    resolveDrag: resolveDrag, compactEnergy: compactEnergy, gridStep: gridStep,
    MIN_DUR: MIN_DUR
  };
}));
