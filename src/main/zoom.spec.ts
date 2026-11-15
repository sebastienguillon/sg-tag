import { describe, expect, it } from 'vitest';
import { nextZoomFactor, trafficLightPosition, ZOOM_FACTORS, zoomCommand } from './zoom';

describe('zoomCommand', () => {
  const press = (
    key: string,
    code: string,
    modifiers: { control?: boolean; meta?: boolean; alt?: boolean } = {},
  ) => ({
    type: 'keyDown',
    key,
    code,
    control: false,
    meta: false,
    alt: false,
    ...modifiers,
  });
  const ctrl = { control: true };

  it('reads the character typed, so that every keyboard layout works', () => {
    expect(zoomCommand(press('=', 'Equal', ctrl), 'win32')).toBe('in');
    expect(zoomCommand(press('+', 'Equal', ctrl), 'win32')).toBe('in');
    expect(zoomCommand(press('+', 'NumpadAdd', ctrl), 'win32')).toBe('in');
    expect(zoomCommand(press('-', 'Minus', ctrl), 'win32')).toBe('out');
    expect(zoomCommand(press('-', 'NumpadSubtract', ctrl), 'win32')).toBe('out');
    expect(zoomCommand(press('0', 'Digit0', ctrl), 'win32')).toBe('reset');
    expect(zoomCommand(press('0', 'Numpad0', ctrl), 'win32')).toBe('reset');
    // AZERTY: - is on the 6 key, and the 0 key types à.
    expect(zoomCommand(press('-', 'Digit6', ctrl), 'win32')).toBe('out');
    expect(zoomCommand(press('à', 'Digit0', ctrl), 'win32')).toBe('reset');
  });

  it('wants ⌘ on macOS and Ctrl elsewhere', () => {
    expect(zoomCommand(press('=', 'Equal', { meta: true }), 'darwin')).toBe('in');
    expect(zoomCommand(press('=', 'Equal', ctrl), 'darwin')).toBeNull();
    expect(zoomCommand(press('=', 'Equal', { meta: true }), 'win32')).toBeNull();
    expect(zoomCommand(press('=', 'Equal', ctrl), 'linux')).toBe('in');
  });

  it('ignores other keys, key releases, and AltGr, which Windows reports as Ctrl+Alt', () => {
    expect(zoomCommand(press('=', 'Equal'), 'win32')).toBeNull();
    expect(zoomCommand(press('6', 'Digit6', ctrl), 'win32')).toBeNull();
    expect(zoomCommand({ ...press('-', 'Minus', ctrl), type: 'keyUp' }, 'win32')).toBeNull();
    expect(zoomCommand(press('=', 'Equal', { control: true, alt: true }), 'win32')).toBeNull();
  });
});

describe('nextZoomFactor', () => {
  it('moves one step at a time, and stops at either end', () => {
    expect(nextZoomFactor(1, 'in')).toBe(1.1);
    expect(nextZoomFactor(1, 'out')).toBe(0.9);
    expect(nextZoomFactor(1.1, 'reset')).toBe(1);
    expect(nextZoomFactor(ZOOM_FACTORS[0], 'out')).toBe(ZOOM_FACTORS[0]);
    expect(nextZoomFactor(3, 'in')).toBe(3);
  });

  it('takes inexact factors read back, and factors between steps, to the next step', () => {
    expect(nextZoomFactor(0.6700001, 'in')).toBe(0.75);
    expect(nextZoomFactor(0.6699999, 'out')).toBe(0.5);
    expect(nextZoomFactor(1.2, 'in')).toBe(1.25);
    expect(nextZoomFactor(1.2, 'out')).toBe(1.1);
  });
});

describe('trafficLightPosition', () => {
  it('keeps the traffic lights centred in the toolbar as it zooms', () => {
    expect(trafficLightPosition(1)).toEqual({ x: 16, y: 18 });
    expect(trafficLightPosition(2)).toEqual({ x: 16, y: 44 });
    expect(trafficLightPosition(0.5)).toEqual({ x: 16, y: 5 });
  });
});
