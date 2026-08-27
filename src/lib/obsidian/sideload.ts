/**
 * Sideload an Obsidian community plugin from a GitHub Releases
 * asset bundle. The doctrine is "zero-friction" - the CLI bypasses
 * BRAT entirely and writes plugin files straight into the vault's
 * `.obsidian/plugins/<id>/` folder, then marks the plugin enabled
 * in `.obsidian/community-plugins.json`.
 *
 * Two install paths exist today:
 *   - the bundled ALTER plugin → vault folder `alter-obsidian-plugin`,
 *     loaded from the assets embedded in this package (no network)
 *   - `coddingtonbear/obsidian-local-rest-api` → folder
 *     `obsidian-local-rest-api`, fetched from its public GitHub release
 *
 * Network failures (404 on the release, missing asset, transient
 * connection drop) surface as descriptive errors so the CLI can
 * print a clean message and exit non-zero rather than crashing the
 * Node process. The pairing flow translates "release not yet
 * published" into a friendly hint pointing at the manifest's
 * `releases` URL.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Network deadline for every release-fetch and asset-download call.
 * 30 seconds matches the existing `LOGIN_TIMEOUT_MS` per-call expectation
 * for OAuth handshakes - long enough for slow corporate egress, short
 * enough that a hung TLS handshake surfaces an actionable error rather
 * than wedging the pairing flow forever.
 */
const SIDELOAD_FETCH_TIMEOUT_MS = 30_000;

/**
 * Origins the asset download is allowed to land on. GitHub Releases
 * usually serve assets from `objects.githubusercontent.com` (with a
 * signed query string) but the API can also return a stable
 * `https://github.com/...` URL; both are accepted. Anything else is
 * refused - a release manifest pointing at `https://evil.example.com`
 * must not be followed.
 */
const ALLOWED_ASSET_ORIGINS = [
  "https://github.com/",
  "https://objects.githubusercontent.com/",
];

export interface PluginAssetSpec {
  /**
   * GitHub `owner/repo` slug for the third-party network-fetch path.
   * Omitted for bundled plugins, which load from the embedded assets
   * and never touch the network.
   */
  repo?: string;
  /** Folder name under `<vault>/.obsidian/plugins/`. */
  pluginId: string;
  /**
   * Files the release asset should contain. The Obsidian plugin
   * manifest mandates `main.js` and `manifest.json`; `styles.css`
   * is conventional but optional.
   */
  files: { name: string; required: boolean }[];
  /**
   * On the embed-in-alter-cli distribution path, plugins whose source ALTER
   * controls ship bundled inside the alter-cli npm package and load from
   * `dist/embedded-plugins/<embeddedRel>/` at sideload time. The npm package
   * itself is the trust envelope -
   * publish-time integrity supplants the per-file SHA-256 pin used for
   * upstream third-party plugins (e.g. obsidian-local-rest-api). When
   * unset, sideload falls through to the GitHub Releases path.
   */
  embeddedRel?: string;
}

export const ALTER_PLUGIN: PluginAssetSpec = {
  pluginId: "alter-obsidian-plugin",
  files: [
    { name: "main.js", required: true },
    { name: "manifest.json", required: true },
    { name: "styles.css", required: false },
  ],
  embeddedRel: "alter-obsidian-plugin",
};

export const LOCAL_REST_API_PLUGIN: PluginAssetSpec = {
  repo: "coddingtonbear/obsidian-local-rest-api",
  pluginId: "obsidian-local-rest-api",
  files: [
    { name: "main.js", required: true },
    { name: "manifest.json", required: true },
    { name: "styles.css", required: false },
  ],
};

/**
 * Per-asset SHA-256 digest pins, keyed by `<repo>@<tag>`. Verified
 * after download but before the asset is written to disk. A miss
 * (key absent, value `null`, or `FILL_IN_*` placeholder) is FATAL
 * - the sideloader fails closed rather than warn-and-continue, on
 * the basis that an unpinned community-plugin install is a supply-
 * chain risk equivalent to `curl | bash` from a third-party host.
 *
 * Operational note: `fetchLatestRelease()` always asks GitHub for the
 * `/releases/latest` of each `repo` and the verifier looks up
 * `<repo>@<tag_name>` in this map. When upstream cuts a new release,
 * the install fails closed until alter-cli ships a follow-up that pins
 * the new tag's digests. That is the intended trade-off - a known-good
 * release is locked, and a silent supply-chain swap is impossible.
 *
 * Format: hex (lowercase). Use `null` only for files explicitly
 * known not to exist in a given release (e.g. an optional
 * `styles.css` the upstream chose not to ship); the verifier
 * skips `null` for files that weren't downloaded.
 */
export const EXPECTED_PLUGIN_DIGESTS: Record<
  string,
  Record<string, string | null>
> = {
  // Pinned 2026-04-26 against the actual published GitHub release
  // assets (https://github.com/coddingtonbear/obsidian-local-rest-api
  // /releases/tag/3.6.1, released 2026-04-09). To bump:
  //   gh release download <tag> --repo coddingtonbear/obsidian-local-rest-api
  //   sha256sum main.js manifest.json styles.css
  // and add a new entry; do NOT delete the prior entry until alter-cli
  // is past the deprecation window for the older tag.
  "coddingtonbear/obsidian-local-rest-api@3.6.1": {
    "main.js":
      "ef3e73aa0dd5b045f3f469d59cf7a5a6aed709270d86f87d6c84a0405661b2be",
    "manifest.json":
      "7fc49418529247a33c985ee889d5a358f12eced1bd2fe3cb08d9abb81d93889d",
    "styles.css":
      "9c11d47320384a9af97ca67e78384f9bfe1b46510d611de3e7c8507425d20dfb",
  },
  // Pinned 2026-05-15 against the actual published GitHub release
  // assets (https://github.com/coddingtonbear/obsidian-local-rest-api
  // /releases/tag/3.6.2, released 2026-05-06). Bumped because the
  // upstream `/releases/latest` already points at 3.6.2 and the fail-
  // closed gate at `verifyAssetDigest` was refusing every fresh pair.
  // Re-run: `gh release download 3.6.2 --repo coddingtonbear/obsidian-
  // local-rest-api && sha256sum main.js manifest.json styles.css`.
  // The 3.6.1 entry stays for the deprecation window so older
  // snapshots still verify.
  "coddingtonbear/obsidian-local-rest-api@3.6.2": {
    "main.js":
      "34c2bfabc8cf1e54d0de7b567579d066fd8946b2ffad3b0f7158d5dd9641d263",
    "manifest.json":
      "cd1599c1c8290f8a25b9bf501805817307e73cdb68f9b3eb4b9f1d7a0e47f036",
    "styles.css":
      "9c11d47320384a9af97ca67e78384f9bfe1b46510d611de3e7c8507425d20dfb",
  },
};

/**
 * Test-visible SHA-256 hex helper. Production uses this internally;
 * test fixtures use it to compute expected digests for synthetic
 * release bodies without duplicating the hashing logic.
 */
export function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Verify a downloaded asset against the pinned digest. Throws on
 * any of: tag has no digest entry, file has no digest entry,
 * digest is `null` (placeholder until first release), digest is a
 * `FILL_IN_*` placeholder, computed digest doesn't match.
 *
 * The fail-closed posture is deliberate. The previous warn-and-
 * continue path was a supply-chain footgun: a malicious or
 * compromised release would have been silently sideloaded and
 * enabled inside the user's Obsidian vault.
 */
function verifyAssetDigest(
  repo: string,
  tag: string,
  fileName: string,
  buf: Buffer,
  digests: Record<string, Record<string, string | null>> = EXPECTED_PLUGIN_DIGESTS,
): void {
  const key = `${repo}@${tag}`;
  const tagDigests = digests[key];
  if (!tagDigests) {
    throw new Error(
      `refusing to sideload ${repo}@${tag}: no SHA-256 digest pin on ` +
        `record. Add an entry to EXPECTED_PLUGIN_DIGESTS before this ` +
        `version can be installed. (Fail-closed supply-chain policy.)`,
    );
  }
  const expected = tagDigests[fileName];
  if (expected === undefined) {
    throw new Error(
      `refusing to write ${fileName} for ${repo}@${tag}: file has no ` +
        `SHA-256 digest pin in EXPECTED_PLUGIN_DIGESTS. ` +
        `(Fail-closed supply-chain policy.)`,
    );
  }
  if (expected === null) {
    throw new Error(
      `refusing to write ${fileName} for ${repo}@${tag}: digest pin is ` +
        `null (placeholder). Pin the real SHA-256 before sideload can ` +
        `proceed. (Fail-closed supply-chain policy.)`,
    );
  }
  if (expected.startsWith("FILL_IN_")) {
    throw new Error(
      `refusing to write ${fileName} for ${repo}@${tag}: digest pin is a ` +
        `FILL_IN_* placeholder. RELEASE-BLOCKER - replace with the real ` +
        `SHA-256 of the published release asset. ` +
        `(Fail-closed supply-chain policy.)`,
    );
  }
  const actual = sha256Hex(buf);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `digest mismatch for ${fileName} from ${repo}@${tag}: expected ` +
        `${expected}, got ${actual}. Refusing to sideload - possible ` +
        `tampered release.`,
    );
  }
}

interface GitHubRelease {
  tag_name?: string;
  assets?: { name: string; browser_download_url: string }[];
}

export interface SideloadResult {
  /** Vault-relative path the plugin folder was written to. */
  pluginDir: string;
  /** Files actually downloaded (may exclude optional ones). */
  written: string[];
  /** Tag name fetched, for the post-install message. */
  tag: string;
}

export interface SideloadOptions {
  /** Override the network fetcher - primarily for tests. */
  fetchImpl?: typeof fetch;
  /** Override the destination root - primarily for tests. */
  vaultRoot?: string;
  /**
   * Test-only seam to inject an alternative digest map. Production
   * always uses the module-level EXPECTED_PLUGIN_DIGESTS and the
   * fail-closed posture; tests use this to avoid pinning to real
   * release artifacts that don't exist in the unit-test fixture.
   * Setting this in production code is a smell - it bypasses the
   * supply-chain pin.
   */
  digestsOverride?: Record<string, Record<string, string | null>>;
  /**
   * Test-only seam to point the embedded-plugin lookup at a fixture
   * directory instead of the real `dist/embedded-plugins/` tree resolved
   * from this module's own location. Production never sets this.
   */
  embeddedRootOverride?: string;
  /**
   * Caller-supplied AbortSignal. Composed with the per-request
   * `SIDELOAD_FETCH_TIMEOUT_MS` deadline via `AbortSignal.any`, so
   * EITHER triggers abort. The interactive `alter pair` flow wires
   * this from `withKeyListenerCancel` so q/Esc aborts a slow GitHub
   * fetch without hanging the terminal.
   */
  signal?: AbortSignal;
}

/**
 * Probe whether a plugin folder is already present in the vault.
 * Used by the sideload flow to skip Local REST API when it's
 * already installed.
 */
export function pluginInstalled(
  vaultRoot: string,
  pluginId: string,
): boolean {
  const dir = path.join(vaultRoot, ".obsidian", "plugins", pluginId);
  try {
    return fs.statSync(path.join(dir, "manifest.json")).isFile();
  } catch {
    return false;
  }
}

/**
 * Compose the per-request timeout signal with an optional caller
 * signal. Either triggers abort. `AbortSignal.any` is Node 20+, which
 * matches the package's `engines` floor.
 */
function composeAbortSignal(callerSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(SIDELOAD_FETCH_TIMEOUT_MS);
  if (!callerSignal) return timeoutSignal;
  return AbortSignal.any([callerSignal, timeoutSignal]);
}

async function fetchLatestRelease(
  spec: PluginAssetSpec,
  fetchImpl: typeof fetch,
  callerSignal?: AbortSignal,
): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${spec.repo}/releases/latest`;
  const resp = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "alter-cli",
    },
    // Hard deadline - a hung GitHub API call must not wedge `alter pair`.
    signal: composeAbortSignal(callerSignal),
  });
  if (resp.status === 404) {
    throw new Error(
      `no published release for ${spec.repo}. ` +
        `The plugin repo may not be public yet - check ` +
        `https://github.com/${spec.repo}/releases`,
    );
  }
  if (!resp.ok) {
    throw new Error(
      `could not fetch ${spec.repo} releases (${resp.status} ${resp.statusText})`,
    );
  }
  return (await resp.json()) as GitHubRelease;
}

async function downloadAsset(
  url: string,
  fetchImpl: typeof fetch,
  callerSignal?: AbortSignal,
): Promise<Buffer> {
  // Origin allow-list: refuse to follow a release manifest that
  // points at an attacker-controlled host. GitHub serves release
  // assets from `github.com` (redirect) and
  // `objects.githubusercontent.com` (signed); both are accepted.
  if (!ALLOWED_ASSET_ORIGINS.some((prefix) => url.startsWith(prefix))) {
    throw new Error(
      `asset URL '${url}' is not on a permitted origin ` +
        `(github.com / objects.githubusercontent.com)`,
    );
  }
  const resp = await fetchImpl(url, {
    headers: { "User-Agent": "alter-cli" },
    signal: composeAbortSignal(callerSignal),
  });
  if (!resp.ok) {
    throw new Error(
      `asset download failed (${resp.status} ${resp.statusText})`,
    );
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf;
}

/**
 * Resolve the embedded-plugins root inside the alter-cli npm package.
 * The build step (`scripts/embed-plugin.mjs`) copies the ALTER plugin's
 * `main.js` / `manifest.json` / `styles.css` into
 * `dist/embedded-plugins/<embeddedRel>/`; this helper walks up from
 * `dist/lib/obsidian/sideload.js` to find that root.
 */
function embeddedPluginsRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "embedded-plugins");
}

/**
 * Try to satisfy the sideload from the alter-cli npm package's bundled
 * plugin assets. Returns null when the embed isn't present (older
 * alter-cli build, or a third-party plugin without `embeddedRel`),
 * which signals the caller to fall through to the GitHub Releases path.
 *
 * The trust envelope here is the npm package itself: bytes are hashed
 * at publish time, the lockfile pins the version, and Sigstore-keyless
 * signing covers the publish artefact. No per-file
 * SHA-256 pin is needed inside the embed because the integrity gate
 * is one layer up.
 */
function tryLoadEmbeddedPlugin(
  vaultRoot: string,
  spec: PluginAssetSpec,
  embeddedRootOverride?: string,
): SideloadResult | null {
  if (!spec.embeddedRel) return null;
  const srcDir = path.join(
    embeddedRootOverride ?? embeddedPluginsRoot(),
    spec.embeddedRel,
  );
  const manifestPath = path.join(srcDir, "manifest.json");
  let manifestRaw: string;
  try {
    manifestRaw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return null;
  }
  let manifest: { version?: string; id?: string };
  try {
    manifest = JSON.parse(manifestRaw) as { version?: string; id?: string };
  } catch {
    return null;
  }
  // Obsidian keys the plugin folder off the manifest's own `id`, not off
  // whatever this CLI happens to call it. `spec.pluginId` is meant to
  // mirror that id exactly (see ALTER_PLUGIN above) - if the embedded
  // plugin's manifest ever declares a different id than the constant, the
  // folder we write to and the id Obsidian expects diverge silently,
  // which is exactly the class of bug fixed in #106 (pluginId "alter" vs
  // manifest id "alter-obsidian-plugin"). Fail closed instead of
  // reintroducing that drift.
  if (manifest.id && manifest.id !== spec.pluginId) {
    throw new Error(
      `embedded ${spec.pluginId} manifest declares id '${manifest.id}', ` +
        `which does not match the CLI's ALTER_PLUGIN.pluginId ` +
        `('${spec.pluginId}'). Update the pluginId constant in ` +
        `src/lib/obsidian/sideload.ts to match the plugin's manifest.json ` +
        `before sideloading (a mismatch means Obsidian will refuse to ` +
        `load the plugin from the folder this CLI writes to).`,
    );
  }
  const tag = `v${manifest.version ?? "embedded"}`;
  const pluginDir = path.join(
    vaultRoot,
    ".obsidian",
    "plugins",
    spec.pluginId,
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  const written: string[] = [];
  for (const file of spec.files) {
    const srcPath = path.join(srcDir, file.name);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(srcPath);
    } catch {
      if (file.required) {
        throw new Error(
          `embedded ${spec.pluginId} bundle is missing required file ` +
            `'${file.name}' at ${srcPath}. Rebuild alter-cli with the ` +
            `plugin sibling repo present.`,
        );
      }
      continue;
    }
    fs.writeFileSync(path.join(pluginDir, file.name), buf);
    written.push(file.name);
  }
  if (written.length === 0) {
    throw new Error(
      `embedded ${spec.pluginId} bundle contained none of the expected assets`,
    );
  }
  return { pluginDir, written, tag };
}

/**
 * Download the latest release of the given plugin and write its
 * files into the vault. Idempotent - re-running overwrites the
 * existing files in place, which is exactly what we want for
 * upgrades.
 *
 * Embed-first: when the spec carries `embeddedRel` AND the alter-cli
 * package shipped with the bundled assets, sideload reads from the
 * embedded bundle and skips the network entirely. This is the
 * default for plugins ALTER controls (e.g. ALTER_PLUGIN). Third-party
 * plugins like LOCAL_REST_API_PLUGIN omit `embeddedRel` and always
 * take the GitHub Releases path.
 */
export async function sideloadPlugin(
  vaultRoot: string,
  spec: PluginAssetSpec,
  options: SideloadOptions = {},
): Promise<SideloadResult> {
  const embedded = tryLoadEmbeddedPlugin(
    options.vaultRoot ?? vaultRoot,
    spec,
    options.embeddedRootOverride,
  );
  if (embedded) return embedded;

  // ALTER-owned tooling must NOT distribute via GitHub. When a spec
  // carries `embeddedRel` it advertises itself as
  // an ALTER-controlled bundle; missing the bundle in `dist/` means
  // the npm package was built wrong, and we refuse to fall through to
  // a GitHub Releases fetch on the user's machine. Third-party specs
  // (no `embeddedRel`) continue to take the network path because the
  // upstream repo is out of our trust envelope by definition.
  if (spec.embeddedRel) {
    throw new Error(
      `Embedded plugin bundle for ${spec.pluginId} is missing from this ` +
        `alter-cli build (expected at dist/embedded-plugins/${spec.embeddedRel}/). ` +
        `Reinstall with \`npm install -g @truealter/cli\` to refresh; ` +
        `if the problem persists, run \`alter creds doctor\` and file a bug.`,
    );
  }

  // The network path requires a source repo. Embedded-only specs never
  // reach here - they either load from the bundle above or throw on a
  // missing bundle - so a spec with neither is a build-time misconfig.
  const repo = spec.repo;
  if (!repo) {
    throw new Error(
      `${spec.pluginId} has no embedded bundle and no source repo to fetch from`,
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const release = await fetchLatestRelease(spec, fetchImpl, options.signal);
  const assets = release.assets ?? [];
  const pluginDir = path.join(
    options.vaultRoot ?? vaultRoot,
    ".obsidian",
    "plugins",
    spec.pluginId,
  );
  fs.mkdirSync(pluginDir, { recursive: true });

  const written: string[] = [];
  const tag = release.tag_name ?? "unknown";
  for (const file of spec.files) {
    const asset = assets.find((a) => a.name === file.name);
    if (!asset) {
      if (file.required) {
        throw new Error(
          `release for ${repo} (${tag}) ` +
            `is missing required asset '${file.name}'`,
        );
      }
      continue;
    }
    const buf = await downloadAsset(
      asset.browser_download_url,
      fetchImpl,
      options.signal,
    );
    // Fail-closed digest pin. Throws if the asset has no pin, the pin
    // is a FILL_IN_* placeholder, or
    // the bytes don't match. This MUST run before any disk write.
    verifyAssetDigest(repo, tag, file.name, buf, options.digestsOverride);
    fs.writeFileSync(path.join(pluginDir, file.name), buf);
    written.push(file.name);
  }
  if (written.length === 0) {
    throw new Error(
      `release for ${repo} contained none of the expected assets`,
    );
  }

  return {
    pluginDir,
    written,
    tag,
  };
}

/**
 * Idempotent edit of `<vault>/.obsidian/community-plugins.json` -
 * add `pluginId` to the enabled list if it's not already present.
 * Creates the file when Obsidian has never enabled any community
 * plugin in the vault. Returns true when an edit landed.
 */
export function enableCommunityPlugin(
  vaultRoot: string,
  pluginId: string,
): boolean {
  const file = path.join(vaultRoot, ".obsidian", "community-plugins.json");
  let current: string[] = [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      current = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // File missing or malformed - treat as empty list.
  }
  if (current.includes(pluginId)) return false;
  current.push(pluginId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic write - same tmp-then-rename pattern used by the cosmetics
  // inscribe layer (`src/lib/cosmetics/inscribe.ts`). A ^C between
  // `writeFileSync` and the rename leaves the user with the prior file
  // intact rather than a half-written JSON list that Obsidian would
  // reject on next launch.
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  return true;
}

/**
 * Wipe the alter plugin's `data.json` (consent state) without
 * removing the plugin itself. Used by `alter unpair obsidian` so
 * the plugin's local view of consent matches the daemon's.
 */
export function wipePluginData(vaultRoot: string, pluginId: string): boolean {
  const file = path.join(
    vaultRoot,
    ".obsidian",
    "plugins",
    pluginId,
    "data.json",
  );
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively delete the plugin folder. Used by `alter unpair
 * obsidian --remove-plugin`.
 */
export function removePluginFolder(
  vaultRoot: string,
  pluginId: string,
): boolean {
  const dir = path.join(vaultRoot, ".obsidian", "plugins", pluginId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
