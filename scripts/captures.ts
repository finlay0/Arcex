import { chromium, devices, type Browser, type Page } from "playwright";
import sharp from "sharp";
import { api, collectorToken } from "./client";
import { publicUrl, siteOf } from "../src/contracts";

const MAX_BYTES = 150_000;
const PRICING_PATH =
  /\/(pricing|plans|price|prices|upgrade|premium|subscribe)(\/|$|\?|#)/i;
const BOT_CHECK =
  /just a moment|attention required|access denied|verify you are human|are you a robot|checking your browser|captcha/i;
// Hide consent banners instead of clicking them: no consent is given on anyone's behalf.
const HIDE_BANNERS = `#onetrust-banner-sdk,#onetrust-consent-sdk,#CybotCookiebotDialog,.cky-consent-container,
  #usercentrics-root,.osano-cm-window,#hs-eu-cookie-confirmation,.cc-window,.cookie-banner,#cookie-banner,
  [id*="cookie-consent" i],[class*="cookie-consent" i],[aria-label*="cookie" i][role="dialog"]{display:none!important}`;

type Viewport = "desktop" | "mobile";

async function toWebp(png: Buffer) {
  for (const quality of [72, 60, 48, 36]) {
    const out = await sharp(png).webp({ quality }).toBuffer();
    if (out.byteLength <= MAX_BYTES) return out;
  }
  // Very busy pages: shrink rather than store an oversized file.
  return sharp(png)
    .resize({ width: 1080, withoutEnlargement: true })
    .webp({ quality: 40 })
    .toBuffer();
}

async function open(page: Page, url: string) {
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 25_000,
  });
  await page.waitForTimeout(2500);
  await page.addStyleTag({ content: HIDE_BANNERS }).catch(() => undefined);
  const title = (await page.title()).slice(0, 300);
  if (!response || response.status() >= 400)
    throw new Error(`HTTP ${response?.status() ?? "no response"}`);
  if (BOT_CHECK.test(title)) throw new Error("Bot check page");
  const finalUrl = publicUrl.parse(page.url());
  if (
    siteOf(new URL(finalUrl).hostname.replace(/^www\./, "")) !==
    siteOf(new URL(url).hostname.replace(/^www\./, ""))
  )
    throw new Error("Redirected to another site");
  return { title, finalUrl };
}

async function pricingLink(page: Page) {
  const links = await page.$$eval("a[href]", (as) =>
    as.map((a) => (a as HTMLAnchorElement).href).slice(0, 400),
  );
  const home = new URL(page.url());
  return links.find((href) => {
    try {
      const u = new URL(href);
      return (
        siteOf(u.hostname.replace(/^www\./, "")) ===
          siteOf(home.hostname.replace(/^www\./, "")) &&
        PRICING_PATH.test(u.pathname + "/")
      );
    } catch {
      return false;
    }
  });
}

async function captureProduct(
  browser: Browser,
  product: { id: string; url: string },
) {
  let captured = 0,
    pricing: string | undefined,
    reason: string | undefined;
  for (const viewport of ["desktop", "mobile"] as Viewport[]) {
    const context = await browser.newContext(
      viewport === "desktop"
        ? { viewport: { width: 1440, height: 900 }, locale: "en-US" }
        : {
            ...devices["iPhone 13"],
            viewport: { width: 390, height: 844 },
            locale: "en-US",
          },
    );
    // Nothing is downloaded, and no service worker or permission prompt runs.
    await context.route("**/*", (route) =>
      route.request().resourceType() === "media"
        ? route.abort()
        : route.continue(),
    );
    const page = await context.newPage();
    try {
      for (const target of ["home", "pricing"] as const) {
        const url = target === "home" ? product.url : pricing;
        if (!url) continue;
        let opened: Awaited<ReturnType<typeof open>>;
        try {
          opened = await open(page, url);
        } catch (error) {
          // Keep what was captured; a blocked page is reported, not retried in a loop.
          reason ??= `${target} ${viewport}: ${(error as Error).message.split("\n")[0]}`;
          if (target === "home") break;
          continue;
        }
        const { title, finalUrl } = opened;
        if (target === "home" && viewport === "desktop")
          pricing = await pricingLink(page);
        const png = await page.screenshot({ type: "png", fullPage: false });
        const webp = await toWebp(png);
        await api(`/api/v1/collector/captures/${product.id}`, {
          method: "POST",
          token: collectorToken,
          body: {
            page: target,
            viewport,
            sourceUrl: finalUrl,
            observedAt: new Date().toISOString(),
            title,
            data: webp.toString("base64"),
          },
        });
        captured++;
      }
    } finally {
      await context.close();
    }
  }
  return { captured, reason };
}

export async function captureScreens(limit: number) {
  if (!collectorToken) throw new Error("Collector credential required");
  const { items } = await api<{ items: { id: string; url: string }[] }>(
    `/api/v1/collector/captures/pending?limit=${limit}`,
    { token: collectorToken },
  );
  const browser = await chromium.launch();
  let ok = 0,
    failed = 0,
    images = 0;
  try {
    for (const product of items) {
      let captured = 0,
        reason: string | undefined;
      try {
        ({ captured, reason } = await captureProduct(browser, product));
      } catch (error) {
        reason = (error as Error).message.split("\n")[0];
      }
      reason = reason?.slice(0, 300);
      images += captured;
      // Partial captures still count; the product is retried only if nothing was saved.
      const status = captured ? "ok" : "failed";
      status === "ok" ? ok++ : failed++;
      await api(`/api/v1/collector/captures/${product.id}/check`, {
        method: "POST",
        token: collectorToken,
        body: { status, captured, ...(reason ? { reason } : {}) },
      });
      console.log(JSON.stringify({ productId: product.id, captured, reason }));
    }
  } finally {
    await browser.close();
  }
  return { products: items.length, ok, failed, images };
}

const limit = Number(process.env.CAPTURE_LIMIT ?? 20);
if (!Number.isInteger(limit) || limit < 1 || limit > 60)
  throw new Error("Capture limit must be 1–60");
console.log(JSON.stringify(await captureScreens(limit)));
