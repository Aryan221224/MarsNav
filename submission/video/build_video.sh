#!/usr/bin/env bash
# Renders the demo from the captures already in submission/video/build (stills, eva) and assembles it:
# the opening and the devices shot (devices.html), the rover map, every frame (compositor.html), the sound, the MP4.
# Safe to re-run: with RESUME=1 frames that already exist are kept.  Add --vo to mix in submission/video/vo/line1..7.
set -euo pipefail
cd "$(dirname "$0")/../.."
PORT=8800
curl -s -o /dev/null "http://127.0.0.1:$PORT/" || { python3 -m http.server "$PORT" --bind 127.0.0.1 --directory . >/dev/null 2>&1 & sleep 1.5; }
BASE="http://127.0.0.1:$PORT/"
node submission/video/render_devices.mjs "$BASE" submission/video/build/intro --intro
node submission/video/render_devices.mjs "$BASE" submission/video/build/devices
python3 submission/video/prep_rover_map.py . submission/video/build/rover
if [[ "${1:-}" == "--vo" ]]; then
  CAPTIONS=1 node submission/video/render_video.mjs "$BASE" submission/video/build/frames_vo
  python3 submission/video/make_audio.py --vo submission/video/vo
  python3 submission/video/assemble.py --vo
else
  node submission/video/render_video.mjs "$BASE" submission/video/build/frames
  python3 submission/video/make_audio.py
  python3 submission/video/assemble.py
fi
