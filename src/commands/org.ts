/**
 * `alter org <subcommand>` - org membership management.
 *
 * Implements the local half of the membership-write path: one ~handle is
 * concurrently a member of N orgs, Discord-shape federation,
 * independent per-org role/tier/peers/context. Surfaces:
 *
 *   alter org list                   - list current memberships
 *   alter org join <domain>          - add an org membership
 *   alter org leave <domain>         - remove the local membership record
 *
 * Today the verb writes the local session.json.orgs[] array only.
 * The remote write - registering the membership with the target Org
 * Alter's roster + obtaining a real tier assignment via handshake -
 * is the second half and lands when the org MCP exposes a
 * `org_alter_membership_add` tool. Until then the verb tags new
 * memberships as tier="observer" with role="member" and prints a
 * one-line note that remote registration is deferred.
 *
 * `leave` is the same half of the same path, and says so in the same
 * way. It removes the local record and reports exactly that; the org's
 * roster is a substrate it never reads, so it makes no claim about
 * what that roster holds, in either direction.
 *
 * DNS discovery accepts both conformant record generations of the org
 * DNS discovery record format: the `_org-alter.<domain>`
 * identity-bootstrap record (v02+) and the organisational
 * `_alter.<domain>` record (v=alter1 with org=). A domain publishing
 * neither is rejected - joining requires a discoverable org.
 * Shared resolution lives in ../lib/org-discovery.ts.
 */

import { intro, outro, log, cancel } from "@clack/prompts";
import chalk from "chalk";

import {
  type AlterSession,
  type OrgMembership,
  failNotLoggedIn,
  NOT_LOGGED_IN_MESSAGE,
  readSession,
  writeSession,
} from "../auth.js";
import { discoverOrgAlter } from "../lib/org-discovery.js";

const SUBCOMMANDS = ["list", "join", "leave"] as const;
type Sub = (typeof SUBCOMMANDS)[number];

export async function org(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    return;
  }

  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    console.error(chalk.red(`unknown subcommand: ${sub}`));
    printHelp();
    process.exitCode = 1;
    return;
  }

  switch (sub as Sub) {
    case "list":
      await listMemberships();
      break;
    case "join":
      await joinOrg(args[1]);
      break;
    case "leave":
      await leaveOrg(args[1]);
      break;
  }
}

function printHelp(): void {
  console.log(`alter org <subcommand>

Manage org memberships for the current ~handle.

  list                        list local membership records
  join <domain>               add a local membership record (e.g. example.com)
  leave <domain>              remove a local membership record

Memberships are stored in the local session (OS secure store) under
the 'orgs' array and survive re-login. The remote half of membership
registration (writing into the org's roster) is deferred until
the matching MCP tool ships; today these verbs read and write locally
only, and none of them tells you what an org's own roster holds.`);
}

async function listMemberships(): Promise<void> {
  const session = readSession();
  if (!session) {
    failNotLoggedIn();
    return;
  }

  if (!session.orgs || session.orgs.length === 0) {
    console.log(chalk.dim("no org memberships."));
    return;
  }

  console.log(chalk.bold(`memberships for ${session.handle}:`));
  for (const m of session.orgs) {
    const handle = domainToHandle(m.domain);
    console.log(
      `  ${chalk.yellow(handle)}  ${chalk.dim(m.domain)}  role=${m.role}  tier=${m.tier}`,
    );
  }
}

async function joinOrg(domain: string | undefined): Promise<void> {
  if (!domain) {
    console.error(chalk.red("usage: alter org join <domain>"));
    process.exitCode = 1;
    return;
  }

  // Accept ~handle.tld form (~example.com) - strip the leading ~.
  const normalised = domain.replace(/^~/, "").toLowerCase();

  intro(`Joining org at ${normalised}`);

  const session = readSession();
  if (!session) {
    cancel(NOT_LOGGED_IN_MESSAGE);
    process.exitCode = 1;
    return;
  }

  if (session.orgs.some((m) => m.domain === normalised)) {
    cancel(`already a member of ${normalised}.`);
    return;
  }

  // DNS discovery - the target domain must publish an org record:
  // either the `_org-alter.<domain>` identity-bootstrap record or the
  // organisational `_alter.<domain>` record (v=alter1 with org=), both
  // conformant with the org DNS discovery record format.
  const discovered = await discoverOrgAlter(normalised);
  if (!discovered) {
    cancel(
      `no _org-alter.${normalised} or organisational _alter.${normalised} TXT record found - domain is not a discoverable org.`,
    );
    process.exitCode = 1;
    return;
  }

  log.success(
    `discovered ${chalk.yellow(domainToHandle(normalised))} via DNS (${discovered.label}.${normalised})`,
  );

  const membership: OrgMembership = {
    domain: normalised,
    role: "member",
    tier: "observer",
  };

  const next: AlterSession = {
    ...session,
    orgs: [...session.orgs, membership],
  };
  writeSession(next);

  log.success(`local membership written to session.json`);
  log.warn(
    "remote registration deferred - the org roster write lands when the matching MCP tool ships.",
  );

  outro(
    `${chalk.yellow(domainToHandle(normalised))} ${chalk.dim("(observer)")}`,
  );
}

async function leaveOrg(domain: string | undefined): Promise<void> {
  if (!domain) {
    console.error(chalk.red("usage: alter org leave <domain>"));
    process.exitCode = 1;
    return;
  }

  const normalised = domain.replace(/^~/, "").toLowerCase();

  const session = readSession();
  if (!session) {
    failNotLoggedIn();
    return;
  }

  const before = session.orgs.length;
  const filtered = session.orgs.filter((m) => m.domain !== normalised);

  // Both branches below say what was OBSERVED and nothing more. This verb sees
  // one thing, the local session record, and the org's own roster is a
  // separate substrate it never reads and never writes. Reporting a departure
  // on the strength of a local array filter is the same shape as reporting a
  // deletion because nothing threw: absence of error is not presence of
  // confirmation. The refusal in `alter consent revoke --org` is the standard
  // here, and it is applied rather than copied, because the local removal is a
  // real act worth performing. So the act happens and the claim is sized to it.
  if (filtered.length === before) {
    console.log(
      chalk.dim(`no local membership for ${normalised} in this session.`),
    );
    console.log(
      chalk.dim(
        "  the organisation's own roster is not read by this command, so this is not\n" +
          "  a statement about whether it holds you.",
      ),
    );
    return;
  }

  writeSession({ ...session, orgs: filtered });
  console.log(
    `removed local membership: ${chalk.yellow(domainToHandle(normalised))}`,
  );
  log.warn(
    "local record only - the organisation's roster is unchanged. Withdrawing from\n" +
      "  the roster itself is not available from the CLI yet, so if it holds you, it\n" +
      "  still does.",
  );
}

/** Strip the TLD to form the org handle: example.com becomes ~example. */
function domainToHandle(domain: string): string {
  const slug = domain.split(".")[0] ?? domain;
  return `~${slug}`;
}

