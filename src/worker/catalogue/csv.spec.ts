import { describe, expect, it } from 'vitest';
import { Slicer } from '../tag-transfer/slices';
import { eachCsvRecord } from './csv';

/** The records of `text`, each as `[record number, ...fields]`. */
async function recordsOf(text: string): Promise<(string | number)[][]> {
  const records: (string | number)[][] = [];
  await eachCsvRecord(
    text,
    (fields, record) => {
      records.push([record, ...fields]);
    },
    new Slicer(),
  );
  return records;
}

describe('eachCsvRecord', () => {
  it('reads fields separated by commas, records by LF or CRLF', async () => {
    expect(await recordsOf('a,b,c\n1,2,3\r\n4,,6')).toEqual([
      [1, 'a', 'b', 'c'],
      [2, '1', '2', '3'],
      [3, '4', '', '6'],
    ]);
  });

  it('reads quoted fields with commas, line breaks and doubled quotes', async () => {
    expect(await recordsOf('"a, b","line\nbreak","say ""hi""",""\nnext')).toEqual([
      [1, 'a, b', 'line\nbreak', 'say "hi"', ''],
      [2, 'next'],
    ]);
  });

  it('passes over blank lines, counting them as rows, and reads a trailing comma as a field', async () => {
    expect(await recordsOf('a,\n\n\r\nb\n')).toEqual([
      [1, 'a', ''],
      [4, 'b'],
    ]);
  });

  it('reads broken quoting as spreadsheets do', async () => {
    // Text after a closing quote stays in the field; a quote never closed runs to the end.
    expect(await recordsOf('"ab"cd,e\nf,"never\nclosed')).toEqual([
      [1, 'abcd', 'e'],
      [2, 'f', 'never\nclosed'],
    ]);
  });

  it('reads a lone CR as a line break, and a quote inside an unquoted field as a character', async () => {
    expect(await recordsOf('a\rb"c\r')).toEqual([
      [1, 'a'],
      [2, 'b"c'],
    ]);
  });

  it('yields between records once a slice is spent, and stops when the reading throws', async () => {
    const slicer = new Slicer();
    let yields = 0;
    Object.defineProperty(slicer, 'due', { get: () => true });
    slicer.yield = () => {
      yields++;
      return Promise.resolve();
    };
    const read: string[] = [];
    await expect(
      eachCsvRecord(
        'a\nb\nc\nd',
        ([field]) => {
          if (field === 'c') {
            throw new Error('Enough');
          }
          read.push(field ?? '');
        },
        slicer,
      ),
    ).rejects.toThrow('Enough');
    expect(read).toEqual(['a', 'b']);
    expect(yields).toBe(2);
  });
});
