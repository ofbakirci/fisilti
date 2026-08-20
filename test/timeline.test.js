/* Fısıltı timeline.js saf yardımcı testleri — `node test/timeline.test.js` */
'use strict';
const assert = require('assert');
const path = require('path');
const T = require(path.join(__dirname, '..', 'js', 'timeline.js'));

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

t('timeToX / xToTime gidiş-dönüş', () => {
  assert.strictEqual(T.timeToX(12.5, 30), 375);
  assert.strictEqual(T.xToTime(375, 30), 12.5);
  assert.strictEqual(T.xToTime(100, 0), 0); // sıfır bölme korunur
});

t('clampPps sınırları uygular', () => {
  assert.strictEqual(T.clampPps(1), 4);
  assert.strictEqual(T.clampPps(9999), 240);
  assert.strictEqual(T.clampPps(30), 30);
});

t('resolveDrag move: kaydırır, 0 altına inmez', () => {
  assert.deepStrictEqual(T.resolveDrag('move', 5, 8, 2), { t0: 7, t1: 10 });
  // 0'ın soluna taşma: kayma kırpılır, süre korunur
  assert.deepStrictEqual(T.resolveDrag('move', 1, 3, -5), { t0: 0, t1: 2 });
});

t('resolveDrag left: başlangıç oynar, asgari süre korunur', () => {
  assert.deepStrictEqual(T.resolveDrag('left', 5, 8, 1), { t0: 6, t1: 8 });
  const r = T.resolveDrag('left', 5, 8, 10); // bitişi geçemez
  assert.ok(r.t0 <= 8 - T.MIN_DUR + 1e-9);
  assert.strictEqual(r.t1, 8);
  assert.deepStrictEqual(T.resolveDrag('left', 5, 8, -10), { t0: 0, t1: 8 }); // 0 tabanı
});

t('resolveDrag right: bitiş oynar, asgari süre korunur', () => {
  assert.deepStrictEqual(T.resolveDrag('right', 5, 8, 2), { t0: 5, t1: 10 });
  const r = T.resolveDrag('right', 5, 8, -10);
  assert.strictEqual(r.t0, 5);
  assert.ok(r.t1 >= 5 + T.MIN_DUR - 1e-9);
});

t('compactEnergy: yarıya indirir, 0-100 normalize eder', () => {
  const rms = [];
  for (let i = 0; i < 200; i++) rms.push(i < 100 ? 500 : 4000);
  const en = T.compactEnergy({ winMs: 50, rms }, 3.5);
  assert.strictEqual(en.winMs, 100);
  assert.strictEqual(en.offsetSec, 3.5);
  assert.strictEqual(en.rms.length, 100);
  en.rms.forEach(v => { assert.ok(Number.isInteger(v) && v >= 0 && v <= 100, 'aralık dışı: ' + v); });
  assert.ok(en.rms[10] < en.rms[90], 'sessiz bölüm yüksek bölümden küçük olmalı');
  assert.ok(en.rms[90] >= 95, 'konuşma ~100 olmalı: ' + en.rms[90]);
});

t('compactEnergy: tek patlama dalgayı ezmez (98. yüzdelik)', () => {
  const rms = new Array(400).fill(1000);
  rms[7] = 1e9; // tek spike
  const en = T.compactEnergy({ winMs: 50, rms }, 0);
  const typical = en.rms[100];
  assert.ok(typical >= 90, 'tipik değer normalize sonrası yüksek kalmalı: ' + typical);
});

t('compactEnergy: boş/geçersiz girişte null', () => {
  assert.strictEqual(T.compactEnergy(null, 0), null);
  assert.strictEqual(T.compactEnergy({ winMs: 50, rms: [] }, 0), null);
});

t('gridStep: yakınlaştıkça adım küçülür', () => {
  assert.ok(T.gridStep(240) < T.gridStep(4));
  [4, 30, 240].forEach(pps => {
    assert.ok(T.gridStep(pps) * pps >= 80, 'etiketler çakışmamalı (pps=' + pps + ')');
  });
});

console.log('\n' + passed + ' test geçti' + (process.exitCode ? ' (HATALAR VAR)' : ''));
