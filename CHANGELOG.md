# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- A clean pull no longer breaks the build, and a type error can no longer take the CLI off the machine. 249 files under `node_modules/` were tracked, npm's installed-state marker among them, so a pull overwrote the puller's record of what was actually installed and npm then did nothing, including when told the exact version. The build failed naming the wrong file, because the source was correct and the dependency on disk was not. The vendoring was never a decision: the repo's first commit carried a `.gitignore` written as one literal line, `node_modules/\ndist/`, which matched nothing, and only that first install's typescript and `@types` were ever caught by it. Every workflow here installs with `npm ci`, which removes the directory outright, so nothing read those files. The build now type-checks before it cleans, so a failure leaves the previous `dist` standing rather than deleting it and leaving the linked binary pointing at nothing.
- A test now fails if anything in the index matches a `.gitignore` rule, and if any `.gitignore` line carries a literal escape sequence. The second check is the one that would have caught this at the first commit rather than four months later, because a rule written as `node_modules/\ndist/` reads correctly to anyone who opens the file while matching nothing at all.

### Security

- Bumped build-time dependencies to their advisory floors: `js-yaml` (via eslint) to 4.3.1, `ip-address` (via the sigstore signing chain) to 10.3.1+, `brace-expansion` (via eslint's and typescript-eslint's minimatch) to 1.1.18 and 5.0.9 on its two separate lines, and `@sigstore/core` (via `@sigstore/sign`) to 3.2.1. None of these ship in the published package, since `files` only carries `dist/`, never `node_modules`. A compromised build-time transitive dependency still reaches everyone who builds from source, so the floors are worth holding regardless.

## [0.8.42] - 2026-08-13

### Added

- `alter wire` can now install ~Alter into OpenClaw, which brings the list of clients it reaches to five. The runtime underneath has known how to wire OpenClaw since it shipped, and this list had not caught up, so asking for it by name got you "unknown client id" from the one part of the pair that did not know. The name is in the `--only` help and in the menu hint too, since a target you cannot see is one you will not use.

### Security

- Opening the message composer now writes your draft into a private folder only this session can enter, rather than the shared temp folder every other program on the machine can also read from and write into. A draft you have not sent yet should not be readable by anyone else on a shared machine, and the old location made that possible.
- The doctrine-sync hook that `alter cutover` installs kept its once-a-session marker under a predictable name in that same shared temp folder, and stamped it in a way that follows a shortcut. On a machine you share with other people, one of them could leave a shortcut under that name and have your own hook create a file of their choosing, as you. Some of those files are ones ~Alter reads as a yes-or-no setting, so this could switch something on or off that you never touched. The marker now sits in a folder only you own, and both the folder and the marker refuse a shortcut outright rather than following one. ~Alter checks that the folder is not a shortcut before it checks that the folder is yours, because asking who owns it answers about wherever the shortcut points rather than about the folder itself. If anything is in its way, the hook does nothing. Present since 0.8.13, so it is worth updating rather than waiting.

### Fixed

- The README did not mention `alter thread journal`, added in 0.8.41. It is listed now, alongside the programme counter it is not the same as.

## [0.8.41] - 2026-08-12

### Added

- `alter thread journal` - ask whether anything has been planted for you, and read what it is. A thread is planted quietly and you are the one who comes and finds it, so nothing announces itself; asking is what resolves it, and what is waiting is written into your journal at the moment you look. This is your own record, and it is a different thing from `alter thread`, which counts who is woven into the field around you. Add `--json` for the machine-readable form.

### Security

- `alter wire --api-key` now asks for the key at a masked prompt and refuses to take it from the command line, the same way `alter login --token` and `alter key seed import` already do. A value typed as an argument is readable by every other program running on your machine and lands in your shell history. The flag still exists and still does the same job; it just will not accept the key that way. With `--json` there is no prompt to show, so log in and let it use the key on your session.
- On macOS, secrets are now encrypted on disk under a key held in your keychain, rather than being handed to the keychain tool as a command-line argument. That tool takes a password no other way, so something has to travel that route; what travels it now is a wrapping key, which can be replaced if it is ever seen. Your root seed never does, and nothing can reissue a root seed. Windows and Linux were already clear of this.
  - Your existing secrets move across the first time they are read. You do not need to do anything.
  - This is one-way. If you go back to an earlier version on macOS it will look in the old place, find nothing, and treat you as logged out, so you would log in again.

### Fixed

- The package listing linked to a source page that does not resolve, so anyone who followed it from the registry got a 404. The listing now points at the site.
- More of the bare wordmark in terminal messages and in the lines written into your own dotfiles, which should say ~Alter. Anything an earlier version inscribed is still recognised, so removing a block still works on files you already have.

## [0.8.40] - 2026-08-12

### Security

- `alter key seed import` now asks for the seed at a masked prompt and refuses to take it from the command line. A value typed as an argument is readable by every other program running on the machine and lands in your shell history, and this is the one secret nobody can reissue if it gets out. The same refusal has guarded `alter login --token` for months, and a seed is worth more than a token that expires.

### Fixed

- The notices lines used the bare wordmark where the name belongs. What you hold is your ~Alter account, and the wordmark is not the name of it. Both the menu leaf and the line a session prints when something is waiting for you now say it properly.

## [0.8.39] - 2026-08-11

### Added

- `alter key device register` - give this machine a signing key ~Alter recognises. Your member key proves the CLI is you and your attachment key wraps files to you, but neither can answer whether you agreed to a particular set of words, because neither is a signature. A device key is. Registering asks the field for a single-use challenge, signs it here, and sends the public half; the private half is written into the same credential store your other keys live in, and only after the field has accepted the public half, so a registration that fails leaves nothing behind.
  - `alter key device show` prints the key this machine holds, or says plainly that it holds none.
  - Running register twice is safe. The field recognises the key it already has and says so, rather than giving one machine a second identity.
- A root seed, minted alongside that device key and shown to you once. A device key is meant to be replaceable, because replacing it is how you answer a lost laptop, so anything derived from it would die with the machine. The root seed is the opposite. It is minted once, it is yours rather than the machine's, and it is what your longer-lived keys come from. No server holds it and nothing can reissue it, which is why it is printed for you to write down at the moment it is made.
  - `alter key seed export` shows it again on a machine that holds it, after asking whether you want it on screen. `alter key seed import` puts it back on a new machine, and stops rather than replacing a different seed already there.
  - What you write down carries its own checksum, so a single wrong character when you type it back is caught then and there, instead of quietly producing keys nobody recognises.

## [0.8.38] - 2026-08-09

### Added

- `alter wallet revoke <address> [--chain <chain>]` - unbind a wallet you had attested to your ~handle. You could attest one and then had no way to undo it from anywhere except the browser onboarding screen, on either the terminal or an AI client. It reads your own attestation list first and works out the chain from it, so you do not have to remember which chain a wallet was bound on, then asks before it revokes.
  - Where you have the same address attested on more than one chain, it stops and says so rather than guessing, and rather than revoking every match at once. Where there is no active attestation it says that instead of reporting a success that did nothing.
  - Agents get the same thing as the `wallet_attest_revoke` verb, held to the same confirmation the destructive verbs all sit behind, refused by the server independently if that confirmation was skipped.
- `alter consent automated-decisions` - read how matching decides about you, and acknowledge or withdraw, from the terminal. Matching is decided by a computer with no person reviewing it, which under Article 22 of the GDPR means you have to be told how it works, and to say you have been told, before it runs. Until you do, no matches are computed for you. Acknowledging was previously only possible over MCP, so a member without an AI client had no way to unblock their own matching.
  - The disclosure is fetched and printed first, every time, and the acknowledgement carries the version of the text you were shown. There is deliberately no flag that records one without printing it. A record attesting to text nobody displayed attests to nothing.
  - `--withdraw` takes it back, in the same one step as `--acknowledge` and off the same screen. `--yes` skips the confirmation prompt and nothing else. `--json` emits the field's own response.
  - `alter consent list` now carries where you stand on this alongside the other ledgers, so a member whose matching is blocked can find that out without knowing the word first.

### Fixed

- `alter wallet register` can attest a wallet again. It was sending a chain name that does not exist and leaving out your handle, so the request was rejected before you were ever asked to sign, and no wallet could be bound from the terminal at all. It now sends the chain the backend actually names, your bound handle, and the message text you signed, which the check needs to work out that the signature is yours.
- The `wallet_attest` bridge verb had the same gap, for every chain rather than one, so an agent could not bind a wallet either. It now accepts all seven chains you can actually pair, rejects the one that never existed, and names the missing field itself rather than relaying the backend's bare status code.
- `alter cash-out` shows you the off-ramp providers on every path that can fail, not only the one that succeeds. It also knows where you are now, covering Australia, the United States, the United Kingdom and the EU/EEA rather than assuming Australia, and it carries the places a provider will not serve you as a field any provider can have rather than a footnote about one of them.
- Transak's Australian payout is by card, not by bank transfer, which is what the note claimed. Independent Reserve and Kraken are both listed for Australia, each checked against the provider's own published terms for selling USDC on Base into an Australian bank account.

### Changed

- `alter pair` and `alter discover` stop reciting which sources you can connect and point at the live list instead. Five help and hint strings still named github and obsidian as the whole set, long after the picker started reading the real registry, so the help was telling you less than the command could do. Nothing about which sources actually work changed here.

### Security

- A caller who replays a nonce is now told apart from one who arrived when the cache was full, and neither can push the other out. The bridge's replay cache used to evict whatever was oldest once it hit its limit, even when that entry was still live, so anyone able to send enough distinct nonces could force out one they wanted to reuse and then reuse it. Nothing else on that path bounds replay, so the cache now clears only genuinely expired entries and refuses the request outright when everything left is still live.
- Release downloads carry a detached signature you can check. Each published artefact gets a `.sig` alongside it and the manifest is signed over its own exact bytes, and the sigstore bundle that the manifest had been pointing at is now actually uploaded rather than only referenced. This covers the platform downloads; the npm package's own provenance still waits on the source repository going public.

## [0.8.37] - 2026-08-06

### Added

- `alter contest` - dispute a decision, score or restriction Alter recorded about you, without having to learn a single one of Alter's words for it. Run it with no flags and it asks two plain questions, what this is about and what is wrong with it, works out which of the nine typed claims that is, then shows you what it worked out and waits. Nothing is lodged until you say yes, and if the mapping is wrong you change it there.
  - You walk away with a reference. It is printed first, along with what happens next, taken from what the server itself returned rather than written here. Where the server sends no next step, it says so instead of inventing one.
  - Every step after lodging is mechanical. No one at Alter reads your claim and decides whether you are right, and the command never suggests otherwise.
  - When a claim belongs to a different type than the one you picked, that is not treated as your mistake. You are told which type it is and offered that lodgement on the spot. When Alter has not built the record a claim needs to attach to, it says that plainly and owns it, rather than telling you to try something else.
  - `alter contest --type <claim-type> --ref <record>` lodges without a terminal, for scripts and agents; the record kind and the part of it are filled in from the claim type wherever it admits only one. `alter contest types` lists the nine in plain words, `--json` for machine reading.
- The bundled statusline can carry a second line for what you own, rather than what this session is doing. It reads three things the background service already writes to your own machine, so nothing new is fetched and nothing new is spawned. Those three are what you have earned, your attunement, and the peers you are in contact with, named rather than counted. It is off unless one of them has something to say. Set `line2_mode` in `~/.config/alter/statusline-wardrobe.json` to `full` to keep the row in a fixed place you can read by position, or `off` to never see it.

### Changed

- The context gauge now reads as a percentage burnt through the window, in four bands, beside the five-hour and seven-day figures that were already there. The previous bar saturated early and then stopped moving, so the half of the window where the number matters most was the half it could not show.
- `alter status`, and the sign-in flow's own next-step beat, now report back what happened after a suggestion was shown, the next time either one runs. It sends the suggestion's id, the id of whatever you acted on instead if that differs, and when. It only sends when a suggestion was actually shown to you, adds no delay, changes nothing you see, and stays silent on any failure rather than retrying or surfacing an error.

### Fixed

- The hooks `alter hooks install` puts in place now run on macOS and on Windows Git Bash. Six of them were doing nothing at all on those two platforms, on every invocation, and saying nothing about it. Each one needed a tool that comes with Linux and not with stock macOS or Git Bash, `flock`, `sha256sum`, `jq` or Python's `fcntl`, and each one checked for it and then quietly exited. A hook that exits early emits exactly what a hook with nothing to say emits, so an install check could confirm every file was present and unmodified while a third of them had never once fired. They now fall back to something that works everywhere instead of falling silent. The handover lock uses an atomic directory rather than `flock`, `sha256sum` falls back to `shasum -a 256`, `stat -c` gains its BSD counterpart, and the lock and stamp paths honour `TMPDIR` rather than assuming `/tmp`. One narrow verification claim is owed here. This was run on Linux with those tools removed from `PATH`, which exercises the same code paths but is not a run on either operating system.
- The bundled guard on destructive shell commands no longer passes four shapes it should have caught, among them a bare newline that hid `git push --force` from its scanner.
- Your consent tier now renders at every level, L4 included. It was shown at L1 through L3 and hidden at L4, which meant the one fact most worth confirming, what you have agreed to share, was invisible to exactly the people sharing the most. Fixed on both the full statusline and the reduced one that runs when only an older bash is available.

## [0.8.36] - 2026-07-30

### Added

- `alter doctor loom <path> [--json] [--no-write]` - point this at any folder of files, a teacher's student records, a family's eldercare paperwork, a project folder you share with someone else, anything, and it checks each file for the everyday things that quietly damage a body of records. It also reports what's changed since the last run.
  - It looks for corrupted text, unfilled placeholders left behind, links that point at nothing, something that looks like a password or card number sitting in plain text, a file that's suddenly lost most of its content, and duplicate copies wasting space.
  - Won't false-fire on your CI/CD workflow files, GitHub Actions and Azure Pipelines both, and a link to a real subdirectory resolves correctly.
  - Verdicts are cached in a per-machine baseline and reused between runs; `--no-write` runs read-only. Requires Python 3 on `PATH`. A target folder whose name begins with `-` is marked with `--`: `alter doctor loom -- -Inbox`.
  - Proven end to end against four real, unmodified open source repositories, Express.js, Flask, Vite and axios. A cold run against Express.js, over 200 files, finished in 0.18 seconds - one machine, one sample, not a guarantee for every repository. Reproduce it yourself by running the command above against your own repository and timing it.
- `alter doctor loom --ci [path] [--config <file>] [--json]` - a generic local CI runner. Declare a check list once, in `.alter/loom.json`, any shell command a repository already runs, and this runs it locally and reports the result straight to GitHub, so a required check can go green without spending hosted Actions minutes on it.
  - Those commands come from the repository and run as you, so nothing runs until you say so. The first run in a folder prints the declared commands and stops; `alter doctor loom --ci <path> --approve` records that you have read them, and you are asked again the moment any of them changes. Approve a repository you would run by hand. Approval covers what the file declares, never the code those commands then reach.
  - An approved check runs with this CLI's own variables and anything named like a credential withheld from it, in a working directory that must sit inside the repository, and in its own process group, so a check that times out takes whatever it started with it rather than leaving it running after the report says the run is over.
  - No config present prints the expected file shape instead of guessing what to run. Needs `gh`, logged in, to report the result; without it the checks still run and the result still prints, it just says plainly that nothing was reported.
  - Replacing five duplicated pull-request workflows, lint, tests and similar checks, with local checks took our own GitHub Actions usage on those workflows from 7,304 runs a month to 296 immediately, and to zero once the migration finished. Counted straight from GitHub's own Actions-run history for those five workflows over the 30 days either side of the change; the same count is available to anyone through the Actions API or `gh run list` against their own repository. That is our own migration's result, not a promise about yours.
  - One caveat matters here. This runs under the contributor's own control and reports under their own login, so it is not independent verification. Only wire it as a required check on a repository where you trust every collaborator with write access; on a repository with collaborators you don't fully trust, treating it as a required check lets whoever is running it satisfy their own gate.

### Changed

- `alter login` now ends on the welcome box. It no longer prints a next-step block after a successful sign-in. You asked to log in, not to be told what to do next. `alter status` still carries the next step for anyone who wants it.

### Fixed

- Self-update no longer reads "Nix" off a machine that merely has Nix on it. The check was satisfied by the `NIX_PROFILES` variable alone, which Nix's shell integration sets in every shell, so a plain `npm install -g` on such a machine reported itself Nix-managed and `alter update` then declined to update a user it could have updated. It now asks where the executable actually sits.
- `alter doctor loom` will not open a file that is not a file. A named pipe among the files being checked used to hold the run open indefinitely, waiting for a writer that need never arrive. It is now reported as unreadable and never opened, as is a device or a socket.
- `alter doctor loom` no longer takes minutes over a file full of unclosed brackets. Link extraction ran a scan whose cost grew with the square of the file size, so 30 KB of `[` took over half a minute on the first run, with no configuration and nothing cached. The same file now takes under a tenth of a second.
- `alter doctor loom` keeps its own writes inside the folder it was pointed at. A `.loom` state directory replaced by a symlink had the tool create directories and write verdict files wherever that link pointed. The store is now refused if it does not resolve inside the folder.
- A verdict recalled from a previous run now has its explanation checked against the machine's own record, not just its pass or fail. Editing the explanation inside a folder, leaving the verdict alone, could put arbitrary text on your terminal under a check's name. The report also escapes control characters in every path, link and explanation it prints, so a filename cannot rewrite lines already on the screen.
- The per-machine directory where `alter doctor loom` keeps its baselines is now readable only by you. It held a machine identifier and the full path of every folder ever scanned, at permissions any other account on the machine could read; an existing one is narrowed on the next run.

## [0.8.35] - 2026-07-13

### Fixed

- Self-update no longer mistakes how alter was installed. It used to check whether the Node interpreter sat under the global npm prefix, when it meant to check whether alter itself did. On a system where Node comes from the distribution, those are `/usr/bin/node` and `/usr`, so every install looked npm-managed no matter how it was actually installed, and an update would try to `npm install -g` over the top of a package-manager install. It now reads alter's own location, so a Homebrew, AUR, Scoop, winget, Nix or install-script copy is upgraded through the tool that installed it, and never overwritten by npm.
- An update that cannot be written is now explained instead of failing with a raw permission error. When the global npm prefix is owned by root, alter says so and points at a user-writable prefix, rather than dying on `EACCES`.
- `alter logout` now revokes your member API key server-side reliably. It previously revoked the access token before revoking the member key, so the key revocation was rejected and the key could stay valid on the server until it expired. Logout now revokes the member key first, then the access token.

### Added

- alter now recognises when it is running from a source checkout rather than an installed release, reports it as a local build in `alter about`, and never self-updates over it. A local build can be ahead of, behind, or simply different from what is published, so replacing it with a release would discard work. `alter update` says what is being run and how to rebuild it.
- `alter audit` now reports the active secure-store backend (`dpapi-file`, `macos-keychain`, `libsecret`, or `encrypted-file`), so you can see at a glance which credential store your session will use.

### Changed

- The bundled Obsidian plugin is refreshed to its current release. The vault-pairing surface now carries the ~Alter wordmark throughout, and the consent copy it shows you reads plainly.

## [0.8.34] - 2026-07-12

### Added

- `alter register` creates a new ~alter member from the terminal, with no browser and no passkey. Pick a ~handle, confirm you are 18 or older, acknowledge the member terms, and you are registered and signed in. It pairs with `alter login`, which signs in an existing member. Headless flags (`--handle`, `--i-am-18`, `--accept-terms`) support scripted use.
- `alter cash-out` points you at licensed third-party providers who convert settled USDC to your local currency. ~Alter settles on-chain to your own wallet and stops there. It holds no funds, charges no fee, and passes on no address, amount, or identity data. The conversion is your own act on the provider's own site. Cash-out is also offered from `alter wallet` status and `alter earnings`, and `--json` output is available for agent surfaces.
- `alter login` and `alter status` now show what to do next, read from your own next-best-action projection, so you always finish with a clear next step rather than a bare welcome.

### Fixed

- `alter register` now handles a missing or blocked `--api` override cleanly, printing a clear message and exiting instead of throwing a raw error.
- When `alter cutover` finds no project hooks, it now points you at `alter hooks install` instead of naming a repository you have no access to, and it no longer searches two hard-coded paths in your home directory for them.

### Removed

- `alter doctor` no longer offers a `dev` category. Those checks only did anything in a development checkout of the CLI's own source, so for anyone who installed the CLI they reported nothing and pointed at files that were never there. The remaining categories (identity, mcp, runtime, config, pairing) are unchanged.

### Changed

- Lowered the published `engines.node` floor from 22.22.2 to 20, matching what the CLI actually requires day to day. Only self-update needs Node 22.22.2 or newer (the bundled release-signature verifier's floor); `alter login`, `alter doctor`, and every other command run on any supported Node. README corrected to match.

## [0.8.33] - 2026-07-05

### Fixed

- Self-update now verifies your Node.js version before it downloads and signature-checks a release. On a version older than the 22.22.2 minimum that step needs, it prints a clear "requires Node 22.22.2 or newer" message and exits cleanly instead of failing later with a raw error deep in the release-verification path. Every other command is unaffected by this floor.

### Changed

- Tightened the bundled Claude Code tooling so it stays generic to any project and no longer applies project-specific conventions to your own files. No change to how the core CLI behaves.

## [0.8.32] - 2026-07-03

### Changed

- Build and release hygiene. No user-facing behaviour change.

## [0.8.31] - 2026-07-03

### Changed

- Documentation hygiene. No change to how the CLI behaves.

## [0.8.30] - 2026-07-01

### Changed

- Build and packaging hygiene. No user-facing behaviour change.

## [0.8.29] - 2026-07-01

### Added

- `alter login` now closes with a recognition payoff: it shows what ~alter has read into you so far, as aggregate counts (paired sources and traits read), and the one next step. A new member with a live signal sees their real counts; one with nothing read yet is pointed at `alter pair` to begin. The read is best-effort and fast-timeout bounded, so it never blocks or fails login on a slow or offline network.

### Fixed

- `alter logout` is now a verified, complete credential wipe. It clears the stored session and member key, confirms the removal, and reports loudly if anything could not be cleared, so logging out leaves nothing recoverable on the device.

### Changed

- Removed an unreachable code path in the connect-tools flow. It already failed silently, so this is a cleanup with no behaviour change.
- Trimmed the project-root search to the generic home-directory locations and the current git checkout. No behaviour change for a normal install.

## [0.8.28] - 2026-06-27

### Fixed

- The sign-in handoff now opens the allowlisted routes, so login and registration land on a reachable page instead of a blocked one.

## [0.8.27] - 2026-06-18

### Fixed

- Restart the local runtime daemon after login and after a proactive token rotation, so a refreshed session is picked up without a manual bounce.
- Recognise a registered payout wallet correctly (read the wallet address from the field the backend returns).
- Consent now shows an honest posture message and surfaces the MCP grant ledger on both the command and the menu.

## [0.8.26] - 2026-06-18

### Changed

- Wording polish in help text. No behaviour change.

## [0.8.25] - 2026-06-18

### Changed

- The bundled vault plugin now lists ~Alter as its author, in keeping with the rest of the project. No behaviour change.

## [0.8.24] - 2026-06-18

### Changed

- Development-tooling cleanup. No change to how the CLI behaves.

## [0.8.23] - 2026-06-18

### Changed

- Obsidian pairing: the ~Alter vault plugin now installs entirely from the copy bundled inside the CLI, with no external references in the shipped plugin, and the pairing screen shows clearer progress messages. No change to how pairing works.

## [0.8.22] - 2026-06-18

### Changed

- Wording polish across the README, help text, command screens, diagnostics, the first-run walkthrough, and the bundled status line and hooks, all in plain ~alter voice. The status line shows your identity and a small set of generally useful runtime cues by default, with specialist segments hidden until the data they describe is present. Optional integrations that are absent report cleanly as not configured. No behaviour change.

## [0.8.16] - 2026-06-18

### Fixed

- macOS: the bundled Claude Code hooks and status line now work on a stock install. Several helper scripts relied on features stock macOS does not ship, so they could fail quietly; they now use portable equivalents or degrade cleanly. Linux and Windows Git Bash were already fine.
- macOS: the hook and skill integrity checkers now fail closed when no SHA-256 tool is present, instead of passing unverified. They fall back to a tool stock macOS does ship, and refuse with a clear error when none is available.
- Stale build leftovers can no longer reach the published package. The build clears its output before each run and excludes editor and backup files.

### Changed

- First-run and setup wording in the README and a couple of help screens reads in plain ~alter voice. Copy only.

## [0.8.15] - 2026-06-16

### Added

- Your organisation badge now refreshes without signing out and back in. Membership changes appear while you stay signed in, rather than only at your next sign-in.
- `alter pair status` now shows which fields each connected source read from your account (for example bio, follower counts, account age), not just that the pairing landed. Field names only, never the raw values. A source that captured nothing now says so honestly.

### Fixed

- Windows: `alter` no longer lags, stalls, or stops responding to Escape and Ctrl+C. Reading your sign-in once per command, moving update and floor checks off the command path, and handling Escape on every screen together remove the slowdown and the lock-up. macOS and Linux were unaffected.
- Your organisation badge appears in the status line again, and no longer doubles the `~` on the org handle.
- Your earnings and status numbers no longer carry across a login switch on a shared machine. The cached snapshot is now bound to the signed-in handle and discarded the moment the handle changes.
- A leftover or test-shaped session file can no longer drop you to the signed-out tier or make `alter creds refresh` falsely report "already fresh". Such files are quarantined rather than adopted, and a server rejection is treated as authoritative.
- `alter login` no longer prints a raw diagnostic log line that looked like an error during the browser handoff. Routine diagnostics are quiet on a clean run.

## [0.8.14] - 2026-06-14

### Added

- A full Claude Code status line you can install, alongside the quiet minimal one. Pick "Full" when wiring or from Customise to get git branch, context-remaining, model, scope, a mail indicator, and a per-session label. It degrades gracefully where local tooling is absent: segments with no data simply hide. Your edits to the segment config are never overwritten.
- `alter skills install` / `alter skills uninstall` places a curated set of Claude Code skills and slash commands into your `.claude/` directory in one command. Atomic writes, a tamper-check manifest, and an uninstall that removes only what it installed.
- `alter hooks` now installs lesson-capture and handover-continuity helpers in addition to the existing set. All are local-compute and need no login.
- Build your own colours. Customise gains a custom-colour editor: set any of the twelve colour roles by hand and the menu re-tints live. Your palette persists and feeds the shell prompt too.
- Palette changes preview live as you move the cursor, and the menu now wears your saved palette from the moment it opens.

### Changed

- The full status line is now the default; the quiet identity-only line stays available as a fallback.
- Customise screens replace each other instead of stacking, and the menu is grouped with breathing room between sections.
- A hand-edited sigil in the config file is still honoured.

### Fixed

- Your status-line organisation no longer turns into your email provider. Memberships are now member-declared, so signing in with a privacy-alias address keeps your real organisation. DNS trouble never blocks login.
- `alter org join truealter.com` works now. Both supported organisation DNS record forms resolve, and lookups are bounded so join and login never hang on a dead nameserver.
- No more "you need to login" while you are logged in. Token refresh is now single-flight across every local process, and sessions are written to both the OS keyring and an encrypted-file fallback, so a process that cannot reach the keyring reads the current session rather than a stale one.

## [0.8.10] - 2026-06-05

### Security

- The production minimum-version check now verifies correctly. The client trusted only the development signing key, so every production version-floor check failed closed; the production key is now included.

## [0.8.9] - 2026-06-05

### Added

- `alter whoami --json` prints the non-secret fields of your signed-in identity as one JSON object, read entirely from your local session with no network call. Secrets are excluded, so a hook or script can ask "who is signed in here" without touching a credential.

### Changed

- First-run `alter login` hands you to the browser to finish setup; the terminal still greets you and reflects what you pair. Already-set-up and organisation users just sign in.
- The `alter` menu separates connecting your tools from the rest of your identity, and reveals surfaces as your identity fills in, so a brand-new member is not shown surfaces that open onto nothing yet. Pay-out and withdraw stay visible from the first run and become live once you reach Augmented.

### Fixed

- `alter help` no longer tells a brand-new member to set up a payout before earning anything. The guidance now matches the menu: you earn by signing in, pairing a source, and letting income accrue; choosing a payout method is a later step.

### Security

- The version-floor check verifies the server's signed minimum-version document with a real public key shipped in the client. The signing secret stays on the server. You see no change unless your client is genuinely below the floor.

## [0.8.8] - 2026-06-04

### Added

- Public presence, the "come in" sign. A new `alter room public on|off` toggle lets you opt your `open` presence into public readability; verified strangers can then read that your door is open. The other states stay private to your peers. Default off.
- `alter forget`, the off-switch. Schedules permanent erasure of your whole identity record, with a 30-day grace window during which only you, with your own credential, can call it back.
- Contact email on your handle, separate from your private login email, so you can publish one address to peers while signing in with another.
- Looking Log, a private record of a job search you can read back later. Yours alone, never a claim about you.

### Changed

- Your handle stands alone in the menu header, no longer stamped with a company domain.

### Fixed

- Pay-out, withdraw, and "connect tools" no longer end on a blank screen; each pauses on its result before returning to the menu.
- Several menu items no longer quit the whole app on a backend error; they surface the error and return you to the menu.
- The price shown before a paid query now matches what you are actually charged.
- "100 free lifetime queries" reads as the one-time allocation every member gets, with no fake reset date.
- Windows: the credential health check no longer raises a false permissions warning on a file already protected by its file-system permissions.
- `alter wallet register` checks your input before it prompts, and unknown wallet or earnings subcommands now fail loudly instead of silently showing the default screen.
- `alter pair`'s error lists only sources you can actually pair, and `alter coord status` drops dead sessions from its active view.

## [0.8.7] - 2026-06-03

### Changed

- Querying someone shows the whole cost, what the subject earns, and your remaining free quota before you commit, and prints a receipt afterwards.
- Your attribution log shows your writes again, including local writes with no handle attribution.
- Withdraw runs behind a spinner with clear error handling instead of leaving you on a blank screen.
- Trait counts are labelled by what they actually mean, and "this period" reads "last 30 days".
- Identity profile, portfolio, and style are now distinct views instead of rendering the same template.
- Every handle field prefills the `~` and validates in place; Thread and Verify screens have proper back/Escape/quit.
- "Who can query me" lists one row per peer, and empty states tell you what to do instead of showing a silent blank.

## [0.8.6] - 2026-06-03

### Changed

- Packaging hygiene. Behaviour is unchanged and existing setups keep working. Upgrade to 0.8.6.

## [0.8.5] - 2026-06-03

### Added

- `alter consent revoke` shows the consequences before you confirm: what stops working and what a querier can no longer see. The preview is fetched live, never cached, and if the server cannot supply it the command says so rather than revoking blind.

## [0.8.4] - 2026-06-02

### Fixed

- `alter` opens immediately again. The menu paints first and warms its version and update checks in the background.
- Escape now goes back, not out, in every submenu; `q` is the single deliberate quit key, and every submenu carries a visible "Back" row.
- Slow commands no longer feel frozen. A per-request ceiling and a bounded session refresh replace the old indefinite wait.

## [0.8.3] - 2026-06-02

### Added

- Verified-silent auto-update. The CLI keeps itself current without prompting; a pending update is cryptographically verified before it is applied. Turn it off with `alter update auto off`.

### Fixed

- Withdraw and Pay-out method no longer open to a black screen; they hand the screen back, then return to the menu.
- Verify someone, and Query peer alignment, handle errors and "not granted yet" in place instead of dropping you out of the menu.
- Identity profile shows your trait tiers once, not twice; trait counts and the email line read honestly; consent tables fit the screen.
- Typing a handle without the `~` no longer errors; it is added automatically.

### Changed

- Earnings read as accruing per paid query, with the running total and what is still settling visible. The on-chain payout rail is described as routing "when live".
- User-facing output uses the `Alter` wordmark rather than all-caps. Identity readings show a named tier, never a raw confidence number.
- Broken install instructions corrected to the real `alter prompt install` and `alter wire` commands.

## [0.8.2] - 2026-06-02

### Changed

- Portfolio and Style are consolidated into one "Identity profile" view; both commands still work and route to it.
- The income surfaces say "queriers" rather than "orgs", since the caller is any agent or peer that looked you up.
- Trait counts are labelled by surface so the two figures no longer look like a mismatch.

### Fixed

- The free-query allowance no longer shows a phantom reset; it reads as a one-time lifetime grant.
- Grants fold into one table per peer instead of looking like duplicate rows, and the connected-source count is corrected.
- Wallet withdraw no longer shows a black screen, and an auth failure is distinguished from a genuine zero balance.
- Consent tables no longer overflow the terminal.

### Added

- An indicative per-query pricing panel shown before the confirm step.

## [0.8.1] - 2026-06-02

### Fixed

- `alter doctor` and pairing no longer point at packages that are not published, and obsolete install instructions are removed. The CLI now references only the published packages.

### Added

- The interactive menu header shows the running CLI version beside your handle, read from the build so it can never drift.
- `alter doctor` now covers MCP wiring, the local runtime, and the connector and trait pipeline, on top of the identity and config checks. Run `alter doctor --output-format json` for a machine-readable report. `alter doctor --fix` can auto-wire a missing MCP entry.

### Fixed

- A sweep of menu defects: per-screen breadcrumbs, handle-availability now acts instead of printing usage, `alter wire` works on published bundles, tier labels replace raw scores, narrow terminals scroll with a "more" affordance, and dates render human-readable throughout.

## [0.8.0] - 2026-06-01

### Removed

- Removed the "Try alter as..." persona-prompt menu; `alter` no longer offers persona-roleplay prompts. This is the headline change in 0.8.0.

### Changed

- A copy pass across the member-facing surfaces: a new `alter help advanced` topic gathers power-user plumbing so the default `alter help` leads with the earn path, and Identity Income copy reads "75% goes to you" rather than reciting the split.
- `alter whoami` / `alter status` read in active voice; help text reads in plain ~alter voice; behaviour unchanged.

### Security

- The package's install-time setup script is scoped to this package, so installing the CLI cannot run setup against an unrelated repository.
- The Identity Income prompts use a neutral example handle.

### Fixed

- `alter msg inbox --all` no longer flags every message as unread. Read state from the server is now honoured, so messages marked read render as read.

### Changed

- The interactive menu gains rows for the Golden Thread, Style profile, Verify peer, Morning brief, and Thread with a peer, plus live-preview palette and login layout polish.
- Windows: `alter login` survives a flush-permission hiccup instead of aborting, and commands that shell out to a `.cmd`/`.bat` helper now invoke it correctly.

## [0.7.1] - 2026-05-23

### Changed

- Packaging hygiene for the published build. Behaviour is unchanged; upgrade to 0.7.1.

## [0.6.0] - 2026-05-12

### Changed

- Member-facing copy and menu structure refined across the interactive surfaces.

## [0.5.4] - 2026-05-12

### Fixed

- Stability and copy fixes across the menu and pairing surfaces.

## [0.5.3] - 2026-05-11

### Fixed

- Menu navigation and pairing-status fixes.

## [0.5.2] - 2026-05-11

### Fixed

- Smaller menu and rendering fixes.

## [0.5.1] - 2026-05-11

### Fixed

- Pairing and status-surface fixes.

## [0.5.0] - 2026-05-11

### Added

- Expanded the interactive menu with identity, connection, and customisation surfaces.

## [0.4.9] - 2026-05-09

### Fixed

- Rendering and navigation fixes across the menu.

## [0.4.8] - 2026-05-08

### Changed

- A broad pass over the member-facing surfaces: copy, layout, and navigation refinements.

## [0.4.7] - 2026-05-04

### Changed

- Menu, pairing, and identity-surface improvements.

## [0.4.6] - 2026-05-01

### Fixed

- Pairing and rendering fixes.

## [0.4.5] - 2026-04-30

### Changed

- Member-facing copy and menu refinements.

## [0.4.4] - 2026-04-27

### Changed

- Menu and pairing-surface improvements.

## [0.4.3] - 2026-04-27

### Changed

- Identity and connection surface refinements.

## [0.4.2] - 2026-04-25

### Added

- `alter pair obsidian` sideloads the bundled Obsidian plugin and writes a `~Alter` folder into your vault, where the reflection lands.

## [0.3.0] - 2026-04-23

### Added

- Expanded the command surface across identity, pairing, and income.

## [0.2.1] - 2026-04-23

### Fixed

- Early stability fixes.

## [0.2.0] - 2026-04-23

### Added

- Broadened the initial command set.

## [0.1.0] - 2026-04-20

### Added

- First release of the `alter` command-line client.
