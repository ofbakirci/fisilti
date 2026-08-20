/*
 * Fısıltı — Premiere .prtextstyle üretici.
 * Premiere'in metin stili (Text Style) dosyasını panel stilinden üretir.
 * Blob formatı: Adobe TextDocument FlatBuffers — harita, üç örnek stilin
 * (CLAUDETRIAL/DENEME2/DENEME3, 2026-08-20) byte-diff'inden çıkarıldı.
 * Saf mantık: CEP'e bağımlılık yok, Node ile test edilir.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FisiltiPrStyle = api;
}(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  /* ---------- küçük binary kurucu ---------- */
  function Builder() { this.chunks = []; this.pos = 0; }
  Builder.prototype.add = function (bytes) {
    var off = this.pos;
    this.chunks.push({ off: off, data: new Uint8Array(bytes) });
    this.pos += bytes.length !== undefined ? bytes.length : bytes.byteLength;
    return off;
  };
  Builder.prototype.patch = function (off, bytes) {
    for (var i = 0; i < this.chunks.length; i++) {
      var c = this.chunks[i];
      if (off >= c.off && off < c.off + c.data.length) {
        c.data.set(bytes, off - c.off);
        return;
      }
    }
    throw new Error('patch ' + off);
  };
  Builder.prototype.bytes = function () {
    var out = new Uint8Array(this.pos);
    this.chunks.forEach(function (c) { out.set(c.data, c.off); });
    return out;
  };

  function u16(v) { return [v & 255, (v >> 8) & 255]; }
  function u32(v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]; }
  function f32(v) {
    var b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    return Array.prototype.slice.call(b);
  }
  function pad4(arr) { while (arr.length % 4) arr.push(0); return arr; }
  function strBytes(s) {
    // UTF-8
    var enc = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 128) enc.push(c);
      else if (c < 2048) enc.push(192 | (c >> 6), 128 | (c & 63));
      else enc.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    }
    return enc;
  }

  /*
   * opts: { font (PostScript adı), size (px), fill [r,g,b], strokeW (px),
   *         stroke [r,g,b], c23 [r,g,b], c10 [r,g,b], c17 [r,g,b] (arkaplan),
   *         f12 (arkaplan opaklık % 0-100), f19, f20, b11 (arkaplan açık mı 0/1) }
   * Renkler 0-255; alan yalnız 255'ten farklıysa yazılır (FlatBuffers default).
   */
  function buildBlob(opts) {
    var o = opts || {};
    var font = o.font || 'Helvetica';
    var size = o.size != null ? o.size : 119;
    var fill = o.fill || [255, 255, 255];
    var strokeW = o.strokeW != null ? o.strokeW : 15;
    var stroke = o.stroke || [255, 255, 255];
    var c23 = o.c23 || [255, 255, 255];
    var c10 = o.c10 || [0, 0, 0];
    var c17 = o.c17 || [64, 30, 30];
    var f12 = o.f12 != null ? o.f12 : 100;
    var f19v = o.f19 != null ? o.f19 : 88.0952;
    var f20v = o.f20 != null ? o.f20 : 10;
    var b11 = o.b11 != null ? o.b11 : 1;

    var b = new Builder();
    b.add(u32(12));                       // root tablo @12
    b.add([0, 0]);                        // pad
    b.add(u16(6).concat(u16(10), u16(4))); // root vtable
    var root = b.add(u32(6).concat(u32(0)));

    // ana tablo (45 alan) — alan offset düzeni Adobe'yle birebir
    var MO = { 0: 16, 1: 12, 4: 72, 5: 68, 10: 64, 11: 63, 12: 56, 14: 52, 15: 48,
               16: 44, 17: 40, 18: 39, 19: 32, 20: 28, 26: 26, 32: 20, 40: 8, 43: 27, 44: 7 };
    var offs = [];
    for (var fi = 0; fi < 45; fi++) offs = offs.concat(u16(MO[fi] || 0));
    var vtMain = b.add(u16(94).concat(u16(76), offs));
    var main = b.add(new Array(76).fill(0));
    b.patch(main, u32((main - vtMain) >>> 0)); // soffset pozitif (vt önde)
    function setf(field, bytes) { b.patch(main + MO[field], bytes); }
    setf(4, u32(2)); setf(5, u32(2));
    setf(11, [b11 ? 1 : 0]); setf(12, f32(f12));
    setf(14, f32(3)); setf(15, f32(6)); setf(16, f32(12));
    setf(18, [1]); setf(19, f32(f19v)); setf(20, f32(f20v));
    setf(26, [1]); setf(43, [0]); setf(44, [1]);

    var vtEmpty = b.add(u16(4).concat(u16(4)));
    function emptyTable() {
      var t = b.add(u32(0));
      b.patch(t, u32((t - vtEmpty) >>> 0));
      return t;
    }
    var t40 = emptyTable();
    setf(40, u32(t40 - (main + MO[40])));

    function colorTable(rgb) {
      if (rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255) return emptyTable();
      var pos = 4, fo = [], data = [];
      for (var k = 0; k < 3; k++) {
        if (rgb[k] === 255) fo.push(0);
        else { fo.push(pos); data.push(rgb[k]); pos++; }
      }
      var tsz = 4 + data.length;
      var vt = b.add(u16(10).concat(u16(tsz), u16(fo[0]), u16(fo[1]), u16(fo[2])));
      var t = b.add(u32(0).concat(data));
      b.patch(t, u32((t - vt) >>> 0));
      return t;
    }
    var t10 = colorTable(c10); setf(10, u32(t10 - (main + MO[10])));
    var t17 = colorTable(c17); setf(17, u32(t17 - (main + MO[17])));

    // r.0.32: [{name:"AnimationType"}]
    var vec32 = b.add(u32(1).concat(u32(0)));
    setf(32, u32(vec32 - (main + MO[32])));
    var vtNamed = b.add(u16(6).concat(u16(8), u16(4)));
    var tAnim = b.add(u32(0).concat(u32(0)));
    b.patch(tAnim, u32((tAnim - vtNamed) >>> 0));
    b.patch(vec32 + 4, u32(tAnim - (vec32 + 4)));
    var sAnim = b.add(pad4(u32(13).concat(strBytes('AnimationType'), [0])));
    b.patch(tAnim + 4, u32(sAnim - (tAnim + 4)));

    // font vektörü
    var vecF = b.add(u32(1).concat(u32(0)));
    setf(1, u32(vecF - (main + MO[1])));
    var fB = strBytes(font);
    var sFont = b.add(pad4(u32(fB.length).concat(fB, [0])));
    b.patch(vecF + 4, u32(sFont - (vecF + 4)));

    // paragraf vektörü → paragraf → karakter → renkler → "Aa"
    var vecP = b.add(u32(1).concat(u32(0)));
    setf(0, u32(vecP - (main + MO[0])));
    var vtPar = b.add(u16(8).concat(u16(12), u16(4), u16(8)));
    var tPar = b.add(u32(0).concat(u32(0), u32(0)));
    b.patch(tPar, u32((tPar - vtPar) >>> 0));
    b.patch(vecP + 4, u32(tPar - (vecP + 4)));

    var CO = { 1: 28, 2: 24, 5: 23, 6: 16, 21: 12, 23: 8, 24: 4 };
    var coffs = [];
    for (var ci = 0; ci < 25; ci++) coffs = coffs.concat(u16(CO[ci] || 0));
    var vtChar = b.add(u16(54).concat(u16(32), coffs));
    var tChar = b.add(new Array(32).fill(0));
    b.patch(tChar, u32((tChar - vtChar) >>> 0));
    b.patch(tPar + 8, u32(tChar - (tPar + 8)));
    function setc(field, bytes) { b.patch(tChar + CO[field], bytes); }
    setc(1, f32(size)); setc(5, [1]); setc(6, f32(strokeW)); setc(24, u32(2));
    var t2 = colorTable(fill); setc(2, u32(t2 - (tChar + CO[2])));
    var t21 = colorTable(stroke); setc(21, u32(t21 - (tChar + CO[21])));
    var t23 = colorTable(c23); setc(23, u32(t23 - (tChar + CO[23])));
    var sAa = b.add(pad4(u32(2).concat(strBytes('Aa'), [0])));
    b.patch(tPar + 4, u32(sAa - (tPar + 4)));

    b.patch(root + 4, u32(main - (root + 4)));

    var fb = b.bytes();
    var out = new Uint8Array(12 + fb.length);
    new DataView(out.buffer).setUint32(0, fb.length, true); // uint64 LE alt yarısı
    out[8] = 0x44; out[9] = 0x33; out[10] = 0x22; out[11] = 0x11;
    out.set(fb, 12);
    return out;
  }

  function toBase64(bytes) {
    var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += A[b0 >> 2] + A[((b0 & 3) << 4) | ((b1 || 0) >> 4)];
      out += (i + 1 < bytes.length) ? A[((b1 & 15) << 2) | ((b2 || 0) >> 6)] : '=';
      out += (i + 2 < bytes.length) ? A[b2 & 63] : '=';
    }
    return out;
  }

  // Şablon (gerçek bir .prtextstyle XML'i) + yeni ad + yeni blob → dosya içeriği.
  // uuidFn: 36 karakterlik benzersiz kimlik üretici (çakışmasın diye her seferinde yeni).
  function makePrtextstyle(templateXml, name, blob, uuidFn) {
    var s = templateXml;
    // Tüm nesne kimliklerini yenile (aynı stilin tekrar importu çakışmasın)
    var uids = {};
    s = s.replace(/Object(UID|URef)="([0-9a-f-]{36})"/g, function (m, kind, old) {
      if (!uids[old]) uids[old] = uuidFn();
      return 'Object' + kind + '="' + uids[old] + '"';
    });
    s = s.replace(/<Name>[^<]*<\/Name>/, '<Name>' + name.replace(/[<&]/g, '') + '</Name>');
    var b64 = toBase64(blob);
    var wrapped = b64.replace(/(.{72})/g, '$1\n');
    // BinaryHash: ilk 12 bayt serbest, son 4 bayt büyük-endian blob uzunluğu (gözlem)
    var hex = '';
    for (var i = 0; i < 12; i++) hex += ((Math.abs((blob[i * 7 % blob.length] * 31 + i * 97) | 0) % 256) | 256).toString(16).slice(-2);
    var lenHex = ('00000000' + blob.length.toString(16)).slice(-8);
    var hash = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 24) + lenHex;
    s = s.replace(/(<StartKeyframeValue Encoding="base64" BinaryHash=")[^"]+(">)[^<]+(<\/StartKeyframeValue>)/,
      function (m, p1, p2, p3) { return p1 + hash + p2 + wrapped + '\n\t\t' + p3; });
    return s;
  }

  return { buildBlob: buildBlob, makePrtextstyle: makePrtextstyle, toBase64: toBase64 };
}));
