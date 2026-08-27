/**
 * `cosmetics_inscribe` verb.
 *
 * Destructive - writes `~/.config/alter/cosmetics.json` atomically
 * with the chosen palette + sigil. Terminal confirmation gate
 * required. Atomic write = tmp + rename to avoid a half-written
 * cosmetics file under concurrent CLI sessions.
 *
 * Body: { palette: string, sigil: string }
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { ALTER_CONFIG_DIR } from "../../auth.js";
import {
  ERR_CONFIRMATION_DECLINED,
  ERR_INTERNAL,
  ERR_INVALID_BODY,
  type BridgeContext,
  type BridgeRequest,
  type BridgeResponse,
} from "../types.js";
import { isObject } from "../validators.js";

interface CosmeticsBody {
  palette: string;
  sigil: string;
}

const PALETTE_RE = /^[a-z0-9_-]{1,64}$/i;
const SIGIL_RE = /^[a-z0-9_-]{1,64}$/i;

function parseBody(raw: unknown): CosmeticsBody | null {
  if (!isObject(raw)) return null;
  if (typeof raw.palette !== "string" || !PALETTE_RE.test(raw.palette)) {
    return null;
  }
  if (typeof raw.sigil !== "string" || !SIGIL_RE.test(raw.sigil)) {
    return null;
  }
  return { palette: raw.palette, sigil: raw.sigil };
}

const COSMETICS_FILE = path.join(ALTER_CONFIG_DIR, "cosmetics.json");

export default async function cosmeticsInscribe(
  req: BridgeRequest,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  const body = parseBody(req.body);
  if (!body) {
    return {
      ok: false,
      error:
        "invalid body - palette + sigil required, [A-Za-z0-9_-]{1,64} each",
      code: ERR_INVALID_BODY,
    };
  }

  const proceed = await ctx.confirmDestructive(
    "Inscribe palette/sigil to ~/.config/alter/cosmetics.json?",
  );
  if (!proceed) {
    return {
      ok: false,
      error: "user declined confirmation",
      code: ERR_CONFIRMATION_DECLINED,
    };
  }

  try {
    fs.mkdirSync(ALTER_CONFIG_DIR, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify(
      {
        palette: body.palette,
        sigil: body.sigil,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    );
    const tmp = `${COSMETICS_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, payload, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, COSMETICS_FILE);
    fs.chmodSync(COSMETICS_FILE, 0o600);
    ctx.logger.info("cosmetics inscribed", {
      palette: body.palette,
      sigil: body.sigil,
    });
    return {
      ok: true,
      result: {
        palette: body.palette,
        sigil: body.sigil,
      },
    };
  } catch (err) {
    ctx.logger.error("cosmetics_inscribe exception", {
      message: (err as Error).message,
    });
    return {
      ok: false,
      error: "failed to write cosmetics file",
      code: ERR_INTERNAL,
    };
  }
}
