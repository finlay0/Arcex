import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

if (existsSync(".dev.vars"))
  console.log("Local secret file already exists; retained.");
else {
  const token = () => randomBytes(32).toString("hex");
  await writeFile(
    ".dev.vars",
    `ADMIN_TOKEN=${token()}\nCOLLECTOR_TOKEN=${token()}\nDEV_AUTH_TOKEN=${token()}\nENABLE_DEV_AUTH=true\n`,
    { flag: "wx" },
  );
  console.log("Created ignored .dev.vars with independent local credentials.");
}
