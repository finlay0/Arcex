import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chromium } from "playwright";
import { api, adminToken } from "./client";
import { publicUrl } from "../src/contracts";
import { publicFetch } from "./public-fetch";
import { pageEvidence } from "./collector";

const args = process.argv.slice(2),
  target = args.find((a) => !a.startsWith("--"));
if (!target)
  throw new Error(
    "Usage: pnpm inspect https://target.tld [--browser] [--import] [--product=ID]",
  );
const url = publicUrl.parse(target),
  productId = args.find((a) => a.startsWith("--product="))?.slice(10);
const directory = resolve(
  "captures",
  new Date().toISOString().replaceAll(":", "-") + "-" + new URL(url).hostname,
);
await mkdir(directory, { recursive: true });
const response = await publicFetch(url),
  landing = pageEvidence(url, response.text, response.headers);
await writeFile(
  join(directory, "landing.json"),
  JSON.stringify(landing, null, 2),
);
if (args.includes("--import")) {
  if (!adminToken || !productId)
    throw new Error("--import requires an admin token and --product=ID");
  const result = await api("/api/v1/admin/evidence", {
    method: "POST",
    token: adminToken,
    body: { ...landing, productId },
  });
  console.log(JSON.stringify(result));
}
if (args.includes("--browser")) {
  const terminal = createInterface({ input: stdin, output: stdout });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  // Authentication is interactive. No credentials, storage state or browser profile are persisted.
  await page.goto(url, { waitUntil: "domcontentloaded" });
  let index = 0;
  console.log(
    "Private capture session. Screenshots may contain personal information. Review locally before any upload.",
  );
  try {
    for (;;) {
      const label = await terminal.question(
        "Navigate manually, then enter a step label to capture (or q to finish): ",
      );
      if (label.trim().toLowerCase() === "q") break;
      if (!label.trim()) continue;
      const active =
        context
          .pages()
          .filter((p) => !p.isClosed())
          .at(-1) ?? page;
      const current = new URL(active.url());
      current.search = "";
      current.hash = "";
      publicUrl.parse(current.toString());
      const name = String(index++).padStart(3, "0");
      const image = await active.screenshot({
        path: join(directory, name + ".png"),
        fullPage: false,
        mask: [
          active.locator(
            'input, textarea, [contenteditable="true"], [data-private]',
          ),
        ],
      });
      const snapshot = {
        position: index - 1,
        label: label.slice(0, 200),
        sourceUrl: current.toString(),
        observedAt: new Date().toISOString(),
        screenshot: name + ".png",
        sha256: createHash("sha256").update(image).digest("hex"),
        status: "private_unreviewed",
        annotation: null,
      };
      await writeFile(
        join(directory, name + ".json"),
        JSON.stringify(snapshot, null, 2),
      );
      console.log(`Captured ${name}. Review and redact before importing.`);
    }
  } finally {
    terminal.close();
    await context.close();
    await browser.close();
  }
}
console.log(`Capture directory: ${directory}`);
