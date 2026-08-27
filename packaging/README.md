# Packaging

One file lives here, and it is a test fixture, not a channel. Everything
this directory once staged has moved to the surface that actually serves it.

The `@truealter/cli` npm release tarball at
`https://registry.npmjs.org/@truealter/cli/-/cli-<ver>.tgz` is the canonical
artefact behind every channel. The npm publish, not the GitHub Release, is the
trust root; the GH Release carries the same tarball plus a source zip for people
who want to audit from source.

## `homebrew/Formula/alter.rb`, a fixture, not the channel

The live Homebrew channel is the public tap, `true-alter/homebrew-tap`. That is
what `brew install truealter/tap/alter` resolves against, and it tracks npm on
its own: `track-npm-latest.yml` in that repo reads the published version daily
and opens its own bump pull request when the formula falls behind. Nothing in
this repo is copied there.

The formula here exists to be templated at test time. A cross-channel install
matrix rewrites its `url` and `sha256` to point at the artefact under test, so a
candidate tarball can be brew-installed before it ships.

**So the version pinned in it is not the version the channel serves.** Bumping
it by hand achieves nothing: the matrix overwrites it, and the tap ignores it.
An out-of-date `brew install` is a question for the tap.

## `aur/`, gone, it is served from elsewhere

The AUR PKGBUILD moved out of this repo, where it is kept pinned with a weekly
autobump. The copy that stayed behind here was never removed and drifted 24
releases stale, describing itself as moved while still sitting on disk. It is
deleted now, so the description and the tree agree.

Destination remains AUR `truealter-cli`
(`ssh://aur@aur.archlinux.org/truealter-cli.git`).
