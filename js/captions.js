/*
 * Fısıltı — altyazı motoru.
 * Saf fonksiyonlar: CEP'e bağımlılık yok, Node ile test edilebilir.
 * Zaman birimi her yerde milisaniyedir.
 *
 * Veri modeli:
 *   word    = { t0, t1, text }
 *   segment = { t0, t1, text, words? }
 *   block   = { t0, t1, lines: [string], words: [word], cps }
 */
(function (root, factory) {
  // CEP panelinde (--enable-nodejs --mixed-context) Node'un `module` globali
  // pencerede de vardır; "ya module ya window" UMD kalıbı burada window'u atlar.
  // Bu yüzden ikisine de yaz.
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FisiltiCaptions = api;
}(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var DEFAULTS = {
    maxCharsPerLine: 42,   // Netflix TR rehberi
    maxLines: 2,
    maxDurMs: 6000,
    minDurMs: 1000,
    wordMode: false,       // true: her kelime ayrı blok (sosyal medya tarzı)
    minWordDurMs: 180,     // wordMode'da kelime başına asgari görünme süresi
    minGapMs: 80,       // iki blok arasında korunacak asgari boşluk
    gapSplitMs: 1000,   // kelimeler arası boşluk bunu aşarsa yeni blok
    maxCps: 21,         // uyarı eşiği (karakter/sn)
    splitOnPunct: true,
    splitOnSegment: true, // blok, transkript satırının sınırını aşmaz (konuşmacı karışmasın)
    uppercase: false
  };

  var STRONG_PUNCT = /[.!?…]["»']?$/;
  var SOFT_PUNCT = /[,;:]["»']?$/;
  // Satır sonunda bırakmak istemediğimiz bağlaç/ek sözcükler (Türkçe odaklı)
  var NO_LINE_END = /^(ve|ya|ile|ama|fakat|veya|yahut|çünkü|ki|de|da|mi|mı|mu|mü|bir|bu|şu|o|her|çok|en|ne|için)$/i;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function mergeOpts(opts) {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    if (opts) for (var j in opts) if (opts[j] !== undefined && opts[j] !== null) out[j] = opts[j];
    return out;
  }

  /* ---------------- kelime çıkarımı ---------------- */

  // Kelime zamanı yoksa segment süresini karakter ağırlığıyla paylaştır.
  function estimateWords(seg) {
    var parts = String(seg.text || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return [];
    var totalChars = 0;
    parts.forEach(function (p) { totalChars += p.length + 1; });
    var dur = Math.max(0, seg.t1 - seg.t0);
    var words = [], cursor = seg.t0;
    parts.forEach(function (p) {
      var w = dur * ((p.length + 1) / totalChars);
      words.push({ t0: Math.round(cursor), t1: Math.round(cursor + w), text: p });
      cursor += w;
    });
    words[words.length - 1].t1 = seg.t1;
    return words;
  }

  function flattenToWords(segments) {
    var all = [];
    (segments || []).forEach(function (seg, si) {
      var ws = (seg.words && seg.words.length) ? seg.words : estimateWords(seg);
      ws.forEach(function (w) {
        var t = String(w.text || '').trim();
        // segIdx: kelimenin geldiği transkript satırı — splitOnSegment bununla böler
        if (t) all.push({ t0: w.t0, t1: w.t1, text: t, segIdx: si });
      });
    });
    all.sort(function (a, b) { return a.t0 - b.t0; });
    return all;
  }

  /*
   * whisper-cli -ojf çıktısındaki token'ları kelimelere birleştirir.
   * Token metni boşlukla başlıyorsa yeni kelime başlar; [_XX_] özel token'ları atlanır.
   * offsets alanları milisaniyedir.
   */
  function wordsFromWhisperJson(json) {
    var out = [];
    var tr = (json && json.transcription) || [];
    tr.forEach(function (seg) {
      var toks = seg.tokens || [];
      var cur = null;
      toks.forEach(function (tk) {
        var txt = tk.text || '';
        if (/^\s*\[_[^\]]*\]\s*$/.test(txt)) return; // [_BEG_], [_TT_150] vb. özel token'lar
        var startsWord = /^\s/.test(txt) || !cur;
        var o = tk.offsets || {};
        var t0 = (o.from != null) ? o.from : (seg.offsets ? seg.offsets.from : 0);
        var t1 = (o.to != null) ? o.to : t0;
        if (startsWord) {
          if (cur && cur.text.trim()) out.push(cur);
          cur = { t0: t0, t1: t1, text: txt };
        } else {
          cur.text += txt;
          cur.t1 = t1;
        }
      });
      if (cur && cur.text.trim()) out.push(cur);
      // Segment sınırında sarkmaları kırp
      if (seg.offsets && out.length) {
        var last = out[out.length - 1];
        if (last.t1 > seg.offsets.to) last.t1 = seg.offsets.to;
      }
    });
    out.forEach(function (w) { w.text = w.text.trim(); });
    return out.filter(function (w) { return w.text; });
  }

  function segmentsFromWhisperJson(json) {
    var tr = (json && json.transcription) || [];
    return tr.map(function (seg) {
      var o = seg.offsets || { from: 0, to: 0 };
      return { t0: o.from, t1: o.to, text: String(seg.text || '').trim() };
    }).filter(function (s) { return s.text; });
  }

  /* ---------------- satır kırma ---------------- */

  function breakLines(words, maxChars, maxLines) {
    // words: string dizisi. Dengeli, noktalama ve bağlaç kurallarına saygılı kırım.
    var text = words.join(' ');
    if (text.length <= maxChars || maxLines <= 1) return [text];

    // İki satır için en iyi kırılma noktasını ara (daha fazla satır gerekiyorsa özyinele)
    var best = null;
    for (var i = 1; i < words.length; i++) {
      var left = words.slice(0, i).join(' ');
      var right = words.slice(i).join(' ');
      if (left.length > maxChars) break;
      var score = Math.abs(left.length - right.length); // denge
      if (SOFT_PUNCT.test(words[i - 1]) || STRONG_PUNCT.test(words[i - 1])) score -= 8; // noktalamadan sonra kırmak iyi
      if (NO_LINE_END.test(words[i - 1])) score += 10;  // bağlaçla satır bitirme
      if (right.length <= maxChars || maxLines > 2) {
        if (!best || score < best.score) best = { i: i, score: score };
      }
    }
    if (!best) {
      // Dengeli kırım bulunamadı. Kelimeyi ASLA kırpma — metin kaybı olur
      // (karaoke ASS'te words'ten tam yazılıp taşar). Greedy: ilk satıra
      // sığan kadar kelime al (en az 1), kalanına devam et.
      var take = 1;
      while (take < words.length && words.slice(0, take + 1).join(' ').length <= maxChars) take++;
      var restL = words.length > take ? breakLines(words.slice(take), maxChars, maxLines - 1) : [];
      return [words.slice(0, take).join(' ')].concat(restL).slice(0, maxLines);
    }
    var first = words.slice(0, best.i).join(' ');
    var rest = words.slice(best.i);
    var restLines = breakLines(rest, maxChars, maxLines - 1);
    return [first].concat(restLines).slice(0, maxLines);
  }

  /* ---------------- blok üretimi ---------------- */

  function buildCaptions(segments, opts) {
    var o = mergeOpts(opts);
    var words = flattenToWords(segments);
    if (!words.length) return [];

    // Kelime kelime mod: her kelime kendi bloğu (sosyal medya / karaoke tarzı)
    if (o.wordMode) {
      return words.map(function (w, i) {
        var t1 = Math.max(w.t1, w.t0 + o.minWordDurMs);
        if (i + 1 < words.length) t1 = Math.min(t1, Math.max(w.t0 + 80, words[i + 1].t0));
        var txt = o.uppercase ? w.text.toLocaleUpperCase('tr') : w.text;
        var chars = txt.length, dur = (t1 - w.t0) / 1000;
        return { t0: w.t0, t1: t1, lines: [txt], words: [clone(w)],
                 cps: dur > 0 ? Math.round((chars / dur) * 10) / 10 : 99 };
      });
    }

    var maxBlockChars = o.maxCharsPerLine * o.maxLines;
    var blocks = [];
    var cur = null;

    function charCount(ws) {
      var n = 0;
      ws.forEach(function (w) { n += w.text.length; });
      return n + Math.max(0, ws.length - 1);
    }

    function flush() {
      if (!cur || !cur.words.length) { cur = null; return; }
      var texts = cur.words.map(function (w) { return o.uppercase ? w.text.toLocaleUpperCase('tr') : w.text; });
      var t0 = cur.words[0].t0, t1 = cur.words[cur.words.length - 1].t1;
      blocks.push({
        t0: t0, t1: t1,
        lines: breakLines(texts, o.maxCharsPerLine, o.maxLines),
        words: clone(cur.words),
        cps: 0
      });
      cur = null;
    }

    words.forEach(function (w) {
      if (cur) {
        var last = cur.words[cur.words.length - 1];
        var gap = w.t0 - last.t1;
        var candChars = charCount(cur.words.concat([w]));
        var candDur = w.t1 - cur.words[0].t0;
        var punctBreak = o.splitOnPunct && STRONG_PUNCT.test(last.text) &&
          charCount(cur.words) >= Math.min(12, o.maxCharsPerLine * 0.3);
        // transkript satırı değişti → yeni blok (farklı konuşmacıların lafı karışmasın)
        var segBreak = o.splitOnSegment && w.segIdx !== undefined &&
          last.segIdx !== undefined && w.segIdx !== last.segIdx;
        if (candChars > maxBlockChars || candDur > o.maxDurMs || gap > o.gapSplitMs || punctBreak || segBreak) flush();
      }
      if (!cur) cur = { words: [] };
      cur.words.push(w);
    });
    flush();

    /* zamanlama düzeltmeleri */
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var next = blocks[i + 1];
      // asgari süreye uzat (bir sonraki bloğa çarpmadan)
      if (b.t1 - b.t0 < o.minDurMs) {
        var want = b.t0 + o.minDurMs;
        b.t1 = next ? Math.min(want, next.t0 - o.minGapMs) : want;
        if (b.t1 < b.t0 + 200) b.t1 = b.t0 + 200;
      }
      // örtüşmeyi gider — çok sıkışık bloklarda örtüşmektense boşluğu feda et
      if (next && b.t1 > next.t0 - o.minGapMs) {
        b.t1 = Math.max(b.t0 + 1, Math.min(next.t0 - o.minGapMs, b.t1));
        if (b.t1 <= b.t0) b.t1 = Math.min(b.t0 + 200, next.t0);
      }
      var chars = b.lines.join(' ').length;
      var dur = (b.t1 - b.t0) / 1000;
      b.cps = dur > 0 ? Math.round((chars / dur) * 10) / 10 : 99;
    }
    return blocks;
  }

  /* ---------------- zaman biçimleri ---------------- */

  function pad(n, w) { n = String(Math.floor(n)); while (n.length < w) n = '0' + n; return n; }

  function msToSrt(ms) {
    ms = Math.max(0, Math.round(ms));
    return pad(ms / 3600000, 2) + ':' + pad((ms % 3600000) / 60000, 2) + ':' +
      pad((ms % 60000) / 1000, 2) + ',' + pad(ms % 1000, 3);
  }
  function msToVtt(ms) { return msToSrt(ms).replace(',', '.'); }
  function msToAss(ms) {
    ms = Math.max(0, Math.round(ms));
    return Math.floor(ms / 3600000) + ':' + pad((ms % 3600000) / 60000, 2) + ':' +
      pad((ms % 60000) / 1000, 2) + '.' + pad((ms % 1000) / 10, 2);
  }

  /* ---------------- dışa aktarım biçimleri ---------------- */

  function toSRT(blocks) {
    return blocks.map(function (b, i) {
      return (i + 1) + '\n' + msToSrt(b.t0) + ' --> ' + msToSrt(b.t1) + '\n' + b.lines.join('\n');
    }).join('\n\n') + '\n';
  }

  function toVTT(blocks) {
    return 'WEBVTT\n\n' + blocks.map(function (b) {
      return msToVtt(b.t0) + ' --> ' + msToVtt(b.t1) + '\n' + b.lines.join('\n');
    }).join('\n\n') + '\n';
  }

  function toTXT(blocks) {
    return blocks.map(function (b) { return b.lines.join(' '); }).join('\n') + '\n';
  }

  function toCSV(blocks) {
    function esc(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }
    var rows = ['start_ms,end_ms,start,end,text'];
    blocks.forEach(function (b) {
      rows.push([b.t0, b.t1, msToSrt(b.t0), msToSrt(b.t1), esc(b.lines.join(' '))].join(','));
    });
    return rows.join('\n') + '\n';
  }

  /* ---------------- ASS (stilli render) ---------------- */

  var STYLE_DEFAULTS = {
    fontFamily: 'Helvetica Neue',
    fontSizePct: 5.2,          // PlayResY yüzdesi
    textColor: '#FFFFFF',
    bold: true,
    italic: false,
    outlineEnabled: true,
    outlineColor: '#000000',
    outlineWidth: 2,           // px (PlayResY=720 tabanında)
    shadow: 0,
    backgroundEnabled: true,
    backgroundColor: '#000000',
    backgroundAlpha: 0.55,     // 0 şeffaf → 1 opak
    position: 'bottom',        // bottom | middle | top
    marginVPct: 6,
    karaoke: false,
    karaokeColor: '#FFD400',
    uppercase: false
  };

  function mergeStyle(style) {
    var out = {};
    for (var k in STYLE_DEFAULTS) out[k] = STYLE_DEFAULTS[k];
    if (style) for (var j in style) if (style[j] !== undefined && style[j] !== null) out[j] = style[j];
    return out;
  }

  // '#RRGGBB' + alpha(0-1 opaklık) → ASS '&HAABBGGRR'
  function assColor(hex, alphaOpacity) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#FFFFFF');
    var r = m ? m[1] : 'FF', g = m ? m[2] : 'FF', b = m ? m[3] : 'FF';
    var a = (alphaOpacity == null) ? 0 : Math.round((1 - alphaOpacity) * 255);
    // pad() sayısal çalışır; hex string'e uygulanırsa NaN üretir — burada string doldur
    var hexA = ('0' + a.toString(16).toUpperCase()).slice(-2);
    return '&H' + hexA + (b + g + r).toUpperCase();
  }

  function escAss(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')');
  }

  function toASS(blocks, style, width, height) {
    var st = mergeStyle(style);
    var W = width || 1920, H = height || 1080;
    var fontSize = Math.round(H * st.fontSizePct / 100);
    var align = st.position === 'top' ? 8 : (st.position === 'middle' ? 5 : 2);
    var marginV = Math.round(H * st.marginVPct / 100);
    var marginH = Math.round(W * 0.05); // yatay kenar %5 — sarma sınırı
    var scale = H / 720;
    var outlineOn = st.outlineEnabled !== false && st.outlineWidth > 0;
    var outline = outlineOn ? Math.round(st.outlineWidth * scale * 10) / 10 : 0;
    var boxPad = Math.max(outline, Math.round(fontSize * 0.22));

    // Karaoke: PrimaryColour = söylenmiş (vurgu), SecondaryColour = henüz söylenmemiş (taban)
    var primary = st.karaoke ? assColor(st.karaokeColor, 1) : assColor(st.textColor, 1);
    var secondary = assColor(st.textColor, 1);
    var transparent = assColor('#000000', 0);

    function styleLine(name, borderStyle, outlineW, primaryC, secondaryC, outlineC, backC) {
      return ['Style: ' + name, st.fontFamily, fontSize, primaryC, secondaryC, outlineC, backC,
        st.bold ? -1 : 0, st.italic ? -1 : 0, 0, 0, 100, 100, 0, 0,
        borderStyle, outlineW, st.shadow, align, marginH, marginH, marginV, 1].join(',');
    }

    // Metin katmanı her zaman BorderStyle 1: kontur genişliği kullanıcının değeri,
    // kapalıysa gerçekten 0. Arkaplan kutusu ayrı bir alt katmandır (BorderStyle 4,
    // libass'a özgü satır başına kutu; Outline değeri kutu dolgusu olur). BorderStyle 4
    // glifleri de OutlineColour ile konturladığından kutu katmanının yazısı ve konturu
    // tam şeffaftır — görünen metin ve kontur yalnız üst katmandan gelir. Böylece
    // kontur kutu dolgusundan bağımsızdır; kutu + kontur birlikte de çalışır.
    var styles = [];
    if (st.backgroundEnabled) {
      styles.push(styleLine('FisiltiBox', 4, boxPad, transparent, transparent,
        transparent, assColor(st.backgroundColor, st.backgroundAlpha)));
    }
    styles.push(styleLine('Fisilti', 1, outline, primary, secondary,
      assColor(st.outlineColor, 1), assColor(st.backgroundColor, st.backgroundAlpha)));

    var head = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: ' + W,
      'PlayResY: ' + H,
      // 0 = akıllı sarma: satır yine de tuvale sığmazsa libass dengeli böler
      // (2 = sarma yok → dikey sequence'ta taşıyordu)
      'WrapStyle: 0',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
      'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, ' +
      'Alignment, MarginL, MarginR, MarginV, Encoding'
    ].concat(styles).concat([
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
    ]);

    var events = [];
    blocks.forEach(function (b) {
      var plain = b.lines.map(function (l) {
        return escAss(st.uppercase ? l.toLocaleUpperCase('tr') : l);
      }).join('\\N');
      var text;
      if (st.karaoke && b.words && b.words.length) {
        // \k süreleri santisaniyedir; kelime aralarındaki boşluk süreye dahil edilir
        var parts = [];
        for (var i = 0; i < b.words.length; i++) {
          var w = b.words[i];
          var end = (i + 1 < b.words.length) ? b.words[i + 1].t0 : w.t1;
          var cs = Math.max(1, Math.round((end - Math.max(w.t0, b.t0)) / 10));
          var txt = st.uppercase ? w.text.toLocaleUpperCase('tr') : w.text;
          parts.push('{\\k' + cs + '}' + escAss(txt));
        }
        // satır kırılımını koru: kelime sayısına göre \N yerleştir
        var lineWordCounts = b.lines.map(function (l) { return l.split(/\s+/).filter(Boolean).length; });
        var rebuilt = [], idx = 0;
        lineWordCounts.forEach(function (n, li) {
          rebuilt.push(parts.slice(idx, idx + n).join(' '));
          idx += n;
        });
        text = rebuilt.join('\\N');
      } else {
        text = plain;
      }
      // Kutu katmanı görünen metinle aynı satır kırılımını taşımalı (kutu boyutu
      // metinden hesaplanır) ama \k etiketsiz — kutu, karaoke ile parça parça çıkmasın
      if (st.backgroundEnabled) {
        events.push('Dialogue: 0,' + msToAss(b.t0) + ',' + msToAss(b.t1) + ',FisiltiBox,,0,0,0,,' + plain);
      }
      events.push('Dialogue: 1,' + msToAss(b.t0) + ',' + msToAss(b.t1) + ',Fisilti,,0,0,0,,' + text);
    });

    return head.concat(events).join('\n') + '\n';
  }

  /* ---------------- konuşma başlangıcına hizalama ---------------- */

  // Whisper ilk segmenti (ve sessizlik sonrası segmentleri) sıkça 0'dan ya da
  // gerçek konuşmadan saniyeler önce başlatır. Ses enerjisiyle (pencere RMS)
  // segment başlangıcını ilk sesli pencereye çeker. Yalnız başlangıç oynar;
  // bitişe dokunulmaz. Gürültü/müzik altında eşik aşılmazsa hiçbir şey değişmez.
  //   segments: [{t0,t1,text,words?}] ms (wav'a göre), rms: [Number], winMs: pencere
  //   opts: { maxShiftMs (3000), minShiftMs (120), padMs (60) }
  function snapToSpeech(segments, rms, winMs, opts) {
    opts = opts || {};
    if (!rms || rms.length < 10 || !winMs) return segments;
    var maxShift = opts.maxShiftMs != null ? opts.maxShiftMs : 3000;
    var minShift = opts.minShiftMs != null ? opts.minShiftMs : 250; // altyazının ~0.25 sn önde gelmesi doğal
    var pad = opts.padMs != null ? opts.padMs : 80;
    var sorted = rms.slice().sort(function (a, b) { return a - b; });
    var floor = sorted[Math.floor(sorted.length * 0.2)] || 0;

    return segments.map(function (seg) {
      var i0 = Math.max(0, Math.floor(seg.t0 / winMs));
      var i1 = Math.min(rms.length, Math.ceil(seg.t1 / winMs));
      if (i1 - i0 < 3) return seg;
      var peak = 0;
      for (var i = i0; i < i1; i++) if (rms[i] > peak) peak = rms[i];
      var thr = Math.max(floor * 3, peak * 0.2);
      if (peak <= floor * 3) return seg; // segment tümüyle sessiz/gürültü: dokunma
      var on = -1;
      for (var j = i0; j < i1 - 1; j++) {
        if (rms[j] > thr && rms[j + 1] > thr) { on = j; break; }
      }
      if (on < 0) return seg;
      // yumuşak giriş: gürültü tabanının belirgin üstündeki zayıf pencereleri
      // geriye doğru kapsa (en çok 500 ms) — "h", "s" gibi sessiz başlangıçlar kesilmesin
      var soft = floor * 1.5, back = 0;
      while (on > i0 && back < Math.ceil(500 / winMs) && rms[on - 1] > soft) { on--; back++; }
      var newT0 = Math.max(seg.t0, on * winMs - pad);
      var shift = newT0 - seg.t0;
      if (shift < minShift || shift > maxShift) return seg;
      if (newT0 >= seg.t1 - 200) return seg;
      var out = { t0: newT0, t1: seg.t1, text: seg.text, words: null };
      if (seg.words && seg.words.length) {
        // Yeni başlangıçtan önce kalan kelimelerin zamanı güvenilmez: onları
        // [newT0, ilk güvenilir kelime) aralığına eşit dağıt; gerisi aynen kalır.
        var ws = seg.words.map(function (w) { return { t0: w.t0, t1: w.t1, text: w.text }; });
        var k = 0;
        while (k < ws.length && ws[k].t0 < newT0 + 100) k++;
        var spanEnd = k < ws.length ? ws[k].t0 : seg.t1;
        if (k > 0 && spanEnd > newT0) {
          var step = (spanEnd - newT0) / k;
          for (var q = 0; q < k; q++) {
            ws[q].t0 = Math.round(newT0 + q * step);
            ws[q].t1 = Math.round(newT0 + (q + 1) * step);
          }
        }
        out.words = ws;
      }
      return out;
    });
  }

  // Verilen tuval ve yazı boyutu için bir satıra sığan karakter sayısı (kaba
  // kestirim: kalın sans-serif'te ortalama karakter ~0.55 em; yatayda %5 kenar).
  function fitCharsPerLine(width, height, fontSizePct, marginHPct) {
    var fontPx = height * (fontSizePct || 5) / 100;
    var usable = width * (1 - 2 * ((marginHPct != null ? marginHPct : 5) / 100));
    return Math.max(4, Math.floor(usable / (fontPx * 0.55)));
  }

  /* ---------------- canlı akış satırı ayrıştırma ---------------- */

  // whisper-cli stdout satırı: "[00:00:03.240 --> 00:00:06.120]   Metin..."
  var LIVE_RE = /^\[(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\]\s?(.*)$/;

  function parseLiveLine(line) {
    var m = LIVE_RE.exec(line);
    if (!m) return null;
    function ms(h, mn, s, msP) { return (+h) * 3600000 + (+mn) * 60000 + (+s) * 1000 + (+msP); }
    var text = m[9].trim();
    if (!text) return null;
    return { t0: ms(m[1], m[2], m[3], m[4]), t1: ms(m[5], m[6], m[7], m[8]), text: text };
  }

  return {
    DEFAULTS: DEFAULTS,
    STYLE_DEFAULTS: STYLE_DEFAULTS,
    estimateWords: estimateWords,
    flattenToWords: flattenToWords,
    wordsFromWhisperJson: wordsFromWhisperJson,
    segmentsFromWhisperJson: segmentsFromWhisperJson,
    breakLines: breakLines,
    buildCaptions: buildCaptions,
    msToSrt: msToSrt,
    msToVtt: msToVtt,
    msToAss: msToAss,
    assColor: assColor,
    toSRT: toSRT,
    toVTT: toVTT,
    toTXT: toTXT,
    toCSV: toCSV,
    toASS: toASS,
    snapToSpeech: snapToSpeech,
    fitCharsPerLine: fitCharsPerLine,
    parseLiveLine: parseLiveLine
  };
}));
