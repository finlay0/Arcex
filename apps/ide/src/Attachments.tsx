// Files attached to the message being written: paste, drop or pick them, see them as chips, remove before sending.
import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import type { Attachment } from "@arcex/contracts";
import { call } from "./store.ts";
import { Icon } from "./shared.tsx";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
/** The engine serves thumbnails. In development the client runs on its own server. */
const engineBase = import.meta.env.DEV ? "http://127.0.0.1:4517" : "";
export const thumbOf = (attachment: Attachment) => `${engineBase}/attachments/${attachment.id}`;

function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error(`couldn't read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

const sizeOf = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Attachments per draft (a thread, or a project's new-thread box), so switching threads keeps each one's files. */
export function useAttachments(key: string, fail: (error: unknown) => void) {
  const [byKey, setByKey] = useState<Record<string, Attachment[]>>({});
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const list = byKey[key] ?? [];
  const set = (next: Attachment[] | ((current: Attachment[]) => Attachment[]), at = key) =>
    setByKey((all) => ({ ...all, [at]: typeof next === "function" ? next(all[at] ?? []) : next }));

  async function add(files: File[]) {
    if (!files.length) return;
    const at = key;
    const room = MAX_FILES - list.length - uploading;
    if (room <= 0) return fail(`A message can carry up to ${MAX_FILES} files.`);
    const picked = files.slice(0, room);
    if (files.length > room) fail(`Only ${room} more ${room === 1 ? "file fits" : "files fit"} in this message.`);
    setUploading((count) => count + picked.length);
    for (const file of picked) {
      try {
        if (file.size > MAX_BYTES) throw new Error(`${file.name || "That file"} is over 10 MB.`);
        const data = await base64Of(file);
        const attachment = await call("attachment.add", { name: file.name || "pasted image.png", mime: file.type || "application/octet-stream", data });
        set((current) => [...current, attachment], at);
      } catch (error) {
        fail(error);
      } finally {
        setUploading((count) => count - 1);
      }
    }
  }

  const onPaste = (event: ClipboardEvent) => {
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    event.preventDefault();
    void add(files);
  };
  const dropProps = {
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      setDragging(false);
      void add([...event.dataTransfer.files]);
    },
  };

  const button = (disabled: boolean) => (
    <>
      <button className="icon" type="button" title="Attach files" aria-label="Attach files" disabled={disabled} onClick={() => picker.current?.click()}>
        <Icon name="clip" />
      </button>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void add([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
    </>
  );

  const chips = list.length || uploading ? (
    <ul className="attached" aria-label="Attached files">
      {list.map((attachment) => (
        <li key={attachment.id}>
          <AttachmentChip attachment={attachment} />
          <button className="qbtn" title="Remove" aria-label={`Remove ${attachment.name}`} onClick={() => set((current) => current.filter((entry) => entry.id !== attachment.id))}>
            <Icon name="x" />
          </button>
        </li>
      ))}
      {uploading > 0 && <li className="busy">Attaching {uploading === 1 ? "a file" : `${uploading} files`}…</li>}
    </ul>
  ) : null;

  return { list, uploading: uploading > 0, dragging, add, set, clear: () => set([]), onPaste, dropProps, button, chips };
}

/** A thumbnail for an image, or the file's name and size. */
export function AttachmentChip({ attachment }: { attachment: Attachment }) {
  return attachment.image ? (
    <img className="thumb" src={thumbOf(attachment)} alt={attachment.name} title={attachment.name} />
  ) : (
    <span className="fchip" title={attachment.name}>
      <Icon name="file" />
      <span className="fname">{attachment.name}</span>
      <span className="fsize">{sizeOf(attachment.size)}</span>
    </span>
  );
}
