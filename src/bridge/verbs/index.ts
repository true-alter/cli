/**
 * Verb dispatch registry.
 *
 * Single source of truth for `verb -> handler`. Server dispatches
 * against this map; an entry missing here = the verb is effectively
 * disabled regardless of whether it's listed in ALLOWED_VERBS.
 */

import type { BridgeVerb, VerbHandler } from "../types.js";

import cosmeticsInscribe from "./cosmetics-inscribe.js";
import forget from "./forget.js";
import health from "./health.js";
import pairDiscord from "./pair-discord.js";
import pairGithub from "./pair-github.js";
import pairIsni from "./pair-isni.js";
import pairOrcid from "./pair-orcid.js";
import pairWebsite from "./pair-website.js";
import promptInstall from "./prompt-install.js";
import walletAttest from "./wallet-attest.js";
import walletAttestRevoke from "./wallet-attest-revoke.js";
import walletRegister from "./wallet-register.js";
import wire from "./wire.js";

export const VERB_HANDLERS: Record<BridgeVerb, VerbHandler> = {
  pair_github: pairGithub,
  pair_discord: pairDiscord,
  pair_website: pairWebsite,
  pair_orcid: pairOrcid,
  pair_isni: pairIsni,
  wallet_attest: walletAttest,
  wallet_attest_revoke: walletAttestRevoke,
  wallet_register: walletRegister,
  wire: wire,
  prompt_install: promptInstall,
  cosmetics_inscribe: cosmeticsInscribe,
  forget: forget,
  health: health,
};
