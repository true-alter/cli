/**
 * doctor/checks/repo.ts -- diagnostics for the repository the user is standing in.
 *
 * These report on the repository's checks; they never run them. Doctor's
 * contract is a fast read that says what is wrong and how to fix it, so
 * executing somebody's test suite from inside it would be the wrong shape
 * entirely. Running is the job of the runner in lib/repocheck, which NOTHING
 * SHIPPED CALLS YET. The sentence here used to say it was reached from a git
 * hook that `alter hooks install` places; that command installs Claude Code
 * hooks, and nothing installs or reads a `.git/hooks` path on this runner's
 * behalf. The runner is built and unwired, and how it will be reached is not
 * yet decided.
 *
 * That has a consequence worth stating where a reader meets it. `approve` has
 * no caller either, so `isApproved` cannot return true on any shipped path, so
 * EVERYTHING BELOW THE EARLY RETURN in `verdicts-current` is unreachable today,
 * the store read included, not only the `contentKey` call. The checks here
 * report on a repository; none of them reads a verdict or keys its content in
 * practice.
 *
 * Outside a git repository every check here reports OK with a plain note. A
 * person running `alter doctor` in their home directory has nothing wrong with
 * them.
 *
 * All checks are local (no network).
 */

import { detectChecks } from "../../lib/repocheck/detect.js";
import { contentKey, repoIdentity, repoRootFrom } from "../../lib/repocheck/identity.js";
import { readStore, recall, verdictKey } from "../../lib/repocheck/store.js";
import { declarationDigest, isApproved } from "../../lib/repocheck/trust.js";
import type { RepoCheck } from "../../lib/repocheck/types.js";

import type { Check, CheckResult } from "../../lib/check-report.js";

/**
 * Detection touches the filesystem and probes for tools on PATH, so it is done
 * once per doctor run and shared by the checks below.
 */
let cached: { root: string | null; checks: RepoCheck[] } | null = null;

function context(): { root: string | null; checks: RepoCheck[] } {
  if (cached) return cached;
  const root = repoRootFrom(process.cwd());
  cached = { root, checks: root ? detectChecks(root) : [] };
  return cached;
}

/** Reset the memo. Exported for tests, which move between fixture repositories. */
export function resetDetectionCache(): void {
  cached = null;
}

const NOT_A_REPO = "not inside a git repository";

const detected: Check = {
  id: "repo.checks-detected",
  category: "repo",
  label: "Repository checks detected",
  healClass: "DIAGNOSE-ONLY",
  async run(): Promise<CheckResult> {
    const { root, checks } = context();
    if (!root) return { status: "OK", detail: NOT_A_REPO };
    if (checks.length === 0) {
      return {
        status: "WARN",
        detail: "nothing recognised in this repository",
        remedy:
          "Checks are read from package.json scripts, pyproject.toml or setup.cfg, Cargo.toml and go.mod, and only offered when the tool is installed.",
      };
    }
    const ecosystems = [...new Set(checks.map((c) => c.ecosystem))].join(", ");
    return {
      status: "OK",
      detail: `${checks.length} check${checks.length > 1 ? "s" : ""} from ${ecosystems}`,
    };
  },
};

const approval: Check = {
  id: "repo.checks-approved",
  category: "repo",
  label: "Repository checks approved to run",
  healClass: "DIAGNOSE-ONLY",
  async run(): Promise<CheckResult> {
    const { root, checks } = context();
    if (!root) return { status: "OK", detail: NOT_A_REPO };
    if (checks.length === 0) return { status: "OK", detail: "nothing to approve" };

    const digest = declarationDigest(checks, "detected");
    if (isApproved(repoIdentity(root), root, digest)) {
      return { status: "OK", detail: "this set of commands is approved" };
    }
    return {
      status: "WARN",
      detail: "this set of commands has not been approved",
      remedy:
        "These commands come from the repository and run as you. You are asked again whenever anything that decides which program a command runs changes, whether that is a command line, a script body, a tool's configuration, a file naming a toolchain to fetch, or what the repository tells git to run on your behalf. Some things outside the repository ask again too: installing or removing one of these tools changes the set, and so can a git setting such as adding a remote. The last twenty sets you approved are remembered, so a repository that changes and then changes back does not ask a second time. Approval cannot cover the code those commands go on to run, so approve a repository you would run by hand.",
    };
  },
};

const fresh: Check = {
  id: "repo.verdicts-current",
  category: "repo",
  label: "Checks already passed against this content",
  healClass: "DIAGNOSE-ONLY",
  async run(): Promise<CheckResult> {
    const { root, checks } = context();
    if (!root) return { status: "OK", detail: NOT_A_REPO };
    if (checks.length === 0) return { status: "OK", detail: "nothing to recall" };

    const identity = repoIdentity(root);
    // Approval first, and only then the content key. Keying the content runs
    // `git status` in the user's directory, and `git status` runs whatever the
    // repository named in `filter.<name>.clean`, so an unapproved repository
    // gets no PROGRAM OF ITS OWN run on its behalf. It does get read: `context`
    // above has already opened this repository's manifests and digested the
    // sidecar files behind them, which is how there is a check set to ask about
    // in the first place. Those reads are the reason detect.ts refuses anything
    // that is not a plain file. This is doctor, which is the path a person
    // reaches by standing in a directory and typing one word, so it is the path
    // that meets a repository they did not write.
    if (!isApproved(identity, root, declarationDigest(checks, "detected"))) {
      return {
        status: "OK",
        detail: "nothing recalled: this repository is not approved yet",
      };
    }

    const store = readStore(identity, root);
    const keys = new Map<string, string | null>();
    let current = 0;
    let unkeyable = false;
    for (const check of checks) {
      // Serialised rather than joined on a separator: the same derivation the
      // runner uses, and no separator is safe against a path containing it.
      const basisId = JSON.stringify(check.basis);
      let content: string | null;
      if (keys.has(basisId)) {
        content = keys.get(basisId) ?? null;
      } else {
        content = await contentKey(root, check.basis, "worktree");
        keys.set(basisId, content);
      }
      // A null key means git could not answer, so nothing is recalled for this
      // check. Counting it as "not passed" would give the same number a fresh
      // repository gives, which is a different thing, so it is said out loud
      // below rather than folded into the count.
      if (content === null) {
        unkeyable = true;
        continue;
      }
      if (recall(store, verdictKey(check, content))) current++;
    }

    if (unkeyable && current === 0) {
      return {
        status: "OK",
        detail: "nothing recalled: this repository's content could not be read",
      };
    }

    if (current === 0) {
      return {
        status: "OK",
        detail: `0 of ${checks.length} already passed on this content`,
      };
    }
    return {
      status: "OK",
      detail: `${current} of ${checks.length} already passed on this content`,
    };
  },
};

export const checks: Check[] = [detected, approval, fresh];
