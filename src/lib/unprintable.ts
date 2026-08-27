/**
 * unprintable.ts -- the one table of codepoints that can misrepresent text on
 * screen, and the treatments built on it.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * It was two tables. `loom-ci.ts` carried the full set (C0/C1 controls, DEL,
 * line/paragraph separators, bidi overrides, zero-width characters) to escape
 * repository-supplied text before printing it; `loom-ci-config.ts` carried a
 * narrower copy to normalise a `context` string before comparing it against
 * the reserved verdict name. The narrower copy omitted every ASCII control
 * character, so a reserved name with a DEL byte in it compared unequal to the
 * reserved string and rendered identically to it -- the exact spoof the
 * comparison exists to prevent. A publish gate found it after the version with
 * two tables had already been fixed once.
 *
 * Two copies of a security-relevant table drift by default, and the drift is
 * invisible because each copy reads as complete on its own. So there is one
 * table, here, and every consumer imports it. Widening this set widens every
 * check built on it in the same commit, which is the property that matters.
 *
 * Every range is written as codepoints, never as literal characters. A bidi
 * override or zero-width character typed into this file would be exactly as
 * unverifiable here -- in review, in a diff, in a terminal -- as it is in the
 * hostile input this module exists to defang. The source-hygiene test in
 * tests/test_doctor_loom_ci.ts reads UNPRINTABLE_RANGES from here and asserts
 * no source file in the repository contains a literal member of it.
 *
 * The Python renderer in src/assets/loom/folder_loom.py keeps the equivalent
 * set in its own `visible()`, deliberately laid out so the two can be diffed
 * codepoint by codepoint. They must be kept equal; a gate has already caught
 * them diverging by six codepoints while both sides' notes claimed parity.
 */

/**
 * C0/C1 controls, DEL, line/paragraph separators, bidi overrides and
 * formatting characters, and zero-width/invisible codepoints -- everything
 * that can move a cursor, clear a line, reorder what is displayed, or render
 * as nothing at all.
 *
 * Exported for the test build, which compiles from src/ and asserts this table
 * against the Python side and against every source file in the repository.
 * Nothing in the shipped artefact imports it, so it is marked internal and
 * `stripInternal` keeps it out of the published declarations rather than
 * letting a test seam become public API by accident.
 * @internal
 */
export const UNPRINTABLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f], // C0 controls
  [0x7f, 0x9f], // DEL, C1 controls
  [0x00ad, 0x00ad], // SOFT HYPHEN
  [0x061c, 0x061c], // ARABIC LETTER MARK
  [0x180e, 0x180e], // MONGOLIAN VOWEL SEPARATOR
  [0x200b, 0x200f], // ZERO WIDTH SPACE/NON-JOINER/JOINER, LRM, RLM
  [0x2028, 0x2029], // LINE SEPARATOR, PARAGRAPH SEPARATOR
  [0x202a, 0x202e], // LRE/RLE/PDF/LRO/RLO (bidi embedding and override)
  [0x2060, 0x2069], // WORD JOINER, invisible operators, LRI/RLI/FSI/PDI
  [0xfeff, 0xfeff], // ZERO WIDTH NO-BREAK SPACE / BOM
];

function classFrom(ranges: readonly (readonly [number, number])[]): RegExp {
  return new RegExp(
    `[${ranges
      .map(([a, b]) =>
        a === b
          ? `\\u{${a.toString(16)}}`
          : `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`,
      )
      .join("")}]`,
    "gu",
  );
}

const UNPRINTABLE = classFrom(UNPRINTABLE_RANGES);

/**
 * Default cap on a single repository-supplied field before display.
 * @internal
 */
export const DEFAULT_FIELD_CAP = 200;

/**
 * A repository-supplied string, made safe to print: escaped, never dropped.
 *
 * The backslash is escaped FIRST, so `\x1b` typed literally by a repository
 * cannot be confused with the rendering of a real ESC byte. Without that, the
 * one signal the operator is asked to read -- "this text contained something
 * that would have moved my cursor" -- can be forged by a filename that simply
 * spells the escape out.
 */
export function visible(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(UNPRINTABLE, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp <= 0xff
      ? `\\x${cp.toString(16).padStart(2, "0")}`
      : `\\u${cp.toString(16).padStart(4, "0")}`;
  });
}

/**
 * The codepoint at and above which a terminal may draw two columns.
 *
 * There is no width TABLE any more, and its absence is the finding. Five gates
 * in a row defeated this prompt through a quantity measured in the wrong unit,
 * and the last two were both a table of a Unicode property that did not match
 * what terminals actually draw. A hand-written one missed 8,405 codepoints. A
 * generated one, taken from East Asian Width W and F, missed 174 more -- the
 * Yijing hexagrams, the Tai Xuan Jing symbols, the counting rod numerals --
 * which that property calls Neutral and which glibc, wcwidth and every emulator
 * tested draw in two columns. Four checks padded with hexagrams put the warning
 * paragraph and the hostile command off an 80x24 screen with every field inside
 * its cap.
 *
 * The lesson is not that the table needed one more source. It is that a bound
 * an attacker can probe must not be a lookup whose gaps are the attack. So the
 * bound is arithmetic: at or above U+1100, where the first wide codepoint in
 * any version lives, assume TWO columns. Below it, one. Nothing to regenerate,
 * no Unicode release to chase, and no gap to find, because there are no
 * entries.
 *
 * It is an UPPER BOUND on every real width, which is the only property the
 * caller needs: a real 2 gets 2, a real 1 gets 1 or 2, a real 0 gets 1. Over
 * counting truncates a little more of a field than a perfect measure would, on
 * scripts above U+1100 that are drawn narrow. Under-counting loses the "these
 * run as you" warning off the operator's screen, which is the entire attack.
 *
 * STATED LIMIT, and it is deliberate rather than overlooked -- but it is much
 * narrower than an earlier draft of this comment claimed, and the claim was
 * wrong about its own examples. East Asian Ambiguous codepoints are drawn in
 * two columns by a terminal in a CJK locale and in one everywhere else. The
 * cutoff spares only the ones BELOW U+1100: the Latin-1 accented letters, Greek
 * and Cyrillic. The examples the earlier text reached for are all above it and
 * are ALREADY billed two columns here -- curly quote U+2019, ellipsis U+2026,
 * Vietnamese U+1EA1 and U+1EC7 -- so the cost that paragraph declined to impose
 * on those users is one this bound imposes on them already.
 *
 * What the residue is worth, stated honestly: a terminal explicitly configured
 * ambiguous-wide could draw a Cyrillic or accented-Latin path at twice the
 * columns counted here. That is a multiplier of two on a screen budget, and it
 * is the reason the budget is no longer the only thing holding this prompt
 * together: the disclosure is anchored to the tail of the message, so losing
 * the arithmetic does not lose the warning. Folding the residue in would double
 * the truncation of every ordinary accented or Cyrillic name, which is a real
 * cost paid by real users, and it is declined for that reason and no other.
 */
const WIDE_FROM = 0x1100;

/** Combining marks: rendered on top of the previous glyph, no column of their own. */


function inRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([a, b]) => cp >= a && cp <= b);
}

/**
 * Columns a code point occupies on a terminal: an UPPER BOUND, 1 or 2.
 *
 * Never the exact width, and deliberately so. Exactness here has to track a
 * moving standard: a first attempt matched Unicode 13 exactly and failed CI,
 * whose runners ship newer tables; a second folded unassigned space into the
 * wide set to survive future additions, and still failed, because U+1734 was a
 * combining mark in Unicode 13 and is not in the runners' version -- a
 * codepoint this table called zero-width and the terminal draws in one column.
 * Every version bump is another chance to be wrong in the one direction that
 * matters.
 *
 * So there is no zero-width table any more, and the invariant is arithmetic
 * rather than a table to maintain. Real terminal width is 0, 1 or 2. This
 * returns 2 for everything East Asian Wide or Fullwidth or currently
 * unassigned, and 1 for everything else, so it is >= the true width of every
 * codepoint under every Unicode version, past or future:
 *
 *   - a real 2 is in W/F, so it gets 2;
 *   - a real 1 gets 1 or 2, both >= 1;
 *   - a real 0 (combining mark) gets 1, which is >= 0.
 *
 * Over-counting truncates a little more of a field than a perfect measure
 * would, on accented or combining text. Under-counting loses the "these run as
 * you" warning off the operator's screen, which is the entire attack. Between a
 * measure that is occasionally pessimistic and one that is occasionally
 * exploitable, this takes pessimistic and stops chasing Unicode releases.
 *
 * WHERE THE PESSIMISM LANDS, named rather than left as a generality, because a
 * publish gate measured it and the sentence above understates it. Whole living
 * scripts sit above U+1100 and are drawn in ONE column: Ethiopic (U+1200+),
 * Cherokee (U+13A0+), Vietnamese Latin Extended Additional (U+1E00+), Greek
 * Extended (U+1F00+) and all of General Punctuation (U+2000+). Every one of
 * them is billed two columns here. A field capped at 200 columns therefore
 * holds 100 characters of an Ethiopic or Vietnamese path, and its owner sees
 * `...[+N more chars, truncated]` twice as early as an ASCII user does. That is
 * a real cost carried by real people, it is paid in truncation rather than in
 * safety, and it is accepted deliberately: the alternative is a table, and a
 * table's gaps are what five gates in a row walked the warning off the screen
 * through.
 * @internal
 */
export function charWidth(cp: number): number {
  return cp >= WIDE_FROM ? 2 : 1;
}

/**
 * Rows one line occupies when a terminal wraps it at `columns`.
 *
 * NOT `ceil(width / columns)`, and the difference is a defeat. A terminal walks
 * column by column and REFUSES to split a two-column glyph across the right
 * margin: with the cursor at column 79 of an 80-column screen and a wide glyph
 * next, the glyph moves to the next row and column 79 is left blank. Division
 * assumes columns pack perfectly across a wrap. They do not, and each wasted
 * column can cost a whole row.
 *
 * Execution-verified against tmux at 80 columns, which implements the
 * no-straddle rule (pyte does not, reports the third line below as two rows,
 * and is the wrong witness for this property):
 *
 *   40 wide glyphs                                  80 cols  ->  1 row
 *   'a' + 40 wide glyphs                            81 cols  ->  2 rows
 *   'a' + 40 wide + 'a' + 39 wide                  160 cols  ->  3 rows
 *
 * The last is the whole primitive: exactly two rows by arithmetic, three on a
 * screen, because the wrap is forced twice at column 79. Nine declared checks
 * padded to that alignment -- every field inside its cap, not one control byte,
 * ordinary CJK -- modelled 24 rows, drew 30, and put the header and the
 * run-as-you disclosure off an 80x24 screen while leaving the hostile command
 * and the approve instruction on it. Five gates attacked the WIDTH in that
 * division and the sixth came out of the DIVISION, which had never been the
 * thing that failed and so had never been looked at.
 *
 * The width it walks with is `charWidth`, an upper bound, so this is an upper
 * bound on rows too. The test suite carries its OWN column walk, deliberately
 * not this one and driven by a Unicode oracle rather than by `charWidth`: an
 * oracle derived from the function under test cannot fail on it, and a gate
 * has already found that exact arrangement here.
 * @internal
 */
export function wrappedRows(line: string, columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  let rows = 1;
  let used = 0;
  for (const ch of line) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    // The glyph does not straddle: it moves whole to the next row, and the
    // columns left behind on this one stay blank.
    if (used + w > width) {
      rows += 1;
      used = 0;
    }
    used += w;
  }
  return rows;
}

/**
 * Columns a string occupies on a terminal.
 * @internal
 */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/**
 * Hard ceiling on code points in one field, applied ALONGSIDE the column
 * budget, never instead of it.
 *
 * A column budget alone is satisfiable by an unbounded number of zero-width
 * characters: a gate counted 5,001 code points passing a 300-column cap, since
 * combining marks are correctly width zero. That is harmless on a terminal that
 * composes them and is not harmless on one that does not, and either way a
 * field the operator is asked to read should not silently carry thousands of
 * code points. Two ceilings, because the two failure modes are different: one
 * bounds what the screen shows, the other bounds what the string is.
 *
 * Expressed as a multiple of the column budget so the two stay in proportion
 * when a call site chooses a different cap. Four is generous: it admits a field
 * of entirely zero-width or combining characters four times longer than the
 * columns allowed, and still bounds it.
 */
const CODEPOINTS_PER_COLUMN_ALLOWED = 4;

/**
 * Bound a repository-supplied string to `max` COLUMNS, with the truncation
 * stated rather than silent -- a reader who sees the count knows something was
 * withheld, instead of trusting a field that quietly reads shorter than it is.
 *
 * Columns, not code points, and applied to the ESCAPED form by `safeField`, so
 * the number at the call site means what a reader assumes it means: how much of
 * their screen this can take. Every previous version of this bound was in a
 * unit smaller than the harm, and each one was defeated by whatever multiplier
 * sat in between.
 * @internal
 */
export function truncateField(text: string, max: number = DEFAULT_FIELD_CAP): string {
  const chars = Array.from(text);
  const maxChars = max * CODEPOINTS_PER_COLUMN_ALLOWED;
  if (displayWidth(text) <= max && chars.length <= maxChars) return text;
  let out = "";
  let w = 0;
  let kept = 0;
  for (const ch of chars) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    // Whichever ceiling binds first stops the copy: columns for what the screen
    // shows, code points for what the string is.
    if (w + cw > max || kept + 1 > maxChars) break;
    out += ch;
    w += cw;
    kept += 1;
  }
  return `${out}...[+${chars.length - kept} more chars, truncated]`;
}

/**
 * Escape, THEN truncate. Every repository-supplied field printed goes through
 * this, and the order is the finding.
 *
 * Truncating first counts code points in the string the repository wrote;
 * escaping then expands each unprintable one to four or six characters and
 * doubles every backslash, so a field "capped" at 300 rendered up to 1,800
 * characters -- twenty-three rows of an eighty-column terminal from a single
 * check, with the caller reading `300` at the call site. A publish gate walked
 * the warning paragraph off the screen that way with the cap never engaged.
 *
 * Bounding the escaped form makes the number at the call site mean what it
 * reads as meaning: rendered characters, which is the unit the harm is in.
 * `folder_loom.py` has always applied its own bound after escaping; this is
 * the same discipline, in the same order, in the other language.
 */
export function safeField(text: string, max: number = DEFAULT_FIELD_CAP): string {
  return truncateField(visible(text), max);
}

/**
 * The unprintable table with everything below U+0020 removed, and the removal
 * is the correctness argument for `jsonVisible` rather than a convenience.
 *
 * Derived from the one table by CLAMPING each range, never by hand-listing the
 * survivors: widening `UNPRINTABLE_RANGES` still widens this in the same
 * commit, which is the property that module header exists to protect. A range
 * that lies wholly below U+0020 drops out; one that straddles keeps its upper
 * part.
 */
const ABOVE_C0 = UNPRINTABLE_RANGES.map(
  ([a, b]) => [Math.max(a, 0x20), b] as const,
).filter(([a, b]) => a <= b);

const UNPRINTABLE_ABOVE_C0 = classFrom(ABOVE_C0);

/**
 * A JSON document with every unprintable codepoint written as a `\uXXXX`
 * escape instead of emitted raw.
 *
 * `JSON.stringify` escapes below U+0020 and stops there. A bidi override, a
 * zero-width character or a C1 control survives it untouched, and `--json`
 * output is read on a terminal at least as often as it is piped to a parser:
 * two gates in a row recorded U+202E reaching the screen through a check id.
 *
 * WHY THIS ESCAPES A NARROWER SET THAN `visible()` DOES, and it is a bug I
 * wrote and caught here rather than a subtlety inherited from anywhere. This
 * treats the SERIALISED DOCUMENT, so that the escape it writes is JSON's own
 * and the document still parses to the identical string. But a pretty-printed
 * document carries STRUCTURAL whitespace -- the real newlines and indentation
 * between tokens, outside every string literal -- and the first version of this
 * function rewrote each of those newlines as the six-character text of its own
 * escape, which is not whitespace anywhere, and left `--json` emitting a
 * document no parser accepts. The suite caught it on the first run.
 *
 * The boundary is exact rather than approximate: `JSON.stringify` never leaves
 * a codepoint below U+0020 raw INSIDE a string, and JSON's own structure is
 * pure ASCII punctuation, so every raw C0 byte in its output is structural and
 * every codepoint at or above U+0020 that this class matches is inside a string
 * literal. Escaping exactly the second set is complete for the harm and cannot
 * touch the syntax.
 *
 * The escapes `JSON.stringify` already wrote are ASCII text and no longer match
 * a raw-codepoint class, so this cannot double-escape them.
 */
export function jsonVisible(json: string): string {
  return json.replace(
    UNPRINTABLE_ABOVE_C0,
    (ch) => `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

/** True when the string contains any codepoint from the unprintable table. */
export function hasUnprintable(s: string): boolean {
  return new RegExp(UNPRINTABLE.source, "u").test(s);
}

/**
 * The comparison form of a string that must not collide with a reserved name.
 *
 * Three steps, in this order, and the order is the whole point:
 *   1. NFKC, folding compatibility variants (fullwidth forms, presentation
 *      forms, NBSP to space) that would otherwise dodge a byte comparison.
 *   2. Collapse whitespace runs to a single space and trim. This must happen
 *      BEFORE stripping, because TAB is a C0 control: stripping it first turns
 *      "Loom<TAB>Tier-0 Verdict" into "LoomTier-0 Verdict", which compares
 *      unequal while rendering, on any terminal that advances to a tab stop,
 *      as the reserved name with a wider gap.
 *   3. Strip what remains of the unprintable table -- the codepoints that
 *      render as nothing at all.
 *
 * What survives is what the operator actually sees, which is the only form
 * worth comparing a name against.
 */
export function reservedCompareForm(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(UNPRINTABLE, "");
}
