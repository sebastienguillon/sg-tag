import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeMediaTool, parseToolVersion } from './media-tools';

describe('parseToolVersion', () => {
  it('reads the version from the first line of `-version`', () => {
    expect(
      parseToolVersion(
        'ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) 2000-2024 the FFmpeg developers\n' +
          'built with gcc 14.2.0 (Rev1, Built by MSYS2 project)\n',
      ),
    ).toBe('7.1-full_build-www.gyan.dev');
    expect(
      parseToolVersion('ffprobe version 9.0.2 Copyright (c) 2007-2026 the FFmpeg developers'),
    ).toBe('9.0.2');
    expect(parseToolVersion('ffmpeg version N-118385-g0225fe857d-20250127 Copyright')).toBe(
      'N-118385-g0225fe857d-20250127',
    );
  });

  it('finds no version in other output', () => {
    expect(parseToolVersion('')).toBeNull();
    expect(parseToolVersion('Usage: ffmpeg [options]')).toBeNull();
  });
});

describe('describeMediaTool', () => {
  const resources = path.join(os.tmpdir(), 'sg-tag-no-such-app', 'resources');

  it('tells the tools shipped with the app from the others', async () => {
    const bundled = path.join(resources, 'bin', 'ffmpeg');
    expect(await describeMediaTool(bundled, resources)).toEqual({
      path: bundled,
      version: null,
      bundled: true,
    });
    const installed = path.join(os.tmpdir(), 'sg-tag-no-such-dir', 'ffmpeg');
    expect((await describeMediaTool(installed, resources)).bundled).toBe(false);
    expect((await describeMediaTool(installed, null)).bundled).toBe(false);
  });
});
