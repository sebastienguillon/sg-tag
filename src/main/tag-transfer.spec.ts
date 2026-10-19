import type { TagExportResult } from '@shared/model';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportFileName, exportTags, isInside } from './tag-transfer';
import type { WorkerHost } from './worker-host';

describe('exportTags', () => {
  const dataDir = path.resolve('/profile/SG Tag');
  const options = { appVersion: '2026.10.0', dataDir };
  const exported: TagExportResult = { path: '', files: 12, missing: 1, tags: 5, leftOut: 0 };

  const setup = () => {
    const calls: unknown[][] = [];
    const worker = {
      call: (method: string, ...args: unknown[]) => {
        calls.push([method, ...args]);
        return Promise.resolve({ ...exported, path: args[0] });
      },
    } as unknown as Pick<WorkerHost, 'call'>;
    return { calls, worker };
  };

  it('has the indexer export the tags to the chosen file', async () => {
    const { calls, worker } = setup();
    const destination = path.resolve('/profile/Documents/SG Tag tags 2026-10-19.jsonl');

    await expect(exportTags(worker, destination, options)).resolves.toEqual({
      ...exported,
      path: destination,
    });
    expect(calls).toEqual([['exportTags', destination, '2026.10.0']]);
  });

  it('refuses a place inside the data folder without asking the indexer', async () => {
    const { calls, worker } = setup();

    for (const destination of [
      path.join(dataDir, 'library.db'),
      path.join(dataDir, 'exports', 'tags.jsonl'),
    ]) {
      await expect(exportTags(worker, destination, options)).rejects.toThrow(
        'Choose a place outside SG Tag’s data folder for the tags export.',
      );
    }
    expect(calls).toEqual([]);
  });
});

describe('isInside', () => {
  it('ignores case on macOS and Windows, and Unicode normalization on macOS', () => {
    const mac = '/Users/Sébastien/Library/Application Support/SG Tag';
    expect(
      isInside(mac, '/users/SÉBASTIEN/library/application support/sg tag/library.db', 'darwin'),
    ).toBe(true);
    expect(isInside(mac, `${mac.normalize('NFD')}/library.db`, 'darwin')).toBe(true);

    const windows = 'C:\\Users\\Seb\\AppData\\Roaming\\SG Tag';
    expect(isInside(windows, 'c:\\users\\seb\\appdata\\roaming\\sg tag\\library.db', 'win32')).toBe(
      true,
    );
    expect(isInside(windows, 'C:/Users/Seb/AppData/Roaming/SG Tag/exports/a.jsonl', 'win32')).toBe(
      true,
    );
  });

  it('respects case on Linux', () => {
    const linux = '/home/seb/.config/SG Tag';
    expect(isInside(linux, '/home/seb/.config/SG Tag/library.db', 'linux')).toBe(true);
    expect(isInside(linux, '/home/seb/.config/sg tag/library.db', 'linux')).toBe(false);
  });

  it('includes the folder itself, but not its parent or a folder sharing its name', () => {
    const data = '/Users/seb/Library/Application Support/SG Tag';
    expect(isInside(data, data, 'darwin')).toBe(true);
    expect(isInside(data, `${data}/`, 'darwin')).toBe(true);
    expect(isInside(data, `${data}/..tags.jsonl`, 'darwin')).toBe(true);
    expect(isInside(data, '/Users/seb/Library/Application Support', 'darwin')).toBe(false);
    expect(isInside(data, `${data}/../tags.jsonl`, 'darwin')).toBe(false);
    expect(isInside(data, `${data} backups/tags.jsonl`, 'darwin')).toBe(false);
  });
});

describe('exportFileName', () => {
  it('names the export after the local date', () => {
    expect(exportFileName(new Date(2026, 9, 19, 0, 30))).toBe('SG Tag tags 2026-10-19.jsonl');
    expect(exportFileName(new Date(2026, 9, 19, 23, 30))).toBe('SG Tag tags 2026-10-19.jsonl');
    expect(exportFileName(new Date(2027, 0, 2))).toBe('SG Tag tags 2027-01-02.jsonl');
  });
});
