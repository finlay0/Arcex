import { readFile } from "node:fs/promises";
import { z } from "zod";
import { api, adminToken } from "./client";
import { candidateInput } from "../src/research";

const path = process.argv[2];
if (!path)
  throw new Error(
    "Usage: pnpm seed PATH_TO_RESEARCH_MANIFEST.json. The manifest must contain candidates with maker evidence; major platforms are excluded.",
  );
if (!adminToken) throw new Error("Configure an Arcex admin token");
const manifest = z
  .object({ candidates: z.array(candidateInput).min(1).max(100) })
  .strict()
  .parse(JSON.parse(await readFile(path, "utf8")));
for (const candidate of manifest.candidates) {
  const result = await api("/api/v1/admin/research/candidates", {
    method: "POST",
    token: adminToken,
    body: candidate,
  });
  console.log(JSON.stringify(result));
}
