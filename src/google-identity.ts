import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { fail, secretsEqual, sha256 } from "./lib";

// Only public signing keys are cached. Tokens and profile data stay request-scoped.
const keys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
export const googleNonce = (verifier: string) =>
  sha256("arcex-google:" + verifier);
export async function googleIdentity(
  token: string,
  clientId: string,
  verifier: string,
) {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
      algorithms: ["RS256"],
      clockTolerance: 30,
      requiredClaims: ["sub", "iat", "exp", "nonce", "email", "email_verified"],
    });
    if (
      (payload.azp && payload.azp !== clientId) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== clientId) ||
      typeof payload.nonce !== "string" ||
      !(await secretsEqual(payload.nonce, await googleNonce(verifier)))
    )
      fail(401, "Google identity verification failed");
    return z
      .object({
        sub: z.string().min(1).max(255),
        email: z.email(),
        email_verified: z.literal(true),
        name: z.string().max(200).optional(),
        picture: z.url().optional(),
      })
      .parse(payload);
  } catch {
    // No token, provider response or claim value is included in the error.
    fail(401, "Google identity verification failed");
  }
}

export function safeReturnTo(value: string | undefined, origin: string) {
  const path = value ?? "/";
  if (
    path.length > 1500 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\\r\n]/.test(path)
  )
    fail(422, "Return path must stay on Arcex");
  const url = new URL(path, origin);
  if (url.origin !== new URL(origin).origin)
    fail(422, "Return path must stay on Arcex");
  return url.pathname + url.search + url.hash;
}
