// speech.js - spoken callouts (Web Speech API; offline voices on most desktops) and alert tones (Web Audio).
// Tones follow the priority: WARNING = fast two-tone, CAUTION = single chime, ADVISORY = soft click.
let audio = null;

export function primeAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch { audio = null; }
}

export function tone(level) {
  if (!audio) return;
  const t0 = audio.currentTime;
  const seq = level === 3 ? [[880, 0], [660, 0.18], [880, 0.36], [660, 0.54]] : level === 2 ? [[740, 0], [740, 0.25]] : [[520, 0]];
  for (const [f, dt] of seq) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "square";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + dt);
    g.gain.exponentialRampToValueAtTime(level === 1 ? 0.03 : 0.08, t0 + dt + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.15);
    o.connect(g).connect(audio.destination);
    o.start(t0 + dt);
    o.stop(t0 + dt + 0.16);
  }
}

export function speak(text) {
  try {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    window.speechSynthesis.speak(u);
  } catch { /* speech not available */ }
}
