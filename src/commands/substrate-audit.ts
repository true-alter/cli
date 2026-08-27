/**
 * Substrate audit - a local discipline read showing the ratio of file
 * reads to live-substrate queries.
 *
 * Reads the local discipline log at
 * ~/.local/share/alter/sot-discipline.log and reports:
 *  - Total queries this session (if session ID detectable)
 *  - File reads
 *  - Live-substrate queries
 *  - Ratio + health indicator
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import chalk from "chalk";

import { brand } from "../ui/biosMenu.js";

interface AuditEntry {
  ts: string;
  session_id: string;
  kind: "memory" | "substrate" | "unknown";
  tool: string;
  detail?: string;
}

interface SessionSummary {
  sessionId: string;
  memoryReads: number;
  substrateQueries: number;
  total: number;
  ratio: number;
  health: "good" | "mixed" | "stale";
}

function logPath(): string {
  const xdg =
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "alter", "sot-discipline.log");
}

function parseLogLine(line: string): AuditEntry | null {
  // Format: ISO\tSESSION_ID\tKIND\tTOOL[\tDETAIL]
  const parts = line.split("\t");
  if (parts.length < 4) return null;
  const [ts, session_id, kind, tool, ...rest] = parts;
  if (!ts || !session_id || !kind || !tool) return null;
  return {
    ts,
    session_id,
    kind: kind === "memory" || kind === "substrate" ? kind : "unknown",
    tool,
    detail: rest.join("\t") || undefined,
  };
}

function summariseSessions(entries: AuditEntry[]): Map<string, SessionSummary> {
  const sessions = new Map<string, SessionSummary>();
  for (const e of entries) {
    let s = sessions.get(e.session_id);
    if (!s) {
      s = {
        sessionId: e.session_id,
        memoryReads: 0,
        substrateQueries: 0,
        total: 0,
        ratio: 0,
        health: "good",
      };
      sessions.set(e.session_id, s);
    }
    s.total++;
    if (e.kind === "memory") s.memoryReads++;
    else if (e.kind === "substrate") s.substrateQueries++;
  }

  for (const s of sessions.values()) {
    if (s.total > 0) {
      s.ratio = s.substrateQueries / s.total;
    }
    if (s.ratio >= 0.7) s.health = "good";
    else if (s.ratio >= 0.4) s.health = "mixed";
    else s.health = "stale";
  }
  return sessions;
}

function healthGlyph(h: SessionSummary["health"]): string {
  switch (h) {
    case "good":
      return chalk.green("OK");
    case "mixed":
      return chalk.yellow("~~");
    case "stale":
      return chalk.red("!!");
  }
}

export async function substrateAudit(): Promise<void> {
  const logFile = logPath();

  process.stdout.write("\n");
  process.stdout.write(
    "  " + brand.titleDim("substrate discipline") + "\n\n",
  );

  if (!fs.existsSync(logFile)) {
    process.stdout.write(
      "  " + brand.faint("no discipline log found.") + "\n" +
        "  " + brand.faint("the log is written by the local development tooling.") + "\n\n",
    );
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(logFile, "utf-8");
  } catch {
    process.stdout.write(
      "  " + brand.accentDeep("could not read ") +
        brand.text(logFile) + "\n\n",
    );
    return;
  }

  const lines = content.trim().split("\n").filter(Boolean);
  const entries = lines
    .map(parseLogLine)
    .filter((e): e is AuditEntry => e !== null);

  if (entries.length === 0) {
    process.stdout.write(
      "  " + brand.faint("log exists but has no parsed entries.") + "\n\n",
    );
    return;
  }

  const sessions = summariseSessions(entries);

  // Show the 5 most recent sessions
  const sorted = Array.from(sessions.values()).sort((a, b) => {
    const aLast = entries.filter((e) => e.session_id === a.sessionId).pop();
    const bLast = entries.filter((e) => e.session_id === b.sessionId).pop();
    return (bLast?.ts ?? "").localeCompare(aLast?.ts ?? "");
  });

  const recent = sorted.slice(0, 5);

  process.stdout.write(
    "  " + brand.dim("session".padEnd(12)) +
      brand.dim("substrate".padEnd(12)) +
      brand.dim("memory".padEnd(10)) +
      brand.dim("ratio".padEnd(8)) +
      brand.dim("health") + "\n",
  );

  for (const s of recent) {
    const sid = s.sessionId.slice(0, 8);
    const ratio = s.total > 0 ? `${Math.round(s.ratio * 100)}%` : "-";
    process.stdout.write(
      "  " + brand.text(sid.padEnd(12)) +
        brand.text(String(s.substrateQueries).padEnd(12)) +
        brand.text(String(s.memoryReads).padEnd(10)) +
        brand.text(ratio.padEnd(8)) +
        healthGlyph(s.health) + "\n",
    );
  }

  // Aggregate
  const totalMemory = entries.filter((e) => e.kind === "memory").length;
  const totalSubstrate = entries.filter((e) => e.kind === "substrate").length;
  const totalAll = entries.length;
  const aggRatio = totalAll > 0 ? totalSubstrate / totalAll : 0;

  process.stdout.write("\n");
  process.stdout.write(
    "  " + brand.titleDim("aggregate") +
      brand.dim(` (${sorted.length} sessions, ${totalAll} events)`) + "\n" +
      "    " + brand.text("substrate queries: ") + brand.accent(String(totalSubstrate)) + "\n" +
      "    " + brand.text("memory reads:      ") + brand.accent(String(totalMemory)) + "\n" +
      "    " + brand.text("substrate ratio:   ") +
      (aggRatio >= 0.7
        ? chalk.green(`${Math.round(aggRatio * 100)}%`)
        : aggRatio >= 0.4
          ? chalk.yellow(`${Math.round(aggRatio * 100)}%`)
          : chalk.red(`${Math.round(aggRatio * 100)}%`)) + "\n",
  );

  process.stdout.write("\n");
  if (aggRatio >= 0.7) {
    process.stdout.write(
      "  " + brand.faint("live substrate is the primary query path. file reads are within expected bounds.") + "\n",
    );
  } else if (aggRatio >= 0.4) {
    process.stdout.write(
      "  " + brand.faint("mixed - some sessions rely on file reads over live substrate. review recent sessions.") + "\n",
    );
  } else {
    process.stdout.write(
      "  " + brand.faint("stale - file reads dominate. live substrate should be the primary query path.") + "\n",
    );
  }
  process.stdout.write("\n");
}
