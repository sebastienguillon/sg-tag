import type { Settings } from '@shared/model';
import { DEFAULT_SETTINGS, SIDEBAR_WIDTH } from '@shared/model';
import { describe, expect, it } from 'vitest';
import { createTestLibrary } from '../testing/test-library';
import { SettingsRepository } from './settings-repository';

describe('SettingsRepository', () => {
  it('starts from the defaults and keeps updates', () => {
    const settings = new SettingsRepository(createTestLibrary().db);
    expect(settings.get()).toEqual(DEFAULT_SETTINGS);

    settings.update({ sidebarWidth: 420 });
    expect(settings.get()).toEqual({ ...DEFAULT_SETTINGS, sidebarWidth: 420 });
  });

  it('keeps the sidebar width within bounds', () => {
    const settings = new SettingsRepository(createTestLibrary().db);
    expect(settings.update({ sidebarWidth: 10_000 }).sidebarWidth).toBe(SIDEBAR_WIDTH.max);
    expect(settings.update({ sidebarWidth: 12.4 }).sidebarWidth).toBe(SIDEBAR_WIDTH.min);
    expect(settings.update({ sidebarWidth: Number.NaN }).sidebarWidth).toBe(
      DEFAULT_SETTINGS.sidebarWidth,
    );
  });

  it('keeps the latest tags export, which settings updates cannot write', () => {
    const { db } = createTestLibrary();
    const settings = new SettingsRepository(db);
    expect(settings.lastTagExport()).toBeNull();

    const record = { at: 1_760_000_000_000, path: '/Users/seb/SG Tag tags.jsonl', files: 12 };
    settings.recordTagExport(record);
    expect(settings.lastTagExport()).toEqual(record);
    expect(settings.get()).toEqual(DEFAULT_SETTINGS);

    settings.update({ lastTagExport: { ...record, files: 0 } } as Partial<Settings>);
    expect(settings.lastTagExport()).toEqual(record);
  });

  it('reads a malformed tags export record as none', () => {
    const { db } = createTestLibrary();
    const settings = new SettingsRepository(db);
    const store = (value: unknown): void => {
      db.prepare("REPLACE INTO settings (key, value) VALUES ('lastTagExport', ?)").run(
        JSON.stringify(value),
      );
    };

    for (const value of [
      null,
      'yesterday',
      { at: 'yesterday', path: '/a.jsonl', files: 1 },
      { at: 1, path: '', files: 1 },
      { at: 1, path: '/a.jsonl', files: -1 },
      { at: 1, path: '/a.jsonl' },
    ]) {
      store(value);
      expect(settings.lastTagExport()).toBeNull();
    }
  });
});
