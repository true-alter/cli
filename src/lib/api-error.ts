/**
 * Member-facing copy for non-2xx backend responses.
 *
 * Commands talk to the backend and occasionally get a non-2xx response.
 * The raw `(${status}): ${body}` form leaks backend internals and means
 * nothing to a member, so every command routes a failed response through
 * `apiErrorMessage`, which maps the status class to a calm, actionable
 * line. The numeric status and the raw body are appended only when ALTER
 * debug logging is on (`DEBUG=alter`), so the team keeps the diagnostic
 * without shipping it to members.
 *
 * `action` is a short verb phrase describing what failed, lower-case, no
 * trailing punctuation - e.g. "change your email", "rotate your key". It
 * reads as: "Couldn't <action> - ...".
 */

/** True when `DEBUG` selects the `alter` namespace (`alter`, `alter:*`, `*`). */
export function alterDebugEnabled(): boolean {
  const d = process.env.DEBUG;
  return !!d && /(^|,)(alter(:|,|$|\*)|\*)/.test(d);
}

export function apiErrorMessage(
  action: string,
  status: number,
  rawBody?: string,
): string {
  let line: string;
  if (status === 401 || status === 403) {
    line = `Couldn't ${action} - your session has expired. Run \`alter login\` and try again.`;
  } else if (status === 404) {
    line = `Couldn't ${action} - we couldn't find what you asked for.`;
  } else if (status === 409) {
    line = `Couldn't ${action} - that conflicts with something already set. Check your input and try again.`;
  } else if (status === 429) {
    line = `Couldn't ${action} - too many attempts. Wait a moment, then try again.`;
  } else if (status >= 500) {
    line = `Couldn't ${action} right now - the service is having trouble. Try again shortly; if it keeps happening, visit truealter.com.`;
  } else if (status >= 400) {
    line = `Couldn't ${action} - check your input and try again.`;
  } else {
    line = `Couldn't ${action}.`;
  }

  if (alterDebugEnabled()) {
    const detail = rawBody ? `: ${rawBody.slice(0, 500)}` : "";
    line += `\n[debug] HTTP ${status}${detail}`;
  }
  return line;
}
