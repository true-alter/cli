/**
 * Shared check-report primitives for `alter doctor`, `alter creds doctor`,
 * and future per-subsystem diagnostics.
 *
 * Shared so every diagnostic surface uses one renderer instead of three
 * divergent implementations.
 *
 * HARD BAN on emoji. Status tokens [OK]/[WARN]/[FAIL] are pipe-safe ASCII.
 * Australian English in comments; US English in identifiers.
 */

// ---------------------------------------------------------------------------
// Core status types
// ---------------------------------------------------------------------------

export type Status = "OK" | "FAIL" | "WARN";

export interface CheckLine {
  status: Status;
  label: string;
  detail?: string;
  remedy?: string;
}

/** Fixed-width status tag. Pipe-safe -- no ANSI, no emoji. */
export function tag(status: Status): string {
  return `[${status}]`.padEnd(7);
}

/** Print a single check line. */
export function print(line: CheckLine): void {
  const head = `${tag(line.status)} ${line.label}`;
  if (line.detail) {
    console.log(`${head} -- ${line.detail}`);
  } else {
    console.log(head);
  }
  if (line.remedy) {
    console.log(`        Fix: ${line.remedy}`);
  }
}

/** Reduce a list of checks to a summary status. */
export function summarise(checks: CheckLine[]): Status {
  if (checks.some((c) => c.status === "FAIL")) return "FAIL";
  if (checks.some((c) => c.status === "WARN")) return "WARN";
  return "OK";
}

// ---------------------------------------------------------------------------
// Doctor-specific extension types
// ---------------------------------------------------------------------------

/**
 * Heal class for a check.
 *
 *   SAFE-AUTOHEAL   -- non-destructive local repair; applied automatically
 *                      under `--fix` (create dirs, chmod, re-link hooks,
 *                      config enum fixes).
 *   CONFIRM-FIRST   -- interactive prompt required (session clear, re-pair).
 *                      In headless/no-TTY contexts, skipped and reported.
 *   DIAGNOSE-ONLY   -- doctor never mutates; prints the remedy and routes the
 *                      member to the appropriate subcommand. Keys are always
 *                      DIAGNOSE-ONLY for missing/corrupt -- doctor never
 *                      regenerates signing or x25519 keys (would break
 *                      existing signatures + grants).
 */
export type HealClass = "SAFE-AUTOHEAL" | "CONFIRM-FIRST" | "DIAGNOSE-ONLY";

/** One of the diagnostic categories. */
export type Category =
  | "identity"
  | "mcp"
  | "runtime"
  | "config"
  | "pairing"
  | "repo";

/** Result returned by a check's `run()` method. */
export interface CheckResult {
  status: Status;
  detail?: string;
  remedy?: string;
}

/** Result returned by a check's `heal()` method. */
export interface HealResult {
  applied: boolean;
  status: Status;
  detail?: string;
}

/**
 * Runtime context threaded into every check.
 * Keep minimal -- checks should not rely on injected state they could
 * read directly; this is for testability and timeout control only.
 */
export interface DoctorCtx {
  /** Current process platform -- used to skip POSIX-only permission checks. */
  platform: NodeJS.Platform;
  /** Unix timestamp (ms) at which the doctor run started. */
  now: number;
  /** Per-check network timeout in milliseconds (default 3000). */
  timeoutMs: number;
}

/** Full check descriptor in the registry. */
export interface Check {
  /** Dotted id: category.check-name, e.g. "identity.session-present". */
  id: string;
  category: Category;
  label: string;
  healClass: HealClass;
  /**
   * When true, this check performs a network or socket call and is skipped
   * under `--quick`. Local-only checks omit this field (treated as false).
   */
  live?: boolean;
  run(ctx: DoctorCtx): Promise<CheckResult>;
  /** Only defined when healClass != "DIAGNOSE-ONLY". */
  heal?(ctx: DoctorCtx): Promise<HealResult>;
}

// ---------------------------------------------------------------------------
// Completed check record (stored after running)
// ---------------------------------------------------------------------------

export interface CompletedCheck {
  check: Check;
  result: CheckResult;
  /** True when heal() was called and applied. */
  healed?: boolean;
  /** State after heal re-run (only set when healed is true). */
  afterHeal?: CheckResult;
  /** True when the check timed out (live probe unreachable). */
  timedOut?: boolean;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/**
 * Human-readable output.
 *
 * Default (verbose=false): category summary lines + failing/warn detail block.
 * verbose=true: also lists every passing check + the id it read.
 */
export function renderHuman(
  completed: CompletedCheck[],
  opts: { verbose: boolean },
): void {
  // Group by category.
  const categories: Category[] = [
    "identity",
    "mcp",
    "runtime",
    "config",
    "pairing",
    "repo",
  ];
  const byCat = new Map<Category, CompletedCheck[]>();
  for (const cat of categories) byCat.set(cat, []);
  for (const c of completed) {
    const bucket = byCat.get(c.check.category);
    if (bucket) bucket.push(c);
  }

  const total = completed.length;
  const activeCategories = categories.filter(
    (cat) => (byCat.get(cat)?.length ?? 0) > 0,
  );
  console.log(
    `\nalter doctor -- ${activeCategories.length} categories, ${total} checks\n`,
  );

  // Category summary lines.
  for (const cat of activeCategories) {
    const checks = byCat.get(cat)!;
    const effectiveResults = checks.map(
      (c) => (c.healed && c.afterHeal ? c.afterHeal : c.result),
    );
    const catStatus: Status = effectiveResults.some((r) => r.status === "FAIL")
      ? "FAIL"
      : effectiveResults.some((r) => r.status === "WARN")
        ? "WARN"
        : "OK";
    const okCount = effectiveResults.filter((r) => r.status === "OK").length;
    const detail = catStatus !== "OK"
      ? "  " +
        checks
          .filter(
            (c) =>
              (c.healed && c.afterHeal
                ? c.afterHeal.status
                : c.result.status) !== "OK",
          )
          .map((c) => c.result.detail ?? c.check.label)
          .slice(0, 1)
          .join(", ")
      : "";
    console.log(
      `${cat.padEnd(10)} ${tag(catStatus)}  ${okCount}/${checks.length}${detail}`,
    );
  }

  // Failing/warn detail block.
  const needsDetail = completed.filter((c) => {
    const effective = c.healed && c.afterHeal ? c.afterHeal : c.result;
    return effective.status !== "OK";
  });

  if (needsDetail.length > 0) {
    console.log();
    for (const c of needsDetail) {
      const effective = c.healed && c.afterHeal ? c.afterHeal : c.result;
      console.log(
        `${tag(effective.status).trim()}  ${c.check.id.padEnd(30)} ${effective.detail ?? c.check.label}`,
      );
      if (effective.remedy) {
        console.log(`      -> ${effective.remedy}`);
      }
    }
  }

  // Verbose: also list passing checks.
  if (opts.verbose) {
    const passing = completed.filter((c) => {
      const effective = c.healed && c.afterHeal ? c.afterHeal : c.result;
      return effective.status === "OK";
    });
    if (passing.length > 0) {
      console.log();
      for (const c of passing) {
        const effective = c.healed && c.afterHeal ? c.afterHeal : c.result;
        console.log(
          `${tag("OK").trim()}  ${c.check.id.padEnd(30)} ${effective.detail ?? c.check.label}`,
        );
      }
    }
  }

  // Summary line.
  console.log();
  const failCount = needsDetail.filter(
    (c) =>
      (c.healed && c.afterHeal ? c.afterHeal.status : c.result.status) ===
      "FAIL",
  ).length;
  const warnCount = needsDetail.filter(
    (c) =>
      (c.healed && c.afterHeal ? c.afterHeal.status : c.result.status) ===
      "WARN",
  ).length;
  const healableCount = completed.filter(
    (c) =>
      c.result.status !== "OK" &&
      !c.healed &&
      c.check.healClass === "SAFE-AUTOHEAL",
  ).length;

  const parts: string[] = [];
  if (failCount > 0) parts.push(`${failCount} failed`);
  if (warnCount > 0) parts.push(`${warnCount} warning${warnCount > 1 ? "s" : ""}`);

  if (parts.length === 0) {
    console.log("All checks passed.");
  } else {
    let summary = parts.join(", ") + ".";
    if (healableCount > 0) {
      summary += ` Run \`alter doctor --fix\` to repair the ${healableCount} auto-fixable item${healableCount > 1 ? "s" : ""}.`;
    }
    console.log(summary);
  }
}

/**
 * JSON envelope matching schemas/doctor-report.schema.json.
 *
 * Fields: version, generated_at, summary{ok,warn,fail}, exit_code,
 *         checks[{id,category,label,status,detail,remedy,heal_class,healed?}].
 */
export function renderJson(completed: CompletedCheck[]): object {
  const summary = { ok: 0, warn: 0, fail: 0 };
  const checks = completed.map((c) => {
    const effective = c.healed && c.afterHeal ? c.afterHeal : c.result;
    if (effective.status === "OK") summary.ok++;
    else if (effective.status === "WARN") summary.warn++;
    else summary.fail++;

    const entry: Record<string, unknown> = {
      id: c.check.id,
      category: c.check.category,
      label: c.check.label,
      status: effective.status,
      heal_class: c.check.healClass,
    };
    if (effective.detail !== undefined) entry.detail = effective.detail;
    if (effective.remedy !== undefined) entry.remedy = effective.remedy;
    if (c.healed !== undefined) entry.healed = c.healed;
    return entry;
  });

  const exitCode =
    summary.fail > 0 ? 1 : 0;

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    summary,
    exit_code: exitCode,
    checks,
  };
}

/**
 * Map a completed run to an exit code.
 *   0 -- all OK or warnings only
 *   1 -- at least one FAIL
 * (Exit code 2 -- doctor itself failed -- is set by the command dispatcher,
 * not by this helper.)
 */
export function exitCodeFor(completed: CompletedCheck[]): number {
  const anyFail = completed.some((c) => {
    const effective = c.healed && c.afterHeal ? c.afterHeal : c.result;
    return effective.status === "FAIL";
  });
  return anyFail ? 1 : 0;
}
