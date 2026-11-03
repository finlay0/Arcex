export function clientStackSignatures(urls: string[]) {
  const found = new Map<
    string,
    { technology: string; observation: string; host: string }
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
    const add = (technology: string, observation: string) =>
      found.set(technology + ":" + host, { technology, observation, host });
    if (url.pathname.startsWith("/_next/static/"))
      add("Next.js", "Client asset path /_next/static/ observed");
    if (
      host.endsWith(".clerk.accounts.dev") ||
      host.endsWith(".clerk.com") ||
      host === "clerk.com"
    )
      add("Clerk", "Clerk client endpoint observed");
    if (host.endsWith(".supabase.co"))
      add(
        "Supabase",
        "Supabase endpoint observed; this does not establish the application's database design",
      );
    if (
      ["js.stripe.com", "checkout.stripe.com", "billing.stripe.com"].includes(
        host,
      )
    )
      add("Stripe", "Stripe client or hosted payment endpoint observed");
    if (host === "posthog.com" || host.endsWith(".posthog.com"))
      add("PostHog", "PostHog client endpoint observed");
    if (host === "plausible.io")
      add("Plausible", "Plausible client endpoint observed");
  }
  return {
    signatures: [...found.values()],
    scope:
      "Observed client-side asset/endpoint signatures only. No request headers, bodies, query parameters, cookies or server implementation claims are stored.",
  };
}
