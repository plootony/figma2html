#!/usr/bin/env bash
# Builds the extension and packs it with the install guide next to the project directory.
# for handing over to testers (load unpacked in chrome://extensions).
set -e
cd "$(dirname "$(readlink -f "$0")")"
npm run build >/dev/null
VER=$(node -p 'require("./extension/manifest.json").version')
STAGE=$(mktemp -d)/site2figma-$VER
mkdir -p "$STAGE"
cp -r extension "$STAGE/extension"
sed "s/VERSION/$VER/" INSTALL_TESTER.txt > "$STAGE/УСТАНОВКА.txt"
OUT="$(dirname "$PWD")/site2figma-$VER.zip"
rm -f "$OUT"
(cd "$(dirname "$STAGE")" && zip -qr "$OUT" "site2figma-$VER")
rm -rf "$(dirname "$STAGE")"
echo "$OUT"
