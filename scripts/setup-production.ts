import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const path = ".secrets.production.json";
if (!existsSync(path))
  await writeFile(
    path,
    JSON.stringify(
      {
        ADMIN_TOKEN: randomBytes(32).toString("hex"),
        COLLECTOR_TOKEN: randomBytes(32).toString("hex"),
        MEDIA_SIGNING_SECRET: randomBytes(32).toString("hex"),
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
const secrets = JSON.parse(await readFile(path, "utf8")) as Record<
  string,
  string
>;
const url = process.argv[2];
if (url) {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("Production API must use HTTPS");
  await writeFile(
    ".env.collector",
    `ARCEX_API_URL=${u.origin}\nARCEX_ADMIN_TOKEN=${secrets.ADMIN_TOKEN}\nARCEX_COLLECTOR_TOKEN=${secrets.COLLECTOR_TOKEN}\n`,
  );
}
console.log(
  "Production credentials are in ignored local files. No credentials were printed.",
);
