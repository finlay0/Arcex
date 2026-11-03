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
import { clientStackSignatures } from "../src/stack-signatures";

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
let landing;
try {
  const response = await publicFetch(url);
  landing = pageEvidence(url, response.text, response.headers);
} catch (error) {
  if (!args.includes("--browser")) throw error;
  await writeFile(
    join(directory, "http-failure.json"),
    JSON.stringify(
      {
        status: "failed",
        sourceUrl: url,
        observedAt: new Date().toISOString(),
        reason: error instanceof Error ? error.message : "HTTP capture failed",
      },
      null,
      2,
    ),
  );
}
if (landing) {
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
}
if (args.includes("--browser")) {
  const terminal = createInterface({ input: stdin, output: stdout });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const resourceUrls = new Set<string>();
  const observePage = (observed: import("playwright").Page) =>
    observed.on("request", (request) => {
      try {
        const u = new URL(request.url());
        if (u.protocol !== "https:" && u.protocol !== "http:") return;
        u.search = "";
        u.hash = "";
        u.username = "";
        u.password = "";
        if (resourceUrls.size < 1000) resourceUrls.add(u.href);
      } catch {}
    });
  observePage(page);
  context.on("page", observePage);
  // Authentication is interactive. No credentials, storage state or browser profile are persisted.
  await page.goto(url, { waitUntil: "domcontentloaded" });
  let index = 0;
  let busy = false;
  const capture = async (active: import("playwright").Page, label: string) => {
    if (busy || index >= 100 || active.isClosed()) return;
    const current = new URL(active.url()),
      targetHost = new URL(url).hostname;
    if (
      current.hostname !== targetHost &&
      !current.hostname.endsWith("." + targetHost)
    )
      return;
    current.search = "";
    current.hash = "";
    publicUrl.parse(current.toString());
    busy = true;
    try {
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
      const scripts = await active
        .locator("script[src]")
        .evaluateAll((elements) =>
          elements.map((e) => (e as HTMLScriptElement).src),
        );
      const stack = clientStackSignatures([...resourceUrls, ...scripts]);
      await writeFile(
        join(directory, name + ".json"),
        JSON.stringify(
          {
            position: index - 1,
            label: label.slice(0, 200),
            sourceUrl: current.toString(),
            observedAt: new Date().toISOString(),
            screenshot: name + ".png",
            sha256: createHash("sha256").update(image).digest("hex"),
            status: "private_unreviewed",
            annotation: null,
            clientStack: stack,
          },
          null,
          2,
        ),
      );
      console.log(`Captured ${name}. Review and redact before importing.`);
    } finally {
      busy = false;
    }
  };
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  if (args.includes("--auto")) {
    const queue = (active: import("playwright").Page, label: string) => {
      clearTimeout(captureTimer);
      captureTimer = setTimeout(() => {
        void capture(active, label).catch(() =>
          console.error("Automatic capture failed; use a manual step label"),
        );
      }, 1000);
    };
    await context.exposeBinding("__arcexCaptureStep", ({ page: active }) =>
      queue(active, "Automatic interaction capture"),
    );
    await context.addInitScript(() =>
      document.addEventListener(
        "click",
        (event) => {
          if (
            (event.target as Element)?.closest(
              "button,a,[role=button],input[type=submit]",
            )
          )
            void (
              window as unknown as { __arcexCaptureStep: () => Promise<void> }
            ).__arcexCaptureStep?.();
        },
        true,
      ),
    );
    for (const active of context.pages())
      active.on("framenavigated", (frame) => {
        if (frame === active.mainFrame())
          queue(active, "Automatic navigation capture");
      });
    context.on("page", (active) =>
      active.on("framenavigated", (frame) => {
        if (frame === active.mainFrame())
          queue(active, "Automatic navigation capture");
      }),
    );
    await page.reload({ waitUntil: "domcontentloaded" });
  }
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
      await capture(active, label);
    }
  } finally {
    clearTimeout(captureTimer);
    terminal.close();
    await context.close();
    await browser.close();
  }
}
console.log(`Capture directory: ${directory}`);
