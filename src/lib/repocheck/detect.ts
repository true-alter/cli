/**
 * repocheck/detect.ts -- work out what to check from what the repository
 * already has.
 *
 * A stranger should not have to write a configuration file to get a first
 * answer. Every check here is read out of a manifest they already maintain,
 * and a check is only offered when the tool that runs it is actually on the
 * machine. Where nothing is recognised the runner says so plainly, rather than
 * inventing a check and reporting on it.
 */

import * as fs from "fs";
import * as path from "path";

import { parse as parseToml } from "smol-toml";

import { which } from "../which.js";
import { digestPath, readTextFile } from "./safe-read.js";
import type { Ecosystem, PythonTool, RepoCheck } from "./types.js";

/**
 * A check before it is placed in a project directory. The four ecosystem
 * readers below describe what to run; detectIn decides where it runs.
 */
type DetectedCheck = Omit<RepoCheck, "workdir">;

/**
 * Content excluded from every check's basis.
 *
 * These are paths whose bytes cannot change the answer to "does this code
 * build, lint, type-check and pass its tests". Excluding them is what lets an
 * edit to the documentation keep a verdict that is still true. The list is
 * deliberately short: anything not named here counts, so a file nobody
 * anticipated is included rather than quietly ignored.
 */
export const BASIS_EXCLUSIONS: string[] = [
  ":(exclude)*.md",
  ":(exclude)*.mdx",
  ":(exclude)*.txt",
  ":(exclude)LICENSE*",
  ":(exclude)*.png",
  ":(exclude)*.jpg",
  ":(exclude)*.jpeg",
  ":(exclude)*.gif",
  ":(exclude)*.svg",
  ":(exclude)*.ico",
  ":(exclude)*.webp",
  ":(exclude)*.pdf",
];

/**
 * How deep a manifest value may nest before this module refuses to render it.
 *
 * The other resource bounds here cap BYTES (`MAX_PARSE_BYTES`), LISTING SIZE
 * (`MAX_DIR_ENTRIES`) and DIRECTORIES VISITED (`MAX_CANDIDATE_DIRS`). None of
 * them caps DEPTH, and depth is the repository's to choose: a 400 KB
 * `package.json` holding `[[[…200k…]]]` takes the recursion below past the
 * stack limit, and an independent reader threw a `RangeError` out of
 * `detectChecks` with it on the live doctor path. 64 is far below any real
 * manifest and far below the stack.
 */
const MAX_RENDER_DEPTH = 64;

/** Raised by `stableRender` past `MAX_RENDER_DEPTH`, caught in `payloadFor`. */
class ValueTooDeep extends Error {}

/**
 * A manifest value rendered so that equal values render identically, whatever
 * order the manifest happened to list their keys in. Used for the payload a
 * check's approval is digested against, where a spurious difference costs the
 * user a needless re-approval and a missed difference costs them the point of
 * asking.
 */
function stableRender(value: unknown, depth = 0): string {
  // REFUSED, NOT TRUNCATED, and the difference is the whole point. A sentinel
  // standing in for a too-deep subtree would render two DIFFERENT manifests
  // identically, which is this module's stated worst direction: too wide costs
  // a re-approval, too narrow runs a program the approval never saw.
  if (depth > MAX_RENDER_DEPTH) throw new ValueTooDeep("manifest value nests too deep");
  // JSON.stringify throws on a bigint rather than rendering it, which would
  // take the whole detection pass down. Today's TOML parser rejects an integer
  // it cannot hold before one reaches here, so this is a guard against a parser
  // that starts returning them rather than a case seen in practice.
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  // A date carries its whole value in its internals and none of it in its own
  // enumerable keys, so the entries walk below would render every date as `{}`
  // and two different datetimes would render identically.
  if (value instanceof Date) {
    const iso = (() => {
      try {
        return value.toISOString();
      } catch {
        return String(value);
      }
    })();
    return JSON.stringify(`date:${iso}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableRender(v, depth + 1)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  // Same trap one class wider: anything else that keeps its value off its own
  // enumerable keys renders as `{}` and collides with every other such value.
  // What the object says about itself is a poor rendering but never a silent
  // collision between two different ones.
  if (entries.length === 0) {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      return JSON.stringify(`opaque:${String(value)}`);
    }
  }
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableRender(v, depth + 1)}`)
    .join(",")}}`;
}

function readJson(file: string): Record<string, unknown> | null {
  const text = readTextFile(file);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readToml(file: string): Record<string, unknown> | null {
  const text = readTextFile(file);
  if (text === null) return null;
  try {
    const parsed = parseToml(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function exists(repoRoot: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(repoRoot, rel));
  } catch {
    return false;
  }
}

/** Which package manager this repository is driven by, read from its lockfile. */
function nodeRunner(repoRoot: string): string | null {
  if (exists(repoRoot, "pnpm-lock.yaml")) return which("pnpm") ? "pnpm run" : null;
  if (exists(repoRoot, "yarn.lock")) return which("yarn") ? "yarn run" : null;
  if (exists(repoRoot, "bun.lockb")) return which("bun") ? "bun run" : null;
  return which("npm") ? "npm run" : null;
}

/**
 * Script names worth running as a check, in the order a person would want them:
 * the cheap ones that fail fast come first.
 */
const NODE_SCRIPTS: { name: string; label: string }[] = [
  { name: "lint", label: "lint" },
  { name: "typecheck", label: "type check" },
  { name: "type-check", label: "type check" },
  { name: "tsc", label: "type check" },
  { name: "test", label: "tests" },
];

/**
 * THE MEMBERSHIP TEST every list below is derived from.
 *
 * A file belongs in an arm's list when a change to its bytes can change WHICH
 * PROGRAM RUNS or WHAT IT LOADS, given a command line that does not itself
 * change. Two members already here were admitted on exactly that ground and are
 * the worked examples: `packageManager` is folded because corepack reads it to
 * fetch and run the package manager, and `rust-toolchain.toml` is folded
 * because rustup reads it to fetch and run a compiler. Anything of that shape is
 * in, whichever ecosystem it belongs to.
 *
 * A file is OUT when its bytes decide which CODE is on disk for a command that
 * was going to run anyway. `Cargo.lock`, `go.sum`, `package-lock.json` and the
 * dependency tables are all that shape, and no digest of a declaration can
 * cover the code a command reaches at runtime (see trust.ts). `conftest.py`,
 * `build.rs` and a test file are the same case one step further in.
 *
 * The lists are derived from each arm's own runner set, never from the last
 * person's recollection: detectIn names four arms, nodeRunner names four node
 * runners, and every one of those eight is answered below. Too wide costs a
 * re-approval nobody needed; too narrow hands the repository a program the
 * user's approval never saw, so an unclear case is included.
 */

/**
 * Read by a version manager on PATH, in every ecosystem, to decide which
 * `npm`, `python`, `cargo` or `go` binary the shell resolves. Exactly the
 * corepack and rustup case, one layer out, so it is folded into all four arms
 * rather than into the one that noticed it.
 *
 * THE PER-LANGUAGE SPELLINGS ARE MEMBERS OF THE SAME SET, not a different one.
 * `.tool-versions` is asdf's and mise's multi-language file, and every entry
 * below is the single-language file the same managers, plus nvm, fnm and pyenv,
 * read in its place. A repository that ships `.nvmrc` chooses the node binary
 * exactly as one that ships `.tool-versions` does. They were missing because the
 * list was written from the multi-language managers and never re-derived from
 * the membership test above, which is the failure this whole list exists to
 * stop, so they are folded into all four arms on the same ground.
 *
 * `.go-version` appears here rather than only in the go arm because the version
 * managers read it wherever it is, and the set is deduplicated where it is used.
 */
const TOOLCHAIN_FILES = [
  ".tool-versions",
  "mise.toml",
  ".mise.toml",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".rust-version",
  ".go-version",
];

/**
 * Files the node package managers read from the project directory.
 *
 * Derived from nodeRunner's four candidates rather than from the one this
 * repository happens to resolve, because the lockfile that picks the runner is
 * itself something the repository can change:
 *
 *   - `.npmrc`, read by npm AND pnpm. `script-shell` names the program that
 *     interprets every script body, and `node-options` reaches NODE_OPTIONS,
 *     where `--require ./anything.js` loads a file of the repository's choosing
 *     into the process before the script starts.
 *   - `.yarnrc.yml` (berry) and `.yarnrc` (classic). `yarnPath` names a
 *     JavaScript file yarn runs AS yarn, and `plugins` names more. `.env.yarn`
 *     is the file berry injects into every script's environment by default
 *     (`injectEnvironmentFiles`), so its bytes reach the process the same way
 *     `.npmrc`'s `node-options` reaches NODE_OPTIONS, one file over.
 *   - `bunfig.toml`. `[run] shell` is the .npmrc case, and `preload` loads a
 *     module before anything else.
 *   - `.pnpmfile.cjs`, which pnpm executes, and `pnpm-workspace.yaml`, which
 *     carries settings of the same class in pnpm 10.
 *
 * All four are folded whichever runner is resolved. Digesting only the resolved
 * one would make the answer depend on which lockfile is present, which is one
 * more thing a repository gets to choose.
 */
const NODE_CONFIG_FILES = [
  ".npmrc",
  ".yarnrc.yml",
  ".yarnrc",
  ".env.yarn",
  "bunfig.toml",
  ".pnpmfile.cjs",
  "pnpm-workspace.yaml",
];

/**
 * The payload for one check: what a manifest declares, parsed so that merely
 * reordering its keys costs nobody a re-approval, alongside a digest of the
 * bytes of every sidecar file that steers what the command executes.
 *
 * EVERY ARM BUILDS ITS PAYLOAD HERE, and the shared TOOLCHAIN_FILES are added
 * in this one place rather than by each caller. That is deliberate and it is
 * the point of the function: a list each arm has to remember to include is a
 * list some future arm will be written without, which is exactly how the node
 * and go arms came to carry less than the python and rust ones. The shared set
 * is now unconditional: an arm gets it by calling this at all. The arm's OWN
 * list is a required parameter, which forces the author to say something, and
 * an author can still say `[]`; what catches that is the test over
 * DECLARATION_FILES, which fails an arm whose list is empty.
 */
function payloadFor(
  ctx: ProjectContext,
  declared: unknown,
  files: string[],
  /**
   * Files folded at ANCESTOR levels only, because the project's own copy is
   * already represented in `declared` as a parsed value. Digesting those at the
   * project level too would make a key reordering a new declaration, which is
   * what parsing them exists to prevent.
   */
  ancestorOnly: string[] = [],
): string | null {
  const all = [...new Set([...files, ...TOOLCHAIN_FILES])].sort();
  const entries: [string, string][] = [];
  const fold = (rel: string, dirs: string[]): void => {
    for (const dir of dirs) {
      // The directory is named beside the digest, so a file appearing at a new
      // level is a change to the payload even when its bytes match one already
      // folded from another level.
      const from = dir === "" ? rel : `${dir}/${rel}`;
      entries.push([from, digestPath(path.join(ctx.repoRoot, dir, rel))]);
    }
  };
  for (const rel of all) fold(rel, ctx.lookupDirs);
  // `lookupDirs[0]` is the project itself, so this drops exactly that level.
  for (const rel of [...new Set(ancestorOnly)].sort()) {
    fold(rel, ctx.lookupDirs.slice(1));
  }

  // GIT'S OWN CONFIGURATION, folded for every arm because git is the one
  // program this module runs on an unapproved repository's behalf regardless of
  // ecosystem. `.gitattributes` binds a path to a `filter.<name>.clean`, and
  // `.git/config` names the program that filter runs; `git status`, which
  // keying the content requires, then executes it. Proven by execution: a
  // repository carrying both wrote a marker file during `contentKey`, and the
  // declaration digest was byte-identical before and after arming it.
  //
  // That is the membership test met exactly, so it is in. Folding `.git/config`
  // whole means an ordinary git operation can cost a re-approval, which is a
  // real cost and is accepted on this module's own stated rule: too wide costs
  // a re-approval, too narrow runs a program the approval never saw, and a
  // parser written here to tell the two apart is one more place for a
  // difference to go missing. MEASURED rather than assumed, because the
  // sentence here previously named the wrong operations: `git remote add` does
  // move the digest, and `git branch` does NOT.
  //
  // WHAT THIS FOLD DOES NOT REACH, known and deliberately not closed. It is
  // recorded here and in the specification rather than fixed, because every
  // member below bites only inside `contentKey`, and `contentKey` is reachable
  // only behind `isApproved`, which cannot return true while nothing calls
  // `approve`. Widening a fold that defends a closed door was judged the wrong
  // spend; these are the three members it owes when the runner is wired.
  //
  //   - A LINKED WORKTREE, SUBMODULE OR --separate-git-dir CLONE. There
  //     `<root>/.git` is a FILE, so this digests "absent" and the real config
  //     at `git rev-parse --git-common-dir` is unfolded. Proven by execution,
  //     and it is the NORMAL case on this machine rather than an exotic one.
  //   - DESCENDANT `.gitattributes`. Git merges attributes from the FILE's own
  //     directory upward, so the files that matter live BELOW the project, and
  //     the ancestor walk below reaches none of them. A plain `git clone`
  //     delivers this one, unlike `.git/config`.
  //   - `.git/info/attributes`, which binds a path to a filter exactly as
  //     `.gitattributes` does.
  //
  // `.gitattributes` is folded at the project level and its ancestors, which is
  // the wrong direction for the reason just given and is kept only because it
  // is strictly better than nothing. `.git/config` is one file at one place.
  for (const dir of ctx.lookupDirs) {
    const from = dir === "" ? ".gitattributes" : `${dir}/.gitattributes`;
    entries.push([from, digestPath(path.join(ctx.repoRoot, dir, ".gitattributes"))]);
  }
  entries.push([
    ".git/config",
    digestPath(path.join(ctx.repoRoot, ".git", "config")),
  ]);

  // NULL MEANS THE PAYLOAD COULD NOT BE RENDERED, and every arm treats that as
  // detecting nothing. A repository that nests its manifest past the depth
  // bound gets no checks offered, which is the same answer as a manifest that
  // will not parse, and it is the fail-closed direction: an approval is never
  // asked for, so nothing is ever run on the strength of one.
  try {
    return stableRender({ declared, files: entries });
  } catch (err) {
    if (err instanceof ValueTooDeep) return null;
    throw err;
  }
}

/**
 * Where one project's checks are detected from, and every directory a tool
 * reading its configuration would look in.
 *
 * WHY THE ANCESTORS. Several of the files folded above are not read from beside
 * the manifest at all. `.npmrc` is merged from every directory between the
 * project and the filesystem root; mise and asdf walk up until they find one;
 * `pnpm-workspace.yaml` lives at the workspace root by definition. A payload
 * built only from the project directory therefore misses the case where a
 * repository steers a subproject's check from a file one level up, which is the
 * more convenient place to put it precisely because that is where nobody looks.
 *
 * WHERE THE WALK STOPS, and why there. It stops at the repository root. Above
 * that the files belong to the user's own machine rather than to the repository,
 * folding them would make the approval digest depend on the directory the clone
 * happens to sit in, and a repository cannot choose their contents anyway.
 */
interface ProjectContext {
  repoRoot: string;
  /** Absolute path of the project directory the manifests are read from. */
  dir: string;
  /** Project directory first, then each ancestor up to the root. "" is the root. */
  lookupDirs: string[];
}

function projectContext(repoRoot: string, workdir: string): ProjectContext {
  const dirs: string[] = [];
  let current = workdir;
  for (;;) {
    dirs.push(current);
    if (current === "") break;
    const parent = path.posix.dirname(current);
    current = parent === "." || parent === "/" ? "" : parent;
  }
  return {
    repoRoot,
    dir: workdir === "" ? repoRoot : path.join(repoRoot, workdir),
    lookupDirs: dirs,
  };
}

/**
 * What `<runner> run <name>` executes, as package.json declares it.
 *
 * The command line says `npm run test`; this says what that runs. Naming only
 * `scripts[name]` would be too narrow, because one invocation reaches more than
 * one declared body:
 *
 *   - the lifecycle trio. npm, yarn 1, pnpm and bun all run `pre<name>` and
 *     `post<name>` around the named script, so three bodies execute for one
 *     command line and each is a place to put something else.
 *   - anything those bodies then name. A script body is free to call another
 *     script, directly (`npm run inner`) or through a runner (`npm-run-all`,
 *     `run-s`), under a name it can build at runtime. Which bodies an
 *     invocation reaches is therefore not decidable by reading the manifest,
 *     so the whole `scripts` map is folded rather than the names this check
 *     happens to look at.
 *   - `config`, which npm exposes to every script as `npm_package_config_*`,
 *     so a script's behaviour can be steered without touching any body.
 *   - `packageManager`, which corepack reads to download and run the package
 *     manager itself.
 *   - `volta`, which Volta reads to fetch and run the node and npm binaries the
 *     scripts are then interpreted by. That is `packageManager`'s case exactly,
 *     one tool over, and it was missing because this list was derived from
 *     corepack rather than from the membership test.
 *
 * And none of that says which SHELL interprets those bodies, or what is loaded
 * into the process before they start. That is what NODE_CONFIG_FILES answers.
 *
 * What is deliberately NOT folded: `dependencies` and friends. Those decide
 * which code is on disk after an install rather than what the manifest declares
 * this command to be, and no digest of a declaration can cover the code a
 * command reaches (see trust.ts).
 */
function nodePayload(ctx: ProjectContext, pkg: Record<string, unknown>): string | null {
  return payloadFor(
    ctx,
    {
      scripts: pkg.scripts,
      config: pkg.config,
      packageManager: pkg.packageManager,
      volta: pkg.volta,
    },
    NODE_CONFIG_FILES,
  );
}

function detectNode(ctx: ProjectContext, basis: string[]): DetectedCheck[] {
  const pkg = readJson(path.join(ctx.dir, "package.json"));
  if (!pkg) return [];
  const scripts = pkg.scripts;
  if (typeof scripts !== "object" || scripts === null) return [];
  const available = scripts as Record<string, unknown>;

  const runner = nodeRunner(ctx.dir);
  if (!runner) return [];

  const payload = nodePayload(ctx, pkg);
  if (payload === null) return [];
  const checks: DetectedCheck[] = [];
  const seenLabels = new Set<string>();
  for (const { name, label } of NODE_SCRIPTS) {
    const body = available[name];
    if (typeof body !== "string") continue;
    // Several aliases map to one label; take the first the repository defines.
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    checks.push({
      id: `node.${name}`,
      label: `node ${label}`,
      ecosystem: "node",
      command: `${runner} ${name}`,
      payload,
      basis,
    });
  }
  return checks;
}

/**
 * Every file each python tool reads its configuration from, beyond the
 * `[tool.<name>]` block in pyproject.toml that is folded separately.
 *
 * Detection fires on pyproject.toml OR setup.cfg, and each of these tools reads
 * a spelling of its configuration that is not pyproject.toml at all. A payload
 * read only from pyproject.toml is therefore a constant for a repository that
 * configures its tools anywhere else, and the constant looks like a covered
 * declaration while covering nothing.
 *
 * Each of these steers execution, not just style: pytest's `addopts = -p <mod>`
 * loads a plugin, mypy's `plugins =` loads a plugin, ruff's config decides
 * which of its own passes run and over what. So every one of them is folded, by
 * a digest of its bytes rather than by parsing: three formats between them, and
 * a parser this module wrote is one more place for a difference to go missing.
 */
const PYTHON_CONFIG_FILES: Record<PythonTool, string[]> = {
  ruff: ["ruff.toml", ".ruff.toml"],
  mypy: ["mypy.ini", ".mypy.ini", "setup.cfg"],
  pytest: ["pytest.ini", ".pytest.ini", "tox.ini", "setup.cfg"],
};

/**
 * What a python tool's configuration says, across every file it reads it from.
 *
 * pyproject.toml contributes its parsed `[tool.<name>]` block, so that merely
 * reordering keys in it does not cost the user a re-approval. Every other file
 * contributes a digest of its bytes.
 *
 * `tool` is a closed union and this takes no `?? []` fallback, for the reason
 * `Ecosystem` is closed one level up. A python tool wired here without an entry
 * would fold NOTHING of its own, so its payload would be the shared toolchain
 * set alone and its configuration would sit outside the approval digest, while
 * both existing guards stayed green: `DECLARATION_FILES.python` is the union of
 * the other tools' files and is non-empty whatever this tool folds. That is the
 * arm-with-no-list defect exactly, one level down, and it was still here after
 * the level above it was closed.
 */
function pythonPayload(
  ctx: ProjectContext,
  tool: PythonTool,
  declared: unknown,
): string | null {
  // pyproject.toml is folded as BYTES at every ancestor level, and as a parsed
  // block only at the project's own. Both halves are needed and neither is
  // sufficient. Parsing is what stops a key reordering costing a re-approval,
  // and it can only be done where the project is. But pytest, ruff and mypy all
  // walk UPWARD for a pyproject.toml when the project has none of their config,
  // and an ancestor `[tool.pytest.ini_options] addopts = "-p evil"` loads a
  // plugin into a subproject's test run. That was proven by execution against a
  // real pytest: the plugin loaded, and the subproject's payload was
  // byte-identical across the change. Digesting the ancestors closes it without
  // giving up the parse.
  const ownFiles = PYTHON_CONFIG_FILES[tool];
  return payloadFor(ctx, declared, ownFiles, ["pyproject.toml"]);
}

function detectPython(ctx: ProjectContext, basis: string[]): DetectedCheck[] {
  const repoRoot = ctx.dir;
  const hasPyproject = exists(repoRoot, "pyproject.toml");
  if (!hasPyproject && !exists(repoRoot, "setup.cfg")) return [];

  const pyproject = hasPyproject
    ? readToml(path.join(repoRoot, "pyproject.toml"))
    : null;
  const tools =
    pyproject && typeof pyproject.tool === "object" && pyproject.tool !== null
      ? (pyproject.tool as Record<string, unknown>)
      : {};

  const checks: DetectedCheck[] = [];
  // A null payload means the manifest would not render, so the check is not
  // offered at all rather than offered with a payload that says less than the
  // truth. Each tool is judged on its own, since they read different files.
  if (tools.ruff !== undefined && which("ruff")) {
    // The tool's own configuration steers what the command does, so a change
    // to it is a change to what would run.
    const payload = pythonPayload(ctx, "ruff", tools.ruff);
    if (payload !== null) {
      checks.push({
        id: "python.ruff",
        label: "python lint",
        ecosystem: "python",
        command: "ruff check .",
        payload,
        basis,
      });
    }
  }
  if (tools.mypy !== undefined && which("mypy")) {
    const payload = pythonPayload(ctx, "mypy", tools.mypy);
    if (payload !== null) {
      checks.push({
        id: "python.mypy",
        label: "python type check",
        ecosystem: "python",
        command: "mypy .",
        payload,
        basis,
      });
    }
  }
  const declaresPytest =
    tools.pytest !== undefined || exists(repoRoot, "tests") || exists(repoRoot, "test");
  if (declaresPytest && which("pytest")) {
    const payload = pythonPayload(ctx, "pytest", tools.pytest);
    if (payload !== null) {
      checks.push({
        id: "python.pytest",
        label: "python tests",
        ecosystem: "python",
        command: "pytest",
        payload,
        basis,
      });
    }
  }
  return checks;
}

/**
 * Files a repository can use to steer what `cargo <subcommand>` executes.
 *
 * Cargo's subcommands are cargo's own and Cargo.toml holds no script body, but
 * that is not the same as the repository having no say. `.cargo/config.toml`
 * carries `[alias]`, `[build] rustc-wrapper` and `[target.*.runner]`, each of
 * which names a program cargo then runs, and `rust-toolchain.toml` makes rustup
 * fetch and run a toolchain the repository chose. Cargo.toml itself is left out
 * on purpose: its churn is dependency churn, and a dependency is code the
 * command reaches rather than a declaration of what the command is.
 */
const RUST_CONFIG_FILES = [
  ".cargo/config.toml",
  ".cargo/config",
  "rust-toolchain.toml",
  "rust-toolchain",
  // The subcommands this arm runs read their own configuration from their own
  // files, on the same ground the python arm folds ruff.toml and mypy.ini:
  // a lint configuration decides which of the tool's passes run and over what,
  // which is a change to what `cargo clippy` does behind an unchanged command.
  "clippy.toml",
  ".clippy.toml",
  "rustfmt.toml",
  ".rustfmt.toml",
];

/**
 * Files a repository can use to steer what `go <subcommand>` executes.
 *
 * `go.mod` IS one of them, and the comment that used to sit here saying
 * otherwise ("go.mod declares dependencies, never a command body") was wrong.
 * go.mod carries the `toolchain` directive, and with GOTOOLCHAIN=auto, the
 * default since Go 1.21, the go command reads it, DOWNLOADS the named toolchain
 * and re-executes itself as that toolchain. `toolchain go1.99.9` in a cloned
 * repository was observed making `go vet ./...` fetch and run a compiler nobody
 * had approved. That is the rustup case exactly, and rust-toolchain.toml is
 * folded for it.
 *
 * Folding go.mod whole means a dependency bump costs a re-approval, which is a
 * real cost and is accepted: `toolchain` and `require` live in one file here
 * where rust keeps them in two, so covering the first without the second would
 * mean parsing, and a parser this module wrote is one more place for a
 * difference to go missing. Too wide costs a re-approval; too narrow ran a
 * downloaded compiler.
 *
 * `go.work` decides which modules `./...` reaches. `.go-version` is read by the
 * version managers, as elsewhere. `go.sum` is left out: it pins the code a
 * command reaches, which no declaration digest can cover.
 */
const GO_CONFIG_FILES = ["go.mod", "go.work", ".go-version"];

function detectRust(ctx: ProjectContext, basis: string[]): DetectedCheck[] {
  if (!exists(ctx.dir, "Cargo.toml") || !which("cargo")) return [];
  const payload = payloadFor(ctx, undefined, RUST_CONFIG_FILES);
  if (payload === null) return [];
  return [
    {
      id: "rust.fmt",
      label: "rust format",
      ecosystem: "rust",
      command: "cargo fmt --check",
      payload,
      basis,
    },
    {
      id: "rust.clippy",
      label: "rust lint",
      ecosystem: "rust",
      command: "cargo clippy --all-targets -- -D warnings",
      payload,
      basis,
    },
    {
      id: "rust.test",
      label: "rust tests",
      ecosystem: "rust",
      command: "cargo test",
      payload,
      basis,
    },
  ];
}

/**
 * Every sidecar file each ecosystem arm folds, keyed by the `ecosystem` string
 * the arm stamps on its checks.
 *
 * Exported so the property can be checked mechanically rather than recited. The
 * defect this exists to catch is not a wrong list, it is an arm that quietly
 * has none: the node arm folded no sidecar file at all and the go arm folded
 * one that is absent from almost every Go repository, so its payload was a
 * constant, while python and rust folded theirs. That asymmetry was visible in
 * the source and nobody was looking for it.
 *
 * WHAT THE KEY TYPE IS DOING, and it is the whole point of this declaration.
 * `Ecosystem` is a closed union and this is a `Record` over it, so an arm added
 * without a file set is a COMPILE ERROR at this line rather than a test nobody
 * wrote. The walking test that reads this file catches an arm whose list is
 * EMPTY; it never caught an arm that was MISSING, because it walked this object
 * and an absent arm is absent from it too. A test cannot see what is not there.
 * The type can, so the guard was moved to where it holds: the union is the one
 * place an ecosystem name is minted, and every arm below stamps a value from it.
 */
export const DECLARATION_FILES: Record<Ecosystem, readonly string[]> = {
  node: NODE_CONFIG_FILES,
  python: [...new Set(Object.values(PYTHON_CONFIG_FILES).flat())],
  rust: RUST_CONFIG_FILES,
  go: GO_CONFIG_FILES,
};

/** The version-manager files every arm folds, whatever else it folds. */
export const SHARED_TOOLCHAIN_FILES: readonly string[] = TOOLCHAIN_FILES;

/**
 * Git's own steering files, folded by every arm.
 *
 * Git is the one program this module runs on an unapproved repository's behalf
 * whatever ecosystem it is, so what the repository tells git to run is a
 * declaration in exactly the sense the membership test means. `.git/config` is
 * folded alongside these at the repository root; it is not listed here because
 * it is not resolved per directory and the walk that drives this export is.
 */
export const SHARED_GIT_FILES: readonly string[] = [".gitattributes"];

function detectGo(ctx: ProjectContext, basis: string[]): DetectedCheck[] {
  if (!exists(ctx.dir, "go.mod") || !which("go")) return [];
  const payload = payloadFor(ctx, undefined, GO_CONFIG_FILES);
  if (payload === null) return [];
  return [
    {
      id: "go.vet",
      label: "go vet",
      ecosystem: "go",
      command: "go vet ./...",
      payload,
      basis,
    },
    {
      id: "go.test",
      label: "go tests",
      ecosystem: "go",
      command: "go test ./...",
      payload,
      basis,
    },
  ];
}

/**
 * Directories never descended into when looking for projects. Build output and
 * vendored dependencies carry manifests that belong to somebody else.
 */
const NEVER_DESCEND = new Set([
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  "out",
  ".git",
  "venv",
  ".venv",
  "__pycache__",
  "third_party",
  "site-packages",
]);

/** Directories that conventionally hold a repository's projects. */
const WORKSPACE_DIRS = new Set([
  "packages",
  "apps",
  "services",
  "crates",
  "libs",
  "modules",
  "projects",
]);

/** Upper bound on projects reported, so a pathological tree cannot run away. */
const MAX_PROJECTS = 25;

/**
 * Upper bound on directories a detection pass will even LOOK in.
 *
 * MAX_PROJECTS bounds what is reported, which is not the same bound and was
 * being asked to serve as both. A repository root holding twenty thousand
 * directories yields no projects at all and so never reaches that ceiling,
 * while every one of those directories has already been opened, had four
 * manifests looked for in it, and had its sidecar files digested. The number of
 * directories a repository contains is the repository's to choose, so the walk
 * needs a ceiling of its own.
 */
const MAX_CANDIDATE_DIRS = 512;

/**
 * Upper bound on entries taken from ONE directory listing.
 *
 * MAX_CANDIDATE_DIRS bounds how many directories are looked in; it does not
 * bound the listing that feeds it, and the number of entries in one directory
 * is the repository's to choose. The whole listing still has to be read to be
 * filtered, so this bounds what is CARRIED rather than what is read, and a
 * directory of a million entries costs one readdir instead of one readdir plus
 * a million-element filter, map and sort.
 */
const MAX_DIR_ENTRIES = 4096;

function childDirectories(abs: string): string[] {
  try {
    const names: string[] = [];
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (names.length >= MAX_DIR_ENTRIES) break;
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || NEVER_DESCEND.has(entry.name)) continue;
      names.push(entry.name);
    }
    return names.sort();
  } catch {
    return [];
  }
}

/**
 * Directories to look for a manifest in: the repository root, each immediate
 * child, and one level deeper inside a directory that conventionally holds
 * projects. This covers a single-project repository and the common
 * several-projects-in-one layouts without walking the whole tree.
 */
function candidateDirs(repoRoot: string): string[] {
  const dirs = [""];
  for (const child of childDirectories(repoRoot)) {
    if (dirs.length >= MAX_CANDIDATE_DIRS) return dirs;
    dirs.push(child);
    if (!WORKSPACE_DIRS.has(child)) continue;
    for (const grandchild of childDirectories(path.join(repoRoot, child))) {
      if (dirs.length >= MAX_CANDIDATE_DIRS) return dirs;
      dirs.push(path.posix.join(child, grandchild));
    }
  }
  return dirs;
}

/**
 * Checks for one project directory.
 * The basis is scoped to that directory, so a change in one project does not
 * discard another project's verdicts.
 */
function detectIn(repoRoot: string, workdir: string): RepoCheck[] {
  const ctx = projectContext(repoRoot, workdir);
  // `:(literal)` on the project directory, because the rest of this list is
  // deliberate pathspec magic and git cannot tell the two apart. A directory
  // named `:(exclude)src` is a legal directory name on Linux, and interpolated
  // raw it would be read as an instruction rather than as the path it is,
  // silently changing which content the verdict is keyed on. The exclusions
  // below stay magic because they are this module's own.
  const basis =
    workdir === ""
      ? [...BASIS_EXCLUSIONS]
      : [`:(literal)${workdir}`, ...BASIS_EXCLUSIONS];

  const found = [
    ...detectNode(ctx, basis),
    ...detectPython(ctx, basis),
    ...detectRust(ctx, basis),
    ...detectGo(ctx, basis),
  ];

  if (workdir === "") return found.map((c) => ({ ...c, workdir }));
  // Qualify the id and label so two projects with a test script stay distinct.
  return found.map((c) => ({
    ...c,
    id: `${c.id}@${workdir}`,
    label: `${c.label} (${workdir})`,
    workdir,
  }));
}

/**
 * Every check this repository supports, in run order.
 * An empty result means nothing was recognised, which the caller reports as
 * exactly that rather than inventing a check to fill the silence.
 */
export function detectChecks(repoRoot: string): RepoCheck[] {
  const checks: RepoCheck[] = [];
  const projects = new Set<string>();
  for (const dir of candidateDirs(repoRoot)) {
    const found = detectIn(repoRoot, dir);
    if (found.length === 0) continue;
    if (projects.size >= MAX_PROJECTS) break;
    projects.add(dir);
    checks.push(...found);
  }
  return checks;
}
