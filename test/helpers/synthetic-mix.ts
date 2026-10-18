/**
 * A deterministic dance-music mix made of math: a four-on-the-floor kick (a pitch-dropping sine with a click), an offbeat bass, detuned
 * saw chords ducked by the kick, and noise hats. Pre-master loudness is set to −16 LUFS like a leveled song; the peak-to-loudness
 * ratio (~13 dB) is that of the EDM styles' renders. For the loudness stage's unit tests, which run without the engine.
 */
import { measure, SR, gain, type Stereo } from './loudness-quality';

function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

export function syntheticMix(seconds: number, bpm = 128, preLufs = -16): Stereo {
  const n = Math.round(seconds * SR);
  const beat = (60 / bpm) * SR;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const rnd = noise(4242);
  const chordHz = [110, 130.8, 164.8, 220, 261.6];
  const phase = chordHz.map((_, i) => i * 0.37);
  let kickPhase = 0;
  let hatPrev = 0;
  for (let i = 0; i < n; i++) {
    const t = (i % beat) / SR;
    // The kick: pitch falls from 135 to 45 Hz, body decays over ~0.2 s, plus a short click.
    const f = 45 + 90 * Math.exp(-t / 0.03);
    kickPhase += (2 * Math.PI * f) / SR;
    const body = Math.sin(kickPhase) * Math.exp(-t / 0.2);
    const click = t < 0.004 ? rnd() * 0.35 * (1 - t / 0.004) : 0;
    const kick = 1.0 * body + click;
    // The ducking every other part gets from the kick.
    const duck = 1 - 0.85 * Math.exp(-t / 0.12);
    // The bass: a 55 Hz tone with a little 2nd and 3rd harmonic, on the off-beat.
    const tb = ((i + beat / 2) % beat) / SR;
    const bf = 55;
    const bass = (Math.sin(2 * Math.PI * bf * (i / SR)) + 0.4 * Math.sin(2 * Math.PI * 2 * bf * (i / SR)) + 0.2 * Math.sin(2 * Math.PI * 3 * bf * (i / SR))) * Math.exp(-tb / 0.25) * 0.5 * duck;
    // Detuned saw chords: each voice a sum of 6 harmonics.
    let chordL = 0;
    let chordR = 0;
    for (let v = 0; v < chordHz.length; v++) {
      const w = (2 * Math.PI * chordHz[v]! * (i / SR)) + phase[v]!;
      let sawL = 0;
      let sawR = 0;
      for (let h = 1; h <= 6; h++) {
        sawL += Math.sin(h * w) / h;
        sawR += Math.sin(h * w * 1.004 + 0.3) / h;
      }
      chordL += sawL * 0.05;
      chordR += sawR * 0.05;
    }
    // Hats on the off-beat 8ths: differentiated noise with a fast decay.
    const th = ((i + beat / 4) % (beat / 2)) / SR;
    const nz = rnd();
    const hat = (nz - hatPrev) * Math.exp(-th / 0.03) * 0.12;
    hatPrev = nz;
    L[i] = kick + bass + chordL * duck + hat;
    R[i] = kick + bass + chordR * duck - hat * 0.5;
  }
  const mix: Stereo = [L, R];
  const g = gain(preLufs - measure(mix).lufs);
  return [L.map((v) => v * g), R.map((v) => v * g)];
}
