#!/bin/zsh
# Gömülü whisper motorunu kaynaktan derler → bin/whisper-cli
# Evrensel (arm64 + x86_64), statik, Metal gömülü. Gereksinim: cmake (brew install cmake)
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="${TMPDIR:-/tmp}/fisilti-whisper-src"

if [ ! -d "$SRC" ]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$SRC"
fi

cmake -S "$SRC" -B "$SRC/build" \
  -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_NATIVE=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF
cmake --build "$SRC/build" -j 8 --target whisper-cli

mkdir -p "$ROOT/bin"
cp "$SRC/build/bin/whisper-cli" "$ROOT/bin/whisper-cli"
cp "$SRC/LICENSE" "$ROOT/bin/LICENSE-whisper.cpp.txt"
chmod +x "$ROOT/bin/whisper-cli"

echo "TAMAM → bin/whisper-cli ($(lipo -archs "$ROOT/bin/whisper-cli"))"
