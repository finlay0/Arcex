type Rule = {
  technology: string;
  category:
    | "framework"
    | "site_builder"
    | "payments"
    | "analytics"
    | "ad_pixel"
    | "support"
    | "auth"
    | "backend"
    | "marketing";
  hosts?: string[];
  path?: string;
};

// A host rule matches the exact host or a subdomain of it, never a lookalike.
const RULES: Rule[] = [
  { technology: "Next.js", category: "framework", path: "/_next/static/" },
  { technology: "Nuxt", category: "framework", path: "/_nuxt/" },
  { technology: "Astro", category: "framework", path: "/_astro/" },
  { technology: "SvelteKit", category: "framework", path: "/_app/immutable/" },
  {
    technology: "Framer",
    category: "site_builder",
    hosts: ["framerusercontent.com", "framer.com"],
  },
  {
    technology: "Webflow",
    category: "site_builder",
    hosts: ["website-files.com", "webflow.com"],
  },
  {
    technology: "Wix",
    category: "site_builder",
    hosts: ["wixstatic.com", "parastorage.com"],
  },
  {
    technology: "Squarespace",
    category: "site_builder",
    hosts: ["squarespace.com", "squarespace-cdn.com"],
  },
  { technology: "WordPress", category: "site_builder", path: "/wp-content/" },
  {
    technology: "Shopify",
    category: "site_builder",
    hosts: ["cdn.shopify.com"],
  },
  { technology: "Lovable", category: "site_builder", hosts: ["cdn.gpteng.co"] },
  {
    technology: "Stripe",
    category: "payments",
    hosts: [
      "js.stripe.com",
      "checkout.stripe.com",
      "billing.stripe.com",
      "buy.stripe.com",
    ],
  },
  { technology: "Paddle", category: "payments", hosts: ["cdn.paddle.com"] },
  {
    technology: "Lemon Squeezy",
    category: "payments",
    hosts: ["assets.lemonsqueezy.com", "app.lemonsqueezy.com"],
  },
  {
    technology: "Chargebee",
    category: "payments",
    hosts: ["js.chargebee.com"],
  },
  {
    technology: "Google Tag Manager",
    category: "analytics",
    hosts: ["googletagmanager.com"],
  },
  { technology: "PostHog", category: "analytics", hosts: ["posthog.com"] },
  { technology: "Plausible", category: "analytics", hosts: ["plausible.io"] },
  {
    technology: "Mixpanel",
    category: "analytics",
    hosts: ["cdn.mxpnl.com", "mixpanel.com"],
  },
  { technology: "Segment", category: "analytics", hosts: ["cdn.segment.com"] },
  {
    technology: "Amplitude",
    category: "analytics",
    hosts: ["cdn.amplitude.com"],
  },
  { technology: "Hotjar", category: "analytics", hosts: ["static.hotjar.com"] },
  {
    technology: "Microsoft Clarity",
    category: "analytics",
    hosts: ["clarity.ms"],
  },
  {
    technology: "Meta Pixel",
    category: "ad_pixel",
    hosts: ["connect.facebook.net"],
  },
  {
    technology: "TikTok Pixel",
    category: "ad_pixel",
    hosts: ["analytics.tiktok.com"],
  },
  {
    technology: "LinkedIn Insight",
    category: "ad_pixel",
    hosts: ["snap.licdn.com"],
  },
  {
    technology: "Reddit Pixel",
    category: "ad_pixel",
    hosts: ["redditstatic.com"],
  },
  {
    technology: "X Pixel",
    category: "ad_pixel",
    hosts: ["static.ads-twitter.com"],
  },
  {
    technology: "Google Ads",
    category: "ad_pixel",
    hosts: ["googleadservices.com"],
  },
  {
    technology: "Intercom",
    category: "support",
    hosts: ["widget.intercom.io", "js.intercomcdn.com"],
  },
  { technology: "Crisp", category: "support", hosts: ["client.crisp.chat"] },
  {
    technology: "Zendesk",
    category: "support",
    hosts: ["static.zdassets.com"],
  },
  {
    technology: "HubSpot",
    category: "marketing",
    hosts: ["js.hs-scripts.com", "js.hsforms.net"],
  },
  { technology: "Rewardful", category: "marketing", hosts: ["r.wdfl.co"] },
  {
    technology: "Clerk",
    category: "auth",
    hosts: ["clerk.accounts.dev", "clerk.com"],
  },
  { technology: "Auth0", category: "auth", hosts: ["auth0.com"] },
  { technology: "Supabase", category: "backend", hosts: ["supabase.co"] },
  {
    technology: "Firebase",
    category: "backend",
    hosts: ["firebaseapp.com", "firebaseio.com"],
  },
];

export function clientStackSignatures(urls: string[]) {
  const found = new Map<
    string,
    { technology: string; category: string; observation: string; host: string }
  >();
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const host = url.hostname.toLowerCase();
    for (const rule of RULES) {
      const byHost = rule.hosts?.some(
        (h) => host === h || host.endsWith("." + h),
      );
      const byPath = rule.path && url.pathname.startsWith(rule.path);
      if (!byHost && !byPath) continue;
      found.set(rule.technology + ":" + host, {
        technology: rule.technology,
        category: rule.category,
        observation: byPath
          ? `Client asset path ${rule.path} observed`
          : `${rule.technology} client endpoint observed`,
        host,
      });
    }
  }
  return {
    signatures: [...found.values()],
    scope:
      "Observed client-side asset/endpoint signatures only. No request headers, bodies, query parameters, cookies or server implementation claims are stored.",
  };
}

/** Technologies visible in a public HTML page's script/link/iframe/img URLs. */
export function htmlStack(html: string, pageUrl: string) {
  const urls: string[] = [];
  for (const m of html.matchAll(
    /<(?:script|link|iframe|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']{1,2000})["']/gi,
  )) {
    try {
      urls.push(new URL(m[1], pageUrl).href);
    } catch {
      // Ignore malformed URLs.
    }
  }
  const byTechnology = new Map<
    string,
    { technology: string; category: string }
  >();
  for (const s of clientStackSignatures(urls.slice(0, 500)).signatures)
    byTechnology.set(s.technology, {
      technology: s.technology,
      category: s.category,
    });
  return [...byTechnology.values()].sort((a, b) =>
    a.technology.localeCompare(b.technology),
  );
}
