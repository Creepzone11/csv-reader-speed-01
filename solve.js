// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader), the reference program of
// csv-reader-speed-01-run-20261121 ("Read broken CSV files faster").
//
// run(input) returns, for every input {text, header}, exactly the answer csv-reader 1.0.0
// returns: {columns, rows, errors}. The semantics are csv-reader's own (see the kit's
// baselines/csv-reader/vendor/csv-reader/index.js, which this file re-implements, faster):
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it
//     one quote, and each CRLF or lone CR inside it is read as LF; what follows its closing
//     quote, up to the next comma or line break, is appended to it as it stands (quote_junk,
//     when the field ends); a quote that never closes is read as a literal character and the
//     text after it is read again as an unquoted field (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never
//     trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records
//     after it (every record when header is false), each padded with "" (short_row, with
//     fields: its count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every LF,
//     CRLF and lone CR inside a quoted field counted), row its record's index in rows (null
//     for the header), in the order met, a field's quote_junk when the field ends and a
//     record's short_row or long_row when the record ends.
//
// Speed: csv-reader reads one character at a time and builds each field a character at a
// time. This file instead jumps and cuts with the engine's own scanners:
//
//   - a record with no quote before its next line break is cut out whole and split on
//     commas (the common shape: most records hold no quoted field). One regex exec finds
//     whichever of a quote or a line break comes first;
//   - an unquoted field jumps straight to its next comma, LF or CR with one regex exec,
//     and is cut out with slice, so a stray CR is the only reason to look at it twice
//     (one regex scan beats three indexOf scans for the next of three characters);
//   - a quoted field jumps from quote to quote with indexOf, cuts the pieces out with
//     slice, and only touches a piece again when it holds a CR or a line break (to turn
//     the CRs into LFs and count the lines).
//
// Everything is one function with plain locals (no closures over the hot state), so V8
// keeps pos/line in registers. The two regexes are module-level and only ever used
// through exec with lastIndex set first, one call at a time, so they hold no state
// between calls. Pure: no clock, no randomness, no locale, nothing kept from one call
// to the next. Dependency-free ES module; no WASM, no native addon.

/** The next comma, CR or LF (an unquoted field's end). */
const DELIM = /[,\r\n]/g;
/** The next quote or LF (whichever comes first decides a record's shape). */
const QUOTE_OR_LF = /["\n]/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // How a field ended: 0 at a comma (the record goes on), 1 at a line break, 2 at the end of the text.
  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // A record with no quote before its next line break holds no quoted field, so the
    // whole line can be cut out and split on commas. The first of a quote or a line
    // break decides: a line break (or neither) means no quote comes first.
    QUOTE_OR_LF.lastIndex = pos;
    const qm = QUOTE_OR_LF.exec(text);
    if (qm === null || qm[0] === '\n') {
      const nextNl = qm === null ? -1 : qm.index;
      const lineEnd = nextNl === -1 ? n : nextNl;
      let contentEnd = lineEnd;
      if (nextNl !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) contentEnd = lineEnd - 1;
      const content = text.slice(pos, contentEnd);
      let fields;
      if (content.indexOf('\r') === -1) {
        fields = content.split(',');
      } else {
        // Every CR here is a lone one (the CRLF's CR was cut off above): one stray_cr
        // each, dropped from the fields.
        const parts = content.split('\r');
        for (let i = 1; i < parts.length; i++) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        fields = parts.join('').split(',');
      }
      pos = nextNl === -1 ? n : nextNl + 1;
      if (nextNl !== -1) line += 1;
      // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '') continue;
      if (width < 0) width = fields.length;
      if (header && columns === null) {
        columns = fields;
        continue;
      }
      if (fields.length < width) {
        errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
      }
      rows.push(fields);
      continue;
    }

    // A record that holds a quote: read it a field at a time.
    const fields = [];
    let ended = 0;
    let lastQuoted = false;
    do {
      let fieldValue;
      let fieldEnded;
      // initValue, when not null, is the value an unquoted read starts from (a plain
      // unquoted field starts from '', a quoted field's junk starts from its value, an
      // unterminated quote starts from the quote itself).
      let initValue = null;
      let isJunk = false;
      if (text.charCodeAt(pos) === 34) {
        // A quoted field: jump from quote to quote.
        lastQuoted = true;
        const open = pos;
        const openLine = line;
        let value = '';
        let start = pos + 1;
        let q = text.indexOf('"', start);
        let closed = false;
        while (q !== -1) {
          // The piece up to this quote: CRs inside it become LFs, and every LF, CRLF
          // and lone CR in it is one more line.
          const chunk = text.slice(start, q);
          if (chunk.indexOf('\r') === -1) {
            if (chunk.indexOf('\n') !== -1) {
              let cc = 0;
              let ci = -1;
              while ((ci = chunk.indexOf('\n', ci + 1)) !== -1) cc += 1;
              line += cc;
            }
            value += chunk;
          } else {
            const rep = chunk.replace(/\r\n?/g, '\n');
            let cc = 0;
            let ci = -1;
            while ((ci = rep.indexOf('\n', ci + 1)) !== -1) cc += 1;
            line += cc;
            value += rep;
          }
          if (text.charCodeAt(q + 1) === 34) {
            // A doubled quote: one quote, and the field goes on.
            value += '"';
            start = q + 2;
            q = text.indexOf('"', start);
          } else {
            // The closing quote.
            pos = q + 1;
            closed = true;
            break;
          }
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the text after it
          // is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          initValue = '"';
        } else if (pos >= n) {
          fieldValue = value;
          fieldEnded = 2;
        } else {
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            fieldValue = value;
            fieldEnded = 0;
          } else if (c === 10) {
            pos += 1;
            line += 1;
            fieldValue = value;
            fieldEnded = 1;
          } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            fieldValue = value;
            fieldEnded = 1;
          } else {
            // What follows the closing quote is appended as it stands, up to the next
            // comma or line break.
            initValue = value;
            isJunk = true;
          }
        }
      } else {
        lastQuoted = false;
        initValue = '';
      }
      if (initValue !== null) {
        // An unquoted read: jump to the next comma, LF or CR, and cut the piece out.
        let value = initValue;
        let added = 0;
        let start = pos;
        let ended2 = 2;
        for (;;) {
          DELIM.lastIndex = pos;
          const dm = DELIM.exec(text);
          let m = -1;
          let w = 0;
          if (dm) {
            m = dm.index;
            const dc = dm[0];
            w = dc === ',' ? 1 : dc === '\n' ? 2 : 3;
          }
          if (m === -1) {
            if (start < n) {
              value += text.slice(start);
              added += n - start;
            }
            pos = n;
            ended2 = 2;
            break;
          }
          if (w === 1) {
            value += text.slice(start, m);
            added += m - start;
            pos = m + 1;
            ended2 = 0;
            break;
          }
          if (w === 2) {
            value += text.slice(start, m);
            added += m - start;
            pos = m + 1;
            line += 1;
            ended2 = 1;
            break;
          }
          if (text.charCodeAt(m + 1) === 10) {
            value += text.slice(start, m);
            added += m - start;
            pos = m + 2;
            line += 1;
            ended2 = 1;
            break;
          }
          // A CR not followed by LF is dropped (stray_cr), and the field goes on.
          value += text.slice(start, m);
          added += m - start;
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          pos = m + 1;
          start = m + 1;
        }
        fieldValue = value;
        fieldEnded = ended2;
        if (isJunk && added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      }
      fields.push(fieldValue);
      ended = fieldEnded;
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
