import type { Slicer } from '../tag-transfer/slices';

/** A field of an unquoted run: up to the next comma or line break. */
const PLAIN = /[^,\r\n]*/y;

/**
 * Calls `onRow` with the fields of each record of `text`, CSV as RFC 4180 writes it: fields
 * separated by commas, records by CRLF or LF (or a lone CR); a field in double quotes may hold
 * commas, line breaks and doubled quotes. Lenient where the format is broken, as spreadsheets are:
 * text after a closing quote belongs to the field, and a quote that is never closed runs to the
 * end of the text. Blank lines are passed over. `record` counts records as a spreadsheet shows
 * them, from 1, blank lines included.
 *
 * Yields once a slice of `slicer` is spent, between two records: `onRow` may stop the reading by
 * throwing.
 */
export async function eachCsvRecord(
  text: string,
  onRow: (fields: string[], record: number) => void,
  slicer: Slicer,
): Promise<void> {
  const { length } = text;
  let index = 0;
  let record = 0;
  while (index < length) {
    record++;
    const fields: string[] = [];
    let blank = true;
    for (;;) {
      let field = '';
      if (text.charCodeAt(index) === 0x22) {
        // Quoted: up to the closing quote, doubled quotes standing for one.
        blank = false;
        let from = index + 1;
        for (;;) {
          const quote = text.indexOf('"', from);
          if (quote === -1) {
            field += text.slice(from);
            index = length;
            break;
          }
          if (text.charCodeAt(quote + 1) === 0x22) {
            field += text.slice(from, quote + 1);
            from = quote + 2;
            continue;
          }
          field += text.slice(from, quote);
          index = quote + 1;
          break;
        }
      }
      // Unquoted, or what follows a closing quote.
      PLAIN.lastIndex = index;
      const plain = PLAIN.exec(text)?.[0] ?? '';
      if (plain !== '') {
        blank = false;
        field += plain;
        index += plain.length;
      }
      fields.push(field);
      const next = text.charCodeAt(index);
      if (next === 0x2c) {
        blank = false;
        index++;
        continue;
      }
      // A line break, or the end of the text.
      if (next === 0x0d) {
        index += text.charCodeAt(index + 1) === 0x0a ? 2 : 1;
      } else if (next === 0x0a) {
        index++;
      }
      break;
    }
    if (!blank) {
      onRow(fields, record);
    }
    if (slicer.due) {
      await slicer.yield();
    }
  }
}
