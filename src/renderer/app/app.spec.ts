import { Component } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { App } from './app';
import { DESKTOP } from './core/desktop';
import { fakeDesktop, settle } from './testing/fake-worker-client';

/** Stands in for each page: the shortcuts are the app's, whatever the page shows. */
@Component({ template: '' })
class Page {}

describe('App', () => {
  let fixture: ComponentFixture<App>;
  let router: Router;

  const start = async (platform: string): Promise<void> => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: Page },
          { path: 'tags', component: Page },
          { path: 'settings', component: Page },
        ]),
        { provide: DESKTOP, useValue: { ...fakeDesktop, platform } },
      ],
    });
    fixture = TestBed.createComponent(App);
    router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    await fixture.whenStable();
  };
  /** Types a character with modifiers, as the keyboard reports it, wherever the focus is. */
  const press = async (init: KeyboardEventInit): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    (document.activeElement ?? document.body).dispatchEvent(event);
    await settle();
    await fixture.whenStable();
    return event;
  };

  it('opens the tags page on ⌘-Shift-T, from every page', async () => {
    await start('darwin');
    const event = await press({ key: 'T', code: 'KeyT', metaKey: true, shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(router.url).toBe('/tags');

    await router.navigateByUrl('/settings');
    // macOS may report the letter small while ⌘ is held.
    await press({ key: 't', code: 'KeyT', metaKey: true, shiftKey: true });
    expect(router.url).toBe('/tags');
  });

  it('opens Settings on ⌘-comma, from every page', async () => {
    await start('darwin');
    await press({ key: ',', code: 'Comma', metaKey: true });
    expect(router.url).toBe('/settings');

    await router.navigateByUrl('/tags');
    await press({ key: ',', code: 'Comma', metaKey: true });
    expect(router.url).toBe('/settings');
  });

  it('matches the character typed, not the key that types it', async () => {
    await start('darwin');
    // On a French AZERTY keyboard, the comma is where M is on QWERTY, and that key types a semicolon.
    await press({ key: ';', code: 'Comma', metaKey: true });
    expect(router.url).toBe('/');
    await press({ key: ',', code: 'KeyM', metaKey: true });
    expect(router.url).toBe('/settings');

    // Where T is typed by another key, that key; the key of T on QWERTY, when it types another letter, not.
    await press({ key: 'Y', code: 'KeyT', metaKey: true, shiftKey: true });
    expect(router.url).toBe('/settings');
    await press({ key: 'T', code: 'KeyK', metaKey: true, shiftKey: true });
    expect(router.url).toBe('/tags');
  });

  it('wants Ctrl rather than ⌘ outside macOS, and Shift for the tags page', async () => {
    await start('win32');
    await press({ key: 'T', metaKey: true, shiftKey: true });
    expect(router.url).toBe('/');
    const withoutShift = await press({ key: 't', ctrlKey: true });
    expect(withoutShift.defaultPrevented).toBe(false);
    expect(router.url).toBe('/');

    await press({ key: 'T', ctrlKey: true, shiftKey: true });
    expect(router.url).toBe('/tags');
    await press({ key: ',', ctrlKey: true });
    expect(router.url).toBe('/settings');
  });
});
