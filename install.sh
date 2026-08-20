#!/bin/zsh
# Fısıltı — Premiere Pro CEP eklentisi kurulumu (macOS)
# Kaynak klasörü CEP extensions dizinine symlink'ler; geliştirme sırasında
# dosya değişiklikleri panel yeniden açılınca anında yansır.
set -e

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.ofb.fisilti"

echo "Fısıltı kurulumu"
echo "  Kaynak : $SRC"
echo "  Hedef  : $DEST"

# 1) İmzasız panellere izin (PlayerDebugMode) — Premiere 25+/26 = CSXS 12
for v in 11 12 13; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 2>/dev/null || true
done
echo "  PlayerDebugMode ayarlandı (CSXS 11/12/13)"

# 2) Symlink kur
mkdir -p "$(dirname "$DEST")"
if [ -L "$DEST" ] || [ -e "$DEST" ]; then
  rm -rf "$DEST"
fi
ln -s "$SRC" "$DEST"
echo "  Symlink kuruldu"

# 3) Bağımlılık kontrolü
if command -v whisper-cli >/dev/null 2>&1 || [ -x /opt/homebrew/bin/whisper-cli ]; then
  echo "  whisper-cli: var"
else
  echo "  UYARI: whisper-cli yok → brew install whisper-cpp"
fi
if command -v ffmpeg >/dev/null 2>&1 || [ -x /opt/homebrew/bin/ffmpeg ] \
   || [ -x "$HOME/Library/Application Support/Fisilti/bin/ffmpeg" ]; then
  echo "  ffmpeg: var"
else
  echo "  NOT: ffmpeg yok (yalnız stilli overlay için gerekli)"
  echo "       Panelden kur: Ayarlar > ffmpeg > İndir (brew gerekmez)"
fi

echo ""
echo "Tamam. Premiere Pro'yu (yeniden) başlat:"
echo "  Window > Extensions > Fısıltı — Whisper Altyazı"
