#!/usr/bin/env bash
# ctest.sh - cross-channel install matrix for @truealter/cli (LOCAL core cells).
#
# Third leg of the pre-publish release gate. This script runs the five LINUX CORE
# cells and writes a ctest-matrix-<date>.json verdict that the recorder
# validates and, on GREEN, turns into the installer-clean marker. The two OS
# cells (macos-homebrew, windows-npm) run in CI only, folded in by the recorder
# from that job's artefacts; they are out of scope here.
#
# CORE CELLS (this script):
#   npm-node20   - `npm i -g <tarball>` on node:20-slim
#   npm-node22   - `npm i -g <tarball>` on node:22-slim
#   npm-alpine   - `npm i -g <tarball>` on node:20-alpine (musl)
#   aur-makepkg  - makepkg a PKGBUILD whose source is the local tarball, on archlinux
#   brew-linux   - brew install a formula whose url is the local tarball, on homebrew/brew
#
# PRE-PUBLISH SEMANTICS (important): the AUR PKGBUILD and Homebrew formula in
# the tree both fetch the tarball from the PUBLISHED npm registry, so neither
# can install the cut version before it is published. This harness therefore
# OVERRIDES each channel's source to the locally packed tarball (recomputing the
# sha256 the packaging pins), which verifies the cut artefact's packaging
# mechanics for THIS version without a chicken-and-egg on the registry upload.
# The registry-sourced PKGBUILD/formula are bumped post-publish separately.
#
# Portable: bash + docker + node/npm (to pack). No GNU-only deps; the JSON is
# emitted by node so no jq is required.
#
# Usage:
#   scripts/ctest.sh                 # pack, run all core cells, write verdict
#   scripts/ctest.sh --tarball X.tgz # use an already-packed tarball
#   scripts/ctest.sh --cells npm     # run only npm-* cells (skip aur/brew)
#   scripts/ctest.sh --out DIR       # write the verdict json into DIR
#
# Exit 0 iff every requested cell PASSed. The verdict json is written
# regardless, so a partial/failed run is still recorded for triage.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

TARBALL=""
OUT_DIR="$REPO_ROOT"
CELLS="all"
while [ $# -gt 0 ]; do
  case "$1" in
    --tarball) TARBALL="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --cells) CELLS="$2"; shift 2 ;;
    -h|--help) sed -n '1,40p' "$0"; exit 0 ;;
    *) echo "ctest: unknown arg $1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "ctest: docker is required" >&2; exit 2; }
command -v node   >/dev/null 2>&1 || { echo "ctest: node is required" >&2; exit 2; }

# `alter --version` prints "alter <semver>", so every cell normalises the
# captured output to the bare semver token before the version match.
semver_of() {
  printf '%s' "$1" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?' | head -1
}

VERSION="$(node -p "require('./package.json').version")"
echo "ctest: cut version ${VERSION}"

# --- pack (or reuse) the artefact the whole matrix installs -------------------
if [ -z "$TARBALL" ]; then
  echo "ctest: packing tarball..."
  TARBALL="$(npm pack --silent | tail -1)"
fi
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
[ -f "$TARBALL" ] || { echo "ctest: tarball not found: $TARBALL" >&2; exit 2; }
TARBALL_SHA="$(sha256sum "$TARBALL" | awk '{print $1}')"
echo "ctest: artefact $(basename "$TARBALL") sha256 ${TARBALL_SHA}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$TARBALL" "$WORK/cli.tgz"

# Results accumulate as newline-delimited "cell|channel|verdict|got|detail".
RESULTS_FILE="$WORK/results.txt"
: > "$RESULTS_FILE"

record_cell() {
  # cell channel verdict got detail
  printf '%s|%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" "$5" >> "$RESULTS_FILE"
  echo "ctest: [$3] $1 (got '${4:-}') ${5:+- $5}"
}

# A cell PASSes iff the installed `alter --version` equals the cut version.
# The container mounts the tarball read-only and installs it; we capture the
# printed version. Any non-match / error is a non-PASS with the captured detail.
run_npm_cell() {
  local cell="$1" image="$2"
  local got detail verdict
  set +e
  got="$(docker run --rm -v "$WORK/cli.tgz:/tmp/cli.tgz:ro" "$image" \
        sh -c 'npm install -g /tmp/cli.tgz >/dev/null 2>&1 && alter --version 2>/dev/null' \
        2>/dev/null | tr -d '\r' | tail -1)"
  local rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    record_cell "$cell" npm FAIL "" "install/exec failed (rc=$rc) on $image"; return
  fi
  got="$(semver_of "$got")"
  if [ "$got" = "$VERSION" ]; then verdict=PASS; detail="$image"
  elif [ -n "$got" ]; then verdict=WARN; detail="version mismatch on $image (got $got)"
  else verdict=FAIL; detail="no version output on $image"; fi
  record_cell "$cell" npm "$verdict" "$got" "$detail"
}

run_aur_cell() {
  # Generate a PKGBUILD whose source is the LOCAL tarball, makepkg it in an
  # archlinux container as a non-root build user, then confirm the packaged
  # binary reports the cut version.
  local got detail verdict
  cat > "$WORK/PKGBUILD" <<PKG
pkgname=truealter-cli
pkgver=${VERSION}
pkgrel=1
pkgdesc='ALTER identity CLI (local ctest build)'
arch=('any')
url='https://truealter.com'
license=('Apache-2.0')
depends=('nodejs>=20')
makedepends=('npm')
source=("cli.tgz")
noextract=("cli.tgz")
sha256sums=('${TARBALL_SHA}')
package() {
  cd "\${srcdir}"
  npm install -g --prefix "\${pkgdir}/usr" "./cli.tgz"
  find "\${pkgdir}/usr" -type f -name 'package.json' -exec sed -i "s|\${srcdir}|/tmp|g" {} \\;
}
PKG
  set +e
  got="$(docker run --rm \
        -v "$WORK/PKGBUILD:/build/PKGBUILD:ro" \
        -v "$WORK/cli.tgz:/build/cli.tgz:ro" \
        archlinux:base-devel \
        bash -c '
          set -e
          pacman -Sy --noconfirm --needed nodejs npm >/dev/null 2>&1
          useradd -m builder
          cp /build/PKGBUILD /build/cli.tgz /home/builder/
          chown -R builder /home/builder
          su builder -c "cd /home/builder && makepkg -f >/dev/null 2>&1"
          pkg=$(ls /home/builder/truealter-cli-*.pkg.tar.* 2>/dev/null | head -1)
          [ -n "$pkg" ] && pacman -U --noconfirm "$pkg" >/dev/null 2>&1
          alter --version 2>/dev/null
        ' 2>/dev/null | tr -d '\r' | tail -1)"
  local rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    record_cell aur-makepkg aur FAIL "" "makepkg/install failed (rc=$rc)"; return
  fi
  got="$(semver_of "$got")"
  if [ "$got" = "$VERSION" ]; then verdict=PASS; detail="archlinux base-devel"
  elif [ -n "$got" ]; then verdict=WARN; detail="version mismatch (got $got)"
  else verdict=FAIL; detail="no version output"; fi
  record_cell aur-makepkg aur "$verdict" "$got" "$detail"
}

run_brew_cell() {
  # Generate a formula whose url is the LOCAL tarball (file://), brew install it
  # in the linuxbrew container, then confirm the cut version.
  local got detail verdict
  cat > "$WORK/alter.rb" <<RB
class Alter < Formula
  desc "ALTER identity CLI (local ctest build)"
  homepage "https://truealter.com"
  url "file:///tmp/cli.tgz"
  version "${VERSION}"
  sha256 "${TARBALL_SHA}"
  depends_on "node"
  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end
  test do
    assert_match version.to_s, shell_output("#{bin}/alter --version")
  end
end
RB
  # Modern Homebrew refuses a bare formula file: it must live in a tap. Create
  # a throwaway local tap, drop the formula in, and install from it.
  set +e
  got="$(docker run --rm \
        -v "$WORK/alter.rb:/tmp/alter.rb:ro" \
        -v "$WORK/cli.tgz:/tmp/cli.tgz:ro" \
        -e HOMEBREW_NO_AUTO_UPDATE=1 -e HOMEBREW_NO_ANALYTICS=1 \
        -e HOMEBREW_NO_INSTALL_FROM_API=1 \
        homebrew/brew \
        bash -c '
          set -e
          brew tap-new local/alter --no-git >/dev/null 2>&1
          tapf="$(brew --repository)/Library/Taps/local/homebrew-alter/Formula"
          mkdir -p "$tapf"
          cp /tmp/alter.rb "$tapf/alter.rb"
          brew install --formula local/alter/alter >/dev/null 2>&1
          alter --version 2>/dev/null
        ' 2>/dev/null | tr -d '\r' | tail -1)"
  local rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    record_cell brew-linux brew FAIL "" "brew install failed (rc=$rc)"; return
  fi
  got="$(semver_of "$got")"
  if [ "$got" = "$VERSION" ]; then verdict=PASS; detail="homebrew/brew"
  elif [ -n "$got" ]; then verdict=WARN; detail="version mismatch (got $got)"
  else verdict=FAIL; detail="no version output"; fi
  record_cell brew-linux brew "$verdict" "$got" "$detail"
}

# --- run the requested cells --------------------------------------------------
case "$CELLS" in
  all)
    run_npm_cell npm-node20 node:20-slim
    run_npm_cell npm-node22 node:22-slim
    run_npm_cell npm-alpine node:20-alpine
    run_aur_cell
    run_brew_cell
    ;;
  npm)
    run_npm_cell npm-node20 node:20-slim
    run_npm_cell npm-node22 node:22-slim
    run_npm_cell npm-alpine node:20-alpine
    ;;
  aur) run_aur_cell ;;
  brew) run_brew_cell ;;
  *) echo "ctest: unknown --cells $CELLS (want: all|npm|aur|brew)" >&2; exit 2 ;;
esac

# --- emit the verdict json (node so no jq dependency) -------------------------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_JSON="${OUT_DIR%/}/ctest-matrix-${STAMP}.json"
RESULTS_FILE="$RESULTS_FILE" VERSION="$VERSION" TARBALL_SHA="$TARBALL_SHA" \
OUT_JSON="$OUT_JSON" STAMP="$STAMP" node -e '
  const fs = require("fs");
  const rows = fs.readFileSync(process.env.RESULTS_FILE, "utf8")
    .split("\n").filter(Boolean).map(l => {
      const [cell, channel, verdict, got, detail] = l.split("|");
      return { cell, channel, base: "local-docker", verdict,
               got_version: got || "", expected: process.env.VERSION,
               detail: detail || "" };
    });
  const out = {
    version: process.env.VERSION,
    artefact_sha256: process.env.TARBALL_SHA,
    generated_at: process.env.STAMP,
    host: "local-docker",
    cells: rows,
  };
  fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(out, null, 2) + "\n");
'
echo "ctest: verdict written -> ${OUT_JSON}"

# Exit non-zero if any requested cell was not PASS.
if grep -qvE '\|PASS\|' "$RESULTS_FILE" 2>/dev/null; then
  # There is at least one non-PASS row.
  if grep -qE '\|(FAIL|WARN|SKIPPED)\|' "$RESULTS_FILE"; then
    echo "ctest: NOT GREEN, at least one cell did not PASS" >&2
    exit 1
  fi
fi
echo "ctest: all requested cells PASSed"
