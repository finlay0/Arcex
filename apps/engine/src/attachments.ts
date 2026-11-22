// Files the user attaches to a message. The engine keeps its own copy, so a queued or resent message still has them.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import type { Attachment } from "@arcex/contracts";

export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_PER_MESSAGE = 10;
/** Text files up to this size go to the agent inline. Bigger ones, and binary files, go as a path it can read. */
const INLINE_TEXT = 256 * 1024;
/** Images an agent can look at. Others (SVG, HEIC) are sent as files. Also the only types served back for thumbnails. */
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ID = /^[0-9a-f-]{36}$/;

export type PromptCapabilities = { image?: boolean; embeddedContext?: boolean } | undefined;

export function createAttachments(dataDir: string) {
  const dir = path.join(dataDir, "attachments");
  mkdirSync(dir, { recursive: true });
  // Each file keeps its own name inside a folder named by its id, so agents see a real file name and extension.
  const fileOf = (attachment: Attachment) => path.join(dir, attachment.id, attachment.name);
  const metaOf = (id: string) => path.join(dir, `${id}.json`);

  function get(id: unknown): Attachment {
    if (typeof id !== "string" || !ID.test(id) || !existsSync(metaOf(id))) throw new Error("an attached file is missing. Attach it again");
    return JSON.parse(readFileSync(metaOf(id), "utf8")) as Attachment;
  }

  return {
    dir,
    add(params: { name: unknown; mime: unknown; data: unknown }): Attachment {
      if (typeof params.data !== "string") throw new Error("the file could not be read");
      const bytes = Buffer.from(params.data, "base64");
      if (!bytes.length) throw new Error("that file is empty");
      if (bytes.length > MAX_BYTES) throw new Error("files can be up to 10 MB");
      const name = (typeof params.name === "string" ? path.basename(params.name) : "").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 200) || "pasted file";
      const mime = typeof params.mime === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(params.mime) ? params.mime.toLowerCase() : "application/octet-stream";
      const attachment: Attachment = { id: randomUUID(), name, mime, size: bytes.length, image: IMAGE_TYPES.has(mime) };
      mkdirSync(path.join(dir, attachment.id));
      writeFileSync(fileOf(attachment), bytes);
      writeFileSync(metaOf(attachment.id), JSON.stringify(attachment));
      return attachment;
    },
    /** Checks a message's attachment ids and returns what they point to. */
    resolve(ids: unknown): Attachment[] {
      if (ids === undefined || ids === null) return [];
      if (!Array.isArray(ids)) throw new Error("invalid attachments");
      if (ids.length > MAX_PER_MESSAGE) throw new Error(`a message can carry up to ${MAX_PER_MESSAGE} files`);
      return [...new Set(ids)].map(get);
    },
    /** The image bytes for a thumbnail, or null for anything that is not a safe image. */
    image(id: string): { mime: string; bytes: Buffer } | null {
      try {
        const attachment = get(id);
        return attachment.image ? { mime: attachment.mime, bytes: readFileSync(fileOf(attachment)) } : null;
      } catch {
        return null;
      }
    },
    /** The message as ACP content blocks, shaped to what the agent says it accepts. */
    blocks(text: string, attachments: Attachment[], caps: PromptCapabilities): acp.ContentBlock[] {
      const blocks: acp.ContentBlock[] = [];
      if (text) blocks.push({ type: "text", text });
      for (const attachment of attachments) {
        const file = fileOf(attachment);
        const uri = pathToFileURL(file).href;
        if (attachment.image && caps?.image) {
          blocks.push({ type: "image", mimeType: attachment.mime, data: readFileSync(file).toString("base64") });
          continue;
        }
        if (!attachment.image && caps?.embeddedContext && attachment.size <= INLINE_TEXT) {
          const bytes = readFileSync(file);
          if (!bytes.includes(0)) {
            const body = bytes.toString("utf8");
            if (!body.includes("\uFFFD")) {
              blocks.push({ type: "resource", resource: { uri, mimeType: attachment.mime, text: body } });
              continue;
            }
          }
        }
        // Every agent accepts a link. It names the stored copy, which the agent can open with its own tools.
        blocks.push({ type: "resource_link", uri, name: attachment.name, mimeType: attachment.mime, size: attachment.size });
      }
      if (!text) blocks.unshift({ type: "text", text: attachments.length === 1 ? "See the attached file." : "See the attached files." });
      return blocks;
    },
  };
}

export type Attachments = ReturnType<typeof createAttachments>;
