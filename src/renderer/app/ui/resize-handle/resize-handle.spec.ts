import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { ResizeHandle } from './resize-handle';

describe('ResizeHandle', () => {
  let fixture: ComponentFixture<ResizeHandle>;
  let handle: HTMLElement;
  /** Width the panel is drawn at, when its styles hold it narrower than `size`. */
  let capped: number | null;

  beforeEach(async () => {
    capped = null;
    fixture = TestBed.createComponent(ResizeHandle);
    fixture.componentRef.setInput('size', 300);
    fixture.componentRef.setInput('min', 200);
    fixture.componentRef.setInput('max', 600);
    fixture.componentRef.setInput('step', 20);
    fixture.componentRef.setInput('defaultSize', 300);
    // jsdom does not lay out.
    fixture.componentRef.setInput('panel', {
      getBoundingClientRect: () => ({ width: capped ?? size() }),
    });
    await fixture.whenStable();
    handle = fixture.nativeElement as HTMLElement;
    // Not implemented by jsdom.
    handle.setPointerCapture = () => undefined;
  });

  function size(): number {
    return fixture.componentInstance.size();
  }

  function key(name: string): void {
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: name, cancelable: true }));
  }

  function pointer(type: string, clientX: number): void {
    handle.dispatchEvent(new PointerEvent(type, { clientX, button: 0, pointerId: 1 }));
  }

  it('is a focusable vertical separator exposing the width', async () => {
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('tabindex')).toBe('0');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuemin')).toBe('200');
    expect(handle.getAttribute('aria-valuemax')).toBe('600');

    key('ArrowLeft');
    await fixture.whenStable();
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
  });

  it('resizes with the keyboard, within bounds', () => {
    key('ArrowLeft');
    expect(size()).toBe(320);
    key('ArrowRight');
    key('ArrowRight');
    expect(size()).toBe(280);
    key('End');
    key('ArrowLeft');
    expect(size()).toBe(600);
    key('Home');
    key('ArrowRight');
    expect(size()).toBe(200);
  });

  it('follows the pointer from the width actually drawn, until released', () => {
    fixture.componentRef.setInput('size', 500);
    capped = 250;

    pointer('pointerdown', 700);
    pointer('pointermove', 650);
    expect(size()).toBe(300);
    pointer('pointermove', 900);
    expect(size()).toBe(200);

    handle.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1 }));
    pointer('pointermove', 400);
    expect(size()).toBe(200);
  });

  it('restores the default width on double-click', () => {
    fixture.componentRef.setInput('size', 480);
    handle.dispatchEvent(new MouseEvent('dblclick'));
    expect(size()).toBe(300);
  });
});
