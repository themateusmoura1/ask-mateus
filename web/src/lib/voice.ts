import { fetchSpeech, type Reply } from "./api";
import type { OrbHandle } from "./orb";

/**
 * Speaks a reply and moves the orb with it. With a server voice the orb
 * follows the real loudness of the audio. With the browser's built-in voice
 * there is no loudness to read, so the orb is paced by hand.
 */
export class Voice {
  private audioContext: AudioContext | null = null;
  private current: HTMLAudioElement | null = null;
  private pacer: number | undefined;
  private token = 0;

  constructor(private orb: () => OrbHandle | null) {}

  /** Browsers only allow sound after a tap or key press. Call this from one. */
  unlock() {
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext ??= new Ctor();
      if (this.audioContext.state === "suspended") void this.audioContext.resume();
    } catch {
      this.audioContext = null;
    }
    if ("speechSynthesis" in window) speechSynthesis.getVoices(); // warms up the voice list
  }

  stop() {
    this.token++;
    this.current?.pause();
    this.current = null;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    window.clearInterval(this.pacer);
    this.orb()?.setLevel(0);
  }

  /** Resolves "spoken", "stopped" (interrupted) or "silent" (this device has no voice). */
  async speak(reply: Reply, useServerVoice: boolean): Promise<"spoken" | "stopped" | "silent"> {
    this.stop();
    const token = this.token;
    try {
      if (useServerVoice) {
        // The site has its own voice. If it is not available for this text, stay
        // quiet and let the caption carry it. Mixing in the browser's voice
        // would make the assistant change voices mid-conversation.
        if (!reply.speak) return "silent";
        await this.fromServer(reply.speak, token);
      } else {
        await this.fromBrowser(reply.text, token);
      }
    } catch {
      return "silent";
    }
    if (token !== this.token) return "stopped";
    this.orb()?.setLevel(0);
    return "spoken";
  }

  private async fromServer(id: string, token: number) {
    const audio = new Audio(URL.createObjectURL(await fetchSpeech(id)));
    if (token !== this.token) return;
    this.current = audio;

    let analyser: AnalyserNode | null = null;
    let samples: Uint8Array<ArrayBuffer> | null = null;
    if (this.audioContext) {
      analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 256;
      this.audioContext.createMediaElementSource(audio).connect(analyser);
      analyser.connect(this.audioContext.destination);
      samples = new Uint8Array(analyser.fftSize);
    }
    const follow = () => {
      if (this.current !== audio || audio.paused) return;
      if (analyser && samples) {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const s of samples) sum += ((s - 128) / 128) ** 2;
        this.orb()?.setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4.5));
      } else {
        this.orb()?.setLevel(0.5);
      }
      requestAnimationFrame(follow);
    };

    await new Promise<void>((resolve, reject) => {
      audio.addEventListener("ended", () => resolve());
      audio.addEventListener("pause", () => resolve());
      audio.addEventListener("error", () => reject(new Error("audio failed")));
      audio.play().then(follow, reject);
    });
  }

  private fromBrowser(text: string, token: number) {
    return new Promise<void>((resolve, reject) => {
      if (!("speechSynthesis" in window)) return reject(new Error("no speech"));
      if (token !== this.token) return resolve();
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      utterance.voice =
        voices.find((v) => /en-GB/i.test(v.lang) && /natural|google|daniel/i.test(v.name)) ||
        voices.find((v) => /^en/i.test(v.lang) && /natural|google/i.test(v.name)) ||
        voices.find((v) => /^en/i.test(v.lang)) ||
        null;
      utterance.lang = utterance.voice?.lang || "en-GB";
      utterance.rate = 1.02;

      // A slow, smooth rise and fall, with a small lift at each word. No random
      // jumps: the shape should look like it is breathing with the voice.
      // It starts at once rather than waiting for the browser to say the voice
      // has begun, because some browsers never send that signal.
      let lift = 0;
      const began = performance.now();
      window.clearInterval(this.pacer);
      this.pacer = window.setInterval(() => {
        const t = (performance.now() - began) / 1000;
        lift *= 0.9;
        this.orb()?.setLevel(0.5 + 0.22 * Math.sin(t * 3.1) + 0.12 * Math.sin(t * 5.3 + 1) + lift);
      }, 50);
      utterance.onboundary = () => (lift = 0.22);
      const finish = () => {
        window.clearInterval(this.pacer);
        resolve();
      };
      utterance.onend = finish;
      utterance.onerror = (event) => (event.error === "interrupted" || event.error === "canceled" ? finish() : reject(new Error(event.error)));
      speechSynthesis.speak(utterance);
    });
  }
}
