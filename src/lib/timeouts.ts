/**
 * Shared loopback-callback timeout constants.
 *
 * Both `alter login` and `alter passkey add` spin up a tiny HTTP
 * server on 127.0.0.1 and wait for the browser to redirect back
 * with a code. Without a hard deadline, a stuck auth page or
 * a misbehaving HTTPS-upgrade extension on the user's browser
 * leaves the terminal hanging silently - there is no way for the
 * user to tell whether the wait will ever end.
 *
 * Centralising the constant lets every callback flow opt into the
 * same guard (and the same env override for power users on slow
 * SSO deployments).
 *
 * Default 15 min: covers first-time registration where the user has
 * to fill out a full form (name, email, password, confirm, T&C) and
 * may hit a refresh detour mid-flow. Prior 5-min default tripped
 * mid-form for first-timers, and the OAuth code minted into a
 * closed loopback surfaced as ERR_CONNECTION_REFUSED with no clear
 * recovery hint.
 */

export const LOGIN_TIMEOUT_MS = parseInt(
  process.env.ALTER_LOGIN_TIMEOUT_MS ?? "900000",
  10,
);
