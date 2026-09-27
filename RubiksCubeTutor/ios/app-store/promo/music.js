/* Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved. Proprietary software. See LICENSE, or the Licence page inside the app. */
/*
 * music.js - the promo's music, made here from sine waves and noise so there is no
 * licence to clear: a bright plucked arpeggio over a soft pad and bass, with light drums
 * that come in when the phone does (2 s) and stop for the end card, where the last chord
 * rings out. 120 bpm, C G Am F. Written as a 44.1 kHz, 16-bit stereo WAV.
 *
 *     node -e "require('./ios/app-store/promo/music.js').writeMusic('music.wav', 20)"
 */
const fs = require('fs');
const { Buffer } = require('buffer');

const RATE = 44100;
const BEAT = 0.5;                                    // 120 bpm
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// One chord a bar (four beats, two seconds), landing home on C for the end card at 16 s.
const BARS = [
  [60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60],     // C G Am F
  [60, 64, 67], [55, 59, 62], [53, 57, 60], [55, 59, 62],     // C G F G
  [60, 64, 67], [60, 64, 67],                                 // C, ringing
];
const ARP = [0, 1, 2, 3, 2, 1, 2, 3];                // chord tones, 3 = the root an octave up

function writeMusic(file, seconds) {
  const n = Math.round(seconds * RATE);
  const L = new Float32Array(n), R = new Float32Array(n);
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  const add = (t0, dur, pan, gain, voice) => {
    const a = Math.max(0, Math.round(t0 * RATE)), b = Math.min(n, Math.round((t0 + dur) * RATE));
    const l = gain * Math.cos((pan + 1) * Math.PI / 4), r = gain * Math.sin((pan + 1) * Math.PI / 4);
    for (let i = a; i < b; i++) { const v = voice((i - a) / RATE); L[i] += v * l; R[i] += v * r; }
  };
  const pluck = (f) => (t) => (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t) + 0.12 * Math.sin(6 * Math.PI * f * t))
    * Math.exp(-t / 0.2) * Math.min(1, t / 0.004);
  const pad = (f, len) => (t) => (Math.sin(2 * Math.PI * f * t) + Math.sin(2 * Math.PI * f * 1.004 * t) * 0.8)
    * Math.min(1, t / 0.35) * Math.min(1, (len - t) / 0.4);
  const bass = (f) => (t) => Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.4) * Math.min(1, t / 0.006);
  const kick = (t) => Math.sin(2 * Math.PI * (45 * t + (110 - 45) * 0.03 * (1 - Math.exp(-t / 0.03)))) * Math.exp(-t / 0.16);
  const snap = (t) => noise() * Math.exp(-t / 0.05);
  const shaker = (t) => noise() * Math.exp(-t / 0.018);
  const bell = (f) => (t) => (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t / 0.4))
    * Math.exp(-t / 1.4) * Math.min(1, t / 0.003);

  BARS.forEach((chord, bar) => {
    const t = bar * 4 * BEAT;
    if (t >= seconds) return;
    const len = bar === BARS.length - 1 ? seconds - t : 4 * BEAT + 0.3;
    chord.forEach((m, k) => add(t, len, k - 1, 0.045, pad(hz(m), len)));            // the pad, spread wide
    if (bar < 9) {
      const tones = [...chord, chord[0] + 12].map((m) => hz(m + 12));
      ARP.forEach((idx, s) => add(t + s * BEAT / 2, 0.9, s % 2 ? 0.35 : -0.35, 0.16, pluck(tones[idx])));
    }
    const drums = t >= 2 && t < 16;
    for (let beat = 0; beat < 4; beat++) {
      const tb = t + beat * BEAT;
      if (bar < 9 && beat % 2 === 0) add(tb, 1.2, 0, 0.24, bass(hz(chord[0] - 24)));
      if (!drums) continue;
      if (beat % 2 === 0) add(tb, 0.5, 0, 0.5, kick);
      else add(tb, 0.25, 0.1, 0.12, snap);
      add(tb + BEAT / 2, 0.08, 0.5, 0.05, shaker);
    }
  });
  // the end card: a bright bell on C as it appears
  [84, 88, 91].forEach((m, k) => add(16.8 + k * 0.07, seconds - 16.8, (k - 1) * 0.4, 0.09, bell(hz(m))));

  // master: soft limit, a quick fade in, a fade out over the last second and a half
  let peak = 0;
  for (let i = 0; i < n; i++) { L[i] = Math.tanh(L[i] * 1.2); R[i] = Math.tanh(R[i] * 1.2); peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
  const scale = 0.89 / (peak || 1);                  // about -1 dBFS
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = Math.min(1, t / 0.05) * Math.min(1, (seconds - t) / 1.5);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * scale * env)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * scale * env)) * 32767), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

module.exports = { writeMusic };
