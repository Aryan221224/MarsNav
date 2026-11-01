"""Final assembly of the MarsNav demo video.

    python3 submission/video/assemble.py            picture + music bed      -> MarsNav_demo_30s_music.mp4
    python3 submission/video/assemble.py --vo       picture + narration mix  -> MarsNav_demo_30s.mp4

Also writes marsnav_en.srt (the English subtitles, from timeline.json, for YouTube's subtitle upload) and embeds the
same subtitles as a selectable track. The captions are burned into the picture as well (render_video.mjs).
"""
import argparse
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
TL = json.load(open(os.path.join(HERE, "timeline.json")))


def ts(x):
    ms = int(round(x * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def write_srt(path):
    with open(path, "w", encoding="utf-8") as f:
        for i, c in enumerate(TL["captions"], 1):
            f.write(f"{i}\n{ts(c['in'])} --> {ts(c['out'])}\n{c['text']}\n\n")


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
                         capture_output=True, text=True, check=True).stdout
    return float(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vo", action="store_true", help="use build/audio_mix.wav (narration) instead of the music bed")
    args = ap.parse_args()
    srt = os.path.join(HERE, "marsnav_en.srt")
    write_srt(srt)
    pic = os.path.join(HERE, "build", "picture_vo.mp4" if args.vo else "picture.mp4")
    aud = os.path.join(HERE, "build", "audio_mix.wav" if args.vo else "audio_music.wav")
    out = os.path.join(HERE, "MarsNav_demo_30s.mp4" if args.vo else "MarsNav_demo_30s_music.mp4")
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", pic, "-i", aud, "-i", srt,
                    "-map", "0:v", "-map", "1:a", "-map", "2:s", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
                    "-c:s", "mov_text", "-metadata:s:s:0", "language=eng", "-metadata", f"title={TL['title']}",
                    "-t", str(TL["duration"]), "-movflags", "+faststart", out], check=True)
    d = duration(out)
    print(f"wrote {out}: {d:.2f} s, {os.path.getsize(out) / 1e6:.1f} MB")
    if d > 30.0:
        raise SystemExit(f"too long for Space Apps: {d:.2f} s (limit 30 s)")


if __name__ == "__main__":
    main()
