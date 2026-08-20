/* Fısıltı prstyle.js birim testleri — `node test/prstyle.test.js` */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const P = require(path.join(__dirname, '..', 'js', 'prstyle.js'));

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

function readTree(blob) {
  // mini FlatBuffers okuyucu (test amaçlı): bilinen alanları çıkarır
  const fb = blob.slice(12);
  const dv = new DataView(fb.buffer, fb.byteOffset, fb.length);
  const u16 = o => dv.getUint16(o, true), i32 = o => dv.getInt32(o, true),
        u32 = o => dv.getUint32(o, true), f32 = o => dv.getFloat32(o, true);
  const root = u32(0);
  const main = root + 4 + u32(root + 4);
  const vt = main - i32(main);
  const fo = fi => u16(vt + 4 + fi * 2);
  const off = fi => main + fo(fi) + u32(main + fo(fi));
  // font: .1 vektör → string
  const vecF = off(1);
  const sF = vecF + 4 + u32(vecF + 4);
  const font = Buffer.from(fb.slice(sF + 4, sF + 4 + u32(sF))).toString('utf8');
  // paragraf → char
  const vecP = off(0);
  const tPar = vecP + 4 + u32(vecP + 4);
  const vtP = tPar - i32(tPar);
  const tChar = tPar + u16(vtP + 6) + u32(tPar + u16(vtP + 6));
  const vtC = tChar - i32(tChar);
  const cfo = fi => u16(vtC + 4 + fi * 2);
  const size = f32(tChar + cfo(1));
  const strokeW = f32(tChar + cfo(6));
  function color(tbl) {
    const v = tbl - i32(tbl);
    const out = [255, 255, 255];
    const n = (u16(v) - 4) / 2;
    for (let k = 0; k < n && k < 3; k++) {
      const o = u16(v + 4 + k * 2);
      if (o) out[k] = fb[tbl + o];
    }
    return out;
  }
  const fill = color(tChar + cfo(2) + u32(tChar + cfo(2)));
  const stroke = color(tChar + cfo(21) + u32(tChar + cfo(21)));
  const bg = color(off(17));
  const bgOpacity = f32(main + fo(19));
  return { font, size, strokeW, fill, stroke, bg, bgOpacity };
}

t('buildBlob paneldeki stili aynen taşır', () => {
  const blob = P.buildBlob({
    font: 'HelveticaNeue-Bold', size: 230, fill: [52, 120, 246],
    strokeW: 16, stroke: [0, 0, 0], c17: [10, 20, 30], f19: 90, b11: 1
  });
  const r = readTree(blob);
  assert.strictEqual(r.font, 'HelveticaNeue-Bold');
  assert.strictEqual(Math.round(r.size), 230);
  assert.strictEqual(Math.round(r.strokeW), 16);
  assert.deepStrictEqual(r.fill, [52, 120, 246]);
  assert.deepStrictEqual(r.stroke, [0, 0, 0]);
  assert.deepStrictEqual(r.bg, [10, 20, 30]);
  assert.strictEqual(Math.round(r.bgOpacity), 90);
});

t('buildBlob b5 (faux bold) bayrağını taşır', () => {
  const on = P.buildBlob({ b5: 1 }), off = P.buildBlob({ b5: 0 });
  // char tablosundaki .5 baytı: iki blob yalnız o baytta ayrışmalı
  assert.strictEqual(on.length, off.length);
  const diffs = [];
  for (let i = 0; i < on.length; i++) if (on[i] !== off[i]) diffs.push(i);
  assert.strictEqual(diffs.length, 1, 'tek bayt farklı olmalı: ' + diffs);
  assert.strictEqual(on[diffs[0]], 1);
  assert.strictEqual(off[diffs[0]], 0);
});

t('buildBlob beyaz dahil tüm kanalları açıkça yazar', () => {
  const blob = P.buildBlob({ fill: [255, 0, 128] });
  const r = readTree(blob);
  assert.deepStrictEqual(r.fill, [255, 0, 128]);
  const w = P.buildBlob({ fill: [255, 255, 255] });
  assert.deepStrictEqual(readTree(w).fill, [255, 255, 255]);
});

t('makePrtextstyle adı, UID\'leri ve blob\'u değiştirir', () => {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'payloads', 'style_template.prtextstyle'), 'utf8');
  const blob = P.buildBlob({ font: 'Futura-Bold', size: 100 });
  let i = 0;
  const doc = P.makePrtextstyle(tpl, 'Fisilti 7', blob, () => '00000000-0000-4000-8000-00000000000' + (i++ % 10));
  assert.ok(doc.includes('<Name>Fisilti 7</Name>'));
  assert.ok(!doc.includes('CLAUDETRIAL'));
  assert.ok(!/fac6cee9|9feb7b19/.test(doc), 'eski UID kalmış');
  const m = /BinaryHash="([^"]+)">([^<]+)</.exec(doc);
  assert.ok(m, 'blob bölümü yok');
  const decoded = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  assert.strictEqual(decoded.length, blob.length);
  assert.deepStrictEqual(readTree(new Uint8Array(decoded)).font, 'Futura-Bold');
  // hash sonu = blob uzunluğu (büyük endian hex)
  assert.ok(m[1].replace(/-/g, '').endsWith(blob.length.toString(16).padStart(8, '0')));
});

console.log('\n' + passed + ' test geçti' + (process.exitCode ? ' (HATALAR VAR)' : ''));
