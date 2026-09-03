/**
 * WebAudio synthesizer — ported from the designer prototype. Off by default;
 * the header toggle flips it on (and primes the AudioContext, which browsers
 * require a gesture for).
 */

let context: AudioContext | null = null;
let soundOn = false;
const listeners = new Set<(on: boolean) => void>();

export const isSoundOn = (): boolean => soundOn;

export function setSoundOn(on: boolean): void {
  soundOn = on;
  if (on) sfx("on");
  listeners.forEach((listener) => listener(on));
}

export function subscribeSound(listener: (on: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sfx(type: string): void {
  if (!soundOn) return;
  try {
    context ??= new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext)();
    if (context.state === "suspended") void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.connect(gain);
    gain.connect(context.destination);
    const t = context.currentTime;

    const ramp = (
      wave: OscillatorType,
      from: number,
      to: number,
      level: number,
      duration: number,
      at = 0,
    ) => {
      oscillator.type = wave;
      oscillator.frequency.setValueAtTime(from, t + at);
      if (to !== from)
        oscillator.frequency.exponentialRampToValueAtTime(
          to,
          t + at + duration,
        );
      gain.gain.setValueAtTime(level, t + at);
      gain.gain.exponentialRampToValueAtTime(0.001, t + at + duration);
      oscillator.start(t);
      oscillator.stop(t + at + duration + 0.02);
    };

    switch (type) {
      case "launch":
        ramp("sawtooth", 140, 32, 0.12, 0.48);
        break;
      case "dotTick":
        ramp("sine", 840, 1260, 0.032, 0.025);
        break;
      case "land":
        ramp("square", 180, 55, 0.11, 0.35);
        break;
      case "feed":
        ramp("sine", 650, 1600, 0.06, 0.22);
        break;
      case "tick":
        ramp("sine", 520, 520, 0.04, 0.05);
        break;
      case "miss":
        ramp("triangle", 240, 110, 0.08, 0.3);
        break;
      case "prime":
        // Two fixed pitches (D5 → A5) like the prototype.
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(587.33, t);
        oscillator.frequency.setValueAtTime(880, t + 0.07);
        gain.gain.setValueAtTime(0.06, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
        oscillator.start(t);
        oscillator.stop(t + 0.25);
        break;
      case "win": {
        // Small arpeggio: the one voice the prototype reserved for takeovers.
        ["523.25", "659.25", "783.99", "1046.5"].forEach((freq, index) => {
          const at = index * 0.09;
          oscillator.frequency.setValueAtTime(Number(freq), t + at);
        });
        oscillator.type = "sine";
        gain.gain.setValueAtTime(0.07, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
        oscillator.start(t);
        oscillator.stop(t + 0.5);
        break;
      }
      default:
        ramp("sine", 920, 920, 0.045, 0.07);
    }
  } catch {
    // Audio is cosmetic; never let it break the game loop.
  }
}
