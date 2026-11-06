import { api, collectorToken } from "./client";
import { publicFetch } from "./public-fetch";

const LIST_LIMIT = 40_000_000;

/**
 * Record today's Tranco top-1M rank for every tracked site. Runs once a day: when
 * every product already has today's row, nothing is downloaded.
 */
export async function collectTraffic() {
  if (!collectorToken) throw new Error("Collector credential required");
  const pending = await api<{
    observedOn: string;
    items: { productId: string; site: string }[];
  }>("/api/v1/collector/traffic/pending", { token: collectorToken });
  if (!pending.items.length) return { trafficRanked: 0, trafficPending: 0 };
  const listId = (
    await publicFetch(
      "https://tranco-list.eu/top-1m-id",
      100,
      undefined,
      "text/plain",
    )
  ).text.trim();
  if (!/^[A-Z0-9]{3,12}$/.test(listId))
    throw new Error("Unexpected Tranco list id");
  const csv = await publicFetch(
    `https://tranco-list.eu/download/${listId}/1000000`,
    LIST_LIMIT,
    undefined,
    "text/csv",
  );
  const wanted = new Set(pending.items.map((i) => i.site));
  const ranks = new Map<string, number>();
  for (const line of csv.text.split("\n")) {
    const comma = line.indexOf(",");
    const site = line.slice(comma + 1).trim();
    if (wanted.has(site)) ranks.set(site, Number(line.slice(0, comma)));
  }
  if (ranks.size === 0 && csv.text.length < 1_000_000)
    throw new Error("Tranco list looks empty or truncated");
  let recorded = 0;
  for (let i = 0; i < pending.items.length; i += 500) {
    const result = await api<{ recorded: number }>(
      "/api/v1/collector/traffic/ranks",
      {
        method: "POST",
        token: collectorToken,
        body: {
          listId,
          observedOn: pending.observedOn,
          ranks: pending.items.slice(i, i + 500).map((item) => ({
            productId: item.productId,
            site: item.site,
            rank: ranks.get(item.site) ?? null,
          })),
        },
      },
    );
    recorded += result.recorded;
  }
  return { trafficRanked: ranks.size, trafficRecorded: recorded };
}
