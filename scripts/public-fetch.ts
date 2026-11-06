import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { publicUrl, siteOf } from "../src/contracts";

export function publicAddress(ip: string) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return (
      /^[23][a-f0-9]{3}:/.test(lower) &&
      !lower.startsWith("2001:db8:") &&
      !lower.startsWith("2002:") &&
      !lower.startsWith("2001:0:")
    );
  }
  return false;
}
export class SourceHttpError extends Error {
  constructor(
    public status: number,
    public location?: string | null,
  ) {
    super(
      `Source returned HTTP ${status}; redirects and access challenges require review`,
    );
  }
}
/**
 * Follow at most three redirects, re-validating every hop as a public HTTPS URL.
 * With sameSite, a redirect to another site still fails: a moved domain needs review.
 */
export async function fetchFollow(
  raw: string,
  maximum: number,
  options: {
    accept?: string;
    validators?: { etag: string | null; lastModified: string | null };
    sameSite?: boolean;
  } = {},
) {
  let url = raw;
  for (let hop = 0; ; hop++) {
    try {
      const result = await publicFetch(
        url,
        maximum,
        options.validators,
        options.accept,
      );
      return { ...result, url };
    } catch (error) {
      if (
        hop < 3 &&
        error instanceof SourceHttpError &&
        [301, 302, 303, 307, 308].includes(error.status) &&
        error.location
      ) {
        const next = publicUrl.parse(new URL(error.location, url).href);
        if (
          options.sameSite &&
          siteOf(new URL(next).hostname) !== siteOf(new URL(raw).hostname)
        )
          throw error;
        url = next;
        continue;
      }
      throw error;
    }
  }
}

export async function publicFetch(
  raw: string,
  maximum = 1_000_000,
  validators?: { etag: string | null; lastModified: string | null },
  accept = "text/html, application/rss+xml, application/atom+xml, application/xml, text/xml",
) {
  const url = new URL(publicUrl.parse(raw));
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error("Source resolved to a private or reserved address");
  const address = addresses[0];
  // Pin the checked address to this TLS connection; a second DNS lookup cannot rebind to private hosts.
  return new Promise<{
    text: string;
    body: Buffer;
    headers: Record<string, string>;
    contentType: string;
    status: 200 | 304;
    httpCache: { etag: string | null; lastModified: string | null };
  }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: {
          "user-agent": "ArcexInspector/0.1 (+https://arcex.dev)",
          ...(validators?.etag ? { "if-none-match": validators.etag } : {}),
          ...(validators?.lastModified
            ? { "if-modified-since": validators.lastModified }
            : {}),
          accept,
        },
        family: address.family,
        lookup: (_host, _options, cb) =>
          cb(null, address.address, address.family),
      },
      (res) => {
        const safeHeader = (name: string, max: number) => {
          const value = res.headers[name];
          return typeof value === "string" &&
            value.length <= max &&
            !/[\r\n]/.test(value)
            ? value
            : null;
        };
        const httpCache = {
          etag: safeHeader("etag", 1000),
          lastModified: safeHeader("last-modified", 200),
        };
        if (
          res.statusCode === 304 &&
          (validators?.etag || validators?.lastModified)
        ) {
          res.resume();
          resolve({
            status: 304,
            text: "",
            body: Buffer.alloc(0),
            headers: {},
            contentType: "",
            httpCache,
          });
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new SourceHttpError(
              res.statusCode ?? 0,
              safeHeader("location", 2000),
            ),
          );
          return;
        }
        const encoding = res.headers["content-encoding"];
        if (encoding && encoding !== "identity") {
          res.resume();
          reject(new Error("Unexpected encoded response"));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maximum) {
            res.destroy(new Error("Source exceeds size limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: 200,
            httpCache,
            body,
            text: body.toString("utf8"),
            contentType: res.headers["content-type"] ?? "",
            headers: Object.fromEntries(
              ["server", "x-powered-by", "content-type"]
                .filter((k) => typeof res.headers[k] === "string")
                .map((k) => [k, res.headers[k] as string]),
            ),
          });
        });
      },
    );
    req.setTimeout(20000, () => req.destroy(new Error("Source timed out")));
    req.on("error", reject);
    req.end();
  });
}
