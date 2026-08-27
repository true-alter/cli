/**
 * Resolve every child_process import inside a test process to the guarded shim.
 *
 * The shim's own import of the real module carries parentURL === SHIM and is
 * passed straight through, which is what stops the redirect recursing.
 */
const SHIM = new URL("./child-process-shim.mjs", import.meta.url).href;

// SYNCHRONOUS on purpose. register.mjs installs this through `registerHooks`,
// whose hooks run in-thread and are never awaited, so an `async` here would
// hand the loader a promise and the redirect would silently stop happening.
// Nothing in the body needs to await, which is what makes the sync API usable.
export function resolve(specifier, context, nextResolve) {
  const wantsChildProcess =
    specifier === "node:child_process" || specifier === "child_process";
  if (wantsChildProcess && context.parentURL !== SHIM) {
    return { url: SHIM, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
