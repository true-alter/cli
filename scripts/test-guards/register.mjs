/**
 * Entry point for the no-live-host gate. Preloaded via NODE_OPTIONS from
 * scripts/run-tests.mjs, so it reaches every test process and any node process
 * a test spawns.
 *
 * That reach is the point, and it is also why this file has to stay SILENT.
 * `module.register()` is deprecated as DEP0205, and a deprecation warning is
 * two lines on stderr of every process in the tree, including the CLI children
 * the tests spawn. Two of those tests count the rows their child drew against
 * a terminal budget, so the warning read as the product overflowing a screen
 * it had not overflowed. `registerHooks` is the named replacement and emits
 * nothing.
 *
 * `registerHooks` landed in Node 22.15 and the package supports Node 20, which
 * is what CI runs, so the API is chosen at load time rather than assumed. Newer
 * runtimes take the silent replacement. Node 20 takes `register`, which carries
 * no deprecation warning on that release and is the path the suite has been
 * green on all along. Every runtime the package supports ends up silent, which
 * is the property this file exists to hold.
 *
 * Anything added here obeys the same constraint: a guard that writes to stderr
 * cannot be preloaded into a process whose stderr is under assertion.
 */
import * as nodeModule from "node:module";

import { resolve } from "./hooks.mjs";

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({ resolve });
} else {
  nodeModule.register("./hooks.mjs", import.meta.url);
}
