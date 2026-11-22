import { execFile } from "node:child_process";
import type { PublishState, PullRequestEntry } from "@arcex/contracts";

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

/** Open pull requests on the project's GitHub repository, newest first. */
export async function listPullRequests(cwd: string): Promise<PullRequestEntry[]> {
  const result = await run("gh", cwd, ["pr", "list", "--state", "open", "--limit", "30", "--json", "number,title,headRefName,author,updatedAt,isDraft"]);
  if (result.missing) throw new Error("install the GitHub CLI (gh) and sign in with it to see pull requests");
  if (!result.ok) {
    if (/auth login|not logged/i.test(result.err)) throw new Error("the GitHub CLI isn't signed in. Run gh auth login in a terminal, then try again.");
    throw new Error(result.err.split(/\r?\n/).slice(-1)[0]?.slice(0, 300) || "the GitHub CLI couldn't list pull requests");
  }
  try {
    const rows = JSON.parse(result.out) as { number: number; title: string; headRefName: string; author?: { login?: string }; updatedAt: string; isDraft?: boolean }[];
    return rows.map((row) => ({
      number: Number(row.number),
      title: String(row.title).slice(0, 200),
      branch: String(row.headRefName).slice(0, 200),
      author: String(row.author?.login ?? "").slice(0, 100),
      updatedAt: Date.parse(row.updatedAt) || 0,
      draft: row.isDraft === true,
    }));
  } catch {
    return [];
  }
}

/**
 * Switches the project to a pull request's branch and returns what a thread needs to start on it. Refuses while files
 * the project tracks have unsaved changes, so switching never mixes work.
 */
export async function checkoutPullRequest(cwd: string, number: number): Promise<{ number: number; title: string; body: string; branch: string; base: string; author: string; url: string }> {
  if (!Number.isInteger(number) || number < 1 || number > 10_000_000) throw new Error("that isn't a pull request number");
  const dirty = await run("git", cwd, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.out.trim()) throw new Error("save or undo the unsaved changes first. Switching to a pull request changes the project's files");
  const view = await run("gh", cwd, ["pr", "view", String(number), "--json", "number,title,body,headRefName,baseRefName,author,url"]);
  if (!view.ok) throw new Error(view.err.split(/\r?\n/).slice(-1)[0]?.slice(0, 300) || "the GitHub CLI couldn't read that pull request");
  const data = JSON.parse(view.out) as { number: number; title: string; body: string; headRefName: string; baseRefName: string; author?: { login?: string }; url: string };
  const checkout = await run("gh", cwd, ["pr", "checkout", String(number)], 120_000);
  if (!checkout.ok && /couldn't find remote ref/i.test(checkout.err)) throw new Error("that pull request's branch is no longer on GitHub, so there's nothing to switch to");
  if (!checkout.ok) throw new Error(checkout.err.split(/\r?\n/).slice(-2).join(" ").slice(0, 300) || "the GitHub CLI couldn't switch to that pull request");
  return {
    number: data.number,
    title: String(data.title).slice(0, 200),
    body: String(data.body ?? "").slice(0, 6_000),
    branch: String(data.headRefName).slice(0, 200),
    base: String(data.baseRefName).slice(0, 200),
    author: String(data.author?.login ?? "").slice(0, 100),
    url: /^https:\/\/github\.com\//.test(data.url) ? data.url : "",
  };
}

/** The branch the project is on and the branch it grew from (the remote's default, else a local main or master). */
export async function branchInfo(cwd: string): Promise<{ branch: string | null; base: string | null; ahead: number }> {
  const branch = (await run("git", cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
  if (!BRANCH.test(branch) || branch === "HEAD") return { branch: null, base: null, ahead: 0 };
  const remoteHead = (await run("git", cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).out.trim();
  const candidates = [remoteHead.startsWith("origin/") ? remoteHead.slice(7) : "", "main", "master"].filter(Boolean);
  let base: string | null = null;
  for (const name of candidates) {
    if (!BRANCH.test(name)) continue;
    if ((await run("git", cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])).ok) {
      base = name;
      break;
    }
  }
  if (!base || base === branch) return { branch, base: null, ahead: 0 };
  const ahead = Number((await run("git", cwd, ["rev-list", "--count", `refs/heads/${base}..HEAD`])).out.trim()) || 0;
  return { branch, base, ahead };
}
