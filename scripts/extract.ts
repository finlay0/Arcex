import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";
import "./client";
import {
  extractionSchema,
  extractionInstructions,
  parseModelResponse,
} from "../src/extraction";

const target = process.argv[2];
if (!target)
  throw new Error("Usage: pnpm extract captures/DIRECTORY [--prepare-only]");
const directory = resolve(target),
  files = (await readdir(directory))
    .filter((f) => /^(landing|\d{3})\.json$/.test(f))
    .sort();
if (!files.length) throw new Error("No Inspector captures found");
if (files.length > 20)
  throw new Error("Split captures into batches of at most 20");
const schema = z.toJSONSchema(extractionSchema);
const content: (
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "high" }
)[] = [];
for (const file of files) {
  const path = join(directory, file);
  if ((await stat(path)).size > 100_000)
    throw new Error("Capture metadata exceeds size limit");
  const capture = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  content.push({
    type: "input_text",
    text: JSON.stringify({ capture: file, metadata: capture }),
  });
  const image = file.replace(".json", ".png");
  if (files.includes(file) && /^\d{3}\.json$/.test(file)) {
    const imagePath = join(directory, image);
    if ((await stat(imagePath)).size > 5_000_000)
      throw new Error("Image exceeds 5 MB");
    content.push({
      type: "input_image",
      image_url:
        "data:image/png;base64," +
        (await readFile(imagePath)).toString("base64"),
      detail: "high",
    });
  }
}
await writeFile(
  join(directory, "analysis.schema.json"),
  JSON.stringify(schema, null, 2),
);
await writeFile(
  join(directory, "analysis-prompt.md"),
  extractionInstructions +
    "\n\n" +
    content
      .filter((c) => c.type === "input_text")
      .map((c) => c.text)
      .join("\n\n"),
);
if (process.argv.includes("--prepare-only"))
  console.log(
    "Prepared analysis-prompt.md and analysis.schema.json for a GPT-6.1 Terra medium app run. Save its structured result as analysis.json.",
  );
else {
  const key = process.env.OPENAI_API_KEY;
  if (!key)
    throw new Error(
      "No OPENAI_API_KEY configured. Use --prepare-only for the Codex app workflow; no API call was made.",
    );
  // No model tools are enabled. The extractor cannot browse, execute code or mutate Arcex.
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer " + key,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-6.1-terra",
      reasoning: { effort: "medium" },
      store: false,
      instructions: extractionInstructions,
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: "arcex_extraction",
          strict: true,
          schema,
        },
      },
      max_output_tokens: 12000,
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok)
    throw new Error(
      "Extraction provider returned HTTP " +
        response.status +
        "; no draft was imported",
    );
  const result = parseModelResponse(await response.json());
  for (const step of result.steps)
    if (!files.includes(step.capture))
      throw new Error("Model referenced an unknown capture");
  if (result.paywall && !files.includes(result.paywall.capture))
    throw new Error("Model referenced an unknown paywall capture");
  if (result.blueprint?.captures.some((c) => !files.includes(c)))
    throw new Error("Model referenced an unknown blueprint capture");
  await writeFile(
    join(directory, "analysis.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    "Saved analysis.json locally. Nothing was published or imported.",
  );
}
