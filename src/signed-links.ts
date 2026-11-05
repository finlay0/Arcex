import type { Bindings } from "./types";
const MEDIA_LINK_SECONDS = 900;
async function mediaKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** A short-lived link to an approved image. Only issued to viewers allowed to see it. */
export async function signedLinkParameters(
  env: Bindings,
  scope: string,
  seconds = MEDIA_LINK_SECONDS,
) {
  if (!env.MEDIA_SIGNING_SECRET) return null;
  const expires = Math.floor(Date.now() / 1000) + seconds;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await mediaKey(env.MEDIA_SIGNING_SECRET),
    new TextEncoder().encode(`${scope}.${expires}`),
  );
  const hex = [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `expires=${expires}&signature=${hex}`;
}

export async function signedMediaUrl(env: Bindings, assetId: string) {
  const parameters = await signedLinkParameters(env, `media:${assetId}`);
  return parameters
    ? `/api/v1/media/${encodeURIComponent(assetId)}?${parameters}`
    : null;
}

export async function signedLinkValid(
  env: Bindings,
  scope: string,
  expires?: string,
  signature?: string,
) {
  if (
    !env.MEDIA_SIGNING_SECRET ||
    !expires ||
    !/^\d{1,12}$/.test(expires) ||
    !signature ||
    !/^[0-9a-f]{64}$/.test(signature) ||
    Number(expires) < Date.now() / 1000
  )
    return false;
  const bytes = Uint8Array.from(signature.match(/../g)!, (h) =>
    parseInt(h, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    await mediaKey(env.MEDIA_SIGNING_SECRET),
    bytes,
    new TextEncoder().encode(`${scope}.${expires}`),
  );
}

export async function mediaLinkValid(
  env: Bindings,
  assetId: string,
  expires?: string,
  signature?: string,
) {
  return signedLinkValid(env, `media:${assetId}`, expires, signature);
}
