#!/usr/bin/env bash
# 手动构建 APK：javac → d8 → aapt2 → zipalign → apksigner（不依赖 Gradle）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="$ROOT/.android-sdk"
BT="$SDK/build-tools/34.0.0"
# android.jar 可能在 platforms/ 或直接解压的 plat/ 下，自动探测
PLAT="$SDK/platforms/android-34/android.jar"
[ -f "$PLAT" ] || PLAT="$SDK/plat/android-34/android.jar"
OUT="$ROOT/android/build"
export JAVA_HOME="${JAVA_HOME:-/home/obs/miniconda3}"
export PATH="$JAVA_HOME/bin:$PATH"

[ -x "$BT/aapt2" ] || { echo "缺少 build-tools：$BT"; exit 1; }
[ -f "$PLAT" ] || { echo "缺少 android.jar：$PLAT"; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT/classes"
echo "[1/6] javac"
javac -nowarn -source 8 -target 8 -classpath "$PLAT" -d "$OUT/classes" $(find "$ROOT/android/src" -name '*.java')
echo "[2/6] d8 (dex)"
"$BT/d8" --lib "$PLAT" --min-api 24 --output "$OUT" $(find "$OUT/classes" -name '*.class')
echo "[3/6] aapt2 compile"
"$BT/aapt2" compile --dir "$ROOT/android/res" -o "$OUT/res.zip"
echo "[4/6] aapt2 link"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$PLAT" --manifest "$ROOT/android/AndroidManifest.xml" \
  -R "$OUT/res.zip" --min-sdk-version 24 --target-sdk-version 34 --auto-add-overlay
echo "[5/6] 打包 dex"
(cd "$OUT" && zip -q base.apk classes.dex && "$BT/zipalign" -f 4 base.apk aligned.apk)
echo "[6/6] 签名"
KS="$ROOT/android/debug.keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias androiddebugkey \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$ROOT/socratic-reader.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs "$ROOT/socratic-reader.apk" | head -3
ls -lh "$ROOT/socratic-reader.apk"
