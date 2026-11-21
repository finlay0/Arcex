// Voice dictation, on this computer. Nothing the user says leaves the machine, and it spends none of their agent usage.
// The speech model (Parakeet TDT-CTC 110M, CC-BY-4.0, NVIDIA) downloads once, when the user first presses the mic.
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SpeechState } from "@arcex/contracts";

const MODEL = {
  name: "Parakeet 110M",
  repo: "handy-computer/parakeet-tdt_ctc-110m-gguf",
  revision: "9d66d34f9e1594075c5dd72c90c0f4c321b29f21",
  file: "parakeet-tdt_ctc-110m-Q8_0.gguf",
  size: 135_373_280,
  sha256: "7dd44c74a331d788a4e5f8b16913b3feb29ced22cf5613aad0e0f6cd30516296",
};
const RATE = 16_000;
const MAX_SECONDS = 300;
const IDLE_UNLOAD_MS = 10 * 60_000;

type Model = { transcribe(pcm: Float32Array): Promise<{ text: string }>; dispose(): void };
type Recording = { chunks: Buffer[]; bytes: number; timer: NodeJS.Timeout };

export function createSpeech(dataDir: string, emit: (state: SpeechState) => void) {
  const dir = path.join(dataDir, "speech");
  const modelPath = path.join(dir, MODEL.file);
  let state: SpeechState = { state: "missing", progress: 0, size: MODEL.size, model: MODEL.name };
  if (existsSync(modelPath) && statSync(modelPath).size === MODEL.size) state = { ...state, state: "ready", progress: 1 };
  let download: Promise<void> | null = null;
  let model: Promise<Model> | null = null;
  let unloadTimer: NodeJS.Timeout | undefined;
  const recordings = new Map<string, Recording>();

  const set = (next: Partial<SpeechState>) => {
    state = { ...state, ...next };
    emit(state);
  };

  async function fetchModel() {
    mkdirSync(dir, { recursive: true });
    const part = `${modelPath}.part`;
    const url = `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${MODEL.file}`;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`The voice model didn't download (${response.status}).`);
    const hash = createHash("sha256");
    let received = 0;
    let shown = 0;
    const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      const progress = Math.min(0.99, received / MODEL.size);
      if (progress - shown >= 0.02) {
        shown = progress;
        set({ progress });
      }
    });
    try {
      await pipeline(body, createWriteStream(part));
      if (hash.digest("hex") !== MODEL.sha256) throw new Error("The voice model download was damaged. Try again.");
      renameSync(part, modelPath);
    } catch (error) {
      rmSync(part, { force: true });
      throw error;
    }
  }

  function prepare() {
    if (state.state === "ready" || download) return state;
    set({ state: "downloading", progress: 0, error: undefined });
    download = fetchModel()
      .then(() => set({ state: "ready", progress: 1 }))
      .catch((error: unknown) => set({ state: "failed", error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        download = null;
      });
    return state;
  }

  // Loaded on first use and let go after ten idle minutes, so dictation costs nothing while it isn't used.
  function loaded(): Promise<Model> {
    clearTimeout(unloadTimer);
    unloadTimer = setTimeout(() => {
      const current = model;
      model = null;
      void current?.then((m) => m.dispose()).catch(() => {});
    }, IDLE_UNLOAD_MS);
    unloadTimer.unref();
    model ??= import("transcribe-cpp")
      .then(({ TranscribeModel }) => TranscribeModel.load(modelPath) as Promise<Model>)
      .catch((error: unknown) => {
        model = null;
        throw new Error(`Voice dictation couldn't start on this computer: ${error instanceof Error ? error.message : String(error)}`);
      });
    return model;
  }

  function recording(id: unknown) {
    const found = typeof id === "string" ? recordings.get(id) : undefined;
    if (!found) throw new Error("That recording has ended.");
    return found;
  }

  function drop(id: string) {
    const found = recordings.get(id);
    if (found) clearTimeout(found.timer);
    recordings.delete(id);
  }

  return {
    status: () => state,
    prepare,
    start() {
      if (state.state !== "ready") throw new Error("Voice dictation isn't ready yet.");
      void loaded().catch(() => {});
      // Only a few at once, and each is forgotten if the client goes quiet.
      if (recordings.size >= 4) drop(recordings.keys().next().value!);
      const recordingId = randomUUID();
      recordings.set(recordingId, { chunks: [], bytes: 0, timer: setTimeout(() => drop(recordingId), (MAX_SECONDS + 60) * 1000) });
      return { recordingId };
    },
    chunk(params: { recordingId: unknown; pcm: unknown }) {
      const found = recording(params.recordingId);
      if (typeof params.pcm !== "string" || params.pcm.length > 200_000) throw new Error("Audio chunk is too large.");
      const bytes = Buffer.from(params.pcm, "base64");
      if (found.bytes + bytes.length > RATE * 2 * MAX_SECONDS) return { ok: true as const }; // Past five minutes; keep what came first.
      found.chunks.push(bytes);
      found.bytes += bytes.length;
      return { ok: true as const };
    },
    async finish(params: { recordingId: unknown }) {
      const found = recording(params.recordingId);
      drop(params.recordingId as string);
      const all = Buffer.concat(found.chunks);
      const samples = Math.floor(all.length / 2);
      if (samples < RATE / 4) return { text: "" };
      const pcm = new Float32Array(samples);
      for (let i = 0; i < samples; i++) pcm[i] = all.readInt16LE(i * 2) / 32768;
      const result = await (await loaded()).transcribe(pcm);
      return { text: result.text.replace(/\s+/g, " ").trim() };
    },
    cancel(params: { recordingId: unknown }) {
      if (typeof params.recordingId === "string") drop(params.recordingId);
      return { ok: true as const };
    },
    close() {
      clearTimeout(unloadTimer);
      for (const id of [...recordings.keys()]) drop(id);
      void model?.then((m) => m.dispose()).catch(() => {});
    },
  };
}
