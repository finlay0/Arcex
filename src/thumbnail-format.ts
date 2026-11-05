export const THUMBNAIL_MAX_BYTES = 20_000;

/** The owner generator emits a single lossy WebP frame, with metadata stripped. */
export function validThumbnail(bytes: Uint8Array) {
  if (bytes.length < 30 || bytes.length > THUMBNAIL_MAX_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, length: number) =>
    String.fromCharCode(...bytes.slice(start, start + length));
  if (
    text(0, 4) !== "RIFF" ||
    text(8, 4) !== "WEBP" ||
    text(12, 4) !== "VP8 " ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    return false;
  if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
    return false;
  const width = view.getUint16(26, true) & 0x3fff,
    height = view.getUint16(28, true) & 0x3fff;
  return width > 0 && width <= 160 && height > 0 && height <= 100;
}
