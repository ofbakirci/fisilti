#!/bin/zsh
# Fısıltı — dağıtım paketi üretici.
# Çıktı: dist/Fisilti_<sürüm>.zxp (imzalı, ZXP Installer ile kurulabilir)
#
# Kullanım: ./package.sh
# İlk çalıştırmada ZXPSignCmd'yi indirir ve self-signed sertifika üretir;
# sonraki çalıştırmalar aynı sertifikayla imzalar.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="$ROOT/dist"
STAGE="$DIST/stage"
TOOLS="$DIST/tools"
SIGN="$TOOLS/ZXPSignCmd"
CERT="$DIST/cert.p12"
PASSFILE="$DIST/cert.pass"
# Apple TSA: DigiCert TSA'nın ZXPSignCmd Mac build'inde segfault geçmişi var (Adobe bug 1331508)
TSA="http://timestamp.apple.com/ts01"
ZXPSIGN_URL="https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.3/macOS/ZXPSignCmd"

VERSION=$(grep -o 'ExtensionBundleVersion="[^"]*"' "$ROOT/CSXS/manifest.xml" | cut -d'"' -f2)
OUT="$DIST/Fisilti_${VERSION}.zxp"

mkdir -p "$DIST" "$TOOLS"

# ---- 1) ZXPSignCmd ----
if [ ! -x "$SIGN" ]; then
  echo "» ZXPSignCmd indiriliyor (Adobe-CEP/CEP-Resources 4.1.3)…"
  curl -sL -f -o "$SIGN" "$ZXPSIGN_URL"
  # sağlama: gerçekten Mach-O binary mi indi (404 HTML sayfasına karşı)
  if ! file "$SIGN" | grep -q "Mach-O"; then
    echo "HATA: ZXPSignCmd indirilemedi ($ZXPSIGN_URL)"; exit 1
  fi
  chmod +x "$SIGN"
  xattr -d com.apple.quarantine "$SIGN" 2>/dev/null || true
fi
echo "» ZXPSignCmd hazır"

# ---- 2) Sertifika ----
if [ ! -f "$CERT" ]; then
  echo "» Self-signed sertifika üretiliyor…"
  PASS=$(openssl rand -hex 16)
  echo "$PASS" > "$PASSFILE"
  chmod 600 "$PASSFILE"
  "$SIGN" -selfSignedCert TR Istanbul "OFB" "Fisilti" "$PASS" "$CERT" -validityDays 3650
fi
PASS=$(cat "$PASSFILE")

# ---- 3) Staging (dev dosyaları hariç) ----
echo "» Dosyalar hazırlanıyor…"
rm -rf "$STAGE"
mkdir -p "$STAGE"
rsync -a "$ROOT/" "$STAGE/" \
  --exclude ".claude" --exclude ".debug" --exclude ".git" \
  --exclude "dist" --exclude "test" --exclude "*.log" \
  --exclude "install.sh" --exclude "package.sh" --exclude ".DS_Store"

# gömülü binary'lerin exec biti staging'de korunur (zip'e exec bilgisi girmese de
# panel ilk çalıştırmada chmod yapar)
for b in "$STAGE"/bin/*; do
  [ -f "$b" ] || continue
  case "$(basename "$b")" in *.txt) continue;; esac
  chmod +x "$b"
  echo "  gömülü $(basename "$b"): $(du -h "$b" | cut -f1) ($(lipo -archs "$b" 2>/dev/null || echo '?'))"
done
if [ ! -f "$STAGE/bin/whisper-cli" ]; then
  echo "  UYARI: bin/whisper-cli yok — paket, kullanıcıda whisper-cli kurulu olmasını bekleyecek"
fi

# symlink guvenlik kontrolu: ZXP icinde symlink kalirsa kurulum bozuk/bos panel
# uretir (Adobe KnownIssue2024)
if [ "$(find "$STAGE" -type l | wc -l | tr -d ' ')" != "0" ]; then
  echo "HATA: staging'de symlink var — paketlenemez:"; find "$STAGE" -type l; exit 1
fi

# ---- 4) İmzala + doğrula ----
echo "» İmzalanıyor…"
rm -f "$OUT"
"$SIGN" -sign "$STAGE" "$OUT" "$CERT" "$PASS" -tsa "$TSA"
"$SIGN" -verify "$OUT" -certInfo
echo "  (kontrol: yukarıda 'Timestamp: Valid' ve 'Signing Certificate: Valid' görünmeli;"
echo "   'OS Trusted: false' self-signed için normaldir)"

echo ""
echo "TAMAM → $OUT"
echo "Kurulum: kullanıcı bu dosyayı 'aescripts ZXP Installer' penceresine sürükler."
