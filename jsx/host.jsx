/*
 * Fısıltı — ExtendScript host katmanı (Premiere Pro).
 * Panel tarafı her fonksiyonu tek JSON string argümanla çağırır (double-stringify köprüsü),
 * dönüş değeri de her zaman JSON string'tir.
 * ExtendScript ES3'tür ve yerleşik JSON yoktur — aşağıda küçük bir uyarlama var.
 */

var TICKS_PER_SECOND = 254016000000;

/* ---------- mini JSON (ES3) ---------- */
if (typeof JSON === 'undefined') { JSON = {}; }
if (!JSON.stringify) {
  JSON.stringify = function (v) {
    function esc(s) {
      return '"' + String(s)
        .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
    }
    function go(x) {
      if (x === null || x === undefined) return 'null';
      var t = typeof x;
      if (t === 'number') return isFinite(x) ? String(x) : 'null';
      if (t === 'boolean') return String(x);
      if (t === 'string') return esc(x);
      if (x instanceof Array) {
        var a = [];
        for (var i = 0; i < x.length; i++) a.push(go(x[i]));
        return '[' + a.join(',') + ']';
      }
      var o = [];
      for (var k in x) if (x.hasOwnProperty(k) && typeof x[k] !== 'function') o.push(esc(k) + ':' + go(x[k]));
      return '{' + o.join(',') + '}';
    }
    return go(v);
  };
}
if (!JSON.parse) {
  // Yalnızca kendi panelimizden gelen güvenilir veri için kullanılır.
  JSON.parse = function (s) { return eval('(' + s + ')'); };
}

$._fst = (function () {

  function ok(data) { data = data || {}; data.ok = true; return JSON.stringify(data); }
  function err(msg) { return JSON.stringify({ ok: false, error: String(msg) }); }

  function activeSeq() { return app.project ? app.project.activeSequence : null; }

  /* ---------- panel bildirimleri (CSXSEvent) ---------- */
  function notify(type, payload) {
    try {
      var eoName = (Folder.fs === 'Macintosh') ? 'PlugPlugExternalObject' : 'PlugPlugExternalObject.dll';
      var lib = new ExternalObject('lib:' + eoName);
      if (lib) {
        var e = new CSXSEvent();
        e.type = type;
        e.data = JSON.stringify(payload || {});
        e.dispatch();
      }
    } catch (ignored) {}
  }

  var api = {};

  /* ---------- ortam bilgisi ---------- */
  api.getEnv = function () {
    try {
      if (!app.project) return err('Proje yok');
      var seq = activeSeq();
      var out = {
        projectName: app.project.name,
        projectPath: app.project.path,
        seq: null
      };
      if (seq) {
        var fps = TICKS_PER_SECOND / Number(seq.timebase);
        var durSec = (Number(seq.end) - Number(seq.zeroPoint)) / TICKS_PER_SECOND;
        var inSec = null, outSec = null;
        try {
          var it = seq.getInPointAsTime(), ot = seq.getOutPointAsTime();
          inSec = Number(it.ticks) / TICKS_PER_SECOND;
          outSec = Number(ot.ticks) / TICKS_PER_SECOND;
        } catch (e1) {}
        out.seq = {
          id: String(seq.sequenceID),
          name: seq.name,
          fps: fps,
          timebase: String(seq.timebase),
          width: seq.frameSizeHorizontal,
          height: seq.frameSizeVertical,
          durationSec: durSec,
          inSec: inSec,
          outSec: outSec,
          videoTrackCount: seq.videoTracks ? seq.videoTracks.numTracks : 0
        };
      }
      return ok(out);
    } catch (e) { return err(e); }
  };

  /* ---------- playhead: hızlı poll (payload küçük tutulur) ---------- */
  api.poll = function () {
    var seq = activeSeq();
    if (!seq) return '';
    return String(seq.sequenceID) + '|' + seq.getPlayerPosition().ticks;
  };

  api.seek = function (payloadJson) {
    try {
      var p = JSON.parse(payloadJson);
      var seq = activeSeq();
      if (!seq) return err('Aktif sequence yok');
      seq.setPlayerPosition(String(Math.round(p.sec * TICKS_PER_SECOND)));
      return ok();
    } catch (e) { return err(e); }
  };

  /* ---------- seçim ---------- */
  api.getSelectionRange = function () {
    try {
      var seq = activeSeq();
      if (!seq) return err('Aktif sequence yok');
      var sel = seq.getSelection();
      var start = null, end = null, count = 0;
      for (var i = 0; i < sel.length; i++) {
        var ti = sel[i];
        if (!ti || ti.name === 'anonymous') continue;
        count++;
        var s = ti.start.seconds, e = ti.end.seconds;
        if (start === null || s < start) start = s;
        if (end === null || e > end) end = e;
      }
      if (!count) return err('Seçili klip yok');
      return ok({ startSec: start, endSec: end, count: count });
    } catch (e2) { return err(e2); }
  };

  /* ---------- ses dışa aktarımı ----------
   * mode: 'sequence' | 'inout' | 'selection'
   * exportAsMediaDirect BLOKLAR: dönüş geldiğinde dosya hazırdır (AME gerekmez).
   * Dönüşte offsetSec: wav'ın 0 anının sequence'teki karşılığı.
   */
  api.exportAudio = function (payloadJson) {
    try {
      var p = JSON.parse(payloadJson);
      var seq = activeSeq();
      if (!seq) return err('Aktif sequence yok');

      var ENCODE_ENTIRE = 0, ENCODE_IN_TO_OUT = 1;
      var workArea = ENCODE_ENTIRE, offsetSec = 0;
      var savedIn = null, savedOut = null;

      if (p.mode === 'inout') {
        workArea = ENCODE_IN_TO_OUT;
        offsetSec = Number(seq.getInPointAsTime().ticks) / TICKS_PER_SECOND;
      } else if (p.mode === 'selection') {
        var selRes = JSON.parse(api.getSelectionRange());
        if (!selRes.ok) return err(selRes.error);
        savedIn = seq.getInPointAsTime().ticks;
        savedOut = seq.getOutPointAsTime().ticks;
        seq.setInPoint(selRes.startSec);
        seq.setOutPoint(selRes.endSec);
        workArea = ENCODE_IN_TO_OUT;
        offsetSec = selRes.startSec;
      }

      var result;
      try {
        result = seq.exportAsMediaDirect(p.outPath, p.eprPath, workArea);
      } finally {
        if (savedIn !== null) {
          // in/out'u geri koy
          try {
            seq.setInPoint(Number(savedIn) / TICKS_PER_SECOND);
            seq.setOutPoint(Number(savedOut) / TICKS_PER_SECOND);
          } catch (eRestore) {}
        }
      }

      // Docs Boolean der, sahada 'Unknown error' gibi string'ler görülür — dosyaya bak.
      var f = new File(p.outPath);
      if (!f.exists) return err('Dışa aktarım başarısız: ' + String(result));
      return ok({ outPath: p.outPath, offsetSec: offsetSec, result: String(result) });
    } catch (e) { return err(e); }
  };

  /* ---------- SRT'yi caption track olarak ekle ---------- */
  api.importSrtAsCaptions = function (payloadJson) {
    try {
      var p = JSON.parse(payloadJson);
      var seq = activeSeq();
      if (!seq) return err('Aktif sequence yok');

      var destBin = app.project.getInsertionBin();
      var prevCount = destBin.children.numItems;

      var imported = app.project.importFiles([p.srtPath], true, destBin, false);
      if (!imported) return err('SRT içe aktarılamadı');

      var newCount = destBin.children.numItems;
      if (newCount <= prevCount) return err('İçe aktarılan SRT proje panelinde bulunamadı');
      var srtItem = destBin.children[newCount - 1];

      var res = seq.createCaptionTrack(srtItem, p.startAtSec || 0, Sequence.CAPTION_FORMAT_SUBTITLE);
      if (!res) return err('createCaptionTrack başarısız oldu');
      return ok();
    } catch (e) { return err(e); }
  };

  /* ---------- overlay videosunu en üste yerleştir ---------- */
  api.importOverlay = function (payloadJson) {
    try {
      var p = JSON.parse(payloadJson);
      var seq = activeSeq();
      if (!seq) return err('Aktif sequence yok');

      var destBin = app.project.getInsertionBin();
      var prevCount = destBin.children.numItems;
      var imported = app.project.importFiles([p.path], true, destBin, false);
      if (!imported) return err('Overlay dosyası içe aktarılamadı');
      var newCount = destBin.children.numItems;
      if (newCount <= prevCount) return err('Overlay proje panelinde bulunamadı');
      var item = destBin.children[newCount - 1];

      var tracks = seq.videoTracks;
      var atSec = p.atSec || 0;

      // Altyazı HER ŞEYİN üstünde olmalı: yalnızca EN ÜST track'e bakılır.
      // Alt katmanlardaki boş track'lere yerleştirmek, üstteki kliplerin
      // altyazıyı örtmesine yol açar.
      var top = tracks.numTracks - 1;
      var topBusy = false;
      var topTr = tracks[top];
      for (var c = 0; c < topTr.clips.numItems; c++) {
        if (topTr.clips[c].end.seconds > atSec) { topBusy = true; break; }
      }

      var target = top;
      if (topBusy) {
        // En üst dolu — QE ile tepeye yeni video track ekle (resmi API'de yok)
        try {
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          qeSeq.addTracks(1, tracks.numTracks, 0, 0);
          target = seq.videoTracks.numTracks - 1;
        } catch (eQE) {
          return err('En üst video track dolu ve yeni track eklenemedi. Timeline\'a elle boş bir video track ekleyip tekrar dene.');
        }
      }

      seq.videoTracks[target].overwriteClip(item, atSec);
      return ok({ track: target + 1 });
    } catch (e) { return err(e); }
  };

  /* ---------- segmentleri sequence marker'ı yap ---------- */
  api.addMarkers = function (payloadJson) {
    try {
      var p = JSON.parse(payloadJson);
      var seq = activeSeq();
      if (!seq) return err('Aktif sequence yok');
      var n = 0;
      for (var i = 0; i < p.markers.length; i++) {
        var m = p.markers[i];
        var mk = seq.markers.createMarker(m.startSec);
        if (mk) {
          mk.name = m.name || '';
          if (m.comment) mk.comments = m.comment;
          if (m.endSec && m.endSec > m.startSec) {
            var t = new Time();
            t.seconds = m.endSec;
            mk.end = t;
          }
          n++;
        }
      }
      return ok({ added: n });
    } catch (e) { return err(e); }
  };

  /* ---------- sequence değişince paneli dürt (best-effort) ---------- */
  api.registerEvents = function () {
    try {
      app.bind('onSequenceActivated', function () {
        var s = activeSeq();
        notify('com.ofb.fisilti.seqChanged', { seqId: s ? String(s.sequenceID) : '' });
      });
      return ok();
    } catch (e) { return err(e); }
  };

  return api;
})();
