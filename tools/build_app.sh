#!/usr/bin/env bash
# Copy the engine (single source of truth in ../engine) into the app so app/ is a self-contained, deployable folder.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf app/engine
mkdir -p app/engine
for f in engine/*.js; do
  [ "$(basename "$f")" = "node_io.js" ] && continue
  cp "$f" app/engine/
done
echo "engine copied: $(ls app/engine | wc -l) modules"
