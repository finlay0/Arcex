import { execFile } from "node:child_process";
import type { PublishState } from "@arcex/contracts";

/**
 * Pushing and pull requests, for people whose project already has a remote. Git and the GitHub CLI use the user's own
 * sign-in; Arcex never sees a token. Prompts are off, so a missing sign-in fails with a message instead of waiting.
 */
function run(file: string, cwd: string, args: string[], timeout = 20_000): Promise<{ ok: boolean; out: string; err: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout, maxBuffer: 2_000_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } },
      (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout), err: String(stderr).trim(), missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT" }),
    );
  });
}

const BRANCH = /^[\w./-]{1,200}$/;

export async function publishState(cwd: string): Promise<PublishState> {
  const remotes = (await run("git", cwd, ["remote"])).out.split(/\r?\n/).filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
  const branch = (await run("git", cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
  if (!remote || !BRANCH.test(branch) || branch === "HEAD") return { remote: null, branch: BRANCH.test(branch) ? branch : null, ahead: 0, upstream: false, main: null, pr: null, gh: false, github: false };
  const url = (await run("git", cwd, ["remote", "get-url", remote])).out.trim();
  const upstream = (await run("git", cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).ok;
  const ahead = Number(
    (upstream
      ? await run("git", cwd, ["rev-list", "--count", "@{u}..HEAD"])
      : await run("git", cwd, ["rev-list", "--count", "HEAD", "--not", `--remotes=${remote}`])
    ).out.trim(),
  ) || 0;
  const head = (await run("git", cwd, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`])).out.trim();
  const main = head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : null;
  const onGitHub = /github\.com[:/]/i.test(url);
  let gh = false;
  let pr: PublishState["pr"] = null;
  if (onGitHub) {
    const view = await run("gh", cwd, ["pr", "view", branch, "--json", "number,url,state,title,statusCheckRollup"]);
    gh = !view.missing;
    if (view.ok) {
      try {
        const data = JSON.parse(view.out) as { number: number; url: string; state: string; title: string; statusCheckRollup?: { conclusion?: string; state?: string; status?: string }[] };
        const checks = data.statusCheckRollup ?? [];
        const outcome = (check: { conclusion?: string; state?: string; status?: string }) => (check.conclusion || check.state || check.status || "").toUpperCase();
        const failing = checks.filter((check) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(outcome(check))).length;
        const pending = checks.filter((check) => ["", "PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING"].includes(outcome(check))).length;
        pr = {
          number: data.number,
          url: /^https:\/\/github\.com\//.test(data.url) ? data.url : "",
          state: data.state === "MERGED" ? "merged" : data.state === "CLOSED" ? "closed" : "open",
          title: String(data.title).slice(0, 200),
          checks: checks.length === 0 ? "none" : failing ? "failing" : pending ? "running" : "passing",
        };
      } catch {
        pr = null;
      }
    }
  }
  return { remote, branch, ahead, upstream, main, pr, gh, github: onGitHub };
}

export async function push(cwd: string): Promise<PublishState> {
  const state = await publishState(cwd);
  if (!state.remote || !state.branch) throw new Error("this project has no remote to push to");
  const result = await run("git", cwd, ["push", ...(state.upstream ? [] : ["-u"]), state.remote, `HEAD:refs/heads/${state.branch}`], 120_000);
  if (!result.ok) {
    if (/rejected|non-fast-forward|fetch first/i.test(result.err)) throw new Error("GitHub has changes this computer doesn't. Ask an agent to pull them in, then push again.");
    if (/auth|credential|permission|403|could not read username/i.test(result.err)) throw new Error("Git couldn't sign in to push. Sign in to GitHub with Git on this computer, then try again.");
    throw new Error(result.err.split(/\r?\n/).slice(-2).join(" ").slice(0, 300) || "Git couldn't push.");
  }
  return publishState(cwd);
}

/** Opens a pull request for the current branch, titled and described from its first saved version. */
export async function createPullRequest(cwd: string): Promise<PublishState> {
  const state = await publishState(cwd);
  if (!state.remote || !state.branch) throw new Error("this project has no remote");
  if (!state.gh) throw new Error("install the GitHub CLI (gh) and sign in with it to open pull requests from Arcex");
  if (state.branch === state.main) throw new Error(`you're on ${state.main}. Pull requests need their own branch`);
  if (state.pr?.state === "open") return state;
  if (state.ahead > 0 || !state.upstream) await push(cwd);
  const result = await run("gh", cwd, ["pr", "create", "--head", state.branch, "--fill-first"], 60_000);
  if (!result.ok) {
    if (/auth login|not logged/i.test(result.err)) throw new Error("the GitHub CLI isn't signed in. Run gh auth login in a terminal, then try again.");
    throw new Error(result.err.split(/\r?\n/).slice(-2).join(" ").slice(0, 300) || "the GitHub CLI couldn't open the pull request");
  }
  return publishState(cwd);
}
