#!/usr/bin/env node
/**
 * onboarding/dry-run - read local signals, classify archetype, and render
 * beat 1 against the current machine WITHOUT touching the network, the
 * session file, or any cache.
 *
 * Intended for:
 *   1. First-pass verification that signals + classifier + render
 *      behave correctly on a developer machine.
 *   2. Copy-review workflow: `node dist/onboarding/dry-run.js --all` to
 *      render every archetype's top observation in sequence.
 *
 * Usage:
 *   node dist/onboarding/dry-run.js                       # pick for this machine
 *   node dist/onboarding/dry-run.js --all                 # render all archetypes
 *   node dist/onboarding/dry-run.js --audit               # dump signal summary
 *   node dist/onboarding/dry-run.js --archetype polyglot  # force one archetype
 *
 * History: orientation renderer removed; student archetype retired.
 * Beat 1 is now exactly two lines per observation.
 */

import { readProfile, summariseProfile } from "./signals.js";
import { classify, pickPrimaryArchetype, type Archetype } from "./archetypes.js";
import { pickObservation, profileSeed } from "./beats.js";
import { body, renderAudit, speakerTag } from "./render.js";

const args = process.argv.slice(2);

function printHeader(label: string): void {
  process.stdout.write("\n");
  process.stdout.write("─".repeat(60) + "\n");
  process.stdout.write(label + "\n");
  process.stdout.write("─".repeat(60) + "\n\n");
}

function renderOne(archetype: Archetype, profile: ReturnType<typeof readProfile>, skipCombos = false): void {
  const obs = pickObservation(archetype, profile, null, { skipCombos });
  speakerTag();
  body(obs.body);
  process.stdout.write(`  [archetype=${archetype}, id=${obs.id}, source=${obs.source}]\n\n`);
}

async function main(): Promise<void> {
  const profile = readProfile();

  if (args.includes("--audit")) {
    renderAudit(summariseProfile(profile));
    return;
  }

  if (args.includes("--all")) {
    const archetypes: Archetype[] = [
      "polyglot",
      "claude-code-user",
      "dotfiles-curator",
      "fresh-machine",
      "long-timer",
      "fallback",
    ];
    for (const a of archetypes) {
      printHeader(`archetype: ${a} (combos skipped)`);
      renderOne(a, profile, true);
    }
    return;
  }

  const forcedIdx = args.indexOf("--archetype");
  if (forcedIdx !== -1 && args[forcedIdx + 1]) {
    const forced = args[forcedIdx + 1] as Archetype;
    printHeader(`forced: ${forced}`);
    renderOne(forced, profile);
    return;
  }

  // Default: classify this machine, show the primary archetype + matches.
  const matches = classify(profile);
  printHeader("signal summary");
  for (const line of summariseProfile(profile)) {
    process.stdout.write(line + "\n");
  }
  process.stdout.write(`\n  signalCount = ${profile.signalCount}\n`);

  printHeader("archetype matches (ordered by strength)");
  for (const m of matches) {
    process.stdout.write(
      `  ${m.archetype.padEnd(20)} strength=${m.strength.toString().padStart(3)}  ${m.reason}\n`,
    );
  }

  const primary = pickPrimaryArchetype(matches, profileSeed(profile));
  printHeader(`primary archetype: ${primary}`);
  renderOne(primary, profile);
}

main().catch((err) => {
  process.stderr.write(`dry-run: ${err.message ?? err}\n`);
  // Soft exit: let the event loop drain cleanly on Windows.
  process.exitCode = 1;
});
