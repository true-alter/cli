# The repository check runner, threat model and invariants

`src/lib/repocheck` reads a repository's own manifests, works out what that
repository says its checks are, asks the user once whether those commands may
execute, runs them, and remembers which ones passed so they need not run again.

Everything it reads is a stranger's to choose. This document says who the
adversary is, what is being protected, and the properties that have to hold. The
invariant list below is the specification the code is measured against: a defect
is a member of an invariant's set that no guard covers, whether or not anybody
has reported it.

This is written the way round it is for a reason. Five find-and-fix rounds were
run against this module, each scoped to the previous round's findings, and each
returned more. A findings list is a sample of the defects somebody happened to
look for. The member set of an invariant is the population.

## 1. Actors

**A1, the hostile repository.** Chooses every byte under the repository root:
manifest contents, sidecar configuration, `.git/config`, `.gitattributes`,
directory names, and the SHAPE of any path (a symlink, a directory, a FIFO, a
device node where a file is expected). Present from the first moment the user
stands in the directory, before any approval exists. This is the actor the
module is mostly written against.

**A2, an approved check's own process.** Once the user approves, a command of
the repository's choosing runs as the user, with the user's `HOME`. It can
therefore write the approval file, the verdict store, and both seals, and it can
leave a survivor behind that writes them later. No boundary this process can
build contains it; the operating system draws no line between a user and their
own child. What is available is detection, and only partial detection.

**A3, a concurrent local writer.** Any process racing the runner's own writes to
the approval file or the verdict store. Distinct from A2 because it needs no
approval to have been given: it needs only to be running while a write happens.

**Not in scope.** A different operating-system user, or root. If either is
hostile the user's `HOME` is already lost and nothing here is the weak point.

## 2. Assets

| Asset | Why it is worth taking |
|---|---|
| The approval file and its seal | An entry in it is arbitrary code execution as the user, unasked |
| The verdict store and its seal | A forged pass is a check that never runs and reports OK |
| The user's process and terminal | Wedging or exhausting the CLI denies every check |
| What the user is told | A person who believes a wrong sentence approves on it |

## 3. Properties

- **P1, no execution before approval.** No program of the repository's choosing
  runs before the user has approved the check set. Includes indirect execution:
  git running a `filter.<name>.clean` or an fsmonitor, corepack fetching a
  package manager, rustup fetching a toolchain, `GOTOOLCHAIN=auto` fetching and
  re-executing a compiler, a version manager on `PATH` resolving a shim.
- **P2, the approval covers what would run.** The digest the user approves
  changes whenever what would execute changes, behind a command line that does
  not.
- **P3, a recall implies a real pass.** A check is skipped only when a real run
  passed against identical content, command, working directory, declaration and
  runner.
- **P4, tampering is visible.** A write to an approval file or verdict store
  that did not come through this module's own writer is noticed at the next
  read. Detection only: see A2.
- **P5, bounded availability.** No repository-chosen input wedges the process,
  exhausts its memory, or runs its work away.
- **P6, the prose is true.** Every user-facing sentence matches what the code
  does.

## 4. Invariants

Each invariant states a property, then the MEMBER SET it ranges over, then how
the set is guarded. A member with no guard is a defect whether or not it has
been observed.

HOW THE VERDICTS WERE REACHED, because a reader will otherwise weigh them all
the same. HELD means a code read established it, and a code read cannot
establish that a set is complete, only that its named members are covered. GUARD
GAP means either an execution proved the gap or the guard demonstrably does not
range over the member named. Where a verdict rests on a measurement, the
measurement is quoted. Nothing here is marked clean on the strength of the tests
passing, because the tests are seeded from this same reading.

### I-1 (P1) Nothing repository-chosen executes before approval is settled

Members: every call path reachable before `isApproved` returns true.

- `repoRootFrom` runs `git rev-parse --show-toplevel`, which reads the
  repository's config and prints a path. It necessarily comes first, since
  nothing can be scoped to a repository before the repository is located.
  ACCEPTED, documented in `identity.ts`.
- `detectChecks` reads files and probes `PATH`. `which` is `accessSync` only and
  never spawns. HELD.
- `contentKey` runs `git status` and `git ls-files`, and `git status` runs the
  repository's clean filters. Reachable only after approval in both callers.
  HELD BY ORDERING, comment-enforced, not structurally.
- No arm executes a tool to interrogate it. HELD.

Guard status: ordering is asserted in prose at three sites and enforced by
nothing. A future caller that keys content before asking is a silent P1 break.

### I-2 (P2) The declaration digest is a function of everything that steers execution

Membership test, unchanged from `detect.ts`: a file or manifest key belongs when
a change to its bytes can change WHICH PROGRAM RUNS or WHAT IT LOADS, given a
command line that does not itself change. It is out when its bytes decide which
CODE is on disk for a command that was going to run anyway.

- **I-2.a Every ecosystem arm folds a non-empty declaration set.** Members: the
  arms, one per `ecosystem` value. GUARD GAP: the test walks
  `DECLARATION_FILES`, a hand-maintained object literal, and never `detectIn`.
  Nothing connects the two, so an arm folding nothing at all passes green.
  `ecosystem: string` means the compiler cannot see it either.
- **I-2.b Every steering file is in some arm's set.** Members: the version
  managers each ecosystem's binary is resolved through, and each runner's own
  configuration. GUARD GAP: `.nvmrc`, `.node-version`, `.python-version` and
  `.rust-version` are read by nvm, fnm, asdf, mise and pyenv to decide which
  binary the shell resolves. That is the `.tool-versions` case exactly and none
  of them is folded.
- **I-2.c Every steering MANIFEST KEY is in its arm's declaration.** Members:
  keys of a parsed manifest, as distinct from sidecar files. GUARD GAP: the
  `volta` key in `package.json` names the node and npm versions Volta fetches
  and runs. `packageManager` is folded for exactly this reason; `volta` is the
  same case and is not.
- **I-2.d A file is digested from where the tool resolves it.** Members: files
  the tool finds by walking UP from the working directory, not only beside the
  manifest. GUARD GAP: `.npmrc`, `.tool-versions`, `mise.toml` and
  `pnpm-workspace.yaml` all resolve from ancestors, so a root-level `.npmrc`
  steers a subproject's check while the subproject's payload never sees it.
  Bound: walk from the project directory up to the repository root inclusive.
  Above the root is the user's own machine, not the repository's choice, and is
  deliberately out.
- **I-2.g Every arm folds what the repository tells GIT to run.** Members: the
  The member set is every file naming a program git executes on this module's
  behalf. Git is the one
  program run for an unapproved repository whatever its ecosystem, so this is
  the membership test met exactly, and no arm folded any of it. MEASURED: a
  repository carrying `.gitattributes` with `* filter=evil` and a matching
  `filter.evil.clean` in `.git/config` wrote a marker file during `contentKey`,
  while its declaration digest stayed byte-identical across arming it. Sharpest
  form, and the reason it outranks its own reachability, is that A2 writes
  `.git/config` once and gets execution on every later run, including one where
  every check is recalled and this module deliberately executes nothing. Bound
  on reachability by A1 alone: `git clone` does not populate `.git/config`, so
  the A1 route needs archive delivery or a submodule.
- **I-2.h Every unit that BUILDS a payload folds a non-empty set of its own.**
  This is I-2.a's property stated at the granularity the code actually works at.
  Members: not the arms, the payload-building units. The python arm builds one
  payload PER TOOL from a per-tool file list, so the tool is the unit that can
  quietly fold nothing, and a tool wired without an entry would put its own
  configuration outside the digest while both existing guards stayed green,
  because the ecosystem's list is the union of the others and is never empty.
  I-2.a's member set was drawn where the previous round's finding pointed rather
  than from its own property sentence, which is the failure this document exists
  to stop, committed inside the document.
- **I-2.e A covered file's byte change always changes the payload.** Absent,
  irregular and unreadable are kept distinct so a directory or a pipe standing
  where a file was is a change rather than a silence. HELD.
- **I-2.f Reordering a manifest costs nobody a re-approval.** `stableRender`
  sorts keys and handles dates, bigints and prototype-bearing values. HELD.

### I-3 (P3) A recalled pass implies a real pass on identical inputs

- **I-3.a The verdict key carries every input that could change the answer.**
  Members: content, check id, command, working directory, runner epoch,
  declaration payload. GUARD GAP: the payload is absent from the key. In
  `worktree` mode an untracked sidecar file is caught by the content key, since
  `status --untracked-files=all` sees it. In `index` mode, which is the basis at
  commit time, untracked content is not in the key at all, so editing an
  ignored `.npmrc` and committing recalls a pass earned under different
  execution.
- **I-3.b A run in which tampering was detected banks nothing from that run.**
  GUARD GAP: the check that was running when the approval file moved has already
  had its pass recorded into the in-memory store, and the store is written
  unconditionally when the repository was approved at all. After the forced
  re-approval that check is recalled and never runs again, which is the one
  check that most needs to.
- **I-3.c The store is written from the copy read before anything ran.** HELD,
  and it is what defeats a check filing verdicts for itself mid-run.
- **I-3.d Only passes are stored.** HELD.

### I-4 (P4) A write that did not come through this module is noticed

- **I-4.a A seal describes the bytes the writer meant to seal.** Members: the
  two writers, `trust.approve` and `store.writeStore`. GUARD GAP, and it is the
  serious one: both compute the seal by RE-READING the file after the rename. A
  writer that replaces the file in that window has its bytes sealed as authentic
  by the legitimate process, which is a forgery signed by the victim. Measured
  at 66.2 per cent of 3000 racing attempts against `approve` and 74.4 per cent
  against `writeStore`. The fix is to seal the buffer that was written.
- **I-4.b A missing seal fails closed.** Both modules answer no when the file is
  present and the seal is not, which is also what an upgrade looks like, so the
  first run after one asks again. HELD.
- **I-4.c A stale seal over a missing file fails closed.** The fingerprint reads
  `absent` and does not match. HELD.
- **I-4.d The window between writing the file and writing the seal fails
  closed.** A reader in that window sees a mismatch and treats the file as cold.
  HELD.
- **I-4.e Withdrawal removes both.** HELD.
- **ACCEPTED, not an invariant.** A forger that rewrites file and seal
  consistently is not detected. Nothing keyed could be: any key would sit under
  the same `HOME` the forger already reads. The seal raises the cost from one
  careless append to a consistent pair of writes, and that is all it does.

### I-5 (P5) No repository-chosen input wedges or exhausts the process

- **I-5.a A path of the wrong SHAPE cannot block a read.** Members: every read
  of a repository-supplied path. `detect.ts` opens with `O_NONBLOCK` and
  `fstat`s the descriptor. GUARD GAP: `identity.digestFile` uses `statSync` and
  `readFileSync` on any path `git status` reported as modified or untracked, with
  no shape guard at all, so a FIFO in the working tree wedges the CLI. It sits
  after approval, which bounds who can reach it and does not make it safe:
  approval covers commands, never the shape of a file added afterwards.
- **I-5.b A large file costs time, never memory.** Digests stream; parsing is
  bounded by `MAX_PARSE_BYTES`, measured from what arrived rather than from a
  size that can change under the read. HELD.
- **I-5.c A pathological tree cannot run the walk away.** `MAX_PROJECTS` bounds
  projects REPORTED. GUARD GAP: it does not bound directories VISITED, and the
  bound is tested after `detectIn` has already run, so a root with very many
  children pays a full detection pass for each.
- **I-5.d Symlinked directories are not descended.** `Dirent.isDirectory` is
  false for a symlink, so a loop cannot form. HELD, incidentally rather than
  deliberately, and worth a test.
- **I-5.e A runaway check is bounded in output, in time, and in what it leaves
  behind.** Output is tailed, a timeout fires, and the process group is swept on
  every exit path. HELD.
- **ACCEPTED.** `setsid` leaves the process group and no signal sent here finds
  it; on Windows `O_NONBLOCK` is undefined and the `fstat` is the only guard;
  the Windows `taskkill` path has a pid-reuse window that POSIX does not.

### I-6 (P2, P3) A basis is the paths it names and nothing else

- **I-6.a A path in the basis is matched literally.** The member set is every
  element passed as a git pathspec. GUARD GAP, and it was derived here before it
  was measured. The working directory is interpolated into the pathspec list beside
  deliberate `:(exclude)` magic, so a directory named with a leading `:(...)`
  is read by git as an instruction rather than as a name. MEASURED against a
  fixture repository: a project directory named `:(exclude)src` passed bare made
  `git ls-files` return the WHOLE TREE rather than that directory, and one named
  `:(exclude)*.ts`, holding three TypeScript files between it and the root, made
  it return everything EXCEPT them, so no edit to any TypeScript in the
  repository could move the content key and a stale pass would be recalled over
  changed code. Under `:(literal)` both name the one directory they are.
- **I-6.b Two different basis lists never key the same.** They are serialised as
  JSON rather than joined on a separator, since no separator is safe against a
  path containing it. HELD.

### I-7 (P6) The prose is true

Members: every user-facing string, and every comment making a claim about
behaviour a reader would rely on.

- **I-7.a** `doctor/checks/repo.ts` tells the user re-approval fires on "the
  commands or the script bodies behind them". The code now also re-approves on
  toolchain files, six node sidecars, clippy and rustfmt configuration, and
  `go.mod` whole, so an ordinary Go dependency bump re-prompts and the only
  sentence the user meets contradicts it. GUARD GAP.
- **I-7.b** The same file tells the user checks are read from "package.json
  scripts, pyproject.toml, Cargo.toml and go.mod". Python detection also fires
  on `setup.cfg`. GUARD GAP, and it is the same defect as I-7.a rather than a
  second one: both are a sentence that was true of an earlier version of the
  code.
- **I-7.c** `trust.ts` describes the cost of forging an approval as a consistent
  pair of writes. Under I-4.a that cost is not imposed, so the claim is
  understated until I-4.a is fixed, and true afterwards.

## 5. What is deliberately not defended

Stated so that a later reader does not mistake an accepted cost for an oversight.

1. **Approval is trust in the repository, not in a string.** The digest covers
   declarations. It cannot cover the code a command reaches: a test file, a
   `conftest.py`, a `build.rs`, a dependency resolved at install time.
2. **A2 cannot be contained.** An approved check runs as the user and can write
   everything this module writes. Withholding environment does not change that,
   because the paths involved are under a `HOME` the check needs anyway.
3. **A seal is a digest, not a signature.** See I-4.
4. **Ancestors above the repository root are not digested.** They are the user's
   own configuration, not the repository's choice. ONE EXCEPTION, found by
   execution rather than reasoned. The digest follows symlinks, so a repository
   shipping `.npmrc` as a link to a path outside the root makes its own approval
   digest depend on a file this clause says is never read. It is a digest only,
   nothing is copied or sent, and the shape guard still refuses anything that is
   not a plain file, so this is an accuracy defect in the sentence rather than
   an exposure. Stated rather than fixed, because refusing an escaping link
   would also refuse the ordinary case of a repository whose configuration is a
   link into its own tooling directory.
5. **The four WRITERS have no caller. The rest of this module ships today.**
   This item previously read "Nothing here is wired", concluded that every gap
   above was latent, and was false in the direction that matters. The narrow
   claim it was built on is true: `runChecks`, `approve`, `writeStore` and
   `record` have no shipped caller. The heading was not. `doctor/registry.ts`
   spreads the repo checks into the default registry and `commands/doctor.ts`
   passes a null `only` filter, so a bare `alter doctor` runs this code in whatever
   repository the user is standing in. That path calls `repoRootFrom`,
   `detectChecks`, which reads and digests every declaration file at every
   ancestor level of a stranger's repository, `declarationDigest`, and
   `isApproved`, which on a seal mismatch calls `revokeAll` and REMOVES two
   files. A shipped command reads a repository nobody vouched for, and carries
   a delete on the same path.

   THE PARTITION BELOW IS DERIVED FROM THE ONE EARLY RETURN THAT DECIDES IT,
   at `doctor/checks/repo.ts:121`, rather than from the list of functions a
   reader happened to name. LIVE, because they run before that return:
   `repoRootFrom`, `detectChecks`, the declaration digest, and `isApproved`.
   SHIPS BUT UNREACHABLE, because everything after the return needs
   `isApproved` to be true and it cannot be while nothing calls `approve`:
   `readStore`, `contentKey`, `verdictKey` and `recall`. UNREACHED FOR THE
   SEPARATE REASON of having no caller at all: `runChecks`, `approve`,
   `writeStore` and `record`.

   Two qualifications on the live side, both found by instrumenting the shipped
   binary rather than by reading it. `revokeAll` sits inside `isApproved` but
   fires only against a trust file whose seal does not match, and reaching that
   state needs a write nothing shipped performs, so it is live by position and
   not in practice. And `readStore` was recorded LIVE here through three
   revisions of this paragraph, carried each time from the sentence above,
   which listed it on the doctor path. It is called at line 128, seven lines
   BELOW the return, and a run of the shipped doctor against a virgin
   repository never reached it. The correction is what the earlier rounds owed
   and did not pay. When a member is found in the wrong column, re-derive the
   whole partition from the mechanism, never relocate the member.

   That distinction carries real weight, because it is what bounds every
   finding about a program git runs on this module's behalf.
   The contradicting evidence was three lines away the whole time, in
   `doctor/checks/repo.ts`, which says this is "the path a person reaches by
   standing in a directory and typing one word, so it is the path that meets a
   repository they did not write."

## 6. What the pass against this document closed

Written after the fixes, from the invariant list rather than from a findings
list, so that a later reader can tell which members were addressed and which
were left with reasons.

EVERY ROW CARRIES HOW ITS VERDICT WAS ESTABLISHED, because the first version of
this table did not and three of its rows turned out to be unestablished. The
methods, strongest first. MEASURED means a probe was executed and its numbers
are here. GUARDED means a test exists AND was observed FAILING against the code
without the fix, which is the only thing that makes a test a guard. TYPED means
the compiler rejects the defect. READ means a code read, which can establish
that named members are covered and can never establish that a set is complete.

| Invariant | Disposition | Established by |
|---|---|---|
| I-1 | Unchanged. Ordering is still comment-enforced, the one gap the type system cannot express here. No caller violates it today | READ, confirmed independently |
| I-2.a | Closed at arm granularity. `Ecosystem` is a closed union and `DECLARATION_FILES` is a `Record` over it, so a missing arm is a compile error | TYPED |
| I-2.b | Closed. The per-language version-manager files folded into the shared set every arm receives unconditionally | GUARDED on membership, by a hand-written list in the test that a deletion breaks. This row previously said GUARDED by the walking test, and that was FALSE: the walk drives itself from the same array the code folds, so deleting all five members left the suite green. The walk guards that the set is APPLIED, never that it is RIGHT |
| I-2.c | Closed. The `volta` key folded beside `packageManager` | GUARDED |
| I-2.d | Closed. Every folded file is digested from the project directory and each ancestor to the repository root, with the level named beside the digest. `pyproject.toml` is parsed at the project's own level and digested at ancestor levels, which an ancestor `[tool.pytest.ini_options]` needed and the first pass missed | GUARDED. The miss was MEASURED against a real pytest, which loaded a plugin named only by the ancestor |
| I-2.g | PARTLY closed, and knowingly. `.gitattributes` is folded at the project level and its ancestors, `.git/config` at the root. THREE MEMBERS ARE NOT REACHED and are named in `detect.ts` beside the fold. A linked worktree or submodule, where `.git` is a file and the real config is elsewhere. DESCENDANT `.gitattributes`, which is the direction git actually merges from and the one a plain clone delivers. And `.git/info/attributes`. Left open deliberately, because every one bites only inside `contentKey`, which cannot be reached while nothing calls `approve` | GUARDED for what is folded. The three gaps were MEASURED by an independent reader, each with a filter executing during `contentKey` and the digest unmoved |
| I-2.h | Closed. `PythonTool` is a closed union and `PYTHON_CONFIG_FILES` is a `Record` over it with no fallback | TYPED |
| I-2.e, I-2.f | Unchanged, already held | READ |
| I-3.a | Closed. The declaration payload is in the verdict key, `RUNNER_EPOCH` bumped to 2 | GUARDED |
| I-3.b | Closed. A tampered run takes back every verdict it filed, while still writing the pre-run copy that overwrites a check's own forgery | GUARDED |
| I-3.c, I-3.d | Unchanged, already held | READ, I-3.b's coverage confirmed independently |
| I-4.a | Closed. Both writers seal the buffer they wrote | GUARDED, and the guard took three attempts. The first raced with `setImmediate`, which cannot preempt synchronous code. The second raced only `approve`, so this row claimed both writers while reverting `writeStore` alone left the suite green. Each writer now has its own racing test. MEASURED at 0 wins against 3000 attempts, where the unfixed writers lost 1789 and 2479 |
| I-4.b to I-4.e | Unchanged, already held | READ |
| I-5.a | Closed. One shared shape guard in safe-read.ts, used by detection and by the working-tree digest that never had it | GUARDED, and the guard took three attempts. First it used an untracked pipe, which git never reports, so it passed against the unfixed code. Then it relied on a per-test timeout, which CANNOT work here, because the hang is a synchronous read blocking the one thread and a timer on that thread never fires. The suite died at 200 seconds with no report. The call now runs in a CHILD process whose event loop is free, and a wedge fails the assertion at 15 seconds instead of stopping the run |
| I-5.c | Closed. `MAX_CANDIDATE_DIRS` bounds directories visited | MEASURED independently at 20000 directories, 248ms before and 22ms after |
| I-5.f | Closed. `MAX_DIR_ENTRIES` bounds what one listing carries, which `MAX_CANDIDATE_DIRS` does not | READ. A large-constant problem rather than an unbounded one |
| I-5.b, I-5.d, I-5.e | Unchanged, already held | READ |
| I-6.a | Closed. The project directory is carried as `:(literal)` | GUARDED, and MEASURED against a real git |
| I-6.b | Unchanged, already held | READ, member set confirmed complete independently |
| I-7.a | Closed on the second attempt. The first rewrite was still untrue, claiming every steering change re-asks while `MAX_APPROVALS` remembers twenty sets, so a repository that changes and changes back does not. It also blamed the repository for a re-prompt that installing or removing a tool causes | READ |
| I-7.b | Closed. `setup.cfg` named | READ |
| I-7.c | Closed by I-4.a | READ |

WHAT IS STILL NOT ESTABLISHED, and belongs to an independent reader rather than
to the author of these fixes. That the three tests added in the second round
fail against the first round's commit, on the same standard the others were held
to. Whether any member of I-2.g exists beyond the two files folded, since git
gains configuration that names programs over time. Whether the version-manager
set in I-2.b is complete, which needs the managers installed to check and none
is on the machine this was written on. Whether folding `.git/config` whole costs
more re-approvals in ordinary use than it is worth, which is a judgement about
people rather than a property of the code.
