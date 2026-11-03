import { api, adminToken } from "./client";

if (!adminToken) throw new Error("Configure ADMIN_TOKEN or ARCEX_ADMIN_TOKEN");
const candidates = [
  {
    slug: "cursor",
    name: "Cursor",
    url: "https://cursor.com",
    description:
      "AI code editor. Research candidate; commercial flow has not been reviewed.",
    category: "coding_dev",
  },
  {
    slug: "lovable",
    name: "Lovable",
    url: "https://lovable.dev",
    description:
      "AI app builder. Research candidate; commercial flow has not been reviewed.",
    category: "coding_dev",
  },
  {
    slug: "bolt",
    name: "Bolt",
    url: "https://bolt.new",
    description:
      "AI app builder. Research candidate; commercial flow has not been reviewed.",
    category: "coding_dev",
  },
  {
    slug: "v0",
    name: "v0",
    url: "https://v0.app",
    description:
      "AI app builder. Research candidate; commercial flow has not been reviewed.",
    category: "coding_dev",
  },
  {
    slug: "replit",
    name: "Replit",
    url: "https://replit.com",
    description:
      "Cloud development platform. Research candidate; commercial flow has not been reviewed.",
    category: "coding_dev",
  },
];
const existing = await api<{ items: { id: string; slug: string }[] }>(
  "/api/v1/admin/products?limit=100",
  { token: adminToken },
);
const sources = await api<{ items: { url: string }[] }>(
  "/api/v1/admin/sources?limit=100",
  { token: adminToken },
);
for (const candidate of candidates) {
  const product =
    existing.items.find((p) => p.slug === candidate.slug) ??
    (await api<{ id: string }>("/api/v1/admin/products", {
      method: "POST",
      token: adminToken,
      body: { ...candidate, monetization: "unknown" },
    }));
  if (!sources.items.some((s) => s.url === candidate.url))
    await api("/api/v1/admin/sources", {
      method: "POST",
      token: adminToken,
      body: {
        productId: product.id,
        name: candidate.name + " public page",
        url: candidate.url,
        kind: "public_page",
        enabled: true,
        intervalHours: 24,
      },
    });
  console.log(
    JSON.stringify({ slug: candidate.slug, id: product.id, status: "draft" }),
  );
}
console.log(
  await api("/api/v1/admin/jobs/enqueue", {
    method: "POST",
    token: adminToken,
  }),
);
