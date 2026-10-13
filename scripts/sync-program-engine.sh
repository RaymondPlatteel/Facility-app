#!/bin/sh
# The program rules live in Project-000 (src/app/program-engine). The Program Trainer runs the same rules, so this
# copies them here. Run it after any rule change in Project-000. athlete.ts is left out: it reads the athlete app's
# member records, which the trainer does not use.
set -e
SRC="${PROJECT_000:-$HOME/Desktop/Projects/Project-000}/src/app/program-engine"
DEST="$(cd "$(dirname "$0")/.." && pwd)/src/app/program-engine"
mkdir -p "$DEST"
for f in "$SRC"/*.ts; do
  name=$(basename "$f")
  [ "$name" = "athlete.ts" ] && continue
  cp "$f" "$DEST/$name"
done
grep -o "ENGINE_VERSION = [0-9]*" "$SRC/../services/program-builder.service.ts" | sed 's/ENGINE_VERSION = \([0-9]*\)/export const ENGINE_VERSION = \1;/' > "$DEST/version.ts"
echo "Synced $(ls "$DEST" | wc -l | tr -d ' ') files from $SRC"
