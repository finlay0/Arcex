import sharp from "sharp";

export async function makeThumbnail(input: Uint8Array) {
  return sharp(input, { limitInputPixels: 16_777_216, animated: false })
    .rotate()
    .resize(160, 100, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#101010" })
    .blur(1.5)
    .webp({ quality: 35, effort: 4 })
    .toBuffer();
}
