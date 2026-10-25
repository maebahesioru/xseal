#!/usr/bin/env bash
# Gradle を使わない手ビルド（aapt2 + javac + d8 + apksigner）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
BT="$SDK/build-tools/34.0.0"
AJ="$SDK/platforms/android-34/android.jar"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk}"
# d8 はスクリプト内で PATH 上の java を呼ぶ。JDK8 が先に来ていると UnsupportedClassVersionError になる
export PATH="$JAVA_HOME/bin:$PATH"
JAVAC="$JAVA_HOME/bin/javac"
KEYTOOL="$JAVA_HOME/bin/keytool"
OUT="$ROOT/build"

for f in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$AJ" "$JAVAC"; do
  [ -e "$f" ] || { echo "見つからない: $f" >&2; exit 1; }
done

echo "=== 1/6 core.js を assets へ ==="
CORE="${CORE_JS:-$ROOT/../chrome/core.js}"
[ -f "$CORE" ] || { echo "core.js が無い: $CORE" >&2; exit 1; }
mkdir -p "$ROOT/assets"
cp "$CORE" "$ROOT/assets/core.js"
ls -l "$ROOT/assets/core.js"

echo "=== 2/6 リソースをコンパイル ==="
rm -rf "$OUT"; mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"
"$BT/aapt2" compile --dir "$ROOT/app/res" -o "$OUT/res.zip"

echo "=== 3/6 リンク（manifest + res + assets） ==="
"$BT/aapt2" link -o "$OUT/base.apk" -I "$AJ" \
  --manifest "$ROOT/app/AndroidManifest.xml" \
  -R "$OUT/res.zip" --java "$OUT/gen" \
  -A "$ROOT/assets" --auto-add-overlay

echo "=== 4/6 javac ==="
find "$ROOT/app/src" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
"$JAVAC" -nowarn -source 17 -target 17 -classpath "$AJ" -d "$OUT/classes" @"$OUT/sources.txt"

echo "=== 5/6 dex ==="
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$BT/d8" --lib "$AJ" --min-api 26 --output "$OUT/dex" @"$OUT/classes.txt"

echo "=== 6/6 パッケージ・整列・署名 ==="
cp "$OUT/base.apk" "$OUT/unsigned.apk"
( cd "$OUT/dex" && zip -q "$OUT/unsigned.apk" classes.dex )
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

KS="$ROOT/debug.keystore"
if [ ! -f "$KS" ]; then
  "$KEYTOOL" -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -dname "CN=Android Debug,O=Android,C=US" \
    -keyalg RSA -keysize 2048 -validity 10000 >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$ROOT/xseal-android.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify "$ROOT/xseal-android.apk"

echo
echo "=== できあがり ==="
ls -lh "$ROOT/xseal-android.apk"
"$BT/aapt2" dump badging "$ROOT/xseal-android.apk" | head -6
echo "--- APK の中身 ---"
unzip -l "$ROOT/xseal-android.apk" | tail -12
