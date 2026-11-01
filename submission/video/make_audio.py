"""Sound for the MarsNav demo: an original music bed synthesised here (no samples, no licences, no AI), the app's own
caution-and-warning tone at the suit leak, and, when the team has recorded it, the narration.

    python3 submission/video/make_audio.py                      music + tone only  -> build/audio_music.wav
    python3 submission/video/make_audio.py --vo submission/video/vo   with narration -> build/audio_mix.wav

The narration is read from vo/line1.* ... vo/line7.* (any format ffmpeg reads: .wav, .m4a, .mp3). Each take is
trimmed of silence, placed at its cue in timeline.json, and sped up a little (at most 12 %) if it runs past its slot.
The music ducks under the voice, and the mix is normalised to -14 LUFS (YouTube's reference), peaks under -1.5 dBTP.
"""
import argparse
import json
import os
import subprocess
import tempfile

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

HERE = os.path.dirname(os.path.abspath(__file__))
TL = json.load(open(os.path.join(HERE, "timeline.json")))
SR = 48000
DUR = TL["duration"]
N = int(round(DUR * SR))
t = np.arange(N) / SR
rng = np.random.default_rng(2026)


def note(name):
    """Note name (e.g. 'D3', 'F#4', 'Bb2') to Hz."""
    names = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    n = names[name[0]]
    rest = name[1:]
    if rest.startswith("#"): n += 1; rest = rest[1:]
    elif rest.startswith("b"): n -= 1; rest = rest[1:]
    return 440.0 * 2 ** ((n - 9) / 12 + int(rest) - 4)


def lowpass(x, fc, order=2):
    return sosfilt(butter(order, fc, "low", fs=SR, output="sos"), x)


def highpass(x, fc, order=2):
    return sosfilt(butter(order, fc, "high", fs=SR, output="sos"), x)


def smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def window(a, b, fade=0.4):
    """1 inside [a, b], with smooth fades of `fade` s at both ends."""
    return smoothstep((t - a) / fade + 1) * smoothstep((b - t) / fade + 1) if fade > 0 else ((t >= a) & (t < b)).astype(float)


def pad_voice(freq, a, b, fade=0.6, bright=1.0, detune=0.004):
    """A soft pad note: a few harmonics, two detuned copies spread left and right."""
    env = window(a, b, fade)
    out = np.zeros((N, 2))
    for ch, d in ((0, 1 - detune), (1, 1 + detune)):
        s = np.zeros(N)
        for h in range(1, 7):
            s += np.sin(2 * np.pi * freq * d * h * t + h * 0.7) * (bright ** (h - 1)) / h
        out[:, ch] = s * env
    return out


def pluck(freq, at, dur=0.9, gain=1.0, pan=0.0):
    out = np.zeros((N, 2))
    i0 = int(at * SR)
    n = min(N - i0, int(dur * SR))
    if n <= 0:
        return out
    tt = np.arange(n) / SR
    s = (np.sin(2 * np.pi * freq * tt) + 0.35 * np.sin(4 * np.pi * freq * tt) + 0.12 * np.sin(6 * np.pi * freq * tt))
    s *= np.exp(-tt * 5.2) * (1 - np.exp(-tt * 400)) * gain
    out[i0:i0 + n, 0] += s * (1 - pan) / 2 * 2
    out[i0:i0 + n, 1] += s * (1 + pan) / 2 * 2
    return out


def boom(at, gain=1.0):
    """A low impact: a falling sine and a short burst of filtered noise."""
    out = np.zeros((N, 2))
    i0 = int(at * SR)
    n = min(N - i0, int(2.2 * SR))
    tt = np.arange(n) / SR
    f = 38 + 52 * np.exp(-tt * 7)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 2.2)
    nz = lowpass(rng.standard_normal(n), 900) * np.exp(-tt * 9) * 0.35
    out[i0:i0 + n, 0] += (s + nz) * gain
    out[i0:i0 + n, 1] += (s + nz) * gain
    return out


def riser(a, b, gain=1.0):
    """Filtered noise rising into a hit (a 'whoosh')."""
    out = np.zeros((N, 2))
    i0, i1 = int(a * SR), int(b * SR)
    n = i1 - i0
    tt = np.linspace(0, 1, n)
    nz = highpass(rng.standard_normal(n), 1200) * (tt ** 2.5) * gain
    out[i0:i1, 0] += nz
    out[i0:i1, 1] += np.roll(nz, 37)
    return out


def warning_tone(at, gain=1.0):
    """The app's WARNING tone (app/js/speech.js): square wave, 880 / 660 Hz, four 150 ms beeps 180 ms apart."""
    out = np.zeros((N, 2))
    for f, dt in ((880, 0.0), (660, 0.18), (880, 0.36), (660, 0.54)):
        i0 = int((at + dt) * SR)
        n = int(0.16 * SR)
        tt = np.arange(n) / SR
        sq = np.sign(np.sin(2 * np.pi * f * tt))
        env = np.minimum(1, tt / 0.01) * np.exp(-np.maximum(0, tt - 0.01) * 18)
        s = lowpass(sq, 5000) * env * gain
        out[i0:i0 + n, 0] += s
        out[i0:i0 + n, 1] += s
    return out


def reverb(x, seconds=2.4, mix=0.32):
    n = int(seconds * SR)
    tt = np.arange(n) / SR
    ir = np.stack([rng.standard_normal(n), rng.standard_normal(n)], 1) * np.exp(-tt * 6.5 / seconds)[:, None]
    ir[:, 0] = lowpass(ir[:, 0], 6000)
    ir[:, 1] = lowpass(ir[:, 1], 6000)
    ir /= np.sqrt((ir ** 2).sum(0))
    wet = np.stack([fftconvolve(x[:, c], ir[:, c])[:N] for c in range(2)], 1)
    return x * (1 - mix) + wet * mix


def music():
    S = TL["shots"]
    at = {s["id"]: s["start"] for s in S}
    mix = np.zeros((N, 2))
    # the leak, as it appears on screen (the devices shot shows captured frame capture_from + from + k)
    dev = next(s for s in S if s["id"] == "devices")
    cap = json.load(open(os.path.join(HERE, "build", "eva", "capture.json")))
    leak_t = dev["start"] + (cap["leakFrame"] - dev["capture_from"] - dev.get("from", 0)) / cap["fps"]
    # chords follow the shots: (start, end, notes)
    R, P, E = at["rover"], at["proof"], at["end"]
    q = (P - R) / 4
    chords = [
        (0.0, at["walkback"] + 0.15, ["D2", "A2"]),
        (at["walkback"], at["devices"] + 0.15, ["D3", "F3", "A3", "E4"]),
        (at["devices"], leak_t + 0.1, ["Bb2", "D3", "F3"]),
        (leak_t, R + 0.15, ["C3", "E3", "G3"]),
        (R, R + q + 0.15, ["D3", "F3", "A3"]),
        (R + q, R + 2 * q + 0.15, ["Bb2", "D3", "F3"]),
        (R + 2 * q, R + 3 * q + 0.15, ["F2", "A2", "C3", "F3"]),
        (R + 3 * q, P + 0.15, ["C3", "E3", "G3"]),
        (P, P + (E - P) / 2 + 0.15, ["Bb2", "D3", "F3", "D4"]),
        (P + (E - P) / 2, E + 0.15, ["C3", "E3", "G3", "E4"]),
        (E, DUR, ["D2", "D3", "F#3", "A3", "E4"]),
    ]
    for a, b, notes in chords:
        bright = 0.42 if a < 4 else 0.5 if a < 27 else 0.55
        for nn in notes:
            mix += pad_voice(note(nn), a, b, fade=0.5 if a > 0 else 0.05, bright=bright) * 0.06
    # the opening: a sub drone and a slow heartbeat under the first line
    mix += pad_voice(note("D1"), 0.0, 4.9, fade=0.05, bright=0.2) * 0.12
    for k in range(5):
        mix += boom(0.35 + 1.0 * k, gain=0.10)
    # the reveal of the name, and the end card
    mix += riser(at["walkback"] - 0.9, at["walkback"], gain=0.05) + boom(at["walkback"], gain=0.55)
    mix += riser(at["end"] - 1.0, at["end"], gain=0.05) + boom(at["end"], gain=0.45)
    # movement under "it ranks ... plans ... reads the suit": a plucked arpeggio (D minor add 9, then B flat)
    pat1 = ["D4", "A4", "E5", "F5", "A5", "E5", "F5", "A4"]
    pat2 = ["Bb3", "F4", "C5", "D5", "F5", "D5", "C5", "F4"]
    step = 0.21
    k = 0
    x = at.get("plan_ui", at.get("globe"))
    while x < at["rover"] - 0.1:
        if not (leak_t - 0.05 < x < leak_t + 0.95):        # it steps aside for the warning
            pat = pat1 if x < at["devices"] else pat2
            mix += pluck(note(pat[k % 8]), x, gain=0.05 * (0.85 if k % 2 else 1), pan=0.5 * np.sin(k * 1.3))
        k += 1
        x += step
    # the proof: a pulse like a clock while the rover's sols tick by, then lift into the 0 / 40 card
    for b in np.arange(at["rover"], at["proof"], 0.42):
        mix += boom(b, gain=0.05)
    mix += riser(at["proof"] - 1.6, at["proof"], gain=0.04) + boom(at["proof"], gain=0.3)
    # bells on the end card
    for nn, dt in (("D5", 0.05), ("F#5", 0.25), ("A5", 0.45), ("D6", 0.7)):
        mix += pluck(note(nn), at["end"] + dt, dur=2.2, gain=0.035, pan=0.3 if nn[1] == "#" else -0.2)
    mix = reverb(mix)
    # tame the low end so the bed stays clear on laptop speakers and under a voice: no sub-rumble, about -3.5 dB
    # below 140 Hz
    mix = np.stack([highpass(mix[:, c], 32) for c in range(2)], 1)
    mix -= 0.33 * np.stack([lowpass(mix[:, c], 140) for c in range(2)], 1)
    # the warning tone itself stays dry and clear, like the app's
    mix += warning_tone(leak_t, gain=0.09)
    # fade out at the very end
    mix *= smoothstep((DUR - t) / 0.6)[:, None]
    return mix, leak_t


def read_audio(path):
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "a.wav")
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", str(SR),
                        "-af", "silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB:stop_duration=0.25",
                        "-c:a", "pcm_f32le", out], check=True)
        _, a = wavfile.read(out)
    return a.astype(np.float64)


def stretch(a, factor):
    with tempfile.TemporaryDirectory() as d:
        i, o = os.path.join(d, "i.wav"), os.path.join(d, "o.wav")
        wavfile.write(i, SR, a.astype(np.float32))
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", i, "-af", f"atempo={factor:.4f}", "-c:a", "pcm_f32le", o], check=True)
        _, b = wavfile.read(o)
    return b.astype(np.float64)


def narration(vo_dir):
    vo = np.zeros(N)
    report = []
    for cue in TL["voiceover"]:
        cands = [f for f in os.listdir(vo_dir) if os.path.splitext(f)[0].lower() == f"line{cue['line']}"]
        if not cands:
            report.append(f"line {cue['line']}: missing")
            continue
        a = read_audio(os.path.join(vo_dir, cands[0]))
        slot = cue["out"] - cue["in"]
        dur = len(a) / SR
        note_ = f"line {cue['line']}: {dur:.2f} s in a {slot:.2f} s slot"
        if dur > slot:
            f = dur / slot
            if f > 1.12:
                note_ += "; more than 12 % too long, so it was sped up 12 % and cut: record it a little faster"
                f = 1.12
            a = stretch(a, f)
            a = a[: int(slot * SR)]
        i0 = int(cue["in"] * SR)
        a = a * (10 ** (-20 / 20) / max(1e-9, np.sqrt(np.mean(a ** 2))))   # every take at the same level
        vo[i0:i0 + len(a)] += a[: N - i0]
        report.append(note_)
    return vo, report


def loudnorm(inp, out, target=-14.0):
    """Two-pass EBU R128 normalisation with ffmpeg."""
    first = subprocess.run(["ffmpeg", "-hide_banner", "-i", inp, "-af", f"loudnorm=I={target}:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                           capture_output=True, text=True).stderr
    m = json.loads(first[first.rindex("{"): first.rindex("}") + 1])
    af = (f"loudnorm=I={target}:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:"
          f"measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", inp, "-af", af, "-ar", str(SR), "-c:a", "pcm_s24le", out], check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vo", help="folder with line1..line7 recordings")
    args = ap.parse_args()
    os.makedirs(os.path.join(HERE, "build"), exist_ok=True)
    mus, leak_t = music()
    if args.vo:
        vo, report = narration(args.vo)
        print("\n".join(report))
        # duck the music under the voice (an envelope follower on the narration)
        env = np.sqrt(np.maximum(0, lowpass(vo ** 2, 6)))       # the filter can ring a hair below zero
        duck = 1 - 0.62 * smoothstep(env / (np.max(env) * 0.25 + 1e-9))
        mix = mus * duck[:, None] * 0.55 + np.stack([vo, vo], 1)
        name = "audio_mix"
    else:
        mix = mus
        name = "audio_music"
    raw = os.path.join(HERE, "build", f"{name}_raw.wav")
    wavfile.write(raw, SR, (mix / max(1e-9, np.max(np.abs(mix))) * 0.7).astype(np.float32))
    out = os.path.join(HERE, "build", f"{name}.wav")
    loudnorm(raw, out)
    print(f"wrote {out}; warning tone at {leak_t:.2f} s")


if __name__ == "__main__":
    main()
