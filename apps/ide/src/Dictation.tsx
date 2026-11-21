import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Icon, Loader } from "./shared.tsx";
import { call, useStore } from "./store.ts";

// Taps the microphone inside the audio thread and hands each block of samples to the page.
const TAP = `class ArcexTap extends AudioWorkletProcessor {
  process(inputs) { const channel = inputs[0] && inputs[0][0]; if (channel) this.port.postMessage(channel.slice(0)); return true; }
}
registerProcessor("arcex-tap", ArcexTap);`;
const RATE = 16_000;
const MAX_SECONDS = 300;

function base64(samples: Int16Array) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

type Take = { stop(): Promise<string>; cancel(): void };

/** Records from the microphone and streams it to the engine, about a second at a time, for transcription there. */
async function record(onLevel: (level: number) => void, onLimit: () => void): Promise<Take> {
  const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const context = new AudioContext({ sampleRate: RATE });
  const { recordingId } = await call("speech.start", {}).catch((error: unknown) => {
    media.getTracks().forEach((track) => track.stop());
    void context.close();
    throw error;
  });
  const url = URL.createObjectURL(new Blob([TAP], { type: "application/javascript" }));
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const source = context.createMediaStreamSource(media);
  const tap = new AudioWorkletNode(context, "arcex-tap");
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(tap).connect(mute).connect(context.destination);

  let buffer = new Int16Array(RATE);
  let filled = 0;
  let total = 0;
  let sending: Promise<unknown> = Promise.resolve();
  let lastLevel = 0;
  const flush = () => {
    if (!filled) return;
    const pcm = base64(buffer.subarray(0, filled));
    buffer = new Int16Array(RATE);
    filled = 0;
    sending = sending.then(() => call("speech.chunk", { recordingId, pcm }));
  };
  tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const block = event.data;
    let sum = 0;
    for (let i = 0; i < block.length; i++) {
      const sample = Math.max(-1, Math.min(1, block[i]!));
      sum += sample * sample;
      buffer[filled++] = sample * 32767;
      if (filled === buffer.length) flush();
    }
    total += block.length;
    const now = performance.now();
    if (now - lastLevel > 60) {
      lastLevel = now;
      onLevel(Math.min(1, Math.sqrt(sum / block.length) * 6));
    }
    if (total >= RATE * MAX_SECONDS) onLimit();
  };
  const release = () => {
    tap.port.onmessage = null;
    source.disconnect();
    media.getTracks().forEach((track) => track.stop());
    void context.close();
  };
  return {
    async stop() {
      release();
      flush();
      await sending;
      return (await call("speech.finish", { recordingId })).text;
    },
    cancel() {
      release();
      void call("speech.cancel", { recordingId });
    },
  };
}

/**
 * The mic button in the message box. The first press fetches the voice model once (it runs on this computer);
 * after that a press starts listening and another press, or Enter, puts the words into the box.
 */
export function Dictation({ onText, fail, disabled }: { onText(text: string): void; fail(error: unknown): void; disabled?: boolean }) {
  const { speech } = useStore();
  const [phase, setPhase] = useState<"idle" | "starting" | "listening" | "writing">("idle");
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const take = useRef<Take | null>(null);
  const wanted = useRef(false);

  useEffect(() => {
    if (!speech) call("speech.status", {}).catch(() => {});
  }, []);
  // Let go of the microphone if the message box goes away mid-recording.
  useEffect(() => () => take.current?.cancel(), []);
  useEffect(() => {
    if (phase !== "listening") return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [phase]);
  // The download finished after the user asked to talk: start listening right away.
  useEffect(() => {
    if (speech?.state === "ready" && wanted.current && phase === "idle") {
      wanted.current = false;
      void start();
    }
    if (speech?.state === "failed" && wanted.current) {
      wanted.current = false;
      fail(speech.error ?? "Voice dictation couldn't be set up.");
    }
  }, [speech?.state]);

  async function start() {
    setPhase("starting");
    setSeconds(0);
    try {
      take.current = await record(setLevel, () => void stop());
      setPhase("listening");
    } catch (error) {
      take.current = null;
      setPhase("idle");
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "NotFoundError");
      fail(denied ? "Arcex can't hear a microphone. Check that one is connected and allowed in Windows privacy settings." : error);
    }
  }

  async function stop() {
    const current = take.current;
    if (!current) return;
    take.current = null;
    setPhase("writing");
    setLevel(0);
    try {
      const text = await current.stop();
      if (text) onText(text);
    } catch (error) {
      fail(error);
    } finally {
      setPhase("idle");
    }
  }

  function cancel() {
    take.current?.cancel();
    take.current = null;
    setPhase("idle");
    setLevel(0);
  }

  async function press() {
    if (phase === "listening") return void stop();
    if (phase !== "idle") return;
    const state = speech ?? (await call("speech.status", {}).catch(() => null));
    if (state?.state === "ready") return void start();
    wanted.current = true;
    if (state?.state !== "downloading") call("speech.prepare", {}).catch((error: unknown) => {
      wanted.current = false;
      fail(error);
    });
  }

  // While listening, Enter finishes and Escape throws the take away, wherever focus is.
  useEffect(() => {
    if (phase !== "listening") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void stop();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase]);

  const downloading = speech?.state === "downloading" && wanted.current;
  if (phase === "listening") {
    return (
      <div className="dictating" role="status" aria-live="polite">
        <span className="bars" aria-hidden="true">
          {[0.55, 1, 0.75, 0.9, 0.6].map((weight, index) => (
            <i key={index} style={{ transform: `scaleY(${0.18 + Math.min(1, level * weight) * 0.82})` }} />
          ))}
        </span>
        <span className="time">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
        <button className="icon" title="Discard (Esc)" aria-label="Discard recording" onClick={cancel}><Icon name="x" /></button>
        <button className="done" title="Done (Enter)" aria-label="Done, write it into the message" onClick={() => void stop()}><Icon name="check" /></button>
      </div>
    );
  }
  const label = downloading
    ? `Getting voice ready, ${Math.round((speech?.progress ?? 0) * 100)}%. This happens once.`
    : phase === "writing" ? "Writing what you said" : "Dictate";
  return (
    <button className="icon mic" title={label} aria-label={label} disabled={disabled || phase !== "idle"} onClick={() => void press()}>
      {downloading ? (
        <span className="ring" style={{ "--p": speech?.progress ?? 0 } as CSSProperties} />
      ) : phase === "writing" || phase === "starting" ? (
        <Loader work={phase === "writing"} />
      ) : (
        <Icon name="mic" />
      )}
    </button>
  );
}
