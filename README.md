# csv-reader, faster

A faster drop-in for [csv-reader 1.0.0](https://make.fun/bounty/csv-reader-speed-01-run-20261121),
make.fun's own CSV reader, entered in the make.fun bounty
[**Read broken CSV files faster, 21 November 2026**](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
(`csv-reader-speed-01-run-20261121`).

## What it is

`main.ts` is the harness driver (unchanged from the kit): it reads every case from
`/input/cases.json`, answers each one alone with `run()` from `solve.js`, and writes
`/output/answers.json`.

`solve.js` is a dependency-free ES module whose `run(input)` returns, for every input
`{text, header}`, exactly the answer csv-reader 1.0.0 returns: `{columns, rows, errors}`.
It reads the text once, left to right, by csv-reader's own broken-row policy:

- a U+FEFF at the very start of the text is dropped;
- a record ends at LF or CRLF, and a line left with no characters is no record;
- outside a quoted field a CR not followed by LF is dropped (`stray_cr`);
- a field that opens with a quote runs to the next quote that is not doubled, `""`
  inside it one quote, and each CRLF or lone CR inside it is read as LF; what follows
  its closing quote, up to the next comma or line break, is appended to it as it
  stands (`quote_junk`, when the field ends); a quote that never closes is read as a
  literal character and the text after it is read again as an unquoted field
  (`unterminated_quote`);
- a quote inside an unquoted field is a literal character; fields stay strings, never
  trimmed or converted;
- `columns` is the first record when `header` is true, else null; `rows` holds the
  records after it (every record when `header` is false), each padded with `""`
  (`short_row`, with `fields`: its count) or cut (`long_row`, with `extra`: the cut
  fields) to the first record's width;
- each error is `{code, line, row}`: `line` the 1-based line its record starts on
  (every LF, CRLF and lone CR inside a quoted field counted), `row` its record's
  index in `rows` (null for the header), in the order met.

## How it is faster

csv-reader reads one character at a time and builds each field a character at a time.
`solve.js` instead jumps and cuts with the engine's own scanners:

- a record with no quote before its next line break is cut out whole and split on
  commas (the common shape: most records hold no quoted field). One regex exec finds
  whichever of a quote or a line break comes first;
- an unquoted field jumps straight to its next comma, LF or CR with one regex exec,
  and is cut out with `slice`, so a stray CR is the only reason to look at it twice
  (one regex scan beats three `indexOf` scans for the next of three characters);
- a quoted field jumps from quote to quote with `indexOf`, cuts the pieces out with
  `slice`, and only touches a piece again when it holds a CR or a line break (to turn
  the CRs into LFs and count the lines).

Everything is one function with plain locals (no closures over the hot state), so V8
keeps `pos`/`line` in registers. Pure: no clock, no randomness, no locale, nothing
kept from one call to the next. No WASM, no native addon, no dependency.

## Results (practice set, 6 cases, 10.19 MB of CSV)

- Correctness: **6/6 cases identical** to csv-reader 1.0.0's answers, verified with
  the kit's own grader (`node cli/makefun.mjs grade-local --kit . --bot <entry>
  --driver process`): `passed 1`, `cases_passed 6/6`, `6 of 6 points`, and the
  L1 regrade reproduced byte for byte. Also checked against the reference on 107
  hand-written edge cases and 2,000 fuzzed inputs, all identical.
- Speed (this machine, Node 24, `--no-incremental-marking`, trimmed mean over
  repeated runs of `run()` on the whole practice set): **~85 ms** against
  csv-reader 1.0.0's **~460–525 ms** — about **5–6x faster** (~120 MB/s vs ~20 MB/s).

## Grade it

From the kit directory (the kit is not part of this repository):

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/this/repo --driver process
```

Or run the driver directly on the practice input:

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=<dir> node main.ts
```

## Licence

MIT — see [LICENSE](LICENSE). Copyright 2026 Creepzone11.
