# Homebrew Formula FIXTURE for @truealter/cli. Not the channel.
#
# The live channel is the public tap, true-alter/homebrew-tap:Formula/alter.rb.
# That is what `brew install truealter/tap/alter` resolves against, and it now
# tracks npm on its own (track-npm-latest.yml in that repo reads the published
# version daily and opens its own bump PR). Nothing here is copied there.
#
# This file exists to be TEMPLATED AT TEST TIME. A cross-channel install matrix
# rewrites its url and sha256 to point at the artefact under test, so a candidate
# tarball can be brew-installed before it ships.
#
# So the version pinned below is NOT the version the channel serves, and bumping
# it by hand achieves nothing: the matrix overwrites it, and the tap ignores it.
# If you came here to fix an out-of-date brew install, the tap is where to look.
#
# `std_npm_args` requires Homebrew >= 4.0 and handles node dependency
# resolution + PATH setup. `bin.install_symlink` exposes `alter` on
# $PATH via the Homebrew prefix.

class Alter < Formula
  desc "ALTER identity CLI -- login once, authenticated everywhere"
  homepage "https://truealter.com"
  url "https://registry.npmjs.org/@truealter/cli/-/cli-0.8.10.tgz"
  # sha256 pinned to published 0.8.10 tarball. Recompute on every version
  # bump via:
  #   curl -fsSL https://registry.npmjs.org/@truealter/cli/-/cli-<ver>.tgz \
  #     | sha256sum
  # CI rejects "REPLACE_WITH_SHA256_POST_PUBLISH" via ci.yml.
  sha256 "3da81dee1061763a2e4f621c5b31ca531b242ba601a3c1af2006379fb13359e1"
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "alter", shell_output("#{bin}/alter --help")
  end
end
