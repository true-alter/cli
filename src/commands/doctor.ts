/**
 * alter doctor -- environment diagnose + self-heal.
 *
 *   alter doctor [--fix] [--quick] [--only <category>[,<cat>...]]
 *                [--output-format json] [--verbose] [-h]
 *
 * Runs every local and live diagnostic in the registry concurrently with a
 * hard ~3s per-check timeout. Live probes that time out degrade to WARN
 * instead of hanging. Use `--quick` to skip live probes.
 *
 * Exit codes:
 *   0  all OK, or warnings only
 *   1  at least one FAIL (after any --fix attempt)
 *   2  doctor itself could not run
 *
 * Heal classes under --fix:
 *   SAFE-AUTOHEAL   applied automatically
 *   CONFIRM-FIRST   prompts y/N (skipped in headless/no-TTY)
 *   DIAGNOSE-ONLY   never mutated; remedy is printed
 *
 * Policy enforced:
 *   - local-only reads (no phone-home from identity diagnostics)
 *   - keys are DIAGNOSE-ONLY (missing/corrupt: route to `alter login`)
 *   - heal-class boundary: identity-destructive mutations blocked
 *   - diagnose and heal are decoupled; --fix is opt-in
 *
 * A separate subcommand lives under this same verb:
 *
 *   alter doctor loom <path> [--json] [--no-write]
 *
 * `loom` diagnoses an arbitrary folder rather than the Alter install itself
 * (change detection + verdict checks, no version control needed), so it is
 * dispatched before the flag parser below rather than folded into the
 * concurrent check registry. See src/doctor/loom.ts.
 */

import * as readline from "node:readline";

import {
  parseOutputFormatFlag,
  isHeadless,
} from "../lib/output-format.js";
import {
  renderHuman,
  renderJson,
  exitCodeFor,
  type Category,
  type Check,
  type CheckResult,
  type CompletedCheck,
  type DoctorCtx,
  type HealClass,
} from "../lib/check-report.js";
import { buildRegistry, filterByCategory } from "../doctor/registry.js";
import { doctorLoom } from "../doctor/loom.js";
import { brand, withKeyListenerCancel } from "../ui/biosMenu.js";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const VALID_CATEGORIES: Category[] = [
  "identity",
  "mcp",
  "runtime",
  "config",
  "pairing",
  "repo",
];

interface DoctorArgs {
  fix: boolean;
  quick: boolean;
  only: Category[] | null;
  json: boolean;
  verbose: boolean;
  help: boolean;
}

function parseArgs(raw: string[]): { args: DoctorArgs; error?: string } {
  const { format, args } = parseOutputFormatFlag(raw);
  const result: DoctorArgs = {
    fix: false,
    quick: false,
    only: null,
    json: format === "json",
    verbose: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--fix":
        result.fix = true;
        break;
      case "--quick":
        result.quick = true;
        break;
      case "--verbose":
        result.verbose = true;
        break;
      case "-h":
      case "--help":
        result.help = true;
        break;
      case "--only": {
        const next = args[i + 1];
        if (!next || next.startsWith("-")) {
          return { args: result, error: "--only requires a comma-separated category list" };
        }
        i++;
        const parsed = parseOnly(next);
        if (parsed.error !== null) return { args: result, error: parsed.error };
        result.only = parsed.categories;
        break;
      }
      default:
        if (arg.startsWith("--only=")) {
          const val = arg.slice("--only=".length);
          const parsed = parseOnly(val);
          if (parsed.error !== null) return { args: result, error: parsed.error };
          result.only = parsed.categories;
        } else {
          return { args: result, error: `unknown flag: ${arg}` };
        }
    }
  }
  return { args: result };
}

function parseOnly(
  val: string,
): { categories: Category[]; error: null } | { error: string; categories: null } {
  const parts = val.split(",").map((s) => s.trim());
  const invalid = parts.filter((p) => !VALID_CATEGORIES.includes(p as Category));
  if (invalid.length > 0) {
    return {
      error: `unknown categories: ${invalid.join(", ")}. Valid: ${VALID_CATEGORIES.join(", ")}`,
      categories: null,
    };
  }
  return { categories: parts as Category[], error: null };
}

// ---------------------------------------------------------------------------
// Run engine
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Run a single check with a timeout. Live checks that exceed the timeout
 * resolve to WARN("unreachable") rather than throwing.
 */
async function runWithTimeout(
  check: Check,
  ctx: DoctorCtx,
): Promise<CheckResult> {
  const timeout = new Promise<CheckResult>((resolve) =>
    setTimeout(
      () =>
        resolve({
          status: "WARN",
          detail: "check timed out (unreachable)",
          remedy: check.id.includes("mcp")
            ? "restart the MCP bridge / client"
            : check.id.includes("runtime")
              ? "run `alter-runtime start`"
              : "check network or daemon connectivity",
        }),
      ctx.timeoutMs,
    ),
  );
  try {
    return await Promise.race([check.run(ctx), timeout]);
  } catch (err) {
    return {
      status: "FAIL",
      detail: `check threw: ${(err as Error).message}`,
    };
  }
}

/**
 * Prompt y/N interactively for a CONFIRM-FIRST heal.
 * Returns false (skip) when not on a TTY.
 */
async function confirmPrompt(label: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`  Heal "${label}"? [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

/**
 * Attempt to heal a non-OK check according to its class.
 * Returns the (possibly updated) CompletedCheck.
 */
async function attemptHeal(
  completed: CompletedCheck,
  ctx: DoctorCtx,
): Promise<CompletedCheck> {
  const { check, result } = completed;
  if (result.status === "OK") return completed;
  if (!check.heal) return completed;

  const healClass: HealClass = check.healClass;

  if (healClass === "DIAGNOSE-ONLY") {
    // Never mutate; just print the remedy.
    if (result.remedy) {
      console.log(`  ${check.id}: ${result.remedy}`);
    }
    return completed;
  }

  if (healClass === "CONFIRM-FIRST") {
    if (!process.stdin.isTTY) {
      console.log(
        `  ${check.id}: needs interactive --fix (no TTY -- skipped)`,
      );
      return completed;
    }
    const confirmed = await confirmPrompt(check.label);
    if (!confirmed) {
      console.log(`  ${check.id}: skipped (user declined)`);
      return completed;
    }
  }

  // SAFE-AUTOHEAL or confirmed CONFIRM-FIRST.
  let healResult;
  try {
    healResult = await check.heal(ctx);
  } catch (err) {
    return {
      ...completed,
      healed: false,
      afterHeal: {
        status: "FAIL",
        detail: `heal threw: ${(err as Error).message}`,
      },
    };
  }

  if (!healResult.applied) {
    return {
      ...completed,
      healed: false,
      afterHeal: {
        status: healResult.status,
        detail: healResult.detail,
      },
    };
  }

  // Re-run the check to confirm the heal worked.
  const recheck = await runWithTimeout(check, ctx);
  return {
    ...completed,
    healed: true,
    afterHeal: recheck,
  };
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function doctor(rawArgs: string[]): Promise<void> {
  // `loom` is a distinct subcommand (folder validation, not environment
  // diagnosis) - dispatch it before the environment-diagnostic flag parser
  // ever sees these args.
  if (rawArgs[0] === "loom") {
    await doctorLoom(rawArgs.slice(1));
    return;
  }

  // Parse flags.
  const { args, error } = parseArgs(rawArgs);
  if (error) {
    console.error(`alter doctor: ${error}`);
    console.error("Run `alter doctor --help` for usage.");
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }

  // Build the check context.
  const ctx: DoctorCtx = {
    platform: process.platform,
    now: Date.now(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  // Load registry, filter.
  let checks: Check[];
  try {
    const registry = buildRegistry();
    const filtered = filterByCategory(registry, args.only);
    // --quick: drop live checks.
    checks = args.quick ? filtered.filter((c) => !c.live) : filtered;
  } catch (err) {
    console.error(`alter doctor: could not build check registry: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  if (checks.length === 0) {
    console.log("alter doctor: no checks to run (all filtered out).");
    return;
  }

  // Run all checks concurrently. On an interactive TTY the run paints a
  // live "running checks… n/N  esc cancel" progress line and esc abandons
  // the wait (checks fizzle out against their own ~3s timeouts) - a slow
  // or hung probe must never freeze the screen with no way out.
  const runAllChecks = async (
    onProgress?: () => void,
  ): Promise<CompletedCheck[]> => {
    const settled = await Promise.allSettled(
      checks.map(async (check): Promise<CompletedCheck> => {
        const result = await runWithTimeout(check, ctx);
        onProgress?.();
        const timedOut =
          result.status === "WARN" && result.detail === "check timed out (unreachable)";
        return { check, result, timedOut };
      }),
    );
    return settled.map((s) => {
      if (s.status === "fulfilled") return s.value;
      // Should not happen (runWithTimeout catches everything), but handle it.
      return {
        check: checks[settled.indexOf(s)],
        result: { status: "FAIL" as const, detail: String((s as PromiseRejectedResult).reason) },
      };
    });
  };

  let completed: CompletedCheck[];
  const interactive =
    !args.json && !isHeadless() && !!process.stdout.isTTY && !!process.stdin.isTTY;
  if (interactive) {
    const total = checks.length;
    let doneCount = 0;
    const paintProgress = (): void => {
      process.stdout.write(
        "\r\x1b[2K  " +
          brand.dim(`running checks… ${doneCount}/${total}  `) +
          brand.muted("esc") +
          brand.dim(" cancel"),
      );
    };
    paintProgress();
    let abandoned = false;
    const wait = await withKeyListenerCancel((signal) => {
      const aborted = new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            abandoned = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
      return Promise.race([
        runAllChecks(() => {
          doneCount++;
          // In-flight checks keep settling after a cancel; they must not
          // keep painting over whatever screen the user escaped to.
          if (!abandoned) paintProgress();
        }),
        aborted,
      ]);
    });
    process.stdout.write("\r\x1b[2K");
    if (wait.cancelled || !wait.result) {
      process.stdout.write("  " + brand.dim("cancelled.") + "\n");
      return;
    }
    completed = wait.result;
  } else {
    completed = await runAllChecks();
  }

  // --fix: attempt heals sequentially (some heals are interactive).
  if (args.fix) {
    for (let i = 0; i < completed.length; i++) {
      completed[i] = await attemptHeal(completed[i], ctx);
    }
  }

  // Render output.
  if (args.json || isHeadless()) {
    const envelope = renderJson(completed);
    console.log(JSON.stringify(envelope, null, 2));
  } else {
    renderHuman(completed, { verbose: args.verbose });
  }

  // Set exit code.
  process.exitCode = exitCodeFor(completed);
}

function printHelp(): void {
  console.log(
    "Usage: alter doctor [--fix] [--quick] [--only <cat>[,<cat>...]] [--output-format json] [--verbose] [-h]\n" +
      "       alter doctor loom <path> [--json] [--no-write]\n" +
      "       alter doctor loom --ci [path] [--config <file>] [--json]\n" +
      "\n" +
      "Run environment diagnostics across all Alter subsystems.\n" +
      "\n" +
      "  (none)                  Read-only diagnose. All categories, concurrent, ~3s timeout.\n" +
      "  --fix                   Apply safe auto-heals; prompt for interactive ones.\n" +
      "  --quick                 Local-only fast subset (skips network/live probes).\n" +
      "  --only <cat>[,<cat>]    Restrict to named categories.\n" +
      "  --output-format json    Machine-readable JSON envelope (for CI / agents).\n" +
      "  --verbose               Show passing checks (default hides green detail).\n" +
      "  -h, --help              Print this message.\n" +
      "\n" +
      "Categories: identity, mcp, runtime, config, pairing, repo\n" +
      "\n" +
      "Exit codes: 0 all green / warnings only, 1 at least one FAIL, 2 doctor failed.\n" +
      "\n" +
      "  loom <path>             Check a folder of files for the everyday\n" +
      "                          things that quietly damage a body of records,\n" +
      "                          corrupted text, unfilled placeholders, links\n" +
      "                          that point at nothing, something that looks\n" +
      "                          like a password or card number sitting in\n" +
      "                          plain text, a file that's lost most of its\n" +
      "                          content, and duplicate copies wasting space.\n" +
      "                          Also reports what's changed since your last\n" +
      "                          run. No version control needed. Requires\n" +
      "                          Python 3 on PATH.\n" +
      "    --json                  Emit the raw JSON report.\n" +
      "    --no-write              Dry run: do not update the local baseline.\n",
  );
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export const __testing__ = {
  parseArgs,
  parseOnly,
  runWithTimeout,
  buildRegistry,
  filterByCategory,
  exitCodeFor,
  renderJson,
  VALID_CATEGORIES,
};
