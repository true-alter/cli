/**
 * `prompt_install` verb.
 *
 * Destructive - installs the ALTER Starship / PS1 shell prompt. v1
 * surfaces the install command in the terminal under the
 * confirmation gate; the actual installer ships separately.
 *
 * Body: { shell?: "starship" | "ps1" }
 */

import {
  ERR_CONFIRMATION_DECLINED,
  ERR_INVALID_BODY,
  type BridgeContext,
  type BridgeRequest,
  type BridgeResponse,
} from "../types.js";
import { isObject } from "../validators.js";

interface PromptInstallBody {
  shell: "starship" | "ps1";
}

function parseBody(raw: unknown): PromptInstallBody | null {
  if (!isObject(raw)) {
    // Allow empty body - default to starship.
    if (raw === null || raw === undefined) return { shell: "starship" };
    return null;
  }
  const shell = raw.shell;
  if (shell === undefined) return { shell: "starship" };
  if (shell !== "starship" && shell !== "ps1") return null;
  return { shell };
}

export default async function promptInstall(
  req: BridgeRequest,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  const body = parseBody(req.body);
  if (!body) {
    return {
      ok: false,
      error: "invalid body - shell must be 'starship' or 'ps1'",
      code: ERR_INVALID_BODY,
    };
  }

  const proceed = await ctx.confirmDestructive(
    "Install ~Alter prompt to your shell?",
  );
  if (!proceed) {
    return {
      ok: false,
      error: "user declined confirmation",
      code: ERR_CONFIRMATION_DECLINED,
    };
  }

  process.stdout.write(
    `\nRun this to complete: alter prompt install\n\n`,
  );

  ctx.logger.info("prompt_install surfaced instruction", {
    shell: body.shell,
  });
  return {
    ok: true,
    result: { shell: body.shell, surfaced: true },
  };
}
