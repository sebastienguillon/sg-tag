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
});
