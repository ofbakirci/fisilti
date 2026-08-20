/* Fısıltı captions.js birim testleri — `node test/captions.test.js` */
'use strict';
const assert = require('assert');
const path = require('path');
const C = require(path.join(__dirname, '..', 'js', 'captions.js'));

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

/* ---- canlı satır ayrıştırma ---- */
t('parseLiveLine gerçek whisper-cli satırını çözer', () => {
  const seg = C.parseLiveLine('[00:00:00.000 --> 00:00:10.500]   And so, my fellow Americans.');
  assert.deepStrictEqual({ t0: seg.t0, t1: seg.t1 }, { t0: 0, t1: 10500 });
  assert.strictEqual(seg.text, 'And so, my fellow Americans.');
});
t('parseLiveLine virgüllü zaman biçimini de kabul eder', () => {
  const seg = C.parseLiveLine('[00:01:02,500 --> 00:01:03,000] merhaba');
  assert.strictEqual(seg.t0, 62500);
});
t('parseLiveLine alakasız satırı reddeder', () => {
  assert.strictEqual(C.parseLiveLine('whisper_print_timings: total time = 1 ms'), null);
});

/* ---- whisper JSON → kelimeler ---- */
const whisperJson = {
  transcription: [{
    offsets: { from: 0, to: 3000 },
    text: ' And so, my fellow',
    tokens: [
      { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
      { text: ' And', offsets: { from: 320, to: 460 } },
      { text: ' so', offsets: { from: 470, to: 530 } },
      { text: ',', offsets: { from: 680, to: 740 } },
      { text: ' my', offsets: { from: 800, to: 900 } },
      { text: ' fel', offsets: { from: 950, to: 1100 } },
      { text: 'low', offsets: { from: 1100, to: 1300 } },
      { text: '[_TT_150]', offsets: { from: 3000, to: 3000 } }
    ]
  }]
};
t('wordsFromWhisperJson token birleştirme (BPE parçaları + noktalama)', () => {
  const words = C.wordsFromWhisperJson(whisperJson);
  assert.deepStrictEqual(words.map(w => w.text), ['And', 'so,', 'my', 'fellow']);
  assert.strictEqual(words[1].t1, 740);       // virgül kelimeye dahil
  assert.strictEqual(words[3].t0, 950);       // 'fel' başlangıcı
  assert.strictEqual(words[3].t1, 1300);      // 'low' bitişi
});
t('segmentsFromWhisperJson segmentleri çıkarır', () => {
  const segs = C.segmentsFromWhisperJson(whisperJson);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].t1, 3000);
});

/* ---- kelime tahmini ---- */
t('estimateWords süreyi karakter ağırlığıyla paylaştırır', () => {
  const ws = C.estimateWords({ t0: 0, t1: 1000, text: 'ab abcd' });
  assert.strictEqual(ws.length, 2);
  assert.strictEqual(ws[0].t0, 0);
  assert.strictEqual(ws[1].t1, 1000);
  assert.ok(ws[0].t1 < 500, 'kısa kelime daha az süre almalı');
});

/* ---- satır kırma ---- */
t('breakLines kısa metni tek satır bırakır', () => {
  assert.deepStrictEqual(C.breakLines(['merhaba', 'dünya'], 38, 2), ['merhaba dünya']);
});
t('breakLines uzun metni dengeli böler', () => {
  const lines = C.breakLines('bu oldukça uzun bir cümle ve iki satıra bölünmesi gerekiyor'.split(' '), 30, 2);
  assert.strictEqual(lines.length, 2);
  lines.forEach(l => assert.ok(l.length <= 30, 'satır limiti aşıldı: ' + l));
});
t('breakLines satır sonunda bağlaç bırakmamaya çalışır', () => {
  const lines = C.breakLines('kediler köpekler ve kuşlar bahçede oynuyor'.split(' '), 26, 2);
  assert.ok(!/\sve$/.test(lines[0]), '"ve" satır sonunda kaldı: ' + lines[0]);
});

/* ---- blok üretimi ---- */
function mkWords(list) { // [t0, t1, text]
  return list.map(a => ({ t0: a[0], t1: a[1], text: a[2] }));
}
t('buildCaptions uzun boşlukta yeni blok açar', () => {
  const segs = [{ t0: 0, t1: 5000, text: '', words: mkWords([
    [0, 400, 'merhaba'], [450, 900, 'dünya'],
    [3000, 3400, 'yeni'], [3450, 3900, 'blok']
  ]) }];
  const blocks = C.buildCaptions(segs, { gapSplitMs: 1000 });
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[1].lines.join(' '), 'yeni blok');
});
t('buildCaptions karakter limitini aşınca böler (kelime bütünlüğüyle)', () => {
  const words = [];
  for (let i = 0; i < 30; i++) words.push([i * 300, i * 300 + 250, 'kelime' + i]);
  const blocks = C.buildCaptions([{ t0: 0, t1: 9000, text: '', words: mkWords(words) }],
    { maxCharsPerLine: 20, maxLines: 2, maxDurMs: 60000, gapSplitMs: 5000 });
  // kelime asla ortadan kesilmez; satır en fazla limit + bir kelime payı taşar
  const longest = Math.max(...words.map(w => w[2].length));
  blocks.forEach(b => b.lines.forEach(l => {
    assert.ok(l.length <= 20 + longest, 'satır çok uzun: ' + l);
    l.split(' ').forEach(w => assert.ok(/^kelime\d+$/.test(w), 'kelime kesilmiş: ' + w));
  }));
  const all = blocks.map(b => b.lines.join(' ')).join(' ');
  assert.strictEqual(all, words.map(w => w[2]).join(' '), 'metin kaybı var');
  assert.ok(blocks.length > 3);
});
t('buildCaptions asgari süreyi uygular ama sonraki bloğa çarpmaz', () => {
  const segs = [{ t0: 0, t1: 2000, text: '', words: mkWords([
    [0, 100, 'hop'], [1500, 2000, 'devam']
  ]) }];
  const blocks = C.buildCaptions(segs, { minDurMs: 800, gapSplitMs: 1000, minGapMs: 80 });
  assert.strictEqual(blocks.length, 2);
  assert.ok(blocks[0].t1 - blocks[0].t0 >= 200);
  assert.ok(blocks[0].t1 <= blocks[1].t0 - 80);
});
t('buildCaptions cümle sonunda böler (splitOnPunct)', () => {
  const segs = [{ t0: 0, t1: 4000, text: '', words: mkWords([
    [0, 400, 'Bu'], [450, 800, 'bir'], [850, 1200, 'cümledir.'],
    [1300, 1700, 'Yenisi'], [1750, 2100, 'başlar']
  ]) }];
  const blocks = C.buildCaptions(segs, { splitOnPunct: true, gapSplitMs: 5000 });
  assert.strictEqual(blocks.length, 2);
  assert.ok(/cümledir\.$/.test(blocks[0].lines.join(' ')));
});

/* ---- biçimler ---- */
const sampleBlocks = C.buildCaptions([{ t0: 0, t1: 2500, text: 'merhaba dünya nasılsın' }]);
t('toSRT geçerli SRT üretir', () => {
  const srt = C.toSRT(sampleBlocks);
  assert.ok(/^1\n00:00:00,000 --> /.test(srt), srt.slice(0, 60));
});
t('toVTT WEBVTT başlığı ve nokta ayracı kullanır', () => {
  const vtt = C.toVTT(sampleBlocks);
  assert.ok(vtt.startsWith('WEBVTT\n'));
  assert.ok(/00:00:00\.000/.test(vtt));
});
t('toCSV alıntı içeren metni kaçırır', () => {
  const csv = C.toCSV([{ t0: 0, t1: 1000, lines: ['dedi ki "dur"'], words: [] }]);
  assert.ok(csv.includes('"dedi ki ""dur"""'));
});
t('assColor doğru AABBGGRR üretir', () => {
  assert.strictEqual(C.assColor('#FF8000', 1), '&H000080FF');   // opak turuncu
  assert.strictEqual(C.assColor('#000000', 0.5), '&H80000000'); // %50 siyah
});
t('assColor hex harfli alpha değerlerinde NaN üretmez (regresyon)', () => {
  assert.strictEqual(C.assColor('#000000', 0.2), '&HCC000000');  // 0xCC
  assert.strictEqual(C.assColor('#000000', 0), '&HFF000000');    // tam şeffaf
  // UI slider'ının tüm adımları (0.00–1.00, 0.05'lik)
  for (let a = 0; a <= 20; a++) {
    const c = C.assColor('#101010', a / 20);
    assert.ok(/^&H[0-9A-F]{8}$/.test(c), 'bozuk renk: ' + c + ' (alpha=' + a / 20 + ')');
  }
});
t('buildCaptions transkript satırı sınırını aşmaz (konuşmacı karışması regresyonu)', () => {
  // xx: "ya..." / yy: "Oğluşum" — kısa kuyruk noktalama eşiğinin (12 karakter)
  // altında kaldığından eski davranış iki konuşmacıyı aynı bloğa koyuyordu
  const segs = [
    { t0: 0, t1: 2000, text: 'ya...' },
    { t0: 2200, t1: 3000, text: 'Oğluşum' }
  ];
  const blocks = C.buildCaptions(segs, { gapSplitMs: 3000 });
  assert.ok(blocks.length >= 2, 'satır sınırında bölünmedi: ' + JSON.stringify(blocks.map(b => b.lines)));
  blocks.forEach(b => {
    const joined = b.lines.join(' ');
    assert.ok(!(joined.includes('ya...') && joined.includes('Oğluşum')),
      'iki konuşmacı aynı blokta: ' + joined);
  });
  // ayar kapatılırsa eski davranış: birleşebilir
  const merged = C.buildCaptions(segs, { gapSplitMs: 3000, splitOnSegment: false });
  assert.ok(merged.length < blocks.length, 'splitOnSegment:false birleştirmeliydi');
});
t('buildCaptions sıkışık bloklarda örtüşme üretmez (regresyon)', () => {
  const segs = [{ t0: 0, t1: 600, text: '', words: [
    { t0: 0, t1: 100, text: 'çok' }, { t0: 150, t1: 250, text: 'hızlı.' },
    { t0: 300, t1: 400, text: 'Konuşma' }, { t0: 450, t1: 600, text: 'burada' }
  ] }];
  const blocks = C.buildCaptions(segs, { minDurMs: 1000, splitOnPunct: true, gapSplitMs: 5000 });
  for (let i = 0; i + 1 < blocks.length; i++) {
    assert.ok(blocks[i].t1 <= blocks[i + 1].t0, 'örtüşme: blok ' + i + ' t1=' + blocks[i].t1 + ' > blok ' + (i + 1) + ' t0=' + blocks[i + 1].t0);
    assert.ok(blocks[i].t1 > blocks[i].t0, 'sıfır/negatif süre');
  }
});
t('toASS stil ve diyalog satırları üretir', () => {
  const ass = C.toASS(sampleBlocks, { backgroundEnabled: true, position: 'bottom' }, 1920, 1080);
  assert.ok(ass.includes('PlayResX: 1920'));
  assert.ok(ass.includes('Style: Fisilti'));
  assert.ok(/BorderStyle/.test(ass));
  assert.ok(/Dialogue: 0,0:00:00\.00,/.test(ass));
  assert.ok(!/undefined|NaN/.test(ass), 'ASS çıktısında undefined/NaN var');
});
t('toASS karaoke modunda \\k etiketleri üretir', () => {
  const segs = [{ t0: 0, t1: 2000, text: '', words: mkWords([[0, 500, 'bir'], [600, 1100, 'iki'], [1200, 2000, 'üç']]) }];
  const blocks = C.buildCaptions(segs);
  const ass = C.toASS(blocks, { karaoke: true }, 1280, 720);
  assert.ok(/\{\\k\d+\}/.test(ass), 'karaoke \\k etiketi yok: ' + ass.split('\n').pop());
});
t('toASS süslü parantezleri etkisizleştirir', () => {
  const ass = C.toASS([{ t0: 0, t1: 1000, lines: ['tehlike {\\b1} burada'], words: [] }], {}, 1280, 720);
  assert.ok(!/\{\\b1\}/.test(ass));
});
t('toASS kutu açıkken kutuyu ayrı katmanda çizer (kontur kutudan bağımsız)', () => {
  const ass = C.toASS(sampleBlocks, { backgroundEnabled: true, outlineWidth: 3 }, 1280, 720);
  const box = ass.split('\n').find(l => l.startsWith('Style: FisiltiBox'));
  const txt = ass.split('\n').find(l => l.startsWith('Style: Fisilti,'));
  assert.ok(box, 'FisiltiBox stili yok');
  // kutu katmanı: BorderStyle 4, yazı+kontur tam şeffaf (glif konturu kutuyu lekelemesin)
  assert.ok(/,4,\d+(\.\d+)?,0,/.test(box), 'kutu BorderStyle 4 değil: ' + box);
  assert.strictEqual(box.split(',')[3], '&HFF000000', 'kutu yazısı şeffaf olmalı');
  assert.strictEqual(box.split(',')[5], '&HFF000000', 'kutu konturu şeffaf olmalı');
  // metin katmanı: BorderStyle 1, kullanıcının kontur genişliği (3 × 720/720 = 3)
  assert.ok(/,1,3,0,/.test(txt), 'metin katmanı BorderStyle 1 + kontur 3 değil: ' + txt);
  // her blok için iki Dialogue: önce kutu (layer 0), sonra metin (layer 1)
  const dial = ass.split('\n').filter(l => l.startsWith('Dialogue:'));
  assert.strictEqual(dial.length, sampleBlocks.length * 2);
  assert.ok(dial[0].startsWith('Dialogue: 0,') && dial[0].includes('FisiltiBox'));
  assert.ok(dial[1].startsWith('Dialogue: 1,') && dial[1].includes(',Fisilti,'));
});
t('toASS kontur kapatılınca gerçekten 0 yazar (kutu açıkken de)', () => {
  const ass = C.toASS(sampleBlocks, { backgroundEnabled: true, outlineEnabled: false, outlineWidth: 3 }, 1280, 720);
  const txt = ass.split('\n').find(l => l.startsWith('Style: Fisilti,'));
  assert.ok(/,1,0,0,/.test(txt), 'kontur 0 olmalı: ' + txt);
});
t('toASS kutu kapalıyken tek stil, tek Dialogue üretir', () => {
  const ass = C.toASS(sampleBlocks, { backgroundEnabled: false, outlineWidth: 2 }, 1280, 720);
  assert.ok(!ass.includes('FisiltiBox'));
  const dial = ass.split('\n').filter(l => l.startsWith('Dialogue:'));
  assert.strictEqual(dial.length, sampleBlocks.length);
});
t('toASS karaoke + kutu: kutu katmanında \\k etiketi olmaz', () => {
  const segs = [{ t0: 0, t1: 2000, text: '', words: mkWords([[0, 500, 'bir'], [600, 1100, 'iki'], [1200, 2000, 'üç']]) }];
  const blocks = C.buildCaptions(segs);
  const ass = C.toASS(blocks, { karaoke: true, backgroundEnabled: true }, 1280, 720);
  const boxDial = ass.split('\n').filter(l => l.includes('FisiltiBox') && l.startsWith('Dialogue:'));
  assert.ok(boxDial.length > 0);
  boxDial.forEach(l => assert.ok(!/\\k\d/.test(l), 'kutu katmanında \\k var: ' + l));
});

/* ---- konuşma başlangıcına hizalama ---- */
// 50 ms pencere: 0–1.2 sn sessiz (~500), 1.2–5.0 sn konuşma (~4000), sonra sessiz
function fakeRms() {
  const r = [];
  for (let i = 0; i < 200; i++) r.push((i >= 24 && i < 100) || (i >= 110 && i < 126) ? 4000 + (i % 7) * 100 : 500 + (i % 5) * 40);
  return r;
}
t('snapToSpeech erken başlayan segmenti ilk sesli pencereye çeker', () => {
  const segs = [{ t0: 0, t1: 5180, text: 'Ne oldu?', words: [{ t0: 0, t1: 444, text: 'Ne' }, { t0: 444, t1: 5180, text: 'oldu?' }] }];
  const out = C.snapToSpeech(segs, fakeRms(), 50);
  assert.ok(out[0].t0 >= 1100 && out[0].t0 <= 1200, 'beklenen ~1140, gelen ' + out[0].t0);
  assert.strictEqual(out[0].t1, 5180);
  assert.strictEqual(out[0].words[0].t0, out[0].t0, 'ilk kelime yeni başlangıca çekilmeli');
  assert.ok(out[0].words[0].t1 - out[0].words[0].t0 > 300, 'erken kelimeler yeni aralığa dağıtılmalı, sıfır süre kalmamalı');
  assert.ok(out[0].words[1].t0 >= out[0].words[0].t1);
});
t('snapToSpeech zaten hizalı segmente dokunmaz', () => {
  const segs = [{ t0: 5480, t1: 6280, text: 'Anlarız şimdi.', words: null }];
  const out = C.snapToSpeech(segs, fakeRms(), 50);
  assert.strictEqual(out[0].t0, 5480);
});
t('snapToSpeech tamamen sessiz/gürültülü segmente dokunmaz', () => {
  const segs = [{ t0: 7000, t1: 9000, text: '…', words: null }];
  const out = C.snapToSpeech(segs, fakeRms(), 50);
  assert.strictEqual(out[0].t0, 7000);
});
t('snapToSpeech çok büyük kaymayı (>3 sn) reddeder', () => {
  const r = fakeRms(); for (let i = 0; i < 90; i++) r[i] = 500; // konuşma 4.5 sn'de başlasın
  const out = C.snapToSpeech([{ t0: 0, t1: 5180, text: 'x', words: null }], r, 50);
  assert.strictEqual(out[0].t0, 0);
});
t('snapToSpeech rms yoksa girdiyi aynen döner', () => {
  const segs = [{ t0: 0, t1: 100, text: 'x', words: null }];
  assert.strictEqual(C.snapToSpeech(segs, null, 50), segs);
});

/* ---- tuvale sığdırma ---- */
t('fitCharsPerLine dikey sequence\'ta satırı kısaltır, yatayda geniş bırakır', () => {
  const vert = C.fitCharsPerLine(1080, 1920, 12, 5);  // yazı 230px
  const horiz = C.fitCharsPerLine(1920, 1080, 5.2, 5); // yazı 56px
  assert.ok(vert < 12, 'dikey: ' + vert);
  assert.ok(horiz >= 42, 'yatay: ' + horiz);
});
t('toASS akıllı sarma ve yatay kenar boşluğu yazar', () => {
  const ass = C.toASS([{ t0: 0, t1: 1000, lines: ['merhaba'], words: [] }], {}, 1080, 1920);
  assert.ok(/WrapStyle: 0/.test(ass));
  assert.ok(/,54,54,/.test(ass), 'MarginL/R = %5 × 1080 = 54');
});

/* ---- diyalog molası ---- */
t('dialogGapMs: kısa cümle + duraksama = konuşmacı değişimi, ayrı blok', () => {
  // "Ne oldu?" (0-1.1) [400ms mola] "Anlarız şimdi." — aynı whisper segmenti
  const seg = [{ t0: 0, t1: 3000, text: '', words: mkWords([
    [0, 500, 'Ne'], [500, 1100, 'oldu?'], [1500, 2200, 'Anlarız'], [2200, 3000, 'şimdi.']
  ]) }];
  const blocks = C.buildCaptions(seg, { gapSplitMs: 5000, dialogGapMs: 250 });
  assert.strictEqual(blocks.length, 2, JSON.stringify(blocks.map(b => b.lines)));
  assert.strictEqual(blocks[0].lines.join(' '), 'Ne oldu?');
  assert.strictEqual(blocks[1].lines.join(' '), 'Anlarız şimdi.');
});
t('dialogGapMs: duraksama yoksa kısa cümle bölünmez (akıcı konuşma)', () => {
  const seg = [{ t0: 0, t1: 3000, text: '', words: mkWords([
    [0, 500, 'Ne'], [500, 1100, 'oldu?'], [1180, 2200, 'Anlarız'], [2200, 3000, 'şimdi.']
  ]) }];
  const blocks = C.buildCaptions(seg, { gapSplitMs: 5000, dialogGapMs: 250 });
  assert.strictEqual(blocks.length, 1);
});
t('dialogGapMs: 0 verilince kural kapanır', () => {
  const seg = [{ t0: 0, t1: 3000, text: '', words: mkWords([
    [0, 500, 'Ne'], [500, 1100, 'oldu?'], [1500, 2200, 'Anlarız'], [2200, 3000, 'şimdi.']
  ]) }];
  const blocks = C.buildCaptions(seg, { gapSplitMs: 5000, dialogGapMs: 0 });
  assert.strictEqual(blocks.length, 1);
});

/* ---- SRT/VTT içe aktarma ---- */
t('fromSubtitle SRT çözer ve toSRT ile gidiş-dönüş korunur', () => {
  const blocks = [
    { t0: 1120, t1: 5180, lines: ['Ne oldu?', 'Canım mı sıkkın?'], words: [] },
    { t0: 5480, t1: 6280, lines: ['Anlarız şimdi.'], words: [] }
  ];
  const segs = C.fromSubtitle(C.toSRT(blocks));
  assert.strictEqual(segs.length, 2);
  assert.deepStrictEqual([segs[0].t0, segs[0].t1], [1120, 5180]);
  assert.strictEqual(segs[0].text, 'Ne oldu? Canım mı sıkkın?');
  assert.strictEqual(segs[1].text, 'Anlarız şimdi.');
});
t('fromSubtitle VTT başlığını, NOTE bloklarını ve cue ayarlarını atlar', () => {
  const vtt = 'WEBVTT\n\nNOTE deneme\nyorum satırı\n\n00:03.240 --> 00:06.120 position:50% line:90%\nMerhaba <b>dünya</b>\n\n1:00:00.000 --> 1:00:01.500\nSon söz\n';
  const segs = C.fromSubtitle(vtt);
  assert.strictEqual(segs.length, 2);
  assert.deepStrictEqual([segs[0].t0, segs[0].t1], [3240, 6120]);
  assert.strictEqual(segs[0].text, 'Merhaba dünya');
  assert.strictEqual(segs[1].t0, 3600000);
});
t('fromSubtitle bozuk girdide boş döner, BOM yutar', () => {
  assert.deepStrictEqual(C.fromSubtitle('rastgele metin\nzaman yok'), []);
  const segs = C.fromSubtitle('\uFEFF1\n00:00:01,000 --> 00:00:02,000\nSelam\n');
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].text, 'Selam');
});

/* ---- kelime kırpılmaz ---- */
t('breakLines satıra sığmayan kelimeyi kırpmaz, kendi satırına bırakır', () => {
  const lines = C.breakLines(['fotoğrafını', 'çek'], 7, 2);
  assert.deepStrictEqual(lines, ['fotoğrafını', 'çek']);
});
t('buildCaptions dar satır sınırında metin kaybetmez', () => {
  const text = 'Testin fotoğrafını çek eksiklerini belirlesin ve seni güçlendirsin';
  const words = text.split(' ');
  const seg = [{ t0: 0, t1: 8000, text, words: words.map((w, i) => ({ t0: i * 1000, t1: i * 1000 + 900, text: w })) }];
  const blocks = C.buildCaptions(seg, { maxCharsPerLine: 7, maxLines: 2 });
  const out = blocks.map(b => b.lines.join(' ')).join(' ').replace(/\s+/g, ' ');
  assert.strictEqual(out, text, 'çıktı: ' + out);
});

/* ---- uçtan uca: gerçek whisper json varsa ---- */
try {
  const real = require('/private/tmp/claude-501/-Users-ofbakirci-apps-ofb-fisilti/a9b7b442-337a-409d-b8ce-b9e85aca077e/scratchpad/jfk_real.json');
  t('E2E: gerçek whisper JSON → kelimeler → bloklar → SRT', () => {
    const words = C.wordsFromWhisperJson(real);
    assert.ok(words.length >= 15, 'kelime sayısı az: ' + words.length);
    assert.ok(words.every(w => w.t1 >= w.t0));
    const blocks = C.buildCaptions([{ t0: 0, t1: 10500, text: '', words }], { maxCharsPerLine: 32 });
    assert.ok(blocks.length >= 2, 'tek uzun segment bloklara bölünmeliydi');
    const srt = C.toSRT(blocks);
    assert.ok(srt.includes('country'));
  });
} catch (e) { console.log('  (gerçek whisper JSON bulunamadı, E2E atlandı)'); }

console.log('\n' + passed + ' test geçti' + (process.exitCode ? ' (HATALAR VAR)' : ''));
