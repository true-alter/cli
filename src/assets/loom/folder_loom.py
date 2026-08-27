#!/usr/bin/env python3
"""Folder-native change detection and verdict cells, without git.

Answers "what changed in this folder since last time" for a plain directory that
has no commit graph, and stores check verdicts against that answer.

Scope: local folders on this machine. Nothing here reaches the network.

A verdict computed on another machine is shown but treated as advisory, and
never counts as a pass until it has been re-verified here.

Files that a cloud client (iCloud Drive, OneDrive, Dropbox smart sync) is
holding remotely are reported DEHYDRATED and are never opened, so running this
cannot trigger a download. A dehydrated file counts as neither changed nor
unchanged nor passing, and carries its last known hash forward, so evicting and
restoring a file untouched does not surface as an edit.

Known limit: outside Linux, a remotely-held file inside a Dropbox or OneDrive
mount is not distinguishable from a local one, so there it reads as ordinary and
will still be fetched on access.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import unicodedata
import uuid
from pathlib import Path
from urllib.parse import unquote

SCHEMA = 1
RUNNER_VERSION = "folder-loom/0.1.0"
HASH_ALGO = "sha256"

ANCHOR_NAME = ".loom-anchor"
INSIDE_DIR = ".loom"
VERDICTS_DIR = "verdicts"
IGNORE_FILE = ".loomignore"

# The exact shape this module writes into the folder it measures: a verdict cell
# named for its key, and the temp file each one is atomically replaced from.
# Nothing else the tool produces lands inside the tree. Named as a pattern
# rather than trusted by directory, so the state directory's name is not itself
# a place to put things that the accounting then waves through.
#
# `\Z` and never `$`. In Python `$` also matches immediately BEFORE a trailing
# newline, and a newline is a legal character in a filename on every POSIX
# filesystem, so `$` accepted `<key>.json\n` as this pattern too. Every pattern
# in this module that decides "this is the tool's own, not the sender's" ends
# at `\Z` for that reason: a name test that admits one extra spelling is an
# exemption that widened by one name, and one name is all it takes.
CELL_FILENAME = re.compile(r"^[0-9a-f]{64}\.json(\.tmp-\d+)?\Z")

# A cell's key is the first sixty-four characters of its filename, which the
# pattern above guarantees are hex when it matches at all.
CELL_KEY_LENGTH = 64

# Directories never walked into. Tool-managed state, not the user's knowledge.
#
# Every name here is stored casefolded and matched casefolded, because the same
# directory carries different capitalisation on different systems: macOS writes
# `.Trash`, the freedesktop spec writes `.Trash-1000`, and an exact-case test
# skips neither. That was not a cosmetic miss. A sync client's version history
# is a full second copy of the folder, so walking it means every note's old
# revisions arrive as content and land in the duplicate report as waste the
# owner is supposedly hoarding.
SKIP_DIRS = frozenset(
    name.casefold()
    for name in {
        ".git",
        ".hg",
        ".svn",
        ".obsidian",
        ".trash",
        ".trash-1000",
        INSIDE_DIR,
        "__pycache__",
        "node_modules",
        # Sync clients' own version history and staging state. These hold copies
        # of the owner's files, which is exactly why they must not be counted as
        # the owner's files.
        ".stversions",
        ".stfolder",
        ".sync",
        ".syncthing",
        ".dropbox.cache",
        ".cache",
    }
)
SKIP_FILES = frozenset({".DS_Store", "Thumbs.db"})

# Above this, a file is stat-tracked but not content-hashed. Structural checks
# that need bytes skip it rather than pretending to have read it. The report
# names such files, because otherwise the hashed count sits below the file
# count with nothing on the page explaining the gap, and a reader reasonably
# concludes a file went missing rather than that one was too big to read.
HASH_SIZE_CEILING = 32 * 1024 * 1024

# How many directory levels below the root this run will descend into. The
# walk recurses one Python call per level, so an unbounded depth is an
# unbounded call stack: a directory tree deep enough (or a boundless one
# reached through some other means) ends the run in a crash rather than a
# report. Two hundred is far past any real project's nesting and still leaves
# wide headroom under the interpreter's own call-stack limit. Raise it with
# the FOLDER_LOOM_MAX_DEPTH environment variable, or --max-depth on the CLI.
# Whatever a run stops short of at the ceiling is named in the report, never
# silently dropped: a truncated scan that reads as a clean pass is worse than
# no scan at all.
DEFAULT_MAX_DEPTH = 200


def resolve_max_depth(explicit: int | None) -> int:
    """The depth ceiling for one run: an explicit value wins, then the
    environment override, then the built-in default."""
    if explicit is not None:
        return explicit
    override = os.environ.get("FOLDER_LOOM_MAX_DEPTH")
    if override:
        try:
            value = int(override)
        except ValueError:
            value = 0
        if value > 0:
            return value
    return DEFAULT_MAX_DEPTH


def _bytes_human(n: int) -> str:
    """Sizes for a person reading a report, not for arithmetic."""
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024 or unit == "GiB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024  # type: ignore[assignment]
    return f"{n} B"


# Entry states. UNREADABLE is a third state beside present and gone: a delete is
# never inferred from a read failure. DEHYDRATED is a fourth: the folder is
# telling us the file exists and that its bytes are not here, which is a
# different fact from a read that failed and a very different fact from a delete.
PRESENT = "present"
UNREADABLE = "unreadable"
DEHYDRATED = "dehydrated"

# Verdict statuses.
PASS = "pass"
FAIL = "fail"
UNVERIFIABLE = "unverifiable"

# A cell computed elsewhere. Displayed, never counted.
ADVISORY = "advisory"


# --------------------------------------------------------------------------
# paths and canonical form
# --------------------------------------------------------------------------


def state_root() -> Path:
    """Per-machine state directory, outside every folder this tool tracks."""
    override = os.environ.get("FOLDER_LOOM_STATE_DIR")
    if override:
        return Path(override)
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return Path(base) / "loom"
    if sys.platform == "darwin":
        return (
            Path(os.path.expanduser("~")) / "Library" / "Application Support" / "loom"
        )
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state"
    )
    return Path(base) / "loom"


# `os.scandir`/`os.listdir` decode a filename byte the platform encoding
# cannot represent with the `surrogateescape` handler: one lone code point in
# U+DC80-DCFF standing in for that original byte. Left in place, that code
# point survives into every JSON payload and digest input this relpath feeds,
# and a plain UTF-8 (strict) encode of any of them raises and kills the whole
# run over one file. Escaping it here, once, at the point every downstream
# consumer reads from, turns it into a stable, printable, always-encodable
# ASCII form instead: the byte is named rather than lost, and the file is
# reported like any other rather than aborting the scan.
SURROGATE_ESCAPE = re.compile("[\udc80-\udcff]")


def canonical_relpath(relpath: str) -> str:
    """NFC, forward slashes. The same file on macOS, Linux and Windows must key
    identically, and a sort over non-canonical bytes is not a stable order."""
    normalised = unicodedata.normalize(
        "NFC", relpath.replace(os.sep, "/").replace("\\", "/")
    )
    return SURROGATE_ESCAPE.sub(lambda m: "\\x%02x" % (ord(m.group()) - 0xDC00), normalised)


def canonical_json(payload: object) -> str:
    return json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )


def digest(text: str) -> str:
    """Stable hash over text that may carry surrogate-escaped bytes.

    `os.scandir`/`os.listdir` decode an undecodable filename byte with the
    `surrogateescape` handler (a lone code point in U+DC80-DCFF standing for
    the original byte), and that string can end up inside `canonical_json`
    output via a relpath used as a dict key. `errors="surrogateescape"` on
    encode is the paired inverse: for a normal string it changes nothing, and
    for a surrogate-escaped one it deterministically reconstructs the exact
    original byte, so the digest stays both stable and collision-resistant.
    Encoding under plain `"utf-8"` (strict) raises `UnicodeEncodeError` on
    that one code point and aborts the whole run.
    """
    return hashlib.sha256(text.encode("utf-8", errors="surrogateescape")).hexdigest()


# Owner-only, never the umask. What this tool keeps is a stable identifier for
# the machine and a complete path-and-filename inventory of every folder that
# has ever been scanned on it; `~/clients/acme-redundancies/` is itself the
# finding. Under a default umask these landed 0755 and 0644, readable by every
# other account on the box, which is a disclosure the tool made on the owner's
# behalf without being asked.
DIR_MODE = 0o700
FILE_MODE = 0o600


def is_state_path(path: Path) -> bool:
    """Is this somewhere this tool keeps its own records, as opposed to the
    owner's folder.

    The distinction decides who gets re-permissioned. This tool narrows what
    IT created; it never re-permissions a directory it was merely pointed at.
    The anchor and the verdict cells live in the owner's folder and keep the
    owner's own modes.

    Goes through `realpath` (via `inside_root`), so it answers where a write
    actually LANDS, symlinks resolved. That is the right question for
    deciding whether to chmod something, and the wrong one for deciding
    whether to trust a directory enough to write through it at all: a
    `baselines/` replaced by a symlink resolves to wherever the symlink
    points, this function correctly says that is not the state root, and a
    caller that reads "not mine" as "must be the owner's folder, write it
    plainly" writes through the symlink anyway. See `intends_state_path`.
    """
    root = state_root()
    return path == root or inside_root(root, path)


def intends_state_path(path: Path) -> bool:
    """Was `path` BUILT as a component of the state root, as opposed to where
    it currently resolves.

    Every state-dir path in this module is constructed the same way, as
    `state_root() / "literal-name"` or a name below that, never received from
    the folder being measured. Lexical containment (no symlink resolution) is
    exactly what that construction guarantees, and exactly what
    `is_state_path`'s `realpath` does not: a `baselines/` a caller built this
    way and finds ALREADY REPLACED by a symlink is this tool's own directory
    compromised, never the owner's, whatever the symlink now points at.
    """
    root = state_root()
    if path == root:
        return True
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def make_secure_dir(path: Path) -> None:
    """Create `path`, owner-only where the tool owns it.

    The repair half matters as much as the create half: a state directory made
    by an earlier version under a permissive umask stays world-readable for the
    rest of its life unless something narrows it.

    Checked before `mkdir`, not after: `mkdir(parents=True, exist_ok=True)`
    treats a symlink resolving to an existing directory as already there and
    does nothing further, so by the time `is_state_path` ran on the result the
    write this call exists to protect had already been handed to whatever the
    symlink pointed at. A directory this tool is about to own is refused
    outright the moment it turns out to already be a symlink, before this
    function creates or touches anything - the same refusal `cell_dir` already
    makes on the owner's side of this same class, applied to this tool's own
    side of it.
    """
    root = state_root()
    targets = [path] if path == root else [path, root]
    # Gated on the CALL being about the state tree at all: `path` here is also
    # the owner's own folder (the anchor's parent), and `root` must never be
    # symlink-checked on THAT call just because it happens to be on the
    # target list for the state-tree case below. A legitimately symlinked
    # state root would otherwise fail every unrelated owner-folder write too.
    if intends_state_path(path):
        for target in targets:
            if target.is_symlink():
                raise OSError(
                    f"refusing {target}: a symlink stands where this tool's "
                    "own state directory belongs"
                )
    path.mkdir(parents=True, exist_ok=True)
    if not is_state_path(path):
        return
    for target in targets:
        try:
            os.chmod(target, DIR_MODE)
        except OSError:
            pass


def write_secure_text(path: Path, text: str) -> None:
    """Write `text` to `path`, owner-readable from the moment it exists when
    the file is the tool's own.

    Created at the mode rather than chmod'ed after: a file written 0644 and
    narrowed a line later is world-readable for the length of that line.
    O_NOFOLLOW where the platform has it, so the write cannot be redirected
    through a link left at the temp name.
    """
    if not is_state_path(path):
        path.write_text(text, encoding="utf-8")
        return
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, FILE_MODE)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    try:
        os.chmod(path, FILE_MODE)
    except OSError:
        pass


def machine_id() -> str:
    """Stable identity for this machine, generated once, kept outside every
    tracked folder so an arriving folder cannot assert it."""
    path = state_root() / "machine-id"
    try:
        value = path.read_text(encoding="utf-8").strip()
        if value:
            # Written once and read every run after, so the read is the only
            # place a file left world-readable by an earlier version is ever
            # seen again. Narrow it here or never - but only the file itself:
            # `chmod` on a symlink has no operation that stops at the link on
            # this platform, so `machine-id` replaced by a symlink would have
            # this narrow whatever it points at instead, on nothing more than
            # state-dir write access. Skipped rather than followed.
            if not path.is_symlink():
                try:
                    os.chmod(path, FILE_MODE)
                except OSError:
                    pass
            return value
    except OSError:
        pass
    value = str(uuid.uuid4())
    make_secure_dir(path.parent)
    tmp = path.with_name(path.name + ".tmp")
    write_secure_text(tmp, value + "\n")
    os.replace(tmp, path)
    return value


def write_json_atomic(path: Path, payload: object) -> None:
    """Temp file beside the target, then replace. A reader never sees a torn
    file, and a crash leaves either the old file or the new one."""
    make_secure_dir(path.parent)
    tmp = path.with_name(path.name + f".tmp-{os.getpid()}")
    write_secure_text(tmp, canonical_json(payload))
    try:
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise


def is_regular_file(path: Path) -> bool:
    """True only for a plain file, never following a symlink to decide.

    A FIFO is neither a symlink nor a directory and sizes to zero, so every
    test this module makes about shape used to wave one through to `open()`,
    where the read blocks until a writer arrives and need never return. This
    process has one thread, so that wait is the whole run. The same is true of
    a character device that streams without end. Both cost one command to
    create, in any folder that arrives by rsync, archive or share.
    """
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


def read_json(path: Path) -> dict | None:
    """A malformed store is discarded whole, never partially salvaged: a row
    missing from a truncated file reads as a deleted file.

    Every one of this tool's own JSON stores (bindings, baselines, ledgers,
    not only `machine-id`) is read through here, so the mode repair belongs
    here once rather than at each store's own read function, where it is one
    store away from being forgotten again. `write_json_atomic` only reaches a
    file's mode when its CONTENT changes (the rename-over-tmp is what narrows
    it), so a store nothing has written to since an earlier, more permissive
    version stays exactly as wide as that version left it. Gated on
    `is_state_path` first, same as every other repair in this module: this
    function is also used to read a FOLDER-supplied file (the anchor, an
    arrived verdict cell), and those keep the owner's own modes. `is_symlink`
    is checked before `chmod`, never after: `chmod` on Linux has no operation
    that acts on a symlink itself, so a `path` a state file was replaced by
    pointing outside the state root would otherwise have its target narrowed
    on the strength of nothing but reading that path.
    """
    if is_state_path(path) and not path.is_symlink():
        try:
            os.chmod(path, FILE_MODE)
        except OSError:
            pass
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# --------------------------------------------------------------------------
# anchor and binding
# --------------------------------------------------------------------------


class CopyDetected(Exception):
    """A folder presenting a folder_id already bound to a different path."""

    def __init__(self, folder_id: str, known_path: str, this_path: str):
        self.folder_id = folder_id
        self.known_path = known_path
        self.this_path = this_path
        super().__init__(
            f"folder {this_path} carries the id of a folder already tracked at {known_path}"
        )


def read_or_create_anchor(root: Path) -> tuple[str, bool]:
    """Return (folder_id, created). The anchor gives the folder an identity that
    survives being renamed. It is a file the owner can edit or delete, so it is
    never trusted alone: see bind()."""
    path = root / ANCHOR_NAME
    # Only a plain file is read as an anchor. A FIFO here blocks the run
    # forever; a DIRECTORY here reads as absent and then makes the write
    # below raise, ending the whole run in a traceback. Both are one command
    # to create in a folder that arrived from somebody else, so neither
    # decides whether this tool runs.
    existing = read_json(path) if is_regular_file(path) else None
    if (
        existing
        and isinstance(existing.get("folder_id"), str)
        and existing["folder_id"]
    ):
        return existing["folder_id"], False
    folder_id = str(uuid.uuid4())
    try:
        write_json_atomic(path, {"schema": SCHEMA, "folder_id": folder_id})
    except OSError:
        # Nothing on disk claims this id, so the next run generates another
        # one and reports a first run again. A degraded answer every time
        # beats no answer at all, and the anchor is the owner's file to fix.
        pass
    return folder_id, True


def bindings_path() -> Path:
    """The per-machine index of every folder this machine has bound. Outside
    every tracked folder, so no folder can write itself into it."""
    return state_root() / "bindings.json"


def bind(root: Path) -> dict:
    """Bind this folder to its baseline.

    The binding is over the anchor id AND the folder's real path at first bind
    AND this machine, not the anchor id alone. Two folders carrying one id, the
    ordinary result of copying a folder, get two baselines and a visible report,
    never one silently shared baseline: a shared baseline turns the shrink check
    into a no-op in exactly the accidental-loss case it exists for.
    """
    real = str(Path(os.path.realpath(root)))
    folder_id, created = read_or_create_anchor(root)
    mid = machine_id()
    index_path = bindings_path()
    index = read_json(index_path) or {"schema": SCHEMA, "bindings": {}}
    bindings = index.setdefault("bindings", {})

    binding_id = digest(canonical_json([folder_id, real, mid]))[:32]
    known = [b for b in bindings.values() if b.get("folder_id") == folder_id]
    fork_of = None
    for other in known:
        if other.get("realpath") != real:
            fork_of = other.get("realpath")
            break

    if binding_id not in bindings:
        bindings[binding_id] = {
            "folder_id": folder_id,
            "realpath": real,
            "machine_id": mid,
            "first_bound_at": time.time(),
            "forked_from": fork_of,
        }
        write_json_atomic(index_path, index)

    return {
        "binding_id": binding_id,
        "folder_id": folder_id,
        "realpath": real,
        "machine_id": mid,
        "anchor_created": created,
        "fork_of": fork_of,
    }


# --------------------------------------------------------------------------
# whose footprint is it
# --------------------------------------------------------------------------


class LocalStores:
    """Which verdict stores inside a measured tree THIS MACHINE actually wrote.

    The rule this class exists to hold: THE OWNERSHIP TEST MUST NOT READ FROM
    INSIDE THE TREE BEING MEASURED. Whoever hands over a folder controls every
    byte in it, so any exemption decided by a file inside it is an exemption
    they can grant themselves, and it costs them exactly as much as creating
    that file. That was true of the anchor: a folder holding an empty file of
    the right name minted its own exempt store, at any depth, and everything
    under it left the count with no line anywhere saying so.

    Both facts come from outside instead. The per-machine binding index says
    which real paths this machine has bound; the per-binding ledger says which
    cell keys this machine itself computed. A store is the tool's own only when
    the folder holding it is a known local binding AND the cell was written
    from here. Everything else in the tree belongs to whoever sent it, and is
    sized like any other excluded content.

    Two files outside the folder, read at most once each per run. The promise
    never to open anything inside the measured tree is untouched.
    """

    def __init__(self) -> None:
        self._by_realpath: dict[str, list[str]] = {}
        index = read_json(bindings_path()) or {}
        mid = machine_id()
        for binding_id, record in (index.get("bindings") or {}).items():
            if not isinstance(record, dict) or record.get("machine_id") != mid:
                continue
            realpath = record.get("realpath")
            if isinstance(realpath, str) and realpath:
                self._by_realpath.setdefault(realpath, []).append(binding_id)
        self._keys: dict[str, frozenset[str]] = {}

    def keys_for(self, folder: Path) -> frozenset[str] | None:
        """The cell keys this machine wrote into this folder, or None when the
        folder is not one this machine has bound at all.

        None and an empty set are different answers and both are used: None
        means nothing here is ours, so even the anchor is the sender's content;
        an empty set means the folder is ours but we have written no cell into
        it yet, so the store's name still buys nothing.
        """
        try:
            real = str(Path(os.path.realpath(folder)))
        except OSError:
            return None
        ids = self._by_realpath.get(real)
        if not ids:
            return None
        held = self._keys.get(real)
        if held is None:
            keys: set[str] = set()
            for binding_id in ids:
                keys |= set(load_ledger(binding_id)["keys"])
            held = frozenset(keys)
            self._keys[real] = held
        return held


def own_footprint(name: str, is_dir: bool, owned: bool) -> bool:
    """True when this entry is something THIS MODULE wrote into the tree it
    measures, rather than content the folder's owner put there.

    Writing into the folder under measurement is the one reflexive thing this
    module does, so its whole footprint is named here in one place: the anchor
    file, and the verdict store beside it. Nothing else it produces lands
    inside a tracked folder; baselines, the ledger, the binding index and the
    machine id all live in the per-machine state directory, outside every
    folder this tool touches.

    Charging that footprint to the folder's owner is what makes a tool report
    its own cache as content someone is holding back: the excluded count climbs
    on a folder nobody touched, and two runs over one unchanged folder disagree.

    `owned` is the whole question, and it is answered from OUTSIDE the tree
    (LocalStores), never from a file inside it. It exempts the anchor and the
    STORE, not the store's NAME: see count_state_dir_foreign and
    is_own_cell, without which the exemption is itself a hiding place that
    costs a sender nothing but knowing a directory name.
    """
    if not owned:
        return False
    return name == INSIDE_DIR if is_dir else name == ANCHOR_NAME


def is_own_cell(name: str, ledgered: frozenset[str]) -> bool:
    """True for a verdict cell this machine itself wrote.

    Shape alone is not enough. A sixty-four character hex name is something a
    sender can type, so the name is checked against the per-machine ledger of
    keys this machine computed. A cell that arrived with the folder is the
    sender's file for sizing purposes, whatever it is named and whatever it
    says inside; it is still displayed as advisory when a check asks for it.
    """
    if not CELL_FILENAME.match(name):
        return False
    return name[:CELL_KEY_LENGTH] in ledgered


# --------------------------------------------------------------------------
# the walk
# --------------------------------------------------------------------------


def load_ignore_globs(root: Path) -> list[str]:
    path = root / IGNORE_FILE
    # Shape first: this is a file the folder supplies, and a FIFO wearing this
    # name would hold the run open at the first read it makes.
    if not is_regular_file(path):
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return []
    return [ln.strip() for ln in lines if ln.strip() and not ln.strip().startswith("#")]


def ignored(relpath: str, globs: list[str]) -> bool:
    return any(fnmatch.fnmatch(relpath, g) for g in globs)


def probe_kind(item: os.DirEntry) -> tuple[bool, bool]:
    """(is_symlink, is_dir) for one directory entry, the single call pair every
    exclusion path uses to size what it is skipping. Isolated to one place so
    the OSError branch (permission denied, or the entry vanished between
    scandir and this call) is one function, not four copies that could drift.
    """
    return item.is_symlink(), item.is_dir(follow_symlinks=False)


def _scan_sorted(path: Path) -> list[os.DirEntry] | None:
    """Directory entries in name order, or None if the directory cannot be read.

    Sorted because directory order is arbitrary, and two runs over one
    unchanged folder that disagree are two runs a reader cannot use.
    """
    try:
        with os.scandir(path) as it:
            return sorted(it, key=lambda e: e.name)
    except OSError:
        return None


def count_files_under(
    path: Path,
    stores: LocalStores | None = None,
    depth: int = 0,
    max_depth: int = DEFAULT_MAX_DEPTH,
    *,
    prefix: str = "",
    depth_capped_dirs: list[str] | None = None,
) -> tuple[int, int]:
    """Structure-only file count under a suppressed subtree: no reads, no
    hashing, nothing that could touch the network on a cloud-backed mount.

    Bounded by the same depth ceiling as the main walk, for the same reason:
    this recurses one Python call per level, and a suppressed subtree can be
    exactly as deep as an unsuppressed one. Past the ceiling this stops.

    A ceiling hit here is a DIFFERENT fact from a directory this pass could
    not even scandir, and the two must never share one bucket: one means "we
    tried and were refused", the other means "we chose not to try". When
    `depth_capped_dirs` is supplied it is where a ceiling hit is named (by
    relpath, same list `descend()` itself appends to, so a truncation is
    visible through one channel no matter which of the four recursive
    functions in this module hit it), and it is NOT added to `unsized`. Only
    when the caller passes no list at all (a direct call outside the walk's
    own bookkeeping) does a ceiling hit fall back to `unsized`, so the event
    is still counted somewhere rather than silently dropped.

    This exists only to size a suppression surface (an ignore glob, a
    boundary, the tool-noise skip list, a reserved filename) so its effect on
    the coverage denominator is visible rather than silently absorbed.

    Inside an ALREADY-EXCLUDED subtree, none of the walk's own exclusion rules
    apply again. Everything below counts, whatever it is named. The caller is
    charging the whole subtree to one bucket, so nothing here can be
    double-counted, and re-applying the rules is how the suppression this
    function exists to size reappears one directory level further down: a
    skip-list name, or a reserved filename, nested inside an excluded subtree
    used to size to nothing at all, which is the same zero-configuration,
    zero-trace hiding place at a depth nobody was looking at. Depth must not
    change the answer, so the accounting lives in the recursion rather than at
    the call sites. The single exception is this tool's own state directory,
    and only for the cells the tool itself wrote.

    "The tool's own" is decided from the per-machine records OUTSIDE the tree
    (LocalStores), never from a file inside it. Deciding it from an anchor file
    was the last spelling of the same defect: any folder anywhere under here
    could mint its own exempt store for the cost of one empty file, so the
    hiding place came back one level further out rather than being closed.

    Returns `(files, unsized)`. `files` is a structural floor: an unreadable
    nested directory contributes nothing to it rather than a guess. `unsized`
    counts entries this pass could not even determine the kind of (or a whole
    subtree it could not list at all), so that residual is a NAMED unknown
    rather than folded into `files` as an assumed zero. Guessing at a missing
    probe is exactly the undercount that misleads a reader about how much is
    hidden; a whole unreadable subtree is scored as one unsized entry, not as
    empty.
    """
    total = 0
    unsized = 0
    stores = stores if stores is not None else LocalStores()
    items = _scan_sorted(path)
    if items is None:
        return total, unsized + 1
    # None unless this machine has itself bound this exact folder. Read from
    # the per-machine index, so a folder cannot answer this question about
    # itself by holding a file.
    ledgered = stores.keys_for(path)
    owned = ledgered is not None
    for item in items:
        try:
            is_link, is_dir = probe_kind(item)
        except OSError:
            unsized += 1
            continue
        if is_link:
            # Matches the "files" denominator's own definition (kind == "file"
            # only): a symlink was never counted there either, so counting one
            # here would overstate what this subtree hides.
            continue
        if is_dir:
            if depth >= max_depth:
                # One level deeper would pass the ceiling. Not opened. Named
                # by relpath in the shared list when the caller is tracking
                # one (the walk always is); only a caller with no list at all
                # falls back to the generic unsized bucket, so the event is
                # never simply dropped.
                if depth_capped_dirs is not None:
                    depth_capped_dirs.append(canonical_relpath(prefix + item.name))
                else:
                    unsized += 1
                continue
            if own_footprint(item.name, True, owned):
                sub_files, sub_unsized = count_state_dir_foreign(
                    Path(item.path),
                    ledgered or frozenset(),
                    stores,
                    depth + 1,
                    max_depth,
                    prefix=prefix + item.name + "/",
                    depth_capped_dirs=depth_capped_dirs,
                )
            else:
                sub_files, sub_unsized = count_files_under(
                    Path(item.path),
                    stores,
                    depth + 1,
                    max_depth,
                    prefix=prefix + item.name + "/",
                    depth_capped_dirs=depth_capped_dirs,
                )
            total += sub_files
            unsized += sub_unsized
        elif not own_footprint(item.name, False, owned):
            total += 1
    return total, unsized


def count_state_dir_foreign(
    path: Path,
    ledgered: frozenset[str],
    stores: LocalStores,
    depth: int = 0,
    max_depth: int = DEFAULT_MAX_DEPTH,
    *,
    prefix: str = "",
    depth_capped_dirs: list[str] | None = None,
) -> tuple[int, int]:
    """Size what sits inside this tool's own state directory that this tool did
    not put there.

    The tool's whole footprint inside the measured tree is verdict cells under
    `<state>/verdicts/`, plus the temp file each is atomically replaced from.
    Those are the tool's own and are never charged to the folder's owner.
    EVERYTHING else under that directory is the owner's and is sized like any
    other excluded content, because exempting the directory wholesale would
    hand a sender a hiding place whose only requirement is knowing the
    directory's name.
    """
    total = 0
    unsized = 0
    items = _scan_sorted(path)
    if items is None:
        return total, unsized + 1
    for item in items:
        try:
            is_link, is_dir = probe_kind(item)
        except OSError:
            unsized += 1
            continue
        if is_link:
            continue
        if is_dir:
            if depth >= max_depth:
                if depth_capped_dirs is not None:
                    depth_capped_dirs.append(canonical_relpath(prefix + item.name))
                else:
                    unsized += 1
                continue
            if item.name == VERDICTS_DIR:
                sub_files, sub_unsized = count_non_cell_files(
                    Path(item.path),
                    ledgered,
                    stores,
                    depth + 1,
                    max_depth,
                    prefix=prefix + item.name + "/",
                    depth_capped_dirs=depth_capped_dirs,
                )
            else:
                sub_files, sub_unsized = count_files_under(
                    Path(item.path),
                    stores,
                    depth + 1,
                    max_depth,
                    prefix=prefix + item.name + "/",
                    depth_capped_dirs=depth_capped_dirs,
                )
            total += sub_files
            unsized += sub_unsized
        else:
            total += 1
    return total, unsized


def count_non_cell_files(
    path: Path,
    ledgered: frozenset[str],
    stores: LocalStores,
    depth: int = 0,
    max_depth: int = DEFAULT_MAX_DEPTH,
    *,
    prefix: str = "",
    depth_capped_dirs: list[str] | None = None,
) -> tuple[int, int]:
    """Files in the verdict store that this machine did not write there.

    A cell is named for its own key, and which keys this machine computed is
    recorded outside the folder. So the exemption is over the LEDGER, not over
    the shape of a name: a sixty-four character hex name is something a sender
    can type, and a name test alone made typing one enough to leave the count.
    Nothing is opened to decide this, which matters because the store can sit
    on a cloud-backed mount where reading five hundred cells is exactly the
    silent network fetch this module exists to refuse.

    A cell that genuinely arrived with the folder is therefore sized as the
    owner's content here, and separately displayed as advisory when a check
    asks for it. Those are two different questions about one file and they get
    two different answers on purpose: it occupies the folder either way, and
    this machine has verified none of it.
    """
    total = 0
    unsized = 0
    items = _scan_sorted(path)
    if items is None:
        return total, unsized + 1
    for item in items:
        try:
            is_link, is_dir = probe_kind(item)
        except OSError:
            unsized += 1
            continue
        if is_link:
            continue
        if is_dir:
            if depth >= max_depth:
                if depth_capped_dirs is not None:
                    depth_capped_dirs.append(canonical_relpath(prefix + item.name))
                else:
                    unsized += 1
                continue
            sub_files, sub_unsized = count_files_under(
                Path(item.path),
                stores,
                depth + 1,
                max_depth,
                prefix=prefix + item.name + "/",
                depth_capped_dirs=depth_capped_dirs,
            )
            total += sub_files
            unsized += sub_unsized
        elif not is_own_cell(item.name, ledgered):
            total += 1
    return total, unsized


def hash_file(path: Path) -> str | None:
    h = hashlib.new(HASH_ALGO)
    try:
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                h.update(chunk)
    except OSError:
        return None
    return h.hexdigest()


# Windows sets these on a file whose bytes live in the cloud. Reading such a
# file silently pulls it over the network, which is the one thing this module
# promises never to do.
FILE_ATTRIBUTE_OFFLINE = 0x1000
FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x00040000
FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000
CLOUD_ATTRIBUTES = (
    FILE_ATTRIBUTE_OFFLINE
    | FILE_ATTRIBUTE_RECALL_ON_OPEN
    | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
)

# iCloud Drive evicts a file by REPLACING it with a small plist under a
# different name. The real name disappears from the directory, so without this
# the walk sees a delete and an unrelated addition.
ICLOUD_STUB = re.compile(r"^\.(?P<real>.+)\.icloud\Z")

# Filesystem sources and types that mean "these bytes may not be local". Matched
# against /proc/mounts, so this is Linux-only by construction; the Windows and
# iCloud signals above are per-file and need no mount table.
CLOUD_FS_MARKERS = (
    "rclone",
    "onedriver",
    "onedrive",
    "dropbox",
    "insync",
    "google-drive",
    "gdrive",
    "gcsfuse",
    "megasync",
    "pcloud",
)


def icloud_shadow(name: str) -> str | None:
    """The real filename an iCloud stub stands in for, or None."""
    m = ICLOUD_STUB.match(name)
    return m.group("real") if m else None


def cloud_backed_mount(root: Path) -> str | None:
    """The mount source backing this folder, when it is a cloud-sync filesystem.

    Read once per run, never per file. Returns None on any platform without
    /proc/mounts, and on any folder sitting on ordinary local storage.

    This exists to keep the sparse-file signal honest. `st_blocks == 0` with a
    non-zero size means "no blocks allocated", which is true of a dehydrated
    cloud file and equally true of a genuinely sparse file on ordinary local
    storage. Treating it as cloud-eviction everywhere would report healthy
    local files unverifiable, so the signal only speaks where a cloud
    filesystem is actually mounted.
    """
    try:
        target = str(root.resolve())
        mounts = Path("/proc/mounts").read_text(encoding="utf-8").splitlines()
    except OSError:
        return None

    # Longest matching mount point wins: a cloud folder nested inside an
    # ordinary one is backed by the inner mount, not the outer.
    best_len = -1
    best_desc = ""
    for line in mounts:
        parts = line.split()
        if len(parts) < 3:
            continue
        source, point, fstype = parts[0], parts[1].replace("\\040", " "), parts[2]
        if target != point and not target.startswith(point.rstrip("/") + "/"):
            continue
        if len(point) <= best_len:
            continue
        best_len = len(point)
        haystack = f"{source} {fstype}".lower()
        is_cloud = any(marker in haystack for marker in CLOUD_FS_MARKERS)
        best_desc = f"{source} ({fstype})" if is_cloud else ""
    return best_desc or None


def dehydration_reason(st: os.stat_result, cloud_mount: str | None) -> str | None:
    """Why this file's bytes are not here, or None if they are.

    Stat-only. Nothing is opened, so nothing is hydrated and no network request
    is made to find out.
    """
    attrs = getattr(st, "st_file_attributes", 0)
    if attrs & CLOUD_ATTRIBUTES:
        return "cloud placeholder (Windows offline or recall-on-access attribute)"
    if cloud_mount:
        blocks = getattr(st, "st_blocks", None)
        if blocks == 0 and st.st_size > 0:
            return f"cloud placeholder (no blocks allocated on {cloud_mount})"
    return None


def dehydrated_entry(prior_entry: dict | None, size: int | None, reason: str) -> dict:
    """Record a file whose bytes are not local, carrying its last known hash.

    Size is recorded only when one is supplied.
    """
    entry: dict = {"state": DEHYDRATED, "kind": "file", "reason": reason}
    if size is not None:
        entry["size"] = size
    prior = prior_entry or {}
    known = prior.get("hash") or prior.get("last_known_hash")
    if known:
        entry["last_known_hash"] = known
        known_size = prior.get("size", prior.get("last_known_size"))
        if known_size is not None:
            entry["last_known_size"] = known_size
    return entry


def walk(
    root: Path,
    baseline: dict | None = None,
    stores: LocalStores | None = None,
    max_depth: int | None = None,
) -> dict:
    """One pass over the folder.

    Two tiers. Tier one stats every entry and reads nothing. Tier two hashes
    only what tier one says has moved, plus anything whose recorded mtime is at
    or after the baseline's own write time, which is the window where a same-tick
    edit hides.

    Directories that cannot be read are recorded, so nothing under them is
    mistaken for deleted. Files a cloud client has evicted are recorded as
    dehydrated and never opened, so nothing is pulled over the network to find
    out what it says.

    A directory tree deeper than `max_depth` (resolve_max_depth: an explicit
    argument, else FOLDER_LOOM_MAX_DEPTH, else DEFAULT_MAX_DEPTH) is stopped
    at the ceiling rather than descended into further, because the walk
    recurses one Python call per level and an unbounded tree is an unbounded
    call stack. Symlinked directories are never followed at all (recorded as
    their own entry, never descended into), so the ceiling's job is the plain
    case: a real, deeply-nested tree, pathological or otherwise. Where it
    bites is named in `depth_capped_dirs` and sized like every other
    exclusion, so a run that stopped short says so instead of reading as a
    clean, complete pass.
    """
    resolved_max_depth = resolve_max_depth(max_depth)
    globs = load_ignore_globs(root)
    prior = (baseline or {}).get("entries", {})
    written_at_ns = (baseline or {}).get("written_at_ns", 0)
    cloud_mount = cloud_backed_mount(root)
    stores = stores if stores is not None else LocalStores()
    # The keys this machine wrote into THIS folder's store, or None when this
    # machine has never bound this folder at all. Read once, from outside.
    root_ledgered = stores.keys_for(root)

    entries: dict[str, dict] = {}
    unreadable_dirs: list[str] = []
    hashed = 0
    skipped = 0
    # Files too big to hash, carried out so the report can name them. Without
    # this the hashed count silently sits below the file count.
    over_ceiling: list[tuple[str, int]] = []
    # Every path below removes content from the walk before it ever becomes an
    # `entries` row: a sender-authored ignore glob, an inner anchor boundary,
    # the built-in tool-noise skip list, and the module's own reserved
    # filenames. Each is counted here (structure only, never opened, never
    # hashed) so the coverage denominator can show what it excludes instead of
    # quietly shrinking to match what it kept. `_unsized` counts entries a
    # counting pass could not even probe (permission denied), which must never
    # be guessed at as "one file": that guess is itself an undercount that
    # misleads a reader about how much is hidden.
    excluded_by_ignore_paths: list[str] = []
    excluded_by_ignore_files = 0
    excluded_by_ignore_unsized = 0
    excluded_by_boundary_files = 0
    excluded_by_boundary_unsized = 0
    excluded_by_skip_dirs_files = 0
    excluded_by_skip_dirs_unsized = 0
    excluded_by_reserved_name_files = 0
    excluded_by_reserved_name_unsized = 0
    excluded_by_depth_cap_files = 0
    excluded_by_depth_cap_unsized = 0
    # Directories the walk stopped short of because they sit at the depth
    # ceiling. Named here rather than folded silently into `unreadable_dirs`:
    # a permission-denied directory and a directory this run chose not to
    # descend into are different facts, and the report says which is which.
    depth_capped_dirs: list[str] = []
    # Two different files can land on one key: canonical_relpath normalises to
    # NFC, and a filesystem that stores raw bytes will hold both the composed
    # and the decomposed spelling of one name in a single directory. The later
    # write used to overwrite the earlier one outright, so a file was read,
    # hashed, and then thrown away: no check saw it, and no line of the report
    # said a file had gone. Named here so the loss is on the page.
    name_collisions: list[str] = []
    # Names recorded from a cloud placeholder rather than from a real file.
    # Tracked so a stale stub sitting beside its own restored file is resolved
    # in favour of the real bytes, whichever order the directory is read in,
    # instead of being counted as two files that collided.
    stub_placeholders: set[str] = set()
    # Every real directory this walk ever laid eyes on, whatever it then did
    # with it (descended, skipped, boundary, depth-capped). Never baselined
    # or diffed like `entries`: this exists for one reader only, link
    # resolution, which needs to tell "this link points at a real directory"
    # from "this link points at nothing" without promoting a directory to a
    # first-class tracked entry with a hash it does not have. A directory
    # nested inside an excluded subtree (node_modules and the like) is not
    # in here beyond its own boundary, the same trade-off `entries` already
    # makes for files under those subtrees.
    dir_relpaths: set[str] = set()

    def record_entry(relpath: str, entry: dict, from_stub: bool = False) -> None:
        """The single place an entry row is written, so a second write to one
        key is NAMED rather than silently dropping a file on the floor."""
        if relpath not in entries:
            entries[relpath] = entry
            if from_stub:
                stub_placeholders.add(relpath)
            return
        if from_stub:
            # The real file is already recorded. A placeholder claiming its
            # bytes are elsewhere is stale; the bytes that are here win.
            #
            # Unless what is already recorded is ANOTHER placeholder. Two
            # placeholders naming one canonical name are two real files that
            # landed on one key, exactly like any other collision, and one of
            # them is lost. Standing one down as stale would be the silent
            # drop the collision accounting exists to refuse.
            if relpath in stub_placeholders:
                name_collisions.append(relpath)
            return
        if relpath in stub_placeholders:
            stub_placeholders.discard(relpath)
            entries[relpath] = entry
            return
        name_collisions.append(relpath)

    def descend(current: Path, prefix: str, depth: int = 0) -> None:
        nonlocal hashed, skipped
        nonlocal excluded_by_ignore_files, excluded_by_ignore_unsized
        nonlocal excluded_by_boundary_files, excluded_by_boundary_unsized
        nonlocal excluded_by_skip_dirs_files, excluded_by_skip_dirs_unsized
        nonlocal excluded_by_reserved_name_files, excluded_by_reserved_name_unsized
        nonlocal excluded_by_depth_cap_files, excluded_by_depth_cap_unsized
        items = _scan_sorted(current)
        if items is None:
            unreadable_dirs.append(prefix.rstrip("/") or ".")
            return
        for item in items:
            name = item.name
            relpath = canonical_relpath(prefix + name)
            if name in SKIP_FILES or name == ANCHOR_NAME or name == IGNORE_FILE:
                # The module's own reserved names (and the OS-noise files
                # SKIP_FILES exists for) are excluded unconditionally, no
                # config needed at all: any content stored under one of these
                # exact names, including a directory sharing the name, never
                # reaches a check. A NESTED `.loom-anchor` is never read at
                # all (only its existence is), and a NESTED `.loomignore` is
                # never read as globs either, only root's own copy is: so away
                # from the root both are indistinguishable from an ordinary
                # file that happens to share a reserved name, and a sender
                # gets a zero-config hiding spot from it. The walk root's OWN
                # copy of either is different: it is the module's own control
                # surface (`.loom-anchor` there is read and parsed as the
                # binding record; `.loomignore` there is read as the glob
                # rules whose effect is already reported separately), always
                # present or legitimately optional by design, so it is not
                # counted here a second time.
                #
                # That exemption is over a KIND, not a name. A DIRECTORY at the
                # root wearing a control file's name is not the control surface
                # and is never read as one: the glob load quietly gets nothing
                # back and carries on, so exempting it by name alone let a
                # sender hide a whole subtree behind a name the tool trusts,
                # with no line anywhere, not even in the raw report. The
                # exemption is for a thing that can actually be READ as the
                # control surface; anything else falls through to the
                # accounting below.
                if (
                    prefix == ""
                    and name in (ANCHOR_NAME, IGNORE_FILE)
                    and (current / name).is_file()
                ):
                    continue
                try:
                    is_link_reserved, is_dir_reserved = probe_kind(item)
                except OSError:
                    excluded_by_reserved_name_unsized += 1
                    continue
                if is_link_reserved:
                    pass
                elif is_dir_reserved:
                    dir_relpaths.add(relpath)
                    sub_files, sub_unsized = count_files_under(
                        Path(item.path),
                        stores,
                        depth + 1,
                        resolved_max_depth,
                        prefix=relpath + "/",
                        depth_capped_dirs=depth_capped_dirs,
                    )
                    excluded_by_reserved_name_files += sub_files
                    excluded_by_reserved_name_unsized += sub_unsized
                else:
                    excluded_by_reserved_name_files += 1
                continue
            if ignored(relpath, globs):
                excluded_by_ignore_paths.append(relpath)
                try:
                    is_link_ignored, is_dir_ignored = probe_kind(item)
                except OSError:
                    # Cannot even tell what it is, let alone how big. Named as
                    # unsized rather than guessed at as "one file": a guess
                    # here is exactly the undercount that misleads a reader
                    # about how much is hidden.
                    excluded_by_ignore_unsized += 1
                    continue
                if is_link_ignored:
                    # A symlink was never part of the "files" denominator
                    # either (kind == "file" only), so it adds nothing here.
                    pass
                elif is_dir_ignored:
                    dir_relpaths.add(relpath)
                    sub_files, sub_unsized = count_files_under(
                        Path(item.path),
                        stores,
                        depth + 1,
                        resolved_max_depth,
                        prefix=relpath + "/",
                        depth_capped_dirs=depth_capped_dirs,
                    )
                    excluded_by_ignore_files += sub_files
                    excluded_by_ignore_unsized += sub_unsized
                else:
                    excluded_by_ignore_files += 1
                continue
            try:
                is_link, is_dir = probe_kind(item)
            except OSError:
                record_entry(relpath, {"state": UNREADABLE, "kind": "unknown"})
                continue

            if is_link:
                # Recorded as its own entry over the target path string. Never
                # followed: a symlink out of the folder is outside what the
                # owner pointed this at.
                try:
                    target = os.readlink(item.path)
                except OSError:
                    record_entry(relpath, {"state": UNREADABLE, "kind": "symlink"})
                    continue
                record_entry(
                    relpath,
                    {
                        "state": PRESENT,
                        "kind": "symlink",
                        "size": len(target),
                        "mtime_ns": 0,
                        "hash": digest(canonical_relpath(target)),
                    },
                )
                continue

            if is_dir:
                dir_relpaths.add(relpath)
                # An inner anchored folder is a boundary, recorded as present and
                # never walked into. Nesting is opt-in: a folder becomes a
                # boundary once it has been pointed at directly.
                if name.casefold() in SKIP_DIRS:
                    # Legitimate and stays: this is tool-managed state, not the
                    # user's knowledge. But it needs no config file at all, so
                    # a sender who names a directory "node_modules" hides its
                    # whole contents with zero setup. The skip stays; its
                    # effect is sized and counted like every other exclusion.
                    #
                    # This tool's OWN store is the one thing that must not be
                    # sized as the owner's hidden content: it is written into
                    # the tree being measured, so charging it to the owner
                    # makes the excluded count climb every run on a folder
                    # nobody touched, and puts the tool's own cache on the page
                    # as material someone is keeping back. Only the cells this
                    # machine actually wrote count as the tool's, never the
                    # whole directory and never a name of the right shape. The
                    # root is the folder this run was pointed at; a store
                    # deeper down belongs to a boundary, which is never
                    # descended into and is sized separately.
                    at_root_store = prefix == "" and root_ledgered is not None
                    if own_footprint(name, True, at_root_store):
                        sub_files, sub_unsized = count_state_dir_foreign(
                            Path(item.path),
                            root_ledgered or frozenset(),
                            stores,
                            depth + 1,
                            resolved_max_depth,
                            prefix=relpath + "/",
                            depth_capped_dirs=depth_capped_dirs,
                        )
                    else:
                        sub_files, sub_unsized = count_files_under(
                            Path(item.path),
                            stores,
                            depth + 1,
                            resolved_max_depth,
                            prefix=relpath + "/",
                            depth_capped_dirs=depth_capped_dirs,
                        )
                    excluded_by_skip_dirs_files += sub_files
                    excluded_by_skip_dirs_unsized += sub_unsized
                    continue
                try:
                    is_boundary = (Path(item.path) / ANCHOR_NAME).is_file()
                except OSError:
                    # Cannot even probe it. Record the directory as unreadable so
                    # nothing beneath it is mistaken for deleted.
                    unreadable_dirs.append(relpath)
                    continue
                if is_boundary:
                    record_entry(relpath, {"state": PRESENT, "kind": "boundary"})
                    sub_files, sub_unsized = count_files_under(
                        Path(item.path),
                        stores,
                        depth + 1,
                        resolved_max_depth,
                        prefix=relpath + "/",
                        depth_capped_dirs=depth_capped_dirs,
                    )
                    excluded_by_boundary_files += sub_files
                    excluded_by_boundary_unsized += sub_unsized
                    continue
                if depth >= resolved_max_depth:
                    # One level deeper would pass the ceiling. Recorded as its
                    # own kind, not "boundary": it excludes nothing by the
                    # owner's design, only because this run stopped here. The
                    # subtree beneath is sized the same way any other
                    # suppressed subtree is, so a run that hit the ceiling
                    # cannot read as a clean, complete pass.
                    depth_capped_dirs.append(relpath)
                    record_entry(relpath, {"state": PRESENT, "kind": "depth-capped"})
                    sub_files, sub_unsized = count_files_under(
                        Path(item.path),
                        stores,
                        depth + 1,
                        resolved_max_depth,
                        prefix=relpath + "/",
                        depth_capped_dirs=depth_capped_dirs,
                    )
                    excluded_by_depth_cap_files += sub_files
                    excluded_by_depth_cap_unsized += sub_unsized
                    continue
                descend(Path(item.path), relpath + "/", depth + 1)
                continue

            try:
                st = item.stat(follow_symlinks=False)
            except OSError:
                record_entry(relpath, {"state": UNREADABLE, "kind": "file"})
                continue

            # Shape before size, and before anything opens it. Only a plain
            # file is read; a FIFO, socket or device is recorded as what it is
            # and never opened, because opening one is a wait with no end. It
            # is not a file, so it is not counted in the file total either.
            if not stat.S_ISREG(st.st_mode):
                record_entry(relpath, {"state": UNREADABLE, "kind": "special"})
                continue

            # An iCloud stub is not a file of its own. It is the folder saying
            # the real name is still there and its bytes are not, so it is
            # recorded UNDER THE REAL NAME. Recording the stub instead would
            # report the real file deleted and a stranger added, which is the
            # false delete this module exists to refuse.
            shadowed = icloud_shadow(item.name)
            if shadowed is not None:
                # Canonical, exactly as an ordinary entry's path is.
                real = canonical_relpath(prefix + shadowed)
                if ignored(real, globs):
                    excluded_by_ignore_paths.append(real)
                    excluded_by_ignore_files += 1
                    continue
                record_entry(
                    real,
                    dehydrated_entry(
                        prior.get(real),
                        None,
                        "cloud placeholder (iCloud Drive evicted the local copy)",
                    ),
                    from_stub=True,
                )
                continue

            evicted = dehydration_reason(st, cloud_mount)
            if evicted is not None:
                record_entry(
                    relpath, dehydrated_entry(prior.get(relpath), st.st_size, evicted)
                )
                continue

            was = prior.get(relpath)
            racy = st.st_mtime_ns >= written_at_ns
            reusable = (
                was
                and was.get("state") == PRESENT
                and was.get("size") == st.st_size
                and was.get("mtime_ns") == st.st_mtime_ns
                and was.get("hash")
                and not racy
            )
            if reusable:
                content_hash = was["hash"]
                skipped += 1
            elif st.st_size > HASH_SIZE_CEILING:
                content_hash = None
                over_ceiling.append((relpath, st.st_size))
            else:
                content_hash = hash_file(Path(item.path))
                if content_hash is None:
                    # Statted but not readable. Not a delete, not unchanged.
                    record_entry(
                        relpath,
                        {
                            "state": UNREADABLE,
                            "kind": "file",
                            "size": st.st_size,
                        },
                    )
                    continue
                hashed += 1

            record_entry(
                relpath,
                {
                    "state": PRESENT,
                    "kind": "file",
                    "size": st.st_size,
                    "mtime_ns": st.st_mtime_ns,
                    "hash": content_hash,
                },
            )

    descend(root, "", 0)
    return {
        "entries": entries,
        "dirs": sorted(dir_relpaths),
        "unreadable_dirs": unreadable_dirs,
        # Deduplicated: multiple recursive paths (descend's own capture, and
        # any of the three sizing helpers hitting the same ceiling while
        # sizing an already-excluded subtree) can in principle name the same
        # directory once each; the report counts a truncation once.
        "depth_capped_dirs": sorted(set(depth_capped_dirs)),
        "max_depth": resolved_max_depth,
        "hashed": hashed,
        "stat_skipped": skipped,
        "over_ceiling": sorted(over_ceiling, key=lambda p: -p[1]),
        "excluded_by_ignore_paths": sorted(excluded_by_ignore_paths),
        "excluded_by_ignore_files": excluded_by_ignore_files,
        "excluded_by_ignore_unsized": excluded_by_ignore_unsized,
        "excluded_by_boundary_files": excluded_by_boundary_files,
        "excluded_by_boundary_unsized": excluded_by_boundary_unsized,
        "excluded_by_skip_dirs_files": excluded_by_skip_dirs_files,
        "excluded_by_skip_dirs_unsized": excluded_by_skip_dirs_unsized,
        "excluded_by_reserved_name_files": excluded_by_reserved_name_files,
        "excluded_by_reserved_name_unsized": excluded_by_reserved_name_unsized,
        "excluded_by_depth_cap_files": excluded_by_depth_cap_files,
        "excluded_by_depth_cap_unsized": excluded_by_depth_cap_unsized,
        "name_collisions": sorted(name_collisions),
    }


def under_any(relpath: str, dirs: list[str]) -> bool:
    return any(d != "." and relpath.startswith(d + "/") for d in dirs) or "." in dirs


def classify(prior: dict, current: dict, unreadable_dirs: list[str]) -> dict:
    """Added, modified, moved, removed, unreadable.

    A path missing from the current walk under a directory that could not be
    read is UNVERIFIABLE, never removed.
    """
    added, modified, removed, unreadable, unchanged = [], [], [], [], []
    unverifiable = []
    dehydrated = []

    for relpath, now in current.items():
        if now.get("state") == UNREADABLE:
            unreadable.append(relpath)
            continue
        if now.get("state") == DEHYDRATED:
            # Not added, not modified, not removed, and above all not unchanged.
            # The bytes are elsewhere; nothing here has been verified.
            dehydrated.append(relpath)
            continue
        was = prior.get(relpath)
        if was is None:
            added.append(relpath)
        elif was.get("state") == UNREADABLE:
            modified.append(relpath)
        elif was.get("state") == DEHYDRATED:
            # Rehydrated. Compare against the hash carried forward when it was
            # evicted, so a file the cloud client took away and gave back
            # unchanged settles as unchanged rather than reading as an edit.
            known = was.get("last_known_hash")
            if known and known == now.get("hash"):
                unchanged.append(relpath)
            else:
                modified.append(relpath)
        elif was.get("hash") != now.get("hash") or was.get("size") != now.get("size"):
            modified.append(relpath)
        else:
            unchanged.append(relpath)

    for relpath, was in prior.items():
        if relpath in current:
            continue
        if under_any(relpath, unreadable_dirs):
            unverifiable.append(relpath)
        else:
            removed.append(relpath)

    # Exact-content moves, joined on hash. A move whose content also changed is
    # not detected and shows as removed plus added; the label is all that is
    # lost, since every check here reads current state.
    moved = []
    gone_by_hash: dict[str, str] = {}
    for relpath in removed:
        h = prior[relpath].get("hash")
        if h:
            gone_by_hash.setdefault(h, relpath)
    for relpath in list(added):
        h = current[relpath].get("hash")
        origin = gone_by_hash.get(h) if h else None
        if origin and origin in removed:
            moved.append({"from": origin, "to": relpath})
            added.remove(relpath)
            removed.remove(origin)

    return {
        "added": sorted(added),
        "modified": sorted(modified),
        "removed": sorted(removed),
        "moved": sorted(moved, key=lambda m: m["from"]),
        "unreadable": sorted(unreadable),
        "unverifiable": sorted(unverifiable),
        "dehydrated": sorted(dehydrated),
        "unchanged": sorted(unchanged),
    }


# --------------------------------------------------------------------------
# baseline store, outside the folder
# --------------------------------------------------------------------------


def baseline_path(binding_id: str) -> Path:
    return state_root() / "baselines" / f"{binding_id}.json"


def load_baseline(binding_id: str) -> dict | None:
    data = read_json(baseline_path(binding_id))
    if not data:
        return None
    if data.get("schema") != SCHEMA or data.get("hash_algo") != HASH_ALGO:
        # Unrecognised shape re-baselines rather than crashing or half-reading.
        return None
    return data


def save_baseline(binding: dict, entries: dict) -> None:
    write_json_atomic(
        baseline_path(binding["binding_id"]),
        {
            "schema": SCHEMA,
            "runner_version": RUNNER_VERSION,
            "hash_algo": HASH_ALGO,
            "folder_id": binding["folder_id"],
            "realpath": binding["realpath"],
            "machine_id": binding["machine_id"],
            "written_at_ns": time.time_ns(),
            "entries": entries,
        },
    )


# --------------------------------------------------------------------------
# cells: verdicts inside the folder, licence outside it
# --------------------------------------------------------------------------

# Bounded so a check declaring a tool that hangs on --version (or a shimmed
# PATH entry that never returns) cannot stall a run. Two seconds is generous
# for a version flag and short enough that a run over many checks stays fast.
ENV_PROBE_TIMEOUT_S = 2


def probe_env(tools: tuple[str, ...] = ()) -> str:
    """Best-effort environment descriptor for a check's cell key.

    A check that declares no external tool ("shells out to nothing") gets a
    Python-runtime descriptor: still a real, varying value (it changes across
    interpreter upgrades, unlike a bare literal), never a constant standing in
    for "no dependency". A check that declares a tool gets that tool's own
    `--version` output when the binary is on PATH and answers within the
    timeout, or the literal "unpinned" when it is not discoverable, named
    explicitly so the store can tell WHICH cells rest on an environment
    nobody pinned rather than silently trusting all of them equally.
    Best-effort: this narrows the reuse-across-machines gap and does not close
    it. A tool with a discoverable but misleading version string, or a check
    whose real dependency isn't the binary itself (a linter library version
    rather than its CLI wrapper), still reads as pinned. Never reads network,
    never blocks past ENV_PROBE_TIMEOUT_S per tool.
    """
    if not tools:
        v = sys.version_info
        return f"stdlib:python{v.major}.{v.minor}.{v.micro}"
    parts = []
    for tool in sorted(set(tools)):
        path = shutil.which(tool)
        if not path:
            parts.append(f"{tool}=unpinned")
            continue
        try:
            proc = subprocess.run(
                [path, "--version"],
                capture_output=True,
                text=True,
                timeout=ENV_PROBE_TIMEOUT_S,
            )
        except (OSError, subprocess.TimeoutExpired, ValueError):
            parts.append(f"{tool}=unpinned")
            continue
        text = ((proc.stdout or "") + (proc.stderr or "")).strip().splitlines()
        parts.append(f"{tool}={text[0].strip() if text else 'unpinned'}")
    return "; ".join(parts)


def cell_key(check_id: str, config: dict, basis: dict[str, str], env_probe: str) -> str:
    """A stable fingerprint for one check's answer, portable across machines
    and folder locations."""
    return digest(
        canonical_json(
            {
                "cell_schema": SCHEMA,
                "runner_version": RUNNER_VERSION,
                "hash_algo": HASH_ALGO,
                "check_id": check_id,
                "check_config_digest": digest(canonical_json(config)),
                "basis": {canonical_relpath(k): v for k, v in sorted(basis.items())},
                "env_probe": env_probe,
            }
        )
    )


def inside_root(root: Path, candidate: Path) -> bool:
    """Does `candidate` resolve to somewhere at or under `root`.

    Both sides go through realpath, so the answer is about where the write
    LANDS rather than about how the path is spelled.
    """
    try:
        real_root = os.path.realpath(root)
        real = os.path.realpath(candidate)
    except OSError:
        return False
    return real == real_root or real.startswith(real_root + os.sep)


def cell_dir(root: Path) -> Path | None:
    """Where this folder's verdict cells live, or None if that is not inside it.

    `.loom` was validated as a NAME everywhere and never as a KIND, and
    `mkdir(parents=True)` follows a symlink, so a `.loom` symlink pointing
    anywhere at all had this tool create directories and write files at a
    destination the folder's sender chose, outside the tree it was pointed at.
    The invariant this module states about itself - that nothing it writes
    lands outside the folder being measured - is enforced here or nowhere.

    A symlink is refused even when it resolves back inside the tree: the store
    belongs beside the folder's own files, not indirected through one of them.
    """
    inside = root / INSIDE_DIR
    d = inside / VERDICTS_DIR
    if inside.is_symlink() or d.is_symlink():
        return None
    if not inside_root(root, d):
        return None
    return d


def cell_path(root: Path, key: str) -> Path | None:
    d = cell_dir(root)
    return None if d is None else d / f"{key}.json"


def ledger_path(binding_id: str) -> Path:
    return state_root() / "ledger" / f"{binding_id}.json"


def load_ledger(binding_id: str) -> dict:
    data = read_json(ledger_path(binding_id))
    if not data or data.get("schema") != SCHEMA:
        return {"schema": SCHEMA, "keys": {}}
    data.setdefault("keys", {})
    return data


def ledger_verdict(held: object, key: str) -> tuple[bool, str | None, str | None]:
    """(does this machine hold this key, what verdict did it record for it,
    and what did the explanation of that verdict look like).

    A row written before the verdict was recorded alongside the key answers
    (True, None, None): the key is ours, the verdict is not known to be. That
    is treated as unlicensed, so the check simply recomputes and rewrites the
    row. A row written before the EXPLANATION was recorded answers a digest of
    None for the same reason and takes the same path.
    """
    keys = held.keys if isinstance(held, Ledger) else held
    record = keys.get(key) if isinstance(keys, dict) else None
    if record is None:
        return False, None, None
    if isinstance(record, dict):
        status = record.get("status")
        detail = record.get("detail_digest")
        return (
            True,
            status if isinstance(status, str) else None,
            detail if isinstance(detail, str) else None,
        )
    return True, None, None


class Ledger:
    """The per-machine record of cell keys this machine computed itself, and
    the verdict it computed for each.

    The verdict is held here, outside the folder, and not only inside the cell.

    Held in memory for the run and written once. Re-reading and rewriting it per
    cell turns a folder with a few hundred files into a few thousand writes of a
    growing file, which is the cost model defeating itself.
    """

    def __init__(self, binding_id: str):
        self.binding_id = binding_id
        self.keys = load_ledger(binding_id)["keys"]
        self.dirty = False

    # Deliberately not a container. `key in ledger` would answer only "this
    # machine has heard of the key". Ask ledger_verdict, which returns both
    # facts and makes the caller use the second one.

    def add(self, key: str, status: str, detail: str = "") -> None:
        self.keys[key] = {
            "at": time.time(),
            "status": status,
            "detail_digest": digest(detail),
        }
        self.dirty = True

    def flush(self) -> None:
        if self.dirty:
            write_json_atomic(
                ledger_path(self.binding_id), {"schema": SCHEMA, "keys": self.keys}
            )
            self.dirty = False


def record_locally_computed(
    binding_id: str, key: str, status: str, detail: str = ""
) -> None:
    ledger = load_ledger(binding_id)
    ledger["keys"][key] = {
        "at": time.time(),
        "status": status,
        "detail_digest": digest(detail),
    }
    write_json_atomic(ledger_path(binding_id), ledger)


def read_cell(
    root: Path, binding_id: str, key: str, ledger: Ledger | None = None
) -> dict | None:
    """Read a cell and say plainly whether this machine computed it.

    A cell this machine has no ledger entry for is advisory however it is
    labelled inside the folder, because everything inside the folder is written
    by whoever handed it over. So is a cell whose verdict no longer matches the
    one this machine recorded when it wrote it: the key being ours does not
    make the bytes now sitting at that key ours.

    Both the verdict and its explanation are checked against the ledger before
    either is trusted; an explanation that no longer matches makes the whole
    cell unverified, so the check recomputes.
    """
    path = cell_path(root, key)
    payload = read_json(path) if path is not None and is_regular_file(path) else None
    if not payload or payload.get("cell_key") != key:
        return None
    held = ledger if ledger is not None else load_ledger(binding_id)["keys"]
    now = time.time()
    observed = payload.get("observed_at", 0)
    if not isinstance(observed, (int, float)) or observed > now:
        # A clock ahead of this one must not sort ahead of local observation.
        observed = now
    payload["observed_at"] = observed
    mine, recorded, recorded_detail = ledger_verdict(held, key)
    served_detail = payload.get("detail", "")
    payload["locally_verified"] = bool(
        mine
        and recorded is not None
        and recorded == payload.get("status")
        and recorded_detail is not None
        and isinstance(served_detail, str)
        and recorded_detail == digest(served_detail)
    )
    if not payload["locally_verified"]:
        payload["gate_status"] = ADVISORY
    else:
        payload["gate_status"] = payload.get("status", UNVERIFIABLE)
    return payload


def write_cell(
    root: Path,
    binding_id: str,
    key: str,
    check_id: str,
    status: str,
    detail: str,
    ledger: Ledger | None = None,
) -> dict:
    payload = {
        "schema": SCHEMA,
        "cell_key": key,
        "check_id": check_id,
        "status": status,
        "detail": detail,
        "runner_version": RUNNER_VERSION,
        "observed_at": time.time(),
    }
    path = cell_path(root, key)
    # No store, no licence. The ledger says this machine HOLDS a key, and a key
    # held with no cell behind it is a claim about a file that is not there, so
    # a refused or failed write records nothing either. The verdict this run
    # computed still stands; it is simply not banked for the next one.
    if path is not None:
        try:
            write_json_atomic(path, payload)
        except OSError:
            path = None
    if path is not None:
        if ledger is not None:
            ledger.add(key, status, detail)
        else:
            record_locally_computed(binding_id, key, status, detail)
    payload["locally_verified"] = True
    payload["gate_status"] = status
    return payload


def _mtime_or_zero(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


ARRIVED_CELL_CEILING = 500


def evict(
    root: Path,
    binding_id: str,
    keep: int = 500,
    protect: set[str] | None = None,
    arrived_ceiling: int = ARRIVED_CELL_CEILING,
) -> dict:
    """Bound the inside store, then drop ledger keys whose payload is gone so
    the two stores cannot drift into a licence with nothing behind it.

    A cell this run actually used is never evicted, whatever the ceiling says.
    Trimming to a fixed count right after writing more than that is not a bound,
    it is a guarantee that the next run misses everything.

    Eviction reaches only as far as the ledger does. A file wearing a
    cell-shaped name that this machine never recorded is not this machine's to
    delete, whatever put it in the store: the ledger, not the filename, is
    what says a cell is ours to manage. That leaves an unclaimed file free to
    accumulate without limit, so unclaimed cells get a ceiling of their own,
    one that counts and reports rather than deletes. A ceiling that evicted
    unknown cells once they passed a threshold would reinstate the same
    defect one step removed, so this one never does; it only says so.
    """
    protect = protect or set()
    vdir = cell_dir(root)
    empty_arrived = {
        "count": 0,
        "ceiling": arrived_ceiling,
        "over_ceiling": False,
    }
    if vdir is None:
        # Nothing was written here, so there is nothing here to bound.
        return {"dropped": 0, "arrived": empty_arrived}
    try:
        files = [p for p in vdir.iterdir() if p.suffix == ".json"]
    except OSError:
        return {"dropped": 0, "arrived": empty_arrived}

    ledger = load_ledger(binding_id)
    known_keys = set(ledger["keys"])
    # Only a cell this machine's ledger holds is ours to trim. Anything else
    # sitting in the store wearing a cell-shaped name arrived from elsewhere,
    # and staying out of its way is the whole point: it is counted, never
    # touched.
    known = [p for p in files if p.stem in known_keys]
    arrived_count = sum(1 for p in files if p.stem not in known_keys)

    dropped = 0
    if len(known) > keep:
        spare = [p for p in known if p.stem not in protect]
        # A dangling symlink wearing a cell-shaped name has no mtime, and a
        # sort that raises ends the run. It sorts first, which is to say it is
        # a candidate to go, which is the right place for it.
        spare.sort(key=lambda p: _mtime_or_zero(p))
        for path in spare[: max(0, len(known) - keep)]:
            try:
                path.unlink()
                dropped += 1
            except OSError:
                pass

    live = (
        {p.stem for p in vdir.iterdir() if p.suffix == ".json"}
        if vdir.exists()
        else set()
    )
    pruned = {k: v for k, v in ledger["keys"].items() if k in live}
    if len(pruned) != len(ledger["keys"]):
        ledger["keys"] = pruned
        write_json_atomic(ledger_path(binding_id), ledger)

    return {
        "dropped": dropped,
        "arrived": {
            "count": arrived_count,
            "ceiling": arrived_ceiling,
            "over_ceiling": arrived_count > arrived_ceiling,
        },
    }


# --------------------------------------------------------------------------
# checks
# --------------------------------------------------------------------------

TEXT_SUFFIXES = frozenset(
    {".md", ".markdown", ".txt", ".json", ".yml", ".yaml", ".csv", ".org", ".rst"}
)

ABSENT = "absent"  # basis sentinel: a path a check depends on that is not there


class Corpus:
    """Everything a check may read, so that whatever it reads is also declarable
    as its basis. A check that reads an input it never lists is how a cache
    serves an answer that is stale with respect to a change it cannot see."""

    def __init__(self, root: Path, entries: dict, prior: dict, dirs: list[str] = ()):
        self.root = root
        self.entries = entries
        self.prior = prior
        self.files = {
            r: e
            for r, e in entries.items()
            if e.get("kind") == "file" and e.get("state") == PRESENT
        }
        # A real directory this run's walk actually saw, kept separately from
        # `files`: a link resolving here has no content to hash, only "does it
        # exist", so it is never folded into the file index that other checks
        # (exact-duplicates, the case-fold file lookup) rely on being files-only.
        self.dirs = set(dirs)
        # Case- and NFC-insensitive index, because the same vault validated on
        # two platforms must not disagree about whether a link resolves.
        self.by_folded: dict[str, list[str]] = {}
        self.by_stem: dict[str, list[str]] = {}
        for relpath in self.files:
            self.by_folded.setdefault(fold(relpath), []).append(relpath)
            self.by_stem.setdefault(fold(Path(relpath).stem), []).append(relpath)
        # Built from `dirs` itself (the parameter), NOT from `self.dirs`: `dirs`
        # arrives as `walk()`'s own `sorted(dir_relpaths)`, so iterating it
        # keeps that deterministic order. `self.dirs` is a set (fine, and
        # needed, for the O(1) exact-match membership test at the first
        # directory tier in `resolve_link`) but a set's iteration order is
        # process-hash-randomized, so building this per-fold index from
        # `self.dirs` instead made "which of two case-differing directories a
        # case-only link resolves to" vary run to run over byte-identical,
        # unchanged content - a real, reproduced violation of this module's
        # own two-runs-must-agree contract (see `_scan_sorted`'s docstring).
        # `dict.fromkeys` also drops any duplicate relpath while preserving
        # first-seen order, though `walk()` should never hand one over twice.
        self.by_folded_dirs: dict[str, list[str]] = {}
        for relpath in dict.fromkeys(dirs):
            self.by_folded_dirs.setdefault(fold(relpath), []).append(relpath)

    def text(self, relpath: str) -> str | None:
        try:
            return (self.root / relpath).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return None

    def targets(self, relpath: str, entry: dict) -> tuple[list[str], bool]:
        """The internal targets this file points at, and whether it could be
        read at all.

        Extracting them means opening the file, which would make every warm run
        read the whole folder and undo the stat-skip the cost model rests on. So
        the list is kept in the baseline beside the content hash that produced
        it, and reused whenever those bytes have not moved.
        """
        prior = self.prior.get(relpath)
        current_hash = entry.get("hash")
        if (
            prior
            and current_hash
            and prior.get("hash") == current_hash
            and isinstance(prior.get("links"), list)
        ):
            entry["links"] = prior["links"]
            return prior["links"], True
        text = self.text(relpath)
        if text is None:
            return [], False
        found = link_targets(text)
        entry["links"] = found
        return found, True


def fold(value: str) -> str:
    return unicodedata.normalize("NFC", value).casefold()


# -- encoding --------------------------------------------------------------


def check_encoding(relpath: str, entry: dict, corpus: Corpus) -> tuple[str, str]:
    """Is this file readable as the text it claims to be."""
    try:
        raw = (corpus.root / relpath).read_bytes()
    except OSError as exc:
        return UNVERIFIABLE, f"could not read: {exc.__class__.__name__}"
    if b"\x00" in raw:
        return FAIL, "contains NUL bytes, not text"
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        return FAIL, f"not valid UTF-8 at byte {exc.start}"
    return PASS, "decodes as UTF-8"


# -- truncation ------------------------------------------------------------

SHRINK_RATIO = 0.4
SHRINK_FLOOR = 4096


def check_shrink(relpath: str, entry: dict, corpus: Corpus) -> tuple[str, str]:
    """Did this file lose most of itself since the last run.

    Its true input is the baseline, which lives outside the folder and differs
    per machine, so this check is never cached: an answer keyed only on current
    content would be served forever for exactly the file that has not changed
    since it shrank.
    """
    prior = corpus.prior.get(relpath)
    if not prior or prior.get("state") != PRESENT or "size" not in prior:
        return UNVERIFIABLE, "no prior size recorded"
    was = prior["size"]
    now = entry.get("size", 0)
    if was - now > SHRINK_FLOOR and now < was * SHRINK_RATIO:
        return FAIL, f"shrank from {was} to {now} bytes"
    return PASS, f"{was} to {now} bytes"


# -- secrets and card numbers ----------------------------------------------

SECRET_PATTERNS = (
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("private key block", re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----")),
    (
        "credential assignment",
        re.compile(
            r"""(?i)\b(?:api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*["'][^\s"']{16,}["']"""
        ),
    ),
)

# The boundaries exclude word characters, not merely digits, because a digit run
# glued to letters is part of a machine token and never a number somebody wrote
# down: a trace id, a hex digest, a URL-encoded blob. The leading dot is excluded
# for the same reason, since a dotted token (`20260729123456.4111111111111111`)
# hands the second half to an issuer-prefix-plus-Luhn test that cannot tell it
# from a card. The trailing dot is deliberately still allowed, so a card number
# written at the end of a sentence is still caught.
CARD_SHAPE = re.compile(r"(?<![\w.-])(?:\d[ -]?){12,18}\d(?![\w-])")

# Issuer prefixes. Luhn alone passes roughly one in ten random digit runs, and a
# notes folder is full of digit runs; requiring a real issuer prefix as well is
# what keeps this check from crying wolf on reference numbers.
CARD_PREFIXES = re.compile(r"^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5)|35)")


def looks_like_a_card(digits: str) -> bool:
    return (
        13 <= len(digits) <= 19 and bool(CARD_PREFIXES.match(digits)) and luhn(digits)
    )


def luhn(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = ord(ch) - 48
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def check_secrets(relpath: str, entry: dict, corpus: Corpus) -> tuple[str, str]:
    """Does this file contain something that should not be sitting in a notes
    folder. Reads its own bytes and nothing else, needs no baseline, and works
    on the first run over a folder nobody has ever pointed a tool at."""
    text = corpus.text(relpath)
    if text is None:
        return UNVERIFIABLE, "could not read as text"
    hits = [name for name, pattern in SECRET_PATTERNS if pattern.search(text)]
    for match in CARD_SHAPE.finditer(text):
        if looks_like_a_card(re.sub(r"[ -]", "", match.group())):
            hits.append("card-number shape")
            break
    if hits:
        return FAIL, "found " + ", ".join(sorted(set(hits)))
    return PASS, "no secret or card-number shapes"


# -- template residue ------------------------------------------------------

# `${{ ... }}` is GitHub Actions' and Azure Pipelines' own evaluated-
# expression syntax rather than a template nobody filled in, so an occurrence
# is exempt when its own content parses as that grammar. The exemption keys on
# the EXPRESSION and never on the file's path or shape: a scanned repository
# writes every byte of its own files, so nothing it declares about itself is
# evidence about itself.
#
# Recognised with a single-pass tokeniser (`_tokenize_ci_expression`) and a
# recursive-descent parser (`_CIExpressionParser`) over that grammar. Both are
# linear: the tokeniser reads each character of the occurrence once, and the
# parser walks the resulting token list with one pointer that only advances,
# so cost does not depend on nesting depth. `_looks_like_ci_expression`
# requires the parser to consume the whole trimmed occurrence, so trailing
# junk is a rejection and no separate boundary rule is needed.
#
# Limit, inherent to the grammar rather than to how it is recognised: a
# context leaf is a user-chosen name, so `${{ secrets.ANYTHING }}` parses
# whatever the name means. No static check can decide that from the text.
CI_EXPR_CONTEXTS = frozenset(
    {
        # GitHub Actions - docs.github.com/en/actions/reference/workflows-
        # and-actions/contexts, fetched 2026-07-29: exactly these twelve.
        # `workflow` is deliberately absent - it is not one of them.
        "github",
        "env",
        "vars",
        "job",
        "jobs",
        "steps",
        "runner",
        "secrets",
        "strategy",
        "matrix",
        "needs",
        "inputs",
        # Azure Pipelines template-expression contexts - learn.microsoft.com/
        # en-us/azure/devops/pipelines/process/expressions, same fetch.
        # `pipeline` (as in `pipeline.startTime`) added; the rest carried
        # over from the prior version of this set.
        "parameters",
        "variables",
        "resources",
        "stagedependencies",
        "dependencies",
        "system",
        "pipeline",
    }
)

# The closed, documented function vocabularies for both dialects - anything
# NOT in this set is not a function call this check will recognise, no
# matter how much it looks like one shaped `identifier(...)`. Case-folded on
# lookup (`.lower()`), matching both tools' own case-insensitive semantics.
# Carried over unchanged from the prior version (independently re-verified
# against a fresh, non-summarised fetch of both dialects' docs).
CI_EXPR_FUNCTIONS = frozenset(
    {
        # GitHub Actions - docs.github.com/en/actions/reference/workflows-
        # and-actions/expressions, "Functions" + "Status check functions"
        # sections, fetched 2026-07-29 (includes `case`, added to GitHub's
        # own docs after this check's prior versions were written).
        "contains",
        "startswith",
        "endswith",
        "format",
        "join",
        "tojson",
        "fromjson",
        "hashfiles",
        "case",
        "success",
        "always",
        "cancelled",
        "failure",
        # Azure Pipelines - learn.microsoft.com/en-us/azure/devops/
        # pipelines/process/expressions, "Functions" + "Job status check
        # functions" sections, same fetch. Note Azure spells the cancelled-
        # check function with one `l` (`canceled`), GitHub with two
        # (`cancelled`) - both are kept, they are genuinely different
        # strings in each tool's own grammar.
        "and",
        "or",
        "not",
        "eq",
        "ne",
        "ge",
        "gt",
        "le",
        "lt",
        "in",
        "notin",
        "coalesce",
        "containsvalue",
        "converttojson",
        "counter",
        "iif",
        "length",
        "lower",
        "upper",
        "replace",
        "split",
        "trim",
        "xor",
        "canceled",
        "failed",
        "succeeded",
        "succeededorfailed",
    }
)

# `true`/`false`/`null` are keyword literals in both dialects, checked
# case-insensitively (their own case-insensitive semantics) before an
# identifier is ever considered as a context root or function name - neither
# vocabulary above contains any of these three strings, so there is no
# ambiguity to resolve.
CI_EXPR_KEYWORD_LITERALS = frozenset({"true", "false", "null"})


# -- tokeniser ----------------------------------------------------------
#
# One left-to-right pass over the (already <=80-character) occurrence text,
# each character consumed exactly once. This is the ONLY place a `'...'`
# string is ever scanned, so the doubled-quote escape (`'it''s a test'`) is
# handled once, here, and every caller - a bare literal, a function
# argument, an operand - inherits it for free.

_CI_TOKEN_IDENT = re.compile(r"[A-Za-z_][\w-]*")
_CI_TOKEN_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")
_CI_TOKEN_OP = re.compile(r"==|!=|<=|>=|&&|\|\|")
_CI_TOKEN_SINGLE_CHARS = "()[].,!<>*"


class _CIToken:
    __slots__ = ("kind", "value")

    def __init__(self, kind: str, value: str):
        self.kind = kind
        self.value = value

    def __repr__(self):  # pragma: no cover - debugging aid only
        return f"_CIToken({self.kind!r}, {self.value!r})"


class _CITokenizeError(Exception):
    """Raised when `inner` contains a character, or an unterminated string,
    the grammar has no token for. Caught by `_looks_like_ci_expression`,
    which treats it exactly like a parse failure: not a real expression,
    not a crash."""


def _tokenize_ci_expression(s: str) -> list[_CIToken]:
    """Tokenise `s` in one linear pass. Every branch below advances `i` by
    at least one character (a quoted string's contents are consumed in one
    inner loop, never revisited), so this function is O(len(s)) by
    construction - there is no path that rescans an index already passed,
    which is exactly the property the exponential-time predecessor lacked."""
    tokens: list[_CIToken] = []
    i = 0
    n = len(s)
    while i < n:
        ch = s[i]
        if ch.isspace():
            i += 1
            continue
        if ch == "'":
            j = i + 1
            chars = []
            closed = False
            while j < n:
                if s[j] == "'":
                    if j + 1 < n and s[j + 1] == "'":
                        chars.append("'")
                        j += 2
                        continue
                    closed = True
                    j += 1
                    break
                chars.append(s[j])
                j += 1
            if not closed:
                raise _CITokenizeError("unterminated string literal")
            tokens.append(_CIToken("STRING", "".join(chars)))
            i = j
            continue
        if ch.isdigit() or (ch == "-" and i + 1 < n and s[i + 1].isdigit()):
            m = _CI_TOKEN_NUMBER.match(s, i)
            if m is None:
                # `str.isdigit()` is broader than `\d` (it also admits
                # Unicode category No - superscript '²', circled '①',
                # etc.) so the guard above can be satisfied while the
                # regex it hands off to still declines to match at this
                # position. Never fall through to `.group()`/`.end()` on a
                # `None` match: neither GitHub Actions nor Azure Pipelines
                # numeric literals ever admit such characters, so this is
                # correctly "not a real token", not a crash.
                raise _CITokenizeError(f"unrecognised character {ch!r}")
            tokens.append(_CIToken("NUMBER", m.group()))
            i = m.end()
            continue
        if ch.isalpha() or ch == "_":
            m = _CI_TOKEN_IDENT.match(s, i)
            if m is None:
                # `str.isalpha()` is Unicode-aware but `_CI_TOKEN_IDENT`
                # anchors its first character to ASCII `[A-Za-z_]` only, so
                # a non-ASCII leading letter (accented Latin, Cyrillic,
                # Greek, CJK, ...) satisfies the guard without satisfying
                # the regex. Azure Pipelines' own property-dereference
                # grammar is documented as ASCII-only ("must start with
                # a-Z or _"), and GitHub Actions' context/function
                # vocabularies are all-ASCII too, so an identifier that
                # cannot even start per that grammar is correctly
                # "not a real token", not a crash.
                raise _CITokenizeError(f"unrecognised character {ch!r}")
            tokens.append(_CIToken("IDENT", m.group()))
            i = m.end()
            continue
        m = _CI_TOKEN_OP.match(s, i)
        if m:
            tokens.append(_CIToken("OP", m.group()))
            i = m.end()
            continue
        if ch in _CI_TOKEN_SINGLE_CHARS:
            tokens.append(_CIToken(ch, ch))
            i += 1
            continue
        raise _CITokenizeError(f"unrecognised character {ch!r}")
    tokens.append(_CIToken("EOF", ""))
    return tokens


# -- recursive-descent parser --------------------------------------------
#
#   expr       := or_expr
#   or_expr    := and_expr ( '||' and_expr )*
#   and_expr   := comparison ( '&&' comparison )*
#   comparison := unary ( cmp_op unary )*
#   cmp_op     := '==' | '!=' | '<=' | '>=' | '<' | '>'
#   unary      := '!' unary | postfix
#   postfix    := primary ( '.' IDENT | '.' '*' | '[' expr ']' )*
#   primary    := NUMBER | STRING | keyword-literal | funccall | contextref
#                 | '(' expr ')'
#   funccall   := IDENT '(' arglist? ')'   -- IDENT in CI_EXPR_FUNCTIONS
#   contextref := IDENT                    -- IDENT in CI_EXPR_CONTEXTS,
#                                              whether or not `postfix` goes
#                                              on to attach a chain to it
#   arglist    := expr ( ',' expr )*
#
# Every `IDENT` used as a context root or a function name is checked against
# the closed vocabularies above at the exact point it is consumed - there is
# no separate post-hoc validation pass, so a placeholder can never be
# "mostly valid syntax with one bad name": the parse fails at the specific
# token that isn't real, and propagates straight out (no backtracking, no
# alternate production re-tried), which is also why this parser cannot be
# made to do the old implementation's repeated-rescan work: every token is
# visited by a bounded, constant number of grammar productions, once.
#
# This is a tiny, closed grammar - contexts with dotted/indexed/filtered
# access, function calls, literals, unary `!`, comparison/boolean operators,
# parentheses - not a general expression engine, and it does not need to be
# one: GitHub Actions' and Azure Pipelines' own `if:`/condition expressions
# never go further than this.


class _CIParseError(Exception):
    """Raised on any grammar violation or unrecognised context/function
    name. Caught by `_looks_like_ci_expression`: "not a real expression",
    not a crash."""


class _CIExpressionParser:
    def __init__(self, tokens: list[_CIToken]):
        self._tokens = tokens
        self._pos = 0

    def _peek(self) -> _CIToken:
        return self._tokens[self._pos]

    def _advance(self) -> _CIToken:
        tok = self._tokens[self._pos]
        self._pos += 1
        return tok

    def _expect(self, kind: str) -> _CIToken:
        tok = self._peek()
        if tok.kind != kind:
            raise _CIParseError(f"expected {kind!r}, found {tok.kind!r}")
        return self._advance()

    def parse_expression_at_eof(self) -> bool:
        """True iff the ENTIRE token stream is one well-formed expression
        with nothing left over. This is the anchoring the old regex-search
        signals never had: a real signal sitting somewhere inside a longer
        string no longer rescues unrelated trailing junk beside it."""
        self._or_expr()
        return self._peek().kind == "EOF"

    def _or_expr(self):
        self._and_expr()
        while self._peek().kind == "OP" and self._peek().value == "||":
            self._advance()
            self._and_expr()

    def _and_expr(self):
        self._comparison()
        while self._peek().kind == "OP" and self._peek().value == "&&":
            self._advance()
            self._comparison()

    def _comparison(self):
        self._unary()
        while self._peek().kind in ("OP", "<", ">") and self._peek().value in (
            "==",
            "!=",
            "<=",
            ">=",
            "<",
            ">",
        ):
            self._advance()
            self._unary()

    def _unary(self):
        if self._peek().kind == "!":
            self._advance()
            self._unary()
            return
        self._postfix()

    def _postfix(self):
        self._primary()
        while True:
            tok = self._peek()
            if tok.kind == ".":
                self._advance()
                nxt = self._peek()
                if nxt.kind == "*":
                    self._advance()
                elif nxt.kind == "IDENT":
                    self._advance()
                else:
                    raise _CIParseError("expected a property name or '*' after '.'")
                continue
            if tok.kind == "[":
                self._advance()
                self._or_expr()
                self._expect("]")
                continue
            break

    def _primary(self):
        tok = self._peek()
        if tok.kind in ("NUMBER", "STRING"):
            self._advance()
            return
        if tok.kind == "(":
            self._advance()
            self._or_expr()
            self._expect(")")
            return
        if tok.kind == "IDENT":
            name = tok.value.lower()
            if name in CI_EXPR_KEYWORD_LITERALS:
                self._advance()
                return
            nxt = self._tokens[self._pos + 1]
            if nxt.kind == "(":
                if name not in CI_EXPR_FUNCTIONS:
                    raise _CIParseError(f"{tok.value!r} is not a recognised function")
                self._advance()  # IDENT
                self._advance()  # (
                if self._peek().kind != ")":
                    self._or_expr()
                    while self._peek().kind == ",":
                        self._advance()
                        self._or_expr()
                self._expect(")")
                return
            if name not in CI_EXPR_CONTEXTS:
                raise _CIParseError(f"{tok.value!r} is not a recognised context")
            self._advance()
            return
        raise _CIParseError(f"unexpected token {tok.kind!r}")


def _looks_like_ci_expression(inner: str) -> bool:
    """Does the text between `${{` and `}}` PARSE as something GitHub
    Actions or Azure Pipelines would actually evaluate, as opposed to a bare
    placeholder identifier someone forgot to fill in.

    Tokenises `inner` once (`_tokenize_ci_expression`), then runs a
    recursive-descent parser (`_CIExpressionParser`) over the real
    expression grammar - a context reference with dotted/indexed/filtered-
    array access, a function call whose arguments are each independently
    judged the same way, literals, the unary `!`, and the comparison/boolean
    operators whose operands are each independently judged the same way -
    checking every context root and function name against the closed,
    documented vocabularies above at the point it is consumed. The parse
    must consume the ENTIRE trimmed string with nothing left over -
    `YOUR_UNFILLED_SECRET_HERE contains(github.ref, 'x')` does not pass just
    because a real signal sits somewhere inside it.

    Both a tokeniser failure (an unrecognised character, an unterminated
    string) and a parser failure (an unrecognised name, an incomplete
    construct, or trailing tokens after an otherwise-complete expression)
    mean "not a real CI expression" - residue, not a crash.
    """
    stripped = inner.strip()
    if not stripped:
        return False
    try:
        tokens = _tokenize_ci_expression(stripped)
        return _CIExpressionParser(tokens).parse_expression_at_eof()
    except (_CITokenizeError, _CIParseError):
        return False
    except Exception:
        # Defence in depth, not the fix: the tokeniser/parser above is
        # written so every rejection path raises `_CITokenizeError` or
        # `_CIParseError` (caught above) rather than any other exception -
        # the guard/regex mismatch that used to slip an uncaught
        # `AttributeError` past both of those is closed at its source in
        # `_tokenize_ci_expression`. This broad catch exists only so that
        # a *future*, different bug in this small grammar can never again
        # take down the single caller's entire `fl.run()`: this function's
        # whole contract is "does this look like a real CI expression",
        # and any exception raised while answering that question is, by
        # definition, "no" - not a reason to abort scanning every other
        # file in the repository. Intentionally not narrowed to specific
        # exception types, and intentionally scoped to this one function
        # only, not wrapped around `fl.run()` itself.
        return False


# Captures an optional immediately-preceding `$` (group 1) alongside the
# brace content (group 2), so the same single scan tells the difference
# between a bare `{{ ... }}` (never CI syntax in any dialect - GitHub
# Actions and Azure Pipelines both require the dollar prefix - so always
# residue-checked at full strictness) and a `${{ ... }}` (CI syntax IF its
# content parses as an expression per `_looks_like_ci_expression`, residue
# otherwise).
MUSTACHE_OCCURRENCE = re.compile(r"(\$)?\{\{([^}\n]{1,80})\}\}")


class _MustachePattern:
    """A `.search`-compatible stand-in for a compiled pattern: behaves
    exactly like the plain `\\{\\{[^}\\n]{1,80}\\}\\}` regex this replaces,
    except a `${{ ... }}` occurrence is not a hit when its content is itself
    valid GitHub Actions / Azure Pipelines expression grammar. Kept as a
    `.search`-compatible object rather than folding this logic into
    `check_residue` directly so the `RESIDUE_PATTERNS` iteration there stays
    a single uniform loop over `(name, pattern)` pairs."""

    def search(self, body: str):
        for m in MUSTACHE_OCCURRENCE.finditer(body):
            dollar, inner = m.group(1), m.group(2)
            if dollar and _looks_like_ci_expression(inner):
                continue  # a live GitHub Actions / Azure Pipelines expression
            return m
        return None


MUSTACHE_PATTERN = _MustachePattern()

RESIDUE_PATTERNS = (
    ("mustache placeholder", MUSTACHE_PATTERN),
    (
        "bracketed placeholder",
        re.compile(r"\[(?:TBD|TODO|PLACEHOLDER|FILL ?ME|YOUR[_ ][A-Z]+)\]", re.I),
    ),
    ("angle placeholder", re.compile(r"<(?:TBD|PLACEHOLDER|YOUR[_ ][A-Z]+)>", re.I)),
    ("lorem ipsum", re.compile(r"\blorem ipsum\b", re.I)),
)


# A file whose whole declared job is to hold UNRENDERED template source
# (Jinja/Django .j2/.jinja[2], Liquid .liquid, Handlebars/Mustache .hbs/
# .handlebars/.mustache, Go text/template .tmpl/.tpl/.gotmpl, including Helm
# chart templates) is not carrying "residue" at all: the braces are the file,
# not something left behind after a render. No exemption for that is coded
# here, because none is needed: `TEXT_SUFFIXES` (this check's suffix
# allowlist, since it declares no "suffixes" override of its own) does not
# contain any of those extensions today, so a .j2/.hbs/.tmpl file never
# reaches `check_residue` in the first place - confirmed by running one
# through unmodified and seeing zero results for it. If `TEXT_SUFFIXES` is
# ever extended to cover one of those extensions (for secret-scanning, say),
# this exemption needs writing at that point, not before: a guard against a
# case that cannot currently occur is unreachable code, not a fix.
#
# Deliberately NOT exempting bare .yml/.yaml wholesale for the same braces:
# Ansible playbooks embed raw Jinja (`{{ ansible_facts.hostname }}`) directly
# in plain .yml with no distinguishing extension, so that dialect keeps a
# known, named, live gap here (an Ansible playbook's inline Jinja can still
# false-fire this check) rather than a blanket .yml exemption that would blind
# it to the far more common case of genuine copied-template residue sitting in
# a YAML config (`{{ YOUR_API_KEY }}` left in a docker-compose.yml).


def check_residue(relpath: str, entry: dict, corpus: Corpus) -> tuple[str, str]:
    """Did a template get filled in. Bare TODO is deliberately not a marker: in
    a real notes folder it is a legitimate thing to write.

    Scans `prose_only(text)`, the same fenced/inline-code strip `check_links`
    already applies: docs THAT TEACH a templating language by showing its
    syntax as a fenced example (a Markdown ```` ``` ```` block demonstrating a
    Jinja/Django/Vue/Handlebars tag, or MkDocs' own theme docs doing exactly
    this) are not residue either - that code sample was written on purpose and
    was never "filled in", the same reasoning that already exempts a bare
    TODO. This only strips MARKDOWN-style ``` / ~~~ fences and backtick inline
    code; it does not understand reStructuredText's OWN code-block/literal-
    block conventions (`.. code-block::`, a bare `::`), so an .rst file's
    fenced Jinja examples are a known, named, un-fixed gap here, not a
    silently-accepted one.

    The "mustache placeholder" check (`MUSTACHE_PATTERN`) exempts a
    `${{ ... }}` occurrence only when its own content parses as GitHub
    Actions / Azure Pipelines expression grammar (see `_looks_like_ci_
    expression`) - a property of the expression itself, never of which file
    or path it sits in. Every other pattern stays at full strictness
    everywhere.
    """
    text = corpus.text(relpath)
    if text is None:
        return UNVERIFIABLE, "could not read as text"
    body = prose_only(text)
    hits = []
    for name, pattern in RESIDUE_PATTERNS:
        if pattern.search(body):
            hits.append(name)
    if hits:
        return FAIL, "unfilled " + ", ".join(sorted(set(hits)))
    return PASS, "no template residue"


# -- internal link integrity -----------------------------------------------

# EVERY REPEATED CLASS HERE IS BOUNDED, and both bound the same fault from
# opposite ends - but only WIKILINK's ALSO admits no `[`. That asymmetry is
# deliberate, not an oversight; see the note above MDLINK below for why.
#
# As written before, `[^\]|#]+` and `[^\]]*` began a match at every `[` in the
# file, ran to end-of-input, and gave the character back one at a time when no
# closer followed. On a file that is simply a long run of `[` - a legal thing
# for a file to contain, and free to put in any folder anybody sends - that is
# quadratic: 30 KB took over half a minute, and the 32 MiB this walk will read
# was months.
#
# Excluding `[` from WIKILINK's target is what actually removes it: inside
# `[[…]]` the run cannot extend past the next `[`, so on a run of brackets
# each start position fails on its first character instead of walking to the
# end of the file. Nothing legitimate is lost there - a bracket inside a
# WIKILINK target is malformed in every dialect here - and the bound stays
# anyway, because it holds for the inputs no one has thought of yet.
#
# The ceilings are what they cost. A link target longer than LINK_TARGET_MAX is
# not recognised as a link at all, so it is neither resolved nor reported
# broken; that is a named limit of this check, and it sits far past any path a
# filesystem will accept.
LINK_TARGET_MAX = 512
LINK_TRIM_MAX = 256

WIKILINK = re.compile(
    r"\[\[([^\[\]|#]{1,%d})(?:#[^\[\]|]{0,%d})?(?:\|[^\[\]]{0,%d})?\]\]"
    % (LINK_TARGET_MAX, LINK_TRIM_MAX, LINK_TRIM_MAX)
)
# MDLINK's target admits `[` (and `]`) on purpose, unlike WIKILINK's: excluding
# them would cut the {1,512} bound's per-position work on a `[](` run roughly
# 512x, the same win WIKILINK gets, but it also stops the target from matching
# at all the moment it contains a literal `[` - and a folder-supplied link
# target holding raw terminal control bytes routinely does, since a CSI
# sequence (`\x1b[2K` and the like) IS a `\x1b` followed by `[`. A target that
# fails to match is a target `check_links` never sees, so it is neither
# resolved nor reported broken, silently, on exactly the adversarial input
# `visible()` exists to catch and escape once this check DOES report it. That
# gap was reproduced here (a markdown link over a control-sequence target that
# `check_links` stopped flagging as broken once `[` was excluded from this
# class) and is why the asymmetry with WIKILINK stays: a ~512x constant on a
# denial-of-availability finding that is already linear and already bounded is
# the cheaper defect of the two.
MDLINK = re.compile(
    r"\[[^\[\]]{0,%d}\]\(([^)\s]{1,%d})(?:\s+\"[^\"\n]{0,%d}\")?\)"
    % (LINK_TRIM_MAX, LINK_TARGET_MAX, LINK_TRIM_MAX)
)
EXTERNAL = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")
# A candidate fence marker line, column-0 anchored only (no leading-whitespace
# tolerance for an indented-list-item or blockquoted fence - a pre-existing,
# separate, named limitation of this whole function, not touched here).
# Captures the FULL run of backticks/tildes (group 1) and everything else on
# that line (group 2), so the code that pairs opening with closing can check
# marker type, run length, and info-string shape, rather than a plain
# re.sub pairing any "```" or "~~~" occurrence with the next one of EITHER
# type found anywhere later in the document.
FENCE_LINE = re.compile(r"^(`{3,}|~{3,})([^\n]*)$", re.M)
INLINE_CODE = re.compile(r"`[^`\n]*`")

# Only formats where a link is a link. A regex inside a JSON string is not a
# broken link, and reading it as one is how a checker teaches people to ignore it.
LINKED_SUFFIXES = frozenset({".md", ".markdown", ".org", ".rst"})


def strip_fenced(text: str) -> str:
    """Remove fenced code blocks, pairing each opening marker only with a
    CLOSING marker of the same type and at least as long a run - never with
    the next occurrence of either fence character found further down the
    document.

    The prior version (`FENCED = re.compile(r"^(?:\\`\\`\\`|~~~).*?^(?:\\`\\`\\`|~~~)")`)
    paired ``` and ~~~ interchangeably, left to right, regardless of type.
    A stray non-fence tilde divider - an ordinary `~~~~~~` ASCII horizontal
    rule, a common and legitimate thing to write in a real document - would
    pair with the next unrelated, genuine backtick fence further down the
    file, and everything textually between the two (including any genuine
    `{{ residue }}`) was deleted before either `check_residue` or
    `check_links` ever saw it. Reproduced: a `~~~~` divider followed later by
    an unrelated ` ```yaml `` / ``` `` block swallowed the paragraph between
    them, taking a genuine unfilled placeholder with it.

    Per CommonMark: a fence closes only with a marker of its own character,
    in a run at least as long as the one that opened it, and a backtick
    fence's info string may not itself contain a backtick (how a fence line
    is told apart from a run of inline code); a tilde fence's info string has
    no such restriction. A closing line may carry nothing but the marker
    itself. An opening marker with no valid closing marker after it is left
    exactly as it was before this function ran (matching the prior
    behaviour for an unterminated fence): a lone divider with no real fence
    anywhere after it is not swallowed at all.

    Single pass, O(n): the naive way to find "the first later marker of the
    same character, at least as long a run, with an empty rest" is to
    re-scan from each open to EOF - and if an open never finds a close (an
    ordinary large document with many separately-tagged, inconsistently-
    closed fenced examples, no adversarial intent required), that scan runs
    the full remaining document, for every such open: O(n) opens times O(n)
    remaining-document each is O(n^2). Reproduced: 500->4000 lines gave
    0.05s->3.46s, clean quadratic scaling (flat time/n^2 ratio across a 4x
    input range), where the prior `FENCED` regex this replaced was
    effectively linear on the same input (8000 lines in 0.001s).

    Instead, `FENCE_LINE.finditer(text)` is materialised ONCE into `matches`
    (a single linear pass), and for each character a suffix-max array
    (`suffix_max_len`) records, for every position in that character's
    ordered list of "could be a valid closer" candidates (`crest.strip() ==
    ""`), the longest closer run length anywhere from that position to the
    end. That turns "is a close even possible for this open" into an O(1)
    lookup: if the longest remaining same-character closer is shorter than
    this open's own run, there is nothing to find, and the open is
    abandoned in O(1) with no scan at all - this is what makes the "n opens,
    none ever close" case linear instead of quadratic. Only when a close IS
    known to exist does the function walk forward to find the first
    qualifying one, and that walk's cost is charged to the text it consumes
    (the outer position jumps past everything up to the close), so across
    the whole document each character position is scanned at most once
    either way: once as part of a single successful open-to-close walk, or
    once as an O(1) rejection.
    """
    matches = list(FENCE_LINE.finditer(text))

    # Per character, the ordered list of match-indices that could validly
    # CLOSE a fence of that character (an opener's own line also qualifies as
    # a closer candidate for a LATER open of the same character - it is only
    # excluded from closing itself, via the position check below).
    closer_idx: dict[str, list[int]] = {"`": [], "~": []}
    for idx, cand in enumerate(matches):
        cmarker, crest = cand.group(1), cand.group(2)
        if crest.strip() == "":
            closer_idx[cmarker[0]].append(idx)

    # suffix_max[char][j] = the longest closer-candidate run length at or
    # after position j in closer_idx[char] (0 once nothing remains).
    suffix_max: dict[str, list[int]] = {}
    for char, idxs in closer_idx.items():
        arr = [0] * (len(idxs) + 1)
        for j in range(len(idxs) - 1, -1, -1):
            arr[j] = max(arr[j + 1], len(matches[idxs[j]].group(1)))
        suffix_max[char] = arr

    # Per-character pointer into closer_idx/suffix_max: only ever advances,
    # across the WHOLE run - not reset per open - which is what keeps the
    # total ptr-advance and consumed-range work linear in the number of
    # marker lines rather than quadratic.
    ptr = {"`": 0, "~": 0}

    out = []
    pos = 0
    i = 0
    n_matches = len(matches)
    while i < n_matches:
        m = matches[i]
        if m.start() < pos:
            i += 1
            continue  # inside a block already consumed
        marker, rest = m.group(1), m.group(2)
        char = marker[0]
        if char == "`" and "`" in rest:
            i += 1
            continue  # not a valid fence open: backtick info strings can't hold a backtick

        idxs = closer_idx[char]
        arr = suffix_max[char]
        p = ptr[char]
        while p < len(idxs) and idxs[p] <= i:
            p += 1  # a closer candidate can't close the fence it's part of
        ptr[char] = p

        if arr[p] < len(marker):
            i += 1  # no closer of sufficient length exists anywhere later
            continue

        close = None
        j = p
        while j < len(idxs):
            candidate = matches[idxs[j]]
            if len(candidate.group(1)) >= len(marker):
                close = candidate
                break
            j += 1
        if close is None:
            i += 1  # unterminated: leave it as prose, matching prior behaviour
            continue

        out.append(text[pos : m.start()])
        out.append(" ")
        pos = close.end()
        i = idxs[j] + 1
    out.append(text[pos:])
    return "".join(out)


def prose_only(text: str) -> str:
    """Code is not prose. A path-shaped string inside a fence or inline code is
    an example, not a reference the folder owes a target."""
    return INLINE_CODE.sub(" ", strip_fenced(text))


def link_targets(text: str) -> list[str]:
    """Every internal target this file points at. External URLs are excluded on
    purpose: resolving one is a network call, and this never makes one."""
    body = prose_only(text)
    found = []
    for match in WIKILINK.finditer(body):
        target = match.group(1).strip()
        if target:
            found.append(target)
    for match in MDLINK.finditer(body):
        target = match.group(1).strip()
        if not target or target.startswith("#") or EXTERNAL.match(target):
            continue
        # Markdown percent-encodes spaces and punctuation in paths. Comparing the
        # encoded form against a filename on disk marks every linked file whose
        # name has a space in it as missing, which is most of them.
        found.append(unquote(target.split("#", 1)[0]))
    return found


OUTSIDE = "outside"
# A directory has no content hash to key the basis on, and does not need one:
# what a cached link-check answer must notice is the target's PRESENCE, and
# the basis dict's KEY (the resolved relpath itself) already changes to
# `{target}::unresolved` the run the directory disappears, which busts the
# cache on its own without a real hash in the value.
DIRECTORY = "directory"


def nearest_hit(hits: list[str], relpath: str) -> str | None:
    """Of several files answering to the same name, the one the linking file
    most plausibly meant: the one sharing the longest run of leading path
    segments with it. Returns None when that is a genuine tie between two or
    more candidates, rather than picking a winner.

    Picking `hits[0]` instead is not merely arbitrary, it poisons the cache. A
    folder holding two note collections that each contain an `Index.md` gave
    every `[[Index]]` in BOTH collections the first collection's file, so the
    second collection's linking file recorded a basis naming a file it does not
    point at. Editing the file it really points at then left the basis, and so
    the cell key, unchanged, and a stale green got served.

    The shared-prefix distance below breaks most such ties, but three or more
    sibling collections holding a same-named file (or a link sitting equally
    close to two collections, e.g. one written at the walk root) leaves a TRUE
    tie in that metric. Falling back to sorted order there was itself a real,
    reproduced instance of the identical cache-poisoning shape, just at a wider
    boundary: whichever collection sorted first silently won, and still does
    if a caller ignores this return. A genuine tie returns None so the caller
    treats the link as unresolved rather than guessing - a checker that says
    it cannot tell is safer than one that lies.
    """
    if len(hits) == 1:
        return hits[0]
    here = os.path.dirname(relpath).split("/") if os.path.dirname(relpath) else []

    def shared(candidate: str) -> int:
        there = (
            os.path.dirname(candidate).split("/") if os.path.dirname(candidate) else []
        )
        count = 0
        for a, b in zip(here, there):
            if a != b:
                break
            count += 1
        return count

    best = max(shared(c) for c in hits)
    tied = [c for c in hits if shared(c) == best]
    if len(tied) > 1:
        return None
    return tied[0]


def resolve_link(target: str, relpath: str, corpus: Corpus) -> tuple[str | None, bool]:
    """Return (resolved relpath, or OUTSIDE, or None, case_only_mismatch).

    A target that resolves to a DIRECTORY is returned exactly like a target
    that resolves to a file: a real relpath, not None. "See the ./examples
    folder" is an ordinary, valid, extremely common README convention, and a
    link is either resolvable or it is not - whether the thing on the other
    end has a hash to check is a separate question `links_basis` answers, not
    this function's to gate on. File candidates are tried before directory
    candidates at each tier (exact, then case-folded) so a file that happens
    to share a name with a directory still wins, matching how file-vs-file
    name collisions are already resolved elsewhere in this module.
    """
    path_bearing = "/" in target or target.startswith(".")
    if path_bearing:
        base = os.path.normpath(os.path.join(os.path.dirname(relpath), target))
        if base.startswith("..") or os.path.isabs(base):
            # It leaves the folder the owner pointed at. Whatever is out there
            # is not this folder's to claim, either way.
            return OUTSIDE, False
        candidates = [canonical_relpath(base)]
        # A wikilink carrying a path resolves against the collection root as
        # well as against the linking file. Obsidian tries the vault root first,
        # and a collection root sitting below the walk root is the ordinary
        # shape once a folder holds more than one set of notes, so resolving
        # only relative to the linking file reported working links as broken.
        # Relative-to-file stays FIRST, which leaves markdown links unchanged.
        if not target.startswith("."):
            root_relative = canonical_relpath(target)
            if root_relative not in candidates:
                candidates.append(root_relative)
    else:
        candidates = [canonical_relpath(target)]
    for candidate in list(candidates):
        if not Path(candidate).suffix:
            candidates.append(candidate + ".md")

    for candidate in candidates:
        if candidate in corpus.files:
            return candidate, False
    for candidate in candidates:
        if candidate in corpus.dirs:
            return candidate, False
    for candidate in candidates:
        hit = corpus.by_folded.get(fold(candidate))
        if hit:
            chosen = nearest_hit(hit, relpath)
            # A genuine tie (three or more same-named files equally near, or
            # two equally near from a root-level linking file) comes back
            # None. Reporting THAT as broken is honest; reporting a guessed
            # winner as resolved is exactly the stale-green this tier exists
            # to prevent, just at the disambiguation step instead of the
            # lookup itself.
            return (chosen, True) if chosen is not None else (None, False)
    for candidate in candidates:
        hit = corpus.by_folded_dirs.get(fold(candidate))
        if hit:
            # NOT run through nearest_hit: two directories differing only by
            # case (e.g. "Docs" and "docs") are not a same-name collision
            # between separate collections, they are the SAME logical target
            # under two spellings, and this tier's own contract (see
            # `Corpus.__init__`'s by_folded_dirs comment and the
            # fresh-process determinism test) is to pick deterministically
            # from `dirs`' own walk order, not to treat two case variants as
            # an ambiguous pair needing disambiguation by path distance.
            return hit[0], True
    if path_bearing:
        # Last resort for a path written from a collection root we cannot see:
        # a file whose own path ENDS with the target. Required to be unique, so
        # this resolves what is unambiguous and invents nothing.
        for candidate in candidates:
            tail = "/" + candidate
            suffixed = [p for p in corpus.files if p.endswith(tail)]
            if len(suffixed) == 1:
                return suffixed[0], False
    # Obsidian-style bare name: resolve on stem anywhere in the folder.
    # Directories are not part of this tier: a bare-word wikilink resolving
    # onto ANY same-named folder anywhere in the tree (rather than a
    # sibling-relative path) is a much looser match than the file case
    # already accepts here, and no reported or reproduced failure asks for it.
    if "/" not in target:
        hit = corpus.by_stem.get(fold(Path(target).stem))
        if hit:
            chosen = nearest_hit(hit, relpath)
            if chosen is None:
                # A genuine tie at the loosest, bare-stem tier. Same rule as
                # the tiers above: unresolved, not a guess.
                return None, False
            # NEITHER side folded. The index is keyed on the folded stem, so a
            # hit here says the names match ignoring case; whether they match
            # EXACTLY is the separate question this answers, and it is answered
            # by comparing the names as written. Folding only the left-hand side
            # made every hit on a capitalised filename report a case-only match,
            # so most links in most folders were raised as "breaks on a
            # case-sensitive filesystem" when they do not.
            return chosen, Path(chosen).stem != Path(target).stem
    return None, False


def links_basis(relpath: str, entry: dict, corpus: Corpus) -> dict[str, str]:
    """The linking file AND every path it points at, present or absent.

    Declaring the targets is what makes the cached answer honest: deleting a
    target changes this basis, so the cell key changes, so the stale green
    cannot be served.
    """
    basis = {relpath: entry.get("hash") or ""}
    targets, readable = corpus.targets(relpath, entry)
    if not readable:
        return basis
    for target in targets:
        resolved, _ = resolve_link(target, relpath, corpus)
        if resolved == OUTSIDE:
            basis[f"{target}::outside"] = OUTSIDE
        elif resolved and resolved in corpus.dirs:
            basis[resolved] = DIRECTORY
        elif resolved:
            basis[resolved] = corpus.files[resolved].get("hash") or ""
        else:
            basis[f"{target}::unresolved"] = ABSENT
    return basis


def check_links(relpath: str, entry: dict, corpus: Corpus) -> tuple[str, str]:
    targets, readable = corpus.targets(relpath, entry)
    if not readable:
        return UNVERIFIABLE, "could not read as text"
    broken, case_only, outside = [], [], []
    for target in targets:
        resolved, case_mismatch = resolve_link(target, relpath, corpus)
        if resolved == OUTSIDE:
            outside.append(target)
        elif resolved is None:
            broken.append(target)
        elif case_mismatch:
            case_only.append(target)
    suffix = (
        f"; {len(outside)} point outside this folder and are not checked"
        if outside
        else ""
    )
    if broken:
        detail = f"{len(broken)} link(s) resolve to nothing: " + ", ".join(
            sorted(broken)[:5]
        )
        if case_only:
            detail += f"; {len(case_only)} resolve only by ignoring case"
        return FAIL, detail + suffix
    if case_only:
        # Not broken here, and broken on a case-sensitive filesystem. Its own
        # finding rather than a false green or a false break.
        return UNVERIFIABLE, (
            f"{len(case_only)} link(s) match only when case is ignored, "
            "which breaks on a case-sensitive filesystem: "
            + ", ".join(sorted(case_only)[:5])
        ) + suffix
    return PASS, "every internal link resolves" + suffix


# -- exact duplicates ------------------------------------------------------


def duplicates_basis(corpus: Corpus) -> dict[str, str]:
    """Every file's content hash: any file changing, appearing or going can
    change the answer, so all of them are declared."""
    return {r: e.get("hash") or "" for r, e in sorted(corpus.files.items())}


def check_duplicates(corpus: Corpus) -> tuple[str, str]:
    """Files whose bytes are identical. Grouped on the hashes already computed;
    no similarity threshold, no comparison of one file's meaning to another's.

    Nothing is ever suppressed, because a folder cannot tell us which of its
    copies are deliberate. A backup directory, a vendored tree and an accident
    are byte-identical to each other in every respect this check can see, so a
    rule that skipped the first two would silently skip the third. What the
    report does instead is ORDER: sets are ranked by the bytes they waste, the
    heaviest few are named, and the rest are counted. Bulk noise sorts itself
    to the bottom rather than being hidden, and no real duplicate can be lost
    to a heuristic guessing wrong about a directory's name.

    The single exemption is files of ZERO length, and it is not a judgement
    about intent. Every empty file is byte-identical to every other empty file
    by definition, so they carry no information: on any folder using .gitkeep
    or equivalent, they are a set that says only that the convention is in use.
    """
    groups: dict[str, list[str]] = {}
    for relpath, e in corpus.files.items():
        h = e.get("hash")
        if h and e.get("size", 0) > 0:
            groups.setdefault(h, []).append(relpath)
    dupes = [sorted(v) for v in groups.values() if len(v) > 1]
    if not dupes:
        return PASS, "no byte-identical duplicates"

    def wasted(members: list[str]) -> int:
        # The copies beyond the first are the waste; one of them is the file.
        size = corpus.files[members[0]].get("size", 0)
        return size * (len(members) - 1)

    dupes.sort(key=lambda m: (-wasted(m), m[0]))
    shown = "; ".join(f"{' = '.join(m)} ({_bytes_human(wasted(m))})" for m in dupes[:3])
    rest = len(dupes) - 3
    tail = f"; {rest} more set(s)" if rest > 0 else ""
    total = _bytes_human(sum(wasted(m) for m in dupes))
    return (
        FAIL,
        f"{len(dupes)} set(s) of byte-identical files, {total} wasted, "
        f"heaviest first: {shown}{tail}",
    )


# Every check here reads only what Python's own stdlib gives it: no linter,
# formatter, or other external binary is shelled out to today. `external_tools`
# is declared per check anyway (empty, for all of them) rather than assumed, so
# a future check that genuinely does shell out states its own dependency and
# env_probe reflects that check specifically, never every check uniformly.
FILE_CHECKS = {
    "encoding-integrity": {
        "fn": check_encoding,
        "cacheable": True,
        "config": {},
        "text_only": True,
        "external_tools": (),
    },
    "secret-scan": {
        "fn": check_secrets,
        "cacheable": True,
        "config": {
            "patterns": [name for name, _ in SECRET_PATTERNS] + ["card-number shape"]
        },
        "text_only": True,
        "external_tools": (),
    },
    "template-residue": {
        "fn": check_residue,
        "cacheable": True,
        "config": {"markers": [name for name, _ in RESIDUE_PATTERNS]},
        "text_only": True,
        "external_tools": (),
    },
    "link-integrity": {
        "fn": check_links,
        "cacheable": True,
        "config": {},
        "text_only": True,
        "suffixes": LINKED_SUFFIXES,
        "basis": links_basis,
        "external_tools": (),
    },
    "truncation-shrink": {
        "fn": check_shrink,
        "cacheable": False,
        "config": {"ratio": SHRINK_RATIO, "floor": SHRINK_FLOOR},
        "text_only": False,
        "external_tools": (),
    },
}

CORPUS_CHECKS = {
    "exact-duplicates": {
        "fn": check_duplicates,
        "basis": duplicates_basis,
        "cacheable": True,
        "config": {},
        "external_tools": (),
    },
}


def evaluate(
    root: Path,
    binding_id: str,
    check_id: str,
    spec: dict,
    basis: dict[str, str],
    compute,
    path: str | None = None,
    ledger: Ledger | None = None,
    env_probe: str = "",
) -> dict:
    """One check, one basis, one answer, with the cell rules applied uniformly.

    A locally-computed cell short-circuits. Anything else recomputes: a cell
    that arrived with the folder is never counted, and where this machine
    cannot reach an answer, the arrived cell stays advisory rather than being
    promoted by our failure to check it.
    """
    if not spec["cacheable"]:
        status, detail = compute()
        return {
            "check_id": check_id,
            "path": path,
            "status": status,
            "detail": detail,
            "gate_status": status,
            "cached": False,
            "arrived": False,
        }

    key = cell_key(check_id, spec["config"], basis, env_probe)
    hit = read_cell(root, binding_id, key, ledger)
    if hit and hit["locally_verified"]:
        return {
            "check_id": check_id,
            "path": path,
            "status": hit["status"],
            "detail": hit.get("detail", ""),
            "gate_status": hit["gate_status"],
            "cached": True,
            "arrived": False,
            "cell_key": key,
        }

    status, detail = compute()
    if status in (PASS, FAIL):
        write_cell(root, binding_id, key, check_id, status, detail, ledger)
        gate = status
    else:
        gate = ADVISORY if hit else status
    if hit and hit.get("status") != status:
        detail = (
            f"{detail} (the copy that arrived with this folder said "
            f"{hit.get('status')}; this machine has not confirmed it)"
        )
    return {
        "check_id": check_id,
        "path": path,
        "status": status,
        "detail": detail,
        "gate_status": gate,
        "cached": False,
        "arrived": bool(hit),
        "cell_key": key,
    }


def run_checks(root: Path, binding: dict, prior_entries: dict, current: dict) -> dict:
    """Run every check over everything it declares an interest in."""
    results = []
    covered: set[str] = set()
    binding_id = binding["binding_id"]
    corpus = Corpus(root, current["entries"], prior_entries, current.get("dirs", []))
    ledger = Ledger(binding_id)
    # Probed once per check per run, not once per file: a tool's version does
    # not change mid-run, and shelling out per file would multiply a bounded
    # per-tool cost by the file count for no new information.
    env_probes = {
        check_id: probe_env(spec.get("external_tools", ()))
        for check_id, spec in {**FILE_CHECKS, **CORPUS_CHECKS}.items()
    }

    for relpath, entry in sorted(current["entries"].items()):
        if entry.get("kind") != "file":
            continue
        if entry.get("state") != PRESENT:
            # A dehydrated file was never opened, so "could not be read" would
            # be a false account of what happened. Both are unverifiable; only
            # one of them was attempted.
            detail = entry.get("reason") or "could not be read this run"
            results.append(
                {
                    "check_id": "readability",
                    "path": relpath,
                    "status": UNVERIFIABLE,
                    "detail": detail,
                    "gate_status": UNVERIFIABLE,
                    "cached": False,
                }
            )
            covered.add(relpath)
            continue

        suffix = Path(relpath).suffix.lower()
        for check_id, spec in FILE_CHECKS.items():
            if spec["text_only"] and suffix not in spec.get("suffixes", TEXT_SUFFIXES):
                continue
            covered.add(relpath)

            if spec["cacheable"] and not entry.get("hash"):
                results.append(
                    {
                        "check_id": check_id,
                        "path": relpath,
                        "status": UNVERIFIABLE,
                        "detail": "not content-hashed this run",
                        "gate_status": UNVERIFIABLE,
                        "cached": False,
                    }
                )
                continue

            basis_fn = spec.get("basis")
            basis = (
                basis_fn(relpath, entry, corpus)
                if basis_fn
                else {relpath: entry.get("hash") or ""}
            )
            results.append(
                evaluate(
                    root,
                    binding_id,
                    check_id,
                    spec,
                    basis,
                    lambda s=spec, r=relpath, e=entry: s["fn"](r, e, corpus),
                    path=relpath,
                    ledger=ledger,
                    env_probe=env_probes[check_id],
                )
            )

    for check_id, spec in CORPUS_CHECKS.items():
        results.append(
            evaluate(
                root,
                binding_id,
                check_id,
                spec,
                spec["basis"](corpus),
                lambda s=spec: s["fn"](corpus),
                path=None,
                ledger=ledger,
                env_probe=env_probes[check_id],
            )
        )

    ledger.flush()
    files = [r for r, e in current["entries"].items() if e.get("kind") == "file"]
    # Every exclusion surface below removed its content from `entries` entirely,
    # upstream in walk(): a sender-authored ignore glob, an inner boundary
    # anchor, the built-in tool-noise skip list (.git, node_modules, ...), and
    # the module's own reserved filenames. Folded back into the denominator
    # here, never as covered, so a folder that hides itself through any of
    # them reports a coverage ratio that says so instead of reading full.
    excluded_by_ignore = current.get("excluded_by_ignore_files", 0)
    excluded_by_boundary = current.get("excluded_by_boundary_files", 0)
    excluded_by_skip_dirs = current.get("excluded_by_skip_dirs_files", 0)
    excluded_by_reserved_name = current.get("excluded_by_reserved_name_files", 0)
    # The walk stopped short of a directory past the depth ceiling. Folded
    # into the denominator exactly like every other exclusion surface, so a
    # run that hit the ceiling cannot come back with a coverage ratio that
    # reads as complete.
    excluded_by_depth_cap = current.get("excluded_by_depth_cap_files", 0)
    # A file whose name normalised onto a name already recorded never became a
    # row of its own, so it reached no check either. Counted in the denominator
    # like every other exclusion, because the alternative is a file that is
    # simply not in the report at all.
    lost_to_collision = len(current.get("name_collisions", []))
    excluded_unsized = (
        current.get("excluded_by_ignore_unsized", 0)
        + current.get("excluded_by_boundary_unsized", 0)
        + current.get("excluded_by_skip_dirs_unsized", 0)
        + current.get("excluded_by_reserved_name_unsized", 0)
        + current.get("excluded_by_depth_cap_unsized", 0)
    )
    return {
        "results": results,
        "coverage": {
            "covered": len(covered),
            "files": (
                len(files)
                + excluded_by_ignore
                + excluded_by_boundary
                + excluded_by_skip_dirs
                + excluded_by_reserved_name
                + excluded_by_depth_cap
                + lost_to_collision
            ),
            "known_files": len(files),
            "excluded_by_ignore": excluded_by_ignore,
            "excluded_by_boundary": excluded_by_boundary,
            "excluded_by_skip_dirs": excluded_by_skip_dirs,
            "excluded_by_reserved_name": excluded_by_reserved_name,
            "excluded_by_depth_cap": excluded_by_depth_cap,
            "excluded_by_name_collision": lost_to_collision,
            "excluded_unsized": excluded_unsized,
        },
        "live_keys": {r["cell_key"] for r in results if r.get("cell_key")},
    }


# --------------------------------------------------------------------------
# one run
# --------------------------------------------------------------------------


def run(
    folder: str | Path, write_baseline: bool = True, max_depth: int | None = None
) -> dict:
    root = Path(folder)
    if not root.is_dir():
        raise NotADirectoryError(str(root))

    binding = bind(root)
    baseline = load_baseline(binding["binding_id"])
    prior_entries = (baseline or {}).get("entries", {})
    first_run = baseline is None

    # Built after bind(), so this run's own folder is in the index, and before
    # the walk, so the walk answers "is this ours" from outside the tree.
    stores = LocalStores()
    current = walk(root, baseline, stores, max_depth)
    # A directory the walk stopped short of at the depth ceiling is, for this
    # purpose, exactly like one it could not open: nothing beneath it was
    # seen this run, so a path that was there last time must not read as
    # removed just because this run chose not to look.
    dark_dirs = current["unreadable_dirs"] + current.get("depth_capped_dirs", [])
    changes = classify(prior_entries, current["entries"], dark_dirs)
    checked = run_checks(root, binding, prior_entries, current)

    # A depth-ceiling truncation is a property of the SCAN, not of any one
    # file, so it is surfaced as its own check result rather than only as
    # report text: that is what makes it flow through the same gate every
    # other check does (report["checks"], the FAIL tally in render(), and
    # main()'s exit code) instead of being visible only to someone who reads
    # the prose. Deliberately FAIL, not advisory or unverifiable: a scan that
    # stopped short of part of the tree and still reported "pass" would be
    # asserting a clean bill of health for files it never opened, and that is
    # a stronger, false claim than "I don't know" would be. Unlike an
    # unreadable directory (an OS-level refusal outside this tool's control,
    # left as report-text-only for now, matching prior behaviour), the depth
    # ceiling is this tool's OWN configurable limit with a direct remedy
    # (--max-depth / FOLDER_LOOM_MAX_DEPTH) named right in the detail, so
    # failing the run until the operator raises it or accepts the truncation
    # is a decision the operator can act on immediately, not a permanent
    # gate.
    depth_capped = sorted(set(current.get("depth_capped_dirs", [])))
    if depth_capped:
        named = ", ".join(depth_capped[:5])
        rest = f", and {len(depth_capped) - 5} more" if len(depth_capped) > 5 else ""
        plural = "y" if len(depth_capped) == 1 else "ies"
        was_were = "was" if len(depth_capped) == 1 else "were"
        checked["results"].append(
            {
                "check_id": "depth-ceiling",
                "path": None,
                "status": FAIL,
                "detail": (
                    f"{len(depth_capped)} director{plural} sat at the "
                    f"{current.get('max_depth')}-level depth ceiling (including any "
                    f"hit while sizing an already-excluded subtree) and {was_were} not "
                    "descended into, so this is a TRUNCATED scan, not a complete "
                    "one. Raise the ceiling with --max-depth or the "
                    f"FOLDER_LOOM_MAX_DEPTH environment variable: {named}{rest}"
                ),
                "gate_status": FAIL,
                "cached": False,
            }
        )

    # A boundary arriving where the prior baseline had no entry at all (new
    # path) or had a non-boundary entry (a folder just anchored underneath an
    # existing path) is a subtree going dark this run. Surfaced as a finding on
    # first sight rather than a silent, unremarked entry in "added": its name
    # carries no hint that it means exclusion.
    new_boundaries = sorted(
        r
        for r, e in current["entries"].items()
        if e.get("kind") == "boundary"
        and (r not in prior_entries or prior_entries[r].get("kind") != "boundary")
    )

    if write_baseline:
        save_baseline(binding, current["entries"])

    # Eviction runs on EVERY run, not only the ones that advance the baseline.
    # run_checks above has already written this run's cells into the folder, and
    # it does that whether or not the baseline moves, so gating the bound on
    # write_baseline left --no-write growing the store without limit while
    # calling itself a read-only pass. Safe to run unconditionally: eviction
    # already refuses to touch anything outside this machine's ledger, and
    # protect= holds back the keys this run just used.
    eviction = evict(root, binding["binding_id"], protect=checked["live_keys"])

    return {
        "folder": str(root),
        "binding": binding,
        "first_run": first_run,
        "changes": changes,
        "checks": checked["results"],
        "coverage": checked["coverage"],
        "new_boundaries": new_boundaries,
        "store": eviction,
        "walk": {
            "hashed": current["hashed"],
            "stat_skipped": current["stat_skipped"],
            "over_ceiling": current.get("over_ceiling", []),
            "unreadable_dirs": current["unreadable_dirs"],
            "depth_capped_dirs": current.get("depth_capped_dirs", []),
            "max_depth": current.get("max_depth"),
            "excluded_by_ignore_paths": current.get("excluded_by_ignore_paths", []),
            "name_collisions": current.get("name_collisions", []),
        },
    }


# Every character that can move a terminal's cursor, clear its screen, or end
# a line early. U+2028 and U+2029 are in here because some readers treat them
# as line breaks, and both are legal inside a filename.
CONTROL_CHARS = re.compile("[\x00-\x1f\x7f-\x9f\u2028\u2029]")

# Explicit bidi formatting characters (the Trojan-Source class, CVE-2021-42574):
# unpaired, one of these makes a bidi-aware terminal display a folder-supplied
# name or path in an order the bytes do not have, so what the operator READS
# and what is actually THERE diverge without a single control character in the
# C0/C1 sense. U+061C and U+200E/F are the weaker directional marks, included
# for the same reason: they are legal inside a filename and this checker's
# whole job is to name what is there, not to judge which bidi character is
# "strong" enough to matter.
BIDI_CONTROLS = re.compile(
    "[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]"
)

# Zero-width and other invisible-but-not-control characters: legal inside a
# filename, render as nothing, and are exactly what a homoglyph or reserved-
# string bypass hides inside. Kept as its own named class (rather than folded
# into BIDI_CONTROLS) so the JS renderer's equivalent set can be diffed
# against this one character-by-character.
#
# U+2060-U+2065 (WORD JOINER and the invisible operators) were missing here
# while both this file's note and the JS side's claimed the two sets were
# equivalent. A publish gate enumerated all 0x110000 codepoints against both
# tables and found exactly those six escaped by JS and passing raw through
# Python, which is how `notes<WJ>.md` and `notes.md` render as one name in a
# report. Claiming parity is not parity; the union below is what must match
# UNPRINTABLE_RANGES in src/lib/unprintable.ts, codepoint for codepoint.
ZERO_WIDTH = re.compile("[\u00ad\u180e\u200b-\u200d\u2060-\u2065\ufeff]")

# One pass, one substitution, over the union of all three classes above -
# never three separate `.sub()` calls, which would let a second pass re-widen
# a string a first pass had already trimmed to the length bound.
UNSAFE_CHARS = re.compile(
    "["
    + CONTROL_CHARS.pattern[1:-1]
    + BIDI_CONTROLS.pattern[1:-1]
    + ZERO_WIDTH.pattern[1:-1]
    + "]"
)

# A single folder-controlled span (a link target, a path) is bounded by regex
# at parse time, but several of them concatenated into one report line are
# not. Padding one line past a terminal's width does not need a single control
# character to push everything printed before it toward, or past, the top of
# the visible screen once it wraps: this is the same "operator cannot read
# what they are approving" property control characters break, reached by
# length instead of by escape sequence. Escaping alone does not close it,
# since the escaped form is still exactly as long. Chosen well above the
# longest line this module prints about itself (its own summary lines run
# under 350 characters against a real folder), so this only ever bites a
# folder-supplied span.
MAX_VISIBLE_LEN = 400


def visible(text: str) -> str:
    """A line of report text made safe to print, whoever wrote its contents.

    Paths, link targets and check explanations all come out of the folder being
    measured, and a POSIX filename may legally contain an ESC, a bidi override,
    or a zero-width character. Printed raw, one escape sequence in one of them
    moves the cursor and overwrites lines already on the screen: a report that
    says FAIL can be made to read PASS by the folder it is reporting on, on the
    very first run, with no cache involved. A bidi override reorders what the
    operator reads without touching a single byte of the surrounding text. A
    zero-width character hides inside a name that then reads as identical to
    a different one. Nothing is dropped silently: a control, bidi or
    zero-width character is replaced by a printable spelling of itself, and a
    line longer than the terminal has any legitimate reason to be is cut with
    an explicit marker naming how much was removed, rather than left to wrap
    and push everything around it out of view.
    """
    # The backslash goes first, and the two-step is not cosmetic. Without it a
    # folder shipping a file literally named `a\x1b[2Kb` renders byte for byte
    # the same as this function's own rendering of a REAL escape byte, so the
    # operator cannot tell a defanged attack from a filename pretending to be
    # one. Escaping the backslash first makes the two forms distinct, which is
    # the whole signal this function asks the operator to read.
    #
    # Codepoints above 0xff are spelt \uNNNN, matching the JS side. `\x202e`
    # for U+202E is ambiguous with `\x20` followed by `2e`, i.e. a space and a
    # full stop, which is a poor way to spell a bidi override.
    def _spell(m: "re.Match[str]") -> str:
        cp = ord(m.group())
        return "\\x%02x" % cp if cp <= 0xFF else "\\u%04x" % cp

    escaped = UNSAFE_CHARS.sub(_spell, text.replace("\\", "\\\\"))
    if len(escaped) > MAX_VISIBLE_LEN:
        omitted = len(escaped) - MAX_VISIBLE_LEN
        escaped = escaped[:MAX_VISIBLE_LEN] + f"...[{omitted} more chars truncated]"
    return escaped


def render(report: dict) -> str:
    lines = []
    b = report["binding"]
    lines.append(f"folder: {report['folder']}")
    if b.get("fork_of"):
        lines.append(
            f"NOTE: this looks like a copy of a folder already tracked at {b['fork_of']}. "
            "It has its own baseline; the two are not shared."
        )
    if report["first_run"]:
        lines.append("first run: everything validated, baseline recorded")
    c = report["changes"]
    lines.append(
        "changed: "
        f"{len(c['added'])} added, {len(c['modified'])} modified, "
        f"{len(c['removed'])} removed, {len(c['moved'])} moved, "
        f"{len(c['unchanged'])} unchanged"
    )
    if c["unreadable"] or c["unverifiable"]:
        lines.append(
            f"UNREADABLE: {len(c['unreadable'])} file(s) could not be read, "
            f"{len(c['unverifiable'])} known file(s) could not be confirmed present. "
            "These are not reported as deleted or unchanged."
        )
    unreadable_dirs = (report.get("walk") or {}).get("unreadable_dirs") or []
    if unreadable_dirs:
        ud = sorted(unreadable_dirs)
        named = ", ".join(ud[:5])
        rest = f", and {len(ud) - 5} more" if len(ud) > 5 else ""
        plural = "y" if len(ud) == 1 else "ies"
        lines.append(
            f"UNREADABLE DIRECTORIES: {len(ud)} director{plural} could not be "
            "opened, so nothing beneath them was walked or checked. Their "
            f"contents are not in the coverage total below: {named}{rest}"
        )
    walk_info = report.get("walk") or {}
    depth_capped = walk_info.get("depth_capped_dirs") or []
    if depth_capped:
        dc = sorted(depth_capped)
        named = ", ".join(dc[:5])
        rest = f", and {len(dc) - 5} more" if len(dc) > 5 else ""
        plural = "y" if len(dc) == 1 else "ies"
        was_were = "was" if len(dc) == 1 else "were"
        lines.append(
            f"DEPTH CEILING HIT: {len(dc)} director{plural} sat at the "
            f"{walk_info.get('max_depth')}-level depth ceiling and {was_were} not "
            "descended into, so nothing beneath them was walked or checked "
            "this run. This is a TRUNCATED scan, not a clean one, however the "
            "checks below read. Raise the ceiling with --max-depth or the "
            f"FOLDER_LOOM_MAX_DEPTH environment variable: {named}{rest}"
        )
    arrived = ((report.get("store") or {}).get("arrived")) or {}
    if arrived.get("over_ceiling"):
        lines.append(
            f"UNCLAIMED CELLS: {arrived['count']} file(s) in the store carry no "
            f"record of this machine having written them (past the {arrived['ceiling']} "
            "watched here). None were removed; this machine only ever deletes "
            "what its own record says is its own."
        )
    if c.get("dehydrated"):
        lines.append(
            f"DEHYDRATED: {len(c['dehydrated'])} file(s) are cloud placeholders. "
            "Their bytes are not on this machine, so they were not opened and "
            "nothing was fetched. They count as neither changed nor passing."
        )
    failures = [r for r in report["checks"] if r["gate_status"] == FAIL]
    advisory = [r for r in report["checks"] if r["gate_status"] == ADVISORY]
    unver = [r for r in report["checks"] if r["gate_status"] == UNVERIFIABLE]
    passed = [r for r in report["checks"] if r["gate_status"] == PASS]
    cov = report["coverage"]
    lines.append(
        f"checks: {len(passed)} passed, {len(failures)} failed, {len(unver)} unverifiable, "
        f"{len(advisory)} advisory (arrived, not verified here); "
        f"coverage {cov['covered']}/{cov['files']} files"
    )
    excl_ignore = cov.get("excluded_by_ignore", 0)
    excl_boundary = cov.get("excluded_by_boundary", 0)
    excl_skip = cov.get("excluded_by_skip_dirs", 0)
    excl_reserved = cov.get("excluded_by_reserved_name", 0)
    excl_depth_cap = cov.get("excluded_by_depth_cap", 0)
    excl_unsized = cov.get("excluded_unsized", 0)
    # An exclusion that was NAMED must be printed even when it sized to zero.
    # Gating this on the counts alone meant an ignore rule matching a directory
    # that holds nothing countable (only symlinks, say) went unmentioned in the
    # text output entirely, so the one surface most readers ever look at said
    # nothing about a rule that had in fact removed a whole path from the walk.
    walked = report.get("walk") or {}
    ignore_paths = sorted(set(walked.get("excluded_by_ignore_paths") or []))
    if (
        excl_ignore
        or excl_boundary
        or excl_skip
        or excl_reserved
        or excl_depth_cap
        or ignore_paths
    ):
        lines.append(
            f"  of the {cov['files']} counted above, {excl_ignore} are excluded by "
            f".loomignore, {excl_boundary} by an inner .loom-anchor boundary, "
            f"{excl_skip} by the built-in skip list (.git, node_modules, and "
            f"the like), {excl_reserved} by a reserved filename "
            "(.loomignore, .loom-anchor, .DS_Store, Thumbs.db), and "
            f"{excl_depth_cap} by the depth ceiling; none of these were "
            "checked and none count as covered"
        )
    if ignore_paths:
        named = ", ".join(ignore_paths[:5])
        rest = f", and {len(ignore_paths) - 5} more" if len(ignore_paths) > 5 else ""
        plural = "" if len(ignore_paths) == 1 else "s"
        lines.append(
            f"  {len(ignore_paths)} path{plural} matched .loomignore and "
            f"{'was' if len(ignore_paths) == 1 else 'were'} not walked or "
            f"checked, sized at {excl_ignore} file(s): {named}{rest}"
        )
    # Two numbers over one fact, and they must be the same number. The
    # denominator counts LOSSES (one per file that could not be recorded);
    # deduplicating for the sentence counted NAMES, so three files on one name
    # put 2 in the denominator and printed "1 file". Both are said here, and
    # the loss count is the one that matches the total above.
    lost_names = walked.get("name_collisions") or []
    collisions = sorted(set(lost_names))
    if lost_names:
        named = ", ".join(collisions[:5])
        rest = f", and {len(collisions) - 5} more" if len(collisions) > 5 else ""
        losses = len(lost_names)
        one_loss = losses == 1
        one_name = len(collisions) == 1
        lines.append(
            f"  NAME COLLISION: {losses} file{'' if one_loss else 's'} could not "
            f"be recorded, across {len(collisions)} "
            f"name{'' if one_name else 's'} that more than one file shares once "
            "names are put in one canonical form. Only one file per name was "
            f"recorded; the {'other' if one_loss else 'others'} reached no "
            f"check. Counted above, never as covered: {named}{rest}"
        )
    if excl_unsized:
        plural = "y" if excl_unsized == 1 else "ies"
        lines.append(
            f"  {excl_unsized} excluded entr{plural} could not even be sized "
            "(permission denied while probing); the totals above do not "
            "include them and may undercount by an unknown amount"
        )
    new_boundaries = report.get("new_boundaries") or []
    for boundary in new_boundaries:
        lines.append(
            f"  NEW BOUNDARY: {boundary} carries a .loom-anchor this run and was not "
            "walked into. Its name does not say it excludes anything; this line is "
            "the only place that says so."
        )
    for r in failures:
        lines.append(
            f"  FAIL  {r['check_id']}  {r['path'] or 'whole folder'}: {r['detail']}"
        )
    for r in advisory:
        lines.append(
            f"  ADVISORY  {r['check_id']}  {r['path'] or 'whole folder'}: {r['detail']}"
        )
    if unver:
        # Why a check could not reach an answer matters more than how many.
        reasons: dict[str, int] = {}
        for r in unver:
            reasons[r["detail"]] = reasons.get(r["detail"], 0) + 1
        for reason, count in sorted(reasons.items(), key=lambda kv: -kv[1]):
            lines.append(f"  UNVERIFIABLE  {count}x: {reason}")
    w = report["walk"]
    lines.append(f"walk: hashed {w['hashed']}, reused {w['stat_skipped']} on stat")
    # The hashed count legitimately sits below the file count when something was
    # too big to read. Say which file, or the gap reads as a lost one.
    big = w.get("over_ceiling") or []
    if big:
        named = ", ".join(f"{p} ({_bytes_human(n)})" for p, n in big[:3])
        rest = f", and {len(big) - 3} more" if len(big) > 3 else ""
        lines.append(
            f"  {len(big)} file(s) over the "
            f"{_bytes_human(HASH_SIZE_CEILING)} hash ceiling, stat-tracked only: "
            f"{named}{rest}"
        )
    # Sanitised once, here, over every line: a per-interpolation escape is a
    # rule the next line added to this function has to remember, and the one
    # that forgets is the one that ships.
    return "\n".join(visible(line) for line in lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("folder")
    parser.add_argument("--json", action="store_true", help="emit the raw report")
    parser.add_argument(
        "--no-write", action="store_true", help="do not update the baseline"
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=None,
        metavar="N",
        help=(
            "how many directory levels below the root to descend into "
            f"(default {DEFAULT_MAX_DEPTH}, or the FOLDER_LOOM_MAX_DEPTH "
            "environment variable). A directory past this depth is not "
            "walked, and the run says so rather than reading as complete."
        ),
    )
    args = parser.parse_args(argv)
    report = run(
        args.folder, write_baseline=not args.no_write, max_depth=args.max_depth
    )
    print(json.dumps(report, indent=2) if args.json else render(report))
    return 1 if any(r["gate_status"] == FAIL for r in report["checks"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
