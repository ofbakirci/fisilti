/*
 * fisilti-eyedropper — macOS sistem damlalığı (NSColorSampler).
 * Büyüteç lupu açılır; tıklanan pikselin rengini "#RRGGBB\n" olarak stdout'a
 * yazar ve 0 ile çıkar. Esc/iptal: çıktı yok, kod 1. Ekran kaydı izni gerekmez
 * (örnekleme sistem servisinde olur, uygulama ekranı görmez).
 *
 * Derleme (universal):
 *   clang -fobjc-arc -O2 -arch arm64 -arch x86_64 \
 *     -framework AppKit -o ../bin/fisilti-eyedropper eyedropper.m
 */
#import <AppKit/AppKit.h>

int main(void) {
  @autoreleasepool {
    [NSApplication sharedApplication]; // NSColorSampler pencere sunucusu bağlantısı ister
    __block int done = 0, ok = 0;
    NSColorSampler *sampler = [[NSColorSampler alloc] init];
    [sampler showSamplerWithSelectionHandler:^(NSColor *color) {
      if (color) {
        NSColor *rgb = [color colorUsingColorSpace:[NSColorSpace sRGBColorSpace]];
        if (rgb) {
          printf("#%02X%02X%02X\n",
                 (int)lround(rgb.redComponent * 255.0),
                 (int)lround(rgb.greenComponent * 255.0),
                 (int)lround(rgb.blueComponent * 255.0));
          ok = 1;
        }
      }
      done = 1;
    }];
    // seçim tamamlanana dek çalıştır (5 dk emniyet tavanı)
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:300];
    while (!done && [deadline timeIntervalSinceNow] > 0) {
      [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode
                            beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return ok ? 0 : 1;
  }
}
