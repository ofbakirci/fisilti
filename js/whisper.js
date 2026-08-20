/*
 * Fısıltı — Node köprüsü: whisper-cli çalıştırma, model indirme, ffmpeg overlay render.
 * CEP panelinde Node aynı JS bağlamında çalışır (mixed-context): child process
 * event'leri doğrudan DOM'u güncelleyebilir, IPC gerekmez.
 */
window.FisiltiWhisper = (function () {
  'use strict';

  var nodeRequire =
    (typeof cep_node !== 'undefined' && cep_node.require) ? cep_node.require :
    (typeof require !== 'undefined' ? require : null);
  if (!nodeRequire) {
    return { available: false, reason: 'Node entegrasyonu yok (manifest --enable-nodejs?)' };
  }

  var cp = nodeRequire('child_process');
  var fs = nodeRequire('fs');
  var path = nodeRequire('path');
  var os = nodeRequire('os');

  var HOME = os.homedir();
  // Eklenti kök dizini (index.html'in bulunduğu yer) — gömülü binary'ler burada.
  var EXT_DIR = (function () {
    try {
      var p = decodeURIComponent(window.location.pathname);
      if (p && p.indexOf('/') === 0) return path.dirname(p);
    } catch (e) {}
    return null;
  })();
  var APP_DIR = path.join(HOME, 'Library', 'Application Support', 'Fisilti');
  var MODELS_DIR = path.join(APP_DIR, 'models');
  var CACHE_DIR = path.join(HOME, 'Library', 'Caches', 'Fisilti');
  var LOG_DIR = path.join(APP_DIR, 'logs');
  var TRANSCRIPTS_DIR = path.join(APP_DIR, 'transcripts');
  // Sequence'e eklenen overlay'ler proje medyasıdır — cache'te DEĞİL burada durur,
  // yoksa "geçici dosyaları temizle" media offline yapar.
  var OVERLAYS_DIR = path.join(APP_DIR, 'overlays');
  // Panelin kendi indirdiği ikililer (ör. ffmpeg) — brew gerekmez
  var BIN_DIR = path.join(APP_DIR, 'bin');
  // Kullanıcının hâlihazırdaki model klasörleri de taranır
  var EXTRA_MODEL_DIRS = [path.join(HOME, 'whisper-models')];

  // GUI uygulamalarının PATH'i dardır; homebrew yollarını ekle
  var WIDE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || '');
  var SPAWN_ENV = Object.assign({}, process.env, { PATH: WIDE_PATH });

  function ensureDirs() {
    [APP_DIR, MODELS_DIR, CACHE_DIR, LOG_DIR, TRANSCRIPTS_DIR, OVERLAYS_DIR, BIN_DIR].forEach(function (d) {
      try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
    });
  }
  ensureDirs();

  /* ---------------- model kataloğu (boyutlar HF'den doğrulanmış) ---------------- */
  var HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
  var CATALOG = [
    { key: 'large-v3-turbo', file: 'ggml-large-v3-turbo.bin', url: HF + 'ggml-large-v3-turbo.bin',
      bytes: 1624555275, note: 'Türkçe için önerilen — hız/kalite dengesi (~18× gerçek zaman)' },
    { key: 'large-v3-turbo-q5_0', file: 'ggml-large-v3-turbo-q5_0.bin', url: HF + 'ggml-large-v3-turbo-q5_0.bin',
      bytes: 574041195, note: 'Turbo\'nun küçültülmüşü — az RAM, ufak kalite kaybı' },
    { key: 'large-v3', file: 'ggml-large-v3.bin', url: HF + 'ggml-large-v3.bin',
      bytes: 3095033483, note: 'En yüksek Türkçe kalitesi, ~2× yavaş' },
    { key: 'medium', file: 'ggml-medium.bin', url: HF + 'ggml-medium.bin',
      bytes: 1533763059, note: 'Orta seviye' },
    { key: 'small', file: 'ggml-small.bin', url: HF + 'ggml-small.bin',
      bytes: 487601967, note: 'Hızlı — Türkçe idare eder' },
    { key: 'base', file: 'ggml-base.bin', url: HF + 'ggml-base.bin',
      bytes: 147951465, note: 'Zayıf — sadece hızlı taslak' },
    { key: 'tiny', file: 'ggml-tiny.bin', url: HF + 'ggml-tiny.bin',
      bytes: 77691713, note: 'Türkçe için önerilmez — test amaçlı' }
  ];
  var VAD_MODEL = {
    key: 'vad-silero', file: 'ggml-silero-v5.1.2.bin',
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
    bytes: 885098, note: 'VAD sessizlik filtresi modeli'
  };

  function findModelFile(fileName) {
    var dirs = [MODELS_DIR].concat(EXTRA_MODEL_DIRS);
    for (var i = 0; i < dirs.length; i++) {
      var p = path.join(dirs[i], fileName);
      try { if (fs.existsSync(p) && fs.statSync(p).size > 1e6) return p; } catch (e) {}
    }
    return null;
  }

  function listModels() {
    var out = CATALOG.map(function (m) {
      var p = findModelFile(m.file);
      return { key: m.key, file: m.file, url: m.url, bytes: m.bytes, note: m.note,
               installed: !!p, path: p, deletable: p ? p.indexOf(MODELS_DIR) === 0 : false };
    });
    var vp = findVadModel();
    out.push({ key: VAD_MODEL.key, file: VAD_MODEL.file, url: VAD_MODEL.url, bytes: VAD_MODEL.bytes,
               note: VAD_MODEL.note, installed: !!vp, path: vp,
               deletable: vp ? vp.indexOf(MODELS_DIR) === 0 : false, isVad: true });
    return out;
  }

  function findVadModel() {
    var p = path.join(MODELS_DIR, VAD_MODEL.file);
    try { if (fs.existsSync(p) && fs.statSync(p).size > 1e5) return p; } catch (e) {}
    return null;
  }

  /* ---------------- indirme (curl ile, ilerleme yüzdesi stderr'den) ---------------- */
  function downloadModel(entry, cbs) {
    ensureDirs();
    cbs = cbs || {};
    var dest = path.join(MODELS_DIR, entry.file);
    var tmp = dest + '.part';
    var proc = cp.spawn('/usr/bin/curl',
      ['-L', '-f', '--progress-bar', '-o', tmp, entry.url],
      { env: SPAWN_ENV });

    var lastPct = -1;
    proc.stderr.on('data', function (chunk) {
      var s = chunk.toString();
      var matches = s.match(/(\d+(?:[.,]\d+)?)%/g);
      if (matches && matches.length) {
        var pct = parseFloat(matches[matches.length - 1]);
        if (pct !== lastPct) { lastPct = pct; if (cbs.onProgress) cbs.onProgress(pct); }
      }
    });
    proc.on('error', function (e) { if (cbs.onError) cbs.onError('curl çalıştırılamadı: ' + e.message); });
    proc.on('close', function (code) {
      if (code === 0) {
        try {
          fs.renameSync(tmp, dest);
          if (cbs.onDone) cbs.onDone(dest);
        } catch (e) { if (cbs.onError) cbs.onError('Dosya taşınamadı: ' + e.message); }
      } else {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        if (code !== null && cbs.onError) cbs.onError('İndirme başarısız (curl kod ' + code + ')');
        if (code === null && cbs.onCancel) cbs.onCancel();
      }
    });
    return { cancel: function () { try { proc.kill('SIGKILL'); } catch (e) {} } };
  }

  function deleteModel(fileName) {
    var p = path.join(MODELS_DIR, fileName);
    if (fs.existsSync(p)) { fs.unlinkSync(p); return true; }
    return false;
  }

  /* ---------------- ikili (binary) bulma ---------------- */
  function which(bin) {
    try {
      var out = cp.execSync('command -v ' + bin, { env: SPAWN_ENV, encoding: 'utf8', shell: '/bin/zsh' });
      var p = out.trim();
      return p || null;
    } catch (e) { return null; }
  }

  // ZXP kurulumu zip'ten açıldığı için exec biti kaybolmuş ve dosya
  // karantinaya alınmış olabilir — gömülü binary'yi kullanmadan önce onar.
  function makeRunnable(binPath) {
    try { fs.chmodSync(binPath, 493 /* 0755 */); } catch (e) {}
    try {
      cp.spawnSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', path.dirname(binPath)], { env: SPAWN_ENV });
    } catch (e2) {}
  }

  function detectWhisper() {
    // 1) Eklentiyle gelen gömülü binary (son kullanıcı kurulumu — brew gerekmez)
    if (EXT_DIR) {
      var bundled = path.join(EXT_DIR, 'bin', 'whisper-cli');
      if (fs.existsSync(bundled)) { makeRunnable(bundled); return bundled; }
    }
    // 2) Sistem kurulumları
    var cands = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'];
    for (var i = 0; i < cands.length; i++) if (fs.existsSync(cands[i])) return cands[i];
    return which('whisper-cli');
  }
  function detectFfmpeg() {
    var cands = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
    for (var i = 0; i < cands.length; i++) if (fs.existsSync(cands[i])) return cands[i];
    // panelin kendi indirdiği kopya
    var own = path.join(BIN_DIR, 'ffmpeg');
    if (fs.existsSync(own)) { makeRunnable(own); return own; }
    return which('ffmpeg');
  }

  /* ---------------- ffmpeg indirme (brew/Xcode gerekmez) ----------------
   * ffmpeg.org'un macOS sayfasının işaret ettiği statik derlemeler
   * (ffmpeg.martin-riedl.de). Tek dosyalık zip iner, ~/Library/Application
   * Support/Fisilti/bin altına açılır, karantina kaldırılır, çalıştığı doğrulanır.
   */
  function machineArch() {
    // Rosetta altında bile gerçek donanımı verir (process.arch yanılabilir)
    try {
      var out = cp.execSync('/usr/sbin/sysctl -n hw.optional.arm64', { encoding: 'utf8' }).trim();
      if (out === '1') return 'arm64';
    } catch (e) {}
    return process.arch === 'arm64' ? 'arm64' : 'amd64';
  }
  function downloadFfmpeg(cbs) {
    ensureDirs();
    cbs = cbs || {};
    var url = 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/' + machineArch() + '/release/ffmpeg.zip';
    var tmp = path.join(CACHE_DIR, 'ffmpeg_dl.zip');
    var dest = path.join(BIN_DIR, 'ffmpeg');
    var proc = cp.spawn('/usr/bin/curl', ['-L', '-f', '--progress-bar', '-o', tmp, url], { env: SPAWN_ENV });

    var lastPct = -1;
    proc.stderr.on('data', function (chunk) {
      var matches = chunk.toString().match(/(\d+(?:[.,]\d+)?)%/g);
      if (matches && matches.length) {
        var pct = parseFloat(matches[matches.length - 1]);
        if (pct !== lastPct) { lastPct = pct; if (cbs.onProgress) cbs.onProgress(pct); }
      }
    });
    proc.on('error', function (e) { if (cbs.onError) cbs.onError('curl çalıştırılamadı: ' + e.message); });
    proc.on('close', function (code) {
      if (code !== 0) {
        try { fs.unlinkSync(tmp); } catch (e0) {}
        if (code === null) { if (cbs.onCancel) cbs.onCancel(); }
        else if (cbs.onError) cbs.onError('ffmpeg indirilemedi (curl kod ' + code + ') — ağ bağlantısını kontrol et.');
        return;
      }
      var un = cp.spawnSync('/usr/bin/unzip', ['-o', tmp, '-d', BIN_DIR], { env: SPAWN_ENV });
      try { fs.unlinkSync(tmp); } catch (e1) {}
      if (un.status !== 0 || !fs.existsSync(dest)) {
        if (cbs.onError) cbs.onError('ffmpeg arşivi açılamadı (unzip kod ' + un.status + ')');
        return;
      }
      makeRunnable(dest);
      var v = cp.spawnSync(dest, ['-version'], { env: SPAWN_ENV });
      if (v.status !== 0) {
        if (cbs.onError) cbs.onError('İndirilen ffmpeg çalıştırılamadı — Ayarlar > Log klasörüne bak.');
        return;
      }
      if (cbs.onDone) cbs.onDone(dest);
    });
    return { cancel: function () { try { proc.kill('SIGKILL'); } catch (e) {} } };
  }

  /* ---------------- sürüm denetimi & içerden güncelleme ----------------
   * zxp = zip; imza dosyaları (META-INF) içeriğin parçasıdır, açınca geçerli
   * kalır. Panel yeni zxp'yi indirip kendi klasörünün üstüne açar; sonrasında
   * paneli kapatıp açmak yeter. Dev kurulumu (symlink) korunur.
   */
  var RELEASES_API = 'https://api.github.com/repos/ofbakirci/fisilti/releases/latest';

  function currentVersion() {
    try {
      var xml = fs.readFileSync(path.join(EXT_DIR, 'CSXS', 'manifest.xml'), 'utf8');
      var m = /ExtensionBundleVersion="([^"]+)"/.exec(xml);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }
  function cmpVersions(a, b) { // a > b → 1, eşit → 0, küçük → -1
    var pa = String(a).split('.'), pb = String(b).split('.');
    for (var i = 0; i < 3; i++) {
      var d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }
  function checkUpdate(cb) {
    var proc = cp.spawn('/usr/bin/curl', ['-sL', '-f', '--max-time', '10', RELEASES_API], { env: SPAWN_ENV });
    var buf = '';
    proc.stdout.on('data', function (c) { buf += c.toString(); });
    proc.on('error', function () { cb(null); });
    proc.on('close', function (code) {
      if (code !== 0) { cb(null); return; }
      try {
        var rel = JSON.parse(buf);
        var latest = String(rel.tag_name || '').replace(/^v/, '');
        var asset = (rel.assets || []).filter(function (a) { return /\.zxp$/i.test(a.name); })[0];
        var cur = currentVersion();
        if (!latest || !asset || !cur) { cb(null); return; }
        cb({ current: cur, latest: latest, url: asset.browser_download_url,
             newer: cmpVersions(latest, cur) > 0 });
      } catch (e) { cb(null); }
    });
  }
  // Bu klasör gerçekten bizim eklentimiz mi? Klasör ADI güvenilmez — ZXP
  // kurucular bundle ID yerine başka ad verebiliyor; içerideki manifest'e bak.
  function isOwnExtensionDir(dir) {
    try {
      var xml = fs.readFileSync(path.join(dir, 'CSXS', 'manifest.xml'), 'utf8');
      return xml.indexOf('com.ofb.fisilti') !== -1;
    } catch (e) { return false; }
  }
  // Geliştirici kurulumu mu? (symlink ya da doğrudan repo'dan koşum — .git var)
  // ZXP kurulumlarında .git yoktur (package.sh dışlar), symlink de olmaz.
  function isDevInstall() {
    try {
      if (!EXT_DIR) return false;
      if (fs.lstatSync(EXT_DIR).isSymbolicLink()) return true;
      return fs.existsSync(path.join(EXT_DIR, '.git'));
    } catch (e) { return false; }
  }
  function selfUpdate(url, cbs) {
    ensureDirs();
    cbs = cbs || {};
    function fail(msg) { if (cbs.onError) cbs.onError(msg); return null; }
    // rsync --delete hedefi bizim eklenti klasörümüz olmalı — başka bir yolu asla silme.
    // Sahiplik klasör adından değil, içindeki manifest'ten doğrulanır (kurucular
    // klasöre başka ad verebiliyor).
    if (!EXT_DIR || !isOwnExtensionDir(EXT_DIR)) {
      return fail('Eklenti klasörü doğrulanamadı — zxp\'yi elle kur.');
    }
    if (isDevInstall()) {
      return fail('Geliştirici kurulumu — panel kendini güncellemez, git pull kullan.');
    }
    try {
      fs.accessSync(EXT_DIR, fs.constants.W_OK);
    } catch (e) {
      return fail('Eklenti klasörü yazılabilir değil (yönetici kurulumu?) — zxp\'yi elle kur.');
    }
    var tmpZxp = path.join(CACHE_DIR, 'update.zxp');
    var tmpDir = path.join(CACHE_DIR, 'update_stage');
    var proc = cp.spawn('/usr/bin/curl', ['-L', '-f', '--progress-bar', '-o', tmpZxp, url], { env: SPAWN_ENV });
    var lastPct = -1;
    proc.stderr.on('data', function (chunk) {
      var matches = chunk.toString().match(/(\d+(?:[.,]\d+)?)%/g);
      if (matches && matches.length) {
        var pct = parseFloat(matches[matches.length - 1]);
        if (pct !== lastPct) { lastPct = pct; if (cbs.onProgress) cbs.onProgress(pct); }
      }
    });
    proc.on('error', function (e) { fail('curl çalıştırılamadı: ' + e.message); });
    proc.on('close', function (code) {
      if (code !== 0) {
        try { fs.unlinkSync(tmpZxp); } catch (e0) {}
        if (code === null) { if (cbs.onCancel) cbs.onCancel(); }
        else fail('Güncelleme indirilemedi (curl kod ' + code + ')');
        return;
      }
      try { cp.spawnSync('/bin/rm', ['-rf', tmpDir], { env: SPAWN_ENV }); } catch (e1) {}
      var un = cp.spawnSync('/usr/bin/unzip', ['-oq', tmpZxp, '-d', tmpDir], { env: SPAWN_ENV });
      try { fs.unlinkSync(tmpZxp); } catch (e2) {}
      // paket sağlaması: manifest yoksa bozuk arşivle mevcut kurulumu ezme
      if (un.status !== 0 || !fs.existsSync(path.join(tmpDir, 'CSXS', 'manifest.xml'))) {
        fail('Güncelleme arşivi açılamadı ya da bozuk.'); return;
      }
      var rs = cp.spawnSync('/usr/bin/rsync', ['-a', '--delete', tmpDir + '/', EXT_DIR + '/'], { env: SPAWN_ENV });
      cp.spawnSync('/bin/rm', ['-rf', tmpDir], { env: SPAWN_ENV });
      if (rs.status !== 0) { fail('Dosyalar kopyalanamadı (rsync kod ' + rs.status + ')'); return; }
      makeRunnable(path.join(EXT_DIR, 'bin', 'whisper-cli'));
      try { cp.spawnSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', EXT_DIR], { env: SPAWN_ENV }); } catch (e3) {}
      if (cbs.onDone) cbs.onDone(currentVersion());
    });
    return { cancel: function () { try { proc.kill('SIGKILL'); } catch (e) {} } };
  }

  /* ---------------- transkripsiyon ----------------
   * opts: { wavPath, modelPath, whisperPath, language, translate, threads,
   *         vad, vadModelPath, prompt }
   * cbs:  { onSegment({t0,t1,text} ms), onProgress(pct), onDone({json}), onError(msg), onLog(line) }
   */
  function transcribe(opts, cbs) {
    ensureDirs();
    cbs = cbs || {};
    var outBase = path.join(CACHE_DIR, 'transcribe_' + Date.now());
    var args = [
      '-m', opts.modelPath,
      '-f', opts.wavPath,
      '-l', opts.language || 'auto',
      '-t', String(opts.threads || 4),
      '-oj', '-ojf',
      '-pp',
      '-of', outBase
    ];
    if (opts.translate) args.push('-tr');
    // sözlük: her 30 sn'lik pencereye taşınsın, yoksa yalnız ilk pencerede etkili
    if (opts.prompt) args.push('--prompt', opts.prompt, '--carry-initial-prompt');
    if (opts.vad && opts.vadModelPath) args.push('--vad', '--vad-model', opts.vadModelPath);

    var bin = opts.whisperPath || detectWhisper();
    if (!bin) { if (cbs.onError) cbs.onError('whisper-cli bulunamadı — eklentiyle gömülü gelir; paketi yeniden kur ya da Ayarlar sekmesinden yolunu gir.'); return null; }
    if (!opts.modelPath || !fs.existsSync(opts.modelPath)) {
      if (cbs.onError) cbs.onError('Model dosyası yok. Modeller sekmesinden indir.'); return null;
    }

    var proc = cp.spawn(bin, args, { env: SPAWN_ENV });
    var cancelled = false, errored = false;
    var stdoutBuf = '', stderrTail = [];

    var SEG_RE = /^\[(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\]\s?(.*)$/;
    function toMs(h, m, s, ms) { return (+h) * 3600000 + (+m) * 60000 + (+s) * 1000 + (+ms); }

    proc.stdout.on('data', function (chunk) {
      stdoutBuf += chunk.toString();
      var lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      lines.forEach(function (line) {
        var m = SEG_RE.exec(line);
        if (m && m[9].trim()) {
          if (cbs.onSegment) cbs.onSegment({
            t0: toMs(m[1], m[2], m[3], m[4]),
            t1: toMs(m[5], m[6], m[7], m[8]),
            text: m[9].trim()
          });
        }
      });
    });

    proc.stderr.on('data', function (chunk) {
      var s = chunk.toString();
      stderrTail.push(s);
      if (stderrTail.length > 200) stderrTail.shift();
      var pm = s.match(/progress\s*=\s*(\d+)%/g);
      if (pm && cbs.onProgress) {
        var last = pm[pm.length - 1].match(/(\d+)%/);
        if (last) cbs.onProgress(parseInt(last[1], 10));
      }
      if (cbs.onLog) cbs.onLog(s);
    });

    proc.on('error', function (e) {
      errored = true;
      if (cbs.onError) cbs.onError('whisper-cli başlatılamadı: ' + e.message);
    });

    proc.on('close', function (code) {
      try { fs.writeFileSync(path.join(LOG_DIR, 'last_transcribe.log'), stderrTail.join('')); } catch (e0) {}
      if (errored) return; // 'error' zaten raporlandı; 'kod null' ile üzerine yazma
      if (cancelled) { if (cbs.onCancel) cbs.onCancel(); return; }
      if (code !== 0) { if (cbs.onError) cbs.onError('whisper-cli hata kodu ' + code + ' (log: ' + LOG_DIR + ')'); return; }
      var jsonPath = outBase + '.json';
      try {
        var json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (cbs.onDone) cbs.onDone({ json: json, jsonPath: jsonPath });
      } catch (e) {
        if (cbs.onError) cbs.onError('Sonuç JSON okunamadı: ' + e.message);
      }
    });

    return {
      cancel: function () { cancelled = true; try { proc.kill('SIGTERM'); } catch (e) {} }
    };
  }

  /* ---------------- ffmpeg: şeffaf ProRes 4444 altyazı overlay'i ----------------
   * opts: { ffmpegPath, assPath, width, height, fps, durationSec, outPath }
   */
  /* ---------- WAV enerji profili (konuşma başlangıcı hizalama için) ---------- */
  // 16-bit PCM WAV (bizim EPR: mono 16 kHz) → pencere RMS dizisi. Başka format
  // ya da hata: null (çağıran hizalamayı atlar).
  function wavRms(wavPath, winMs) {
    try {
      winMs = winMs || 50;
      var buf = fs.readFileSync(wavPath);
      if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
      var pos = 12, fmt = null, dataOff = -1, dataLen = 0;
      while (pos + 8 <= buf.length) {
        var id = buf.toString('ascii', pos, pos + 4), size = buf.readUInt32LE(pos + 4);
        if (id === 'fmt ') fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
        else if (id === 'data') { dataOff = pos + 8; dataLen = Math.min(size, buf.length - dataOff); break; }
        pos += 8 + size + (size % 2);
      }
      if (!fmt || dataOff < 0 || fmt.bits !== 16 || fmt.format !== 1) return null;
      var ch = fmt.channels, rate = fmt.rate;
      var frames = Math.floor(dataLen / (2 * ch));
      var win = Math.max(1, Math.floor(rate * winMs / 1000));
      var out = [];
      for (var f0 = 0; f0 + win <= frames; f0 += win) {
        var acc = 0;
        for (var f = f0; f < f0 + win; f++) {
          var v = buf.readInt16LE(dataOff + (f * ch) * 2); // ilk kanal
          acc += v * v;
        }
        out.push(Math.sqrt(acc / win));
      }
      return { winMs: winMs, rms: out };
    } catch (e) { return null; }
  }

  function renderOverlay(opts, cbs) {
    ensureDirs();
    cbs = cbs || {};
    var bin = opts.ffmpegPath || detectFfmpeg();
    if (!bin) { if (cbs.onError) cbs.onError('ffmpeg bulunamadı — Ayarlar sekmesindeki İndir düğmesiyle tek tıkla kur.'); return null; }

    // ass filtresi için yol kaçışı: \ → \\, : → \: (yol bizim ürettiğimiz
    // Caches/Fisilti altındadır, tek tırnak içermez — kabuk kaçışı gerekmez)
    var assEsc = String(opts.assPath).replace(/\\/g, '\\\\').replace(/:/g, '\\:');
    var fps = (Math.round(opts.fps * 1000) / 1000) || 25;
    var args = [
      '-y', '-hide_banner',
      '-f', 'lavfi',
      '-i', 'color=c=black@0.0:s=' + opts.width + 'x' + opts.height + ':r=' + fps + ',format=rgba',
      // alpha=1 şart: filtre, şeffaf zemine çizerken alfa kanalını da işlesin
      '-vf', "ass=filename='" + assEsc + "':alpha=1",
      '-t', String(opts.durationSec),
      '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
      '-progress', 'pipe:1', '-nostats',
      opts.outPath
    ];
    var proc = cp.spawn(bin, args, { env: SPAWN_ENV });
    var cancelled = false, rErrored = false, errTail = [];

    proc.stdout.on('data', function (chunk) {
      // -progress pipe:1 → out_time_us=... satırları
      var m = chunk.toString().match(/out_time_us=(\d+)/g);
      if (m && cbs.onProgress) {
        var us = parseInt(m[m.length - 1].split('=')[1], 10);
        var pct = Math.min(100, Math.round((us / 1e6 / opts.durationSec) * 100));
        cbs.onProgress(pct);
      }
    });
    proc.stderr.on('data', function (chunk) {
      errTail.push(chunk.toString());
      if (errTail.length > 100) errTail.shift();
    });
    proc.on('error', function (e) {
      rErrored = true;
      if (cbs.onError) cbs.onError('ffmpeg başlatılamadı: ' + e.message);
    });
    proc.on('close', function (code) {
      try { fs.writeFileSync(path.join(LOG_DIR, 'last_overlay.log'), errTail.join('')); } catch (e0) {}
      if (rErrored) return;
      if (cancelled) { if (cbs.onCancel) cbs.onCancel(); return; }
      if (code === 0 && fs.existsSync(opts.outPath)) { if (cbs.onDone) cbs.onDone(opts.outPath); }
      else if (cbs.onError) cbs.onError('ffmpeg hata kodu ' + code + ' (log: ' + LOG_DIR + ')');
    });
    return { cancel: function () { cancelled = true; try { proc.kill('SIGTERM'); } catch (e) {} } };
  }

  /* ---------------- ekrandan renk seçme (sistem damlalığı) ----------------
   * Gömülü fisilti-eyedropper (NSColorSampler): imleçte büyüteç lupu açılır,
   * tıklanan pikselin hex'ini basar. Ekran kaydı izni gerekmez, pencere yok —
   * arkada kalma derdi de yok. Esc: kod 1, çıktı yok.
   * Yardımcı yoksa/çalışmazsa osascript "choose color" paneline düşülür.
   * cb(hex | null) — iptalde null.
   */
  function pickColorNative(defaultHex, cb) {
    var helper = EXT_DIR ? path.join(EXT_DIR, 'bin', 'fisilti-eyedropper') : null;
    if (helper && fs.existsSync(helper)) {
      makeRunnable(helper);
      cp.execFile(helper, [], { env: SPAWN_ENV, timeout: 300000 }, function (err, stdout) {
        var m = /#[0-9A-F]{6}/i.exec(String(stdout || ''));
        if (!err && m) { cb(m[0].toUpperCase()); return; }
        if (err && err.code === 1) { cb(null); return; } // kullanıcı vazgeçti (Esc)
        pickColorPanel(defaultHex, cb); // başlatılamadı/çöktü → panel
      });
      return;
    }
    pickColorPanel(defaultHex, cb);
  }
  // Geri düşüş: yerel renk paneli. Kanal değerleri 16 bittir (0–65535).
  function pickColorPanel(defaultHex, cb) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(defaultHex || '');
    var d = m ? [parseInt(m[1], 16) * 257, parseInt(m[2], 16) * 257, parseInt(m[3], 16) * 257]
              : [65535, 65535, 65535];
    cp.execFile('/usr/bin/osascript',
      // "tell me to activate": panel öne gelmeye çalışsın
      ['-e', 'tell me to activate', '-e', 'choose color default color {' + d.join(', ') + '}'],
      { env: SPAWN_ENV, timeout: 300000 },
      function (err, stdout) {
        if (err) { cb(null); return; } // iptal (-128) dahil
        var nums = String(stdout).match(/\d+/g);
        if (!nums || nums.length < 3) { cb(null); return; }
        var hex = '#' + nums.slice(0, 3).map(function (v) {
          var c = Math.max(0, Math.min(255, Math.round(parseInt(v, 10) / 257)));
          var h = c.toString(16).toUpperCase();
          return h.length === 1 ? '0' + h : h;
        }).join('');
        cb(hex);
      });
  }

  /* ---------------- dosya yardımcıları ---------------- */
  function writeFile(p, content, withBom) {
    ensureDirs();
    var data = withBom ? '\uFEFF' + content : content;
    fs.writeFileSync(p, data, 'utf8');
    return p;
  }
  function readJsonSafe(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  }
  function writeJson(p, obj) {
    ensureDirs();
    fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  }
  function cleanCache() {
    var n = 0;
    try {
      fs.readdirSync(CACHE_DIR).forEach(function (f) {
        try { fs.unlinkSync(path.join(CACHE_DIR, f)); n++; } catch (e) {}
      });
    } catch (e2) {}
    // yarım kalmış model indirmeleri de temizlenir
    try {
      fs.readdirSync(MODELS_DIR).forEach(function (f) {
        if (/\.part$/.test(f)) {
          try { fs.unlinkSync(path.join(MODELS_DIR, f)); n++; } catch (e3) {}
        }
      });
    } catch (e4) {}
    return n;
  }
  function openInFinder(p) { try { cp.spawn('/usr/bin/open', [p], { env: SPAWN_ENV }); } catch (e) {} }

  function versions() {
    var out = { node: process.version };
    try { out.whisper = cp.execSync((detectWhisper() || 'whisper-cli') + ' --help 2>&1 | head -1 || true',
      { env: SPAWN_ENV, encoding: 'utf8', shell: '/bin/zsh' }).trim().slice(0, 80); } catch (e) {}
    return out;
  }

  return {
    available: true,
    APP_DIR: APP_DIR, MODELS_DIR: MODELS_DIR, CACHE_DIR: CACHE_DIR,
    LOG_DIR: LOG_DIR, TRANSCRIPTS_DIR: TRANSCRIPTS_DIR, OVERLAYS_DIR: OVERLAYS_DIR,
    fsx: fs, pathx: path,
    CATALOG: CATALOG, VAD_MODEL: VAD_MODEL,
    listModels: listModels, findModelFile: findModelFile, findVadModel: findVadModel,
    downloadModel: downloadModel, deleteModel: deleteModel,
    detectWhisper: detectWhisper, detectFfmpeg: detectFfmpeg, downloadFfmpeg: downloadFfmpeg,
    currentVersion: currentVersion, checkUpdate: checkUpdate, selfUpdate: selfUpdate,
    isDevInstall: isDevInstall,
    pickColorNative: pickColorNative,
    transcribe: transcribe, renderOverlay: renderOverlay, wavRms: wavRms,
    writeFile: writeFile, readJsonSafe: readJsonSafe, writeJson: writeJson,
    cleanCache: cleanCache, openInFinder: openInFinder, versions: versions
  };
})();
