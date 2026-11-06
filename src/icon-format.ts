export const ICON_SIZE = 64;
export const ICON_MAX_BYTES = 12_000;

/** A product icon is one 64x64 WebP image (lossy, lossless or with alpha), at most 12 KB. */
export function validIcon(bytes: Uint8Array) {
  if (bytes.length < 30 || bytes.length > ICON_MAX_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, length: number) =>
    String.fromCharCode(...bytes.slice(start, start + length));
  if (
    text(0, 4) !== "RIFF" ||
    text(8, 4) !== "WEBP" ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    return false;
  const chunk = text(12, 4);
  let width = 0,
    height = 0;
  if (chunk === "VP8X") {
    if (bytes[20] & 0x02) return false; // animation flag
    width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
  } else if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
      return false;
    width = view.getUint16(26, true) & 0x3fff;
    height = view.getUint16(28, true) & 0x3fff;
  } else if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return false;
    const bits = view.getUint32(21, true);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
  } else return false;
  return width === ICON_SIZE && height === ICON_SIZE;
}
