# Fısıltı 🎬

**Premiere Pro'da altyazı — ses makineden çıkmadan.**

Whisper (whisper.cpp) doğrudan Premiere'in içinde çalışır: transkript canlı akar,
kelimeye tıklarsın video oraya gider, stilini seçersin altyazı öyle yakılır.
Apple Silicon'da ~18× gerçek zaman: 1 saatlik bölüm ≈ 3,5 dakika.
Dakika ücreti yok, abonelik yok, buluta giden ses yok.

**İndir:** [Releases](https://github.com/ofbakirci/fisilti/releases) → en güncel `Fisilti_x.y.z.zxp`

## Özellikler

**Transkripsiyon**
- Tüm sequence / In–Out aralığı / seçili klipler
- Canlı akış: segmentler işlenirken panele düşer
- Dil seçimi (Türkçe varsayılan) + otomatik algılama + İngilizceye çeviri
- Kelime seviyesinde zaman damgaları (karaoke ve kelime-kelime altyazı için)
- VAD sessizlik filtresi (halüsinasyon azaltır), model yöneticisi (indir/sil)

**Transkript**
- Satıra tıkla → video o ana gider; kelimeye tıkla → kelimenin anına gider
- Playhead ilerledikçe transkript takip eder, konuşulan kelime vurgulanır
- **Scroll → videoyu sardır**: transkripti kaydırdıkça video uygun ana gider
- Çift tıkla düzenle (kelime zamanları otomatik yeniden dağıtılır — kayma olmaz)
- **Satır ekle**: `+ Satır` playhead'e yeni altyazı satırı açar; satırın üzerine gelince çıkan `+` altına ekler. Metni boşaltıp onaylayınca satır silinir
- **Zamana çift tıkla**: başlangıç/bitişi elle gir — yalnız o satır kayar, kalan her şey yerinde durur
- **Zaman çizelgesi**: transkriptin altında sürüklenebilir bar görünümü — barı çek: satır taşınır;
  kenarından çek: başlangıç/bitiş ayarlanır; arkada ses dalga formu, konuşmanın gerçekte nerede
  başladığını gösterir; boşluğa tıkla: video sardırılır; ⌥+tekerlek: yakınlaştır
- Arama + önceki/sonraki; **bul-değiştir** (tek eşleşme veya tümü, geri al) — yanlış duyulan özel isimleri tek hamlede düzelt
- Segmentleri sequence marker'ına dökme
- **Sözlük** (Ayarlar): özel isim ve terimleri virgülle yaz, Whisper'a `--prompt` olarak gider; yanlış duyma baştan azalır
- **Konuşma hizalama**: Whisper'ın erken başlattığı altyazılar ses enerjisine göre gerçek konuşma başına çekilir
- **Zaman kaydırma**: tüm altyazıları ± saniye kaydır (Altyazı & Stil > Bölümleme)
- Transkript sequence başına otomatik saklanır; panel kapansa da kaybolmaz
- **İçe aktar**: hazır SRT/VTT dosyasını transkript olarak yükle, düzenle, tekrar üret
- **Stili Premiere'e kaydet**: paneldeki stil Premiere metin stiline çevrilir (yerel stiller + proje); caption track'e Track Style menüsünden tek tıkla uygulanır

**Altyazı**
- Cümle blokları **veya** kelime kelime (viral/sosyal medya) modu
- Netflix TR kurallarına uygun bölümleme: 42 karakter/satır, bağlaçla satır bitirmeme,
  cümle sonunda kırma, asgari süre, CPS (okuma hızı) uyarıları, Türkçe büyük harf (İ/ı)
- **Satır sınırında böl** (varsayılan açık): altyazı bloğu transkriptteki bir satırın
  sınırını aşmaz — iki konuşmacının lafı aynı altyazıya girmez; kimin lafının nerede
  bittiğini transkript satırlarını düzenleyerek sen belirlersin
- **Caption Track ekle**: Premiere'in doğal altyazı track'i (SRT üzerinden, UTF-8 BOM)
- **Stilli overlay**: seçtiğin stil birebir — renk, arkaplan, kontur, font, boyut,
  konum, karaoke kelime vurgusu — alfa kanallı ProRes 4444 video olarak render edilip
  en üst video kanalına yerleştirilir (Premiere API'si caption stiline izin vermediği
  için stilin garantili yolu budur)
- Dışa aktarım: SRT / VTT / TXT / CSV / ASS

## Kurulum (son kullanıcı — ZXP)

1. `Fisilti_x.y.z.zxp` dosyasını indir.
2. [aescripts ZXP Installer](https://aescripts.com/learn/zxp-installer/)'ı aç, zxp'yi pencereye sürükle.
   *(Alternatifler: [Anastasiy's Extension Manager](https://install.anastasiy.com/), ya da Creative Cloud'un
   kendi UPIA aracı: `UnifiedPluginInstallerAgent --install Fisilti_x.y.z.zxp`. İmza geçerli olduğu için
   zxp'yi unzip edip `~/Library/Application Support/Adobe/CEP/extensions/` altına koymak bile yeterli.)*
3. Premiere Pro'yu (yeniden) başlat → **Window > Extensions > Fısıltı — Whisper Altyazı**
4. Panelin **Modeller** sekmesinden bir model indir (Türkçe için `large-v3-turbo` önerilir). Bitti.

Sonraki sürümler için tekrar indirme gerekmez: panel açılışta yeni sürümü denetler,
**Ayarlar > Güncelleme > Güncelle** tek tıkla kurar (paneli kapatıp açmak yeter).

Whisper motoru eklentinin içinde gömülü gelir — Terminal, Homebrew, hiçbir şey gerekmez.
Yalnızca "Stilli overlay" özelliği ffmpeg ister; o da panelden kurulur:
**Ayarlar > ffmpeg > İndir** statik derlemeyi tek tıkla indirir (brew/Xcode gerekmez).

## Kurulum (geliştirici — kaynaktan)

```bash
./install.sh          # symlink + PlayerDebugMode
```

whisper-cli repoda gömülü (`bin/whisper-cli`); ffmpeg'i panelin Ayarlar sekmesinden
indirebilir ya da `brew install ffmpeg` ile kurabilirsin.

`~/whisper-models/` klasöründeki mevcut modeller otomatik tanınır.

## Paketleme (dağıtım)

```bash
./package.sh          # → dist/Fisilti_<sürüm>.zxp (imzalı)
```

İlk çalıştırmada Adobe'nin ZXPSignCmd aracını indirir ve self-signed sertifika üretir.
`bin/whisper-cli` varsa pakete gömülür (evrensel arm64+x86_64 statik derleme).

## Kullanım akışı

1. Sequence'i aç, **Transkribe Et**'e bas (ses 16 kHz WAV olarak dışa aktarılır,
   bu sırada Premiere kısa süre meşgul kalır — normal).
2. Transkript canlı akar; bitince kelime zamanları hassaslaşır.
3. **Altyazı & Stil** sekmesinde stili ve bölümlemeyi ayarla, önizlemeden takip et.
4. `Caption Track ekle` (Premiere'de stillendirirsin) **veya** `Stilli overlay ekle`
   (buradaki stil birebir yakılır).

## Bilinenler / notlar

- Ses dışa aktarımı `exportAsMediaDirect` ile bloklu çalışır (AME gerekmez).
- Caption track'in görsel stili Premiere API'sinde açık değil (Adobe'nin resmi cevabı);
  stil için caption seçiliyken Özellikler (Properties) paneli > Track Style kullan ya da stilli overlay üret.
- CEP, Adobe'nin planına göre ~Eylül 2026'ya dek destekli; sonrası için UXP portu gerekir.
- Loglar: `~/Library/Application Support/Fisilti/logs/`
- Panel hata ayıklama: Premiere açıkken Chrome'da `http://localhost:8090`

## Testler

```bash
node test/captions.test.js
```
