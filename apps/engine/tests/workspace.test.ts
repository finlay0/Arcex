import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { Item, Project, Requests, Settings, Thread } from "@arcex/contracts";
import { openDb } from "../src/db.ts";
import { createEngine } from "../src/engine.ts";

const fixture = `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
const reply = (request, result) => send({ id: request.id, result });
const reject = (request, message) => send({ id: request.id, error: { code: -32603, message } });
let model = "baseline";
let waiting;
const config = () => ({
  configOptions: [{
    id: "fixture-model", category: "model", name: "Model", type: "select", currentValue: model,
    options: [{ value: "baseline", name: "Baseline" }, { value: "other", name: "Other" }]
  }]
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
      setTimeout(() => reply(message, { protocolVersion: message.params.protocolVersion, agentCapabilities: {} }), 250);
      break;
    case "session/new":
      reply(message, { sessionId: "fixture", ...config() });
      break;
    case "session/set_config_option":
      if (message.params.configId !== "fixture-model" || message.params.value === "stale") {
        reject(message, "unavailable model");
      } else {
        model = message.params.value;
        reply(message, config());
      }
      break;
    case "session/prompt": {
      const text = message.params.prompt[0].text;
      fs.appendFileSync("prompts.txt", text + " " + model + "\\n");
      if (text === "ignore cancellation") return;
      if (text === "fail") {
        send({ method: "session/update", params: { sessionId: "fixture", update: {
          sessionUpdate: "tool_call", toolCallId: "edit", title: "Edit fixture", kind: "edit", status: "in_progress"
        } } });
        reject(message, "simulated turn failure");
      } else if (text === "ask") {
        waiting = message;
        send({ id: 99, method: "session/request_permission", params: {
          sessionId: "fixture", toolCall: { toolCallId: "approval", kind: "edit", title: "Edit fixture" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
        } });
      } else {
        reply(message, { stopReason: "end_turn" });
      }
      break;
    }
    case "session/cancel":
      if (waiting) reply(waiting, { stopReason: "cancelled" });
      waiting = undefined;
      break;
  }
});
`;

test("workspace preserves control and review information across ACP failures and restart", { timeout: 20_000 }, async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "arcex-workspace-test-"));
  const db = openDb(folder);
  const engine = createEngine(db, { version: "test", dataDir: folder, projectsDir: folder }, { script: "unused", toolboxFile: "unused" }, () => {});
  const call = engine.handle;
  let reopened: ReturnType<typeof openDb> | undefined;
  try {
    const commandFile = path.join(folder, "fixture.cjs");
    writeFileSync(commandFile, fixture);
    const settings = await call("agents.add", { name: "Fixture", command: `node "${commandFile}"` }) as Settings;
    const provider = settings.agents[0]!.id;
    const project = await call("project.create", { goal: "Fixture project" }) as Project;
    const log = path.join(project.cwd, "prompts.txt");
    const state = () => call("state.get", {}) as Promise<Requests["state.get"]["result"]>;
    const waitForState = async (id: string, expected: Thread["state"]) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if ((await state()).threads.find((thread) => thread.id === id)?.state === expected) return;
        await delay(50);
      }
      assert.fail(`Thread did not reach ${expected}`);
    };

    const stopped = await call("thread.create", { projectId: project.id, provider, text: "stop before prompt" }) as Thread;
    await call("thread.cancel", { threadId: stopped.id });
    await waitForState(stopped.id, "stopped");
    assert.equal(existsSync(log), false);

    const thread = await call("thread.create", { projectId: project.id, provider, model: { value: "stale", name: "Stale" }, text: "reject model" }) as Thread;
    await waitForState(thread.id, "failed");
    assert.equal(existsSync(log), false);
    assert.match(JSON.stringify(await call("thread.items", { threadId: thread.id })), /couldn't use Stale/);

    const prompt = (text: string) => call("thread.prompt", { threadId: thread.id, text });
    const select = (model: Thread["model"]) => call("thread.update", { threadId: thread.id, model });
    await select({ value: "other", name: "Other" });
    await call("draft.set", { projectId: project.id, threadId: thread.id, text: "use explicit" });
    await prompt("use explicit");
    await waitForState(thread.id, "idle");
    assert.equal((await state()).drafts[thread.id], undefined);
    await select(null);
    await prompt("use default");
    await waitForState(thread.id, "idle");
    assert.equal(readFileSync(log, "utf8"), "use explicit other\nuse default baseline\n");

    await prompt("ask");
    await waitForState(thread.id, "needs_you");
    await call("thread.cancel", { threadId: thread.id });
    await waitForState(thread.id, "stopped");
    assert.equal((await call("thread.items", { threadId: thread.id }) as Item[]).find((item) => item.kind === "ask")?.answer, "Turn stopped");

    await prompt("ignore cancellation");
    await waitForState(thread.id, "working");
    await call("thread.cancel", { threadId: thread.id });
    await assert.rejects(prompt("send too early"), /still working/);
    await waitForState(thread.id, "interrupted");

    await prompt("fail");
    await waitForState(thread.id, "failed");
    assert.equal((await call("thread.items", { threadId: thread.id }) as Item[]).find((item) => item.kind === "step")?.status, "interrupted");
    await call("draft.set", { projectId: project.id, threadId: thread.id, text: "Resume after restart" });

    const existing = path.join(folder, "Existing folder");
    mkdirSync(existing);
    const imported = await call("project.create", { cwd: existing, goal: "" }) as Project;
    assert.equal(imported.name, "Existing folder");
    assert.equal(existsSync(path.join(existing, ".git")), false);
    await assert.rejects(call("project.changes", { projectId: imported.id }), /no Git repository/);
    writeFileSync(path.join(project.cwd, "résumé [2026].txt"), "uncommitted text\n");
    assert.deepEqual(await call("project.diff", { projectId: project.id, path: "résumé [2026].txt" }), { text: "+uncommitted text\n+" });

    db.saveThread({ ...db.threads().find((entry) => entry.id === stopped.id)!, state: "working" });
    engine.close();
    reopened = openDb(folder);
    assert.equal(reopened.threads().find((entry) => entry.id === stopped.id)?.state, "interrupted");
    assert.equal(reopened.threads().find((entry) => entry.id === thread.id)?.state, "failed");
    assert.equal(reopened.drafts()[thread.id], "Resume after restart");
  } finally {
    engine.close();
    reopened?.close();
    db.close();
    await rm(folder, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
