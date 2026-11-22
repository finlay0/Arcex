import { exec } from "node:child_process";

/**
 * Which models can look at images, for agents that only say so for the agent as a whole over ACP. OpenCode lists each
 * model's inputs with `opencode models --verbose` (from models.dev), so Arcex reads that once an hour. Nothing is sent
 * to a model.
 */

let cache: { at: number; sees: Map<string, boolean> } | null = null;
let reading: Promise<Map<string, boolean>> | null = null;

function readOpenCode(): Promise<Map<string, boolean>> {
  return new Promise((resolve) => {
    exec("opencode models --verbose", { timeout: 30_000, windowsHide: true, maxBuffer: 30_000_000 }, (_error, stdout) => {
      const sees = new Map<string, boolean>();
      // Each model prints as "provider/model" on its own line, then its details as JSON ending with "}" on its own line.
      for (const match of String(stdout).matchAll(/^(\S+\/\S+)\r?\n(\{[\s\S]*?\r?\n\})/gm)) {
        try {
          const details = JSON.parse(match[2]!) as { capabilities?: { input?: { image?: unknown }; attachment?: unknown } };
          const image = details.capabilities?.input?.image;
          if (typeof image === "boolean") sees.set(match[1]!, image);
        } catch {
          // A model whose details don't parse is left unknown.
        }
      }
      resolve(sees);
    });
  });
}

/** True or false when OpenCode knows whether this model sees images, null when it doesn't say. */
export async function openCodeSeesImages(model: string | null | undefined): Promise<boolean | null> {
  if (!model) return null;
  if (!cache || Date.now() - cache.at > 60 * 60_000) {
    reading ??= readOpenCode().finally(() => (reading = null));
    const sees = await Promise.race([reading, new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000))]);
    if (!sees) return null;
    cache = { at: Date.now(), sees };
  }
  return cache.sees.get(model) ?? null;
}
