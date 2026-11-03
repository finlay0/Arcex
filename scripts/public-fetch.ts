import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { publicUrl } from "../src/contracts";

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
export async function publicFetch(raw: string, maximum = 1_000_000) {
  const url = new URL(publicUrl.parse(raw));
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error("Source resolved to a private or reserved address");
  const address = addresses[0];
  // Pin the checked address to this TLS connection; a second DNS lookup cannot rebind to private hosts.
  return new Promise<{
    text: string;
    headers: Record<string, string>;
    contentType: string;
  }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: {
          "user-agent": "ArcexInspector/0.1 (+https://arcex.dev)",
          accept:
            "text/html, application/rss+xml, application/atom+xml, application/xml, text/xml",
        },
        family: address.family,
        lookup: (_host, _options, cb) =>
          cb(null, address.address, address.family),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new Error(
              `Source returned HTTP ${res.statusCode}; redirects and access challenges require review`,
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
        res.on("end", () =>
          resolve({
            text: Buffer.concat(chunks).toString("utf8"),
            contentType: res.headers["content-type"] ?? "",
            headers: Object.fromEntries(
              ["server", "x-powered-by", "content-type"]
                .filter((k) => typeof res.headers[k] === "string")
                .map((k) => [k, res.headers[k] as string]),
            ),
          }),
        );
      },
    );
    req.setTimeout(20000, () => req.destroy(new Error("Source timed out")));
    req.on("error", reject);
    req.end();
  });
}
