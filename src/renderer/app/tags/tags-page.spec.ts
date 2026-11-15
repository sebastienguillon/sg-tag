import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { Tag, TagDeleteResult, TagDetails, TagEditResult, TagRef } from '@shared/model';
import { DESKTOP } from '../core/desktop';
import { LibraryStore } from '../core/library-store';
import { WorkerClient } from '../core/worker-client';
import { FakeWorkerClient, fakeDesktop, settle } from '../testing/fake-worker-client';
import { TagsPage } from './tags-page';

const tag = (id: number, name: string, more: Partial<Tag> = {}): Tag => ({
  id,
  name,
  aliases: [],
  parentIds: [],
  fileCount: 1,
  ...more,
});
const ref = ({ id, name }: Tag): TagRef => ({ id, name });

// Europe › France › Île-de-France › Paris › Montmartre; Paris is also right below France, and below
// Capitals with Tokyo.
const CAPITALS = tag(1, 'Capitals', { fileCount: 0 });
const EUROPE = tag(2, 'Europe', { fileCount: 3 });
const FRANCE = tag(3, 'France', { parentIds: [2], fileCount: 12 });
const ILE_DE_FRANCE = tag(4, 'Île-de-France', { parentIds: [3], fileCount: 0 });
const MONTMARTRE = tag(5, 'Montmartre', { parentIds: [6], fileCount: 2 });
const PARIS = tag(6, 'Paris', {
  parentIds: [1, 3, 4],
  aliases: ['Lutèce', 'Paname'],
  fileCount: 14,
});
const TOKYO = tag(7, 'Tokyo', { parentIds: [1], fileCount: 5 });
/**
 * In the order the worker sorts names, which is not the order of JavaScript's `sort`: that one
 * puts Île-de-France after Tokyo.
 */
const LIBRARY = [CAPITALS, EUROPE, FRANCE, ILE_DE_FRANCE, MONTMARTRE, PARIS, TOKYO];

describe('TagsPage', () => {
  let fixture: ComponentFixture<TagsPage>;
  let host: HTMLElement;
  let worker: FakeWorkerClient;
  /** The tags the worker lists, in its order. */
  let library: Tag[];
  /** Where the page asked the router to go. */
  let navigations: (readonly unknown[])[];

  /** What the tag editor reads of `of`, from the library as it is. */
  const detailsOf = (of: Tag): TagDetails => ({
    tag: of,
    parents: library.filter((other) => of.parentIds.includes(other.id)).map(ref),
    children: library.filter((other) => other.parentIds.includes(of.id)).map(ref),
    tagsBelow: 0,
    ownFiles: of.fileCount,
    filesWithBelow: of.fileCount,
    taggedFiles: of.fileCount,
    forgottenFiles: 0,
  });
  const render = async (): Promise<void> => {
    await settle();
    await fixture.whenStable();
  };
  /** The library holds `tags` now, as after a change in the worker. */
  const changeLibrary = async (tags: Tag[]): Promise<void> => {
    library = tags;
    worker.emit('tagsChanged', null);
    await render();
  };
  const text = (element: Element | null | undefined): string =>
    element?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  const listbox = (): HTMLElement => host.querySelector<HTMLElement>('[role="listbox"]')!;
  const filterField = (): HTMLInputElement =>
    host.querySelector<HTMLInputElement>('input[aria-label="Filter tags"]')!;
  const newTagField = (): HTMLInputElement | null =>
    host.querySelector<HTMLInputElement>('input[aria-label="Name of the new tag"]');
  const options = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="option"]')];
  const names = (): string[] => options().map((option) => text(option.querySelector('.name')));
  const option = (name: string): HTMLElement | undefined =>
    options().find((candidate) => text(candidate.querySelector('.name')) === name);
  /** The name of the tag selected in the list; `null` when none shown is. */
  const selected = (): string | null => {
    const id = listbox().getAttribute('aria-activedescendant');
    return id === null ? null : text(document.getElementById(id)?.querySelector('.name'));
  };
  const count = (): string => text(host.querySelector('.count'));
  const editorName = (): HTMLInputElement | null =>
    host.querySelector<HTMLInputElement>('app-tag-editor .name input');
  const button = (label: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll('button')].find((candidate) => text(candidate) === label);
  const alerts = (): string[] =>
    [...host.querySelectorAll('.list-header [role="alert"]')].map((alert) => text(alert));
  /** Presses a key in `target`, and answers the event: whether it was kept from the page. */
  const press = async (target: Element, key: string): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    await render();
    return event;
  };
  /** Replaces what `input` holds, as typing or pasting does. */
  const type = async (input: HTMLInputElement, typed: string): Promise<void> => {
    input.focus();
    input.value = typed;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  const click = async (target: HTMLElement | null | undefined): Promise<void> => {
    target?.click();
    await render();
  };

  beforeEach(async () => {
    worker = new FakeWorkerClient();
    library = LIBRARY;
    worker.respond('listTags', () => library);
    worker.respond('getTagDetails', (id) => {
      const found = library.find((each) => each.id === id);
      return found ? detailsOf(found) : null;
    });
    worker.respond('search', () => ({ ids: new Int32Array(0), elapsedMs: 0 }));
    // jsdom lays nothing out and does not scroll: the list scrolls the way a browser does.
    Object.defineProperty(Element.prototype, 'scrollTo', {
      configurable: true,
      value(this: Element, to: ScrollToOptions) {
        this.scrollTop = to.top ?? this.scrollTop;
      },
    });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: WorkerClient, useValue: worker },
        { provide: DESKTOP, useValue: fakeDesktop },
      ],
    });
    navigations = [];
    vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation((commands) => {
      navigations.push(commands);
      return Promise.resolve(true);
    });
    fixture = TestBed.createComponent(TagsPage);
    host = fixture.nativeElement as HTMLElement;
    await render();
  });

  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'scrollTo');
  });

  it('lists every tag in the order the worker gives, with its parent tags and its counts', () => {
    expect(names()).toEqual([
      'Capitals',
      'Europe',
      'France',
      'Île-de-France',
      'Montmartre',
      'Paris',
      'Tokyo',
    ]);
    expect(count()).toBe('7 tags');
    const paris = option('Paris');
    expect(text(paris?.querySelector('.parents'))).toBe('Capitals, France, Île-de-France');
    expect(text(paris?.querySelector('.files'))).toBe('14 files');
    expect(text(paris?.querySelector('.below'))).toBe('1 tag below');
    expect(paris?.getAttribute('aria-setsize')).toBe('7');
    expect(paris?.getAttribute('aria-posinset')).toBe('6');
    const montmartre = option('Montmartre');
    expect(text(montmartre?.querySelector('.files'))).toBe('2 files');
    expect(text(montmartre?.querySelector('.below'))).toBe('');
    expect(text(option('Europe')?.querySelector('.parents'))).toBe('');
  });

  it('counts each tag below a tag once, a tag reached two ways included', () => {
    const below = (name: string): string => text(option(name)?.querySelector('.below'));
    // Paris is right below France, and below Île-de-France: France has three tags below it.
    expect(below('France')).toBe('3 tags below');
    expect(below('Europe')).toBe('4 tags below');
    expect(below('Capitals')).toBe('3 tags below');
    expect(below('Île-de-France')).toBe('2 tags below');
  });

  it('starts in the filter box, and asks to choose a tag', () => {
    expect(document.activeElement).toBe(filterField());
    expect(text(host.querySelector('.editor-pane'))).toBe('Choose a tag to edit it.');
    expect(listbox().getAttribute('aria-activedescendant')).toBeNull();
    expect(host.querySelector('[aria-label="Back to library"]')?.getAttribute('href')).toBe('/');
  });

  it('keeps the tags whose name or an alias holds the text typed, as a search compares them', async () => {
    await type(filterField(), 'PAN');
    expect(names()).toEqual(['Paris']);
    expect(count()).toBe('1 of 7 tags');

    await type(filterField(), 'ile');
    expect(names()).toEqual(['Île-de-France']);

    await type(filterField(), 'lutece');
    expect(names()).toEqual(['Paris']);

    await type(filterField(), 'zzz');
    expect(names()).toEqual([]);
    expect(count()).toBe('0 of 7 tags');

    await type(filterField(), '');
    expect(names()).toHaveLength(7);
    expect(count()).toBe('7 tags');
  });

  it('keeps the unused tags, the tags without a parent tag, or both, with the text typed', async () => {
    const unused = button('Unused');
    const withoutParent = button('No parent');
    expect(unused?.getAttribute('aria-pressed')).toBe('false');

    await click(unused);
    expect(unused?.getAttribute('aria-pressed')).toBe('true');
    expect(names()).toEqual(['Capitals', 'Île-de-France']);
    expect(count()).toBe('2 of 7 tags');

    await click(withoutParent);
    expect(withoutParent?.getAttribute('aria-pressed')).toBe('true');
    expect(names()).toEqual(['Capitals']);

    await click(unused);
    expect(names()).toEqual(['Capitals', 'Europe']);

    await type(filterField(), 'e');
    expect(names()).toEqual(['Europe']);
  });

  it('empties the filter box on Escape, then goes back to the library', async () => {
    await type(filterField(), 'par');
    const first = await press(filterField(), 'Escape');
    expect(first.defaultPrevented).toBe(true);
    expect(filterField().value).toBe('');
    expect(names()).toHaveLength(7);
    expect(navigations).toEqual([]);

    await press(filterField(), 'Escape');
    expect(navigations).toEqual([['/']]);
  });

  it('moves through the list with the keyboard, the editor following without taking the focus', async () => {
    await press(filterField(), 'ArrowDown');
    expect(document.activeElement).toBe(listbox());
    expect(selected()).toBe('Capitals');
    expect(option('Capitals')?.getAttribute('aria-selected')).toBe('true');
    expect(editorName()?.value).toBe('Capitals');

    await press(listbox(), 'ArrowDown');
    expect(selected()).toBe('Europe');
    expect(editorName()?.value).toBe('Europe');
    expect(document.activeElement).toBe(listbox());
    expect(option('Capitals')?.getAttribute('aria-selected')).toBe('false');

    await press(listbox(), 'End');
    expect(selected()).toBe('Tokyo');
    await press(listbox(), 'ArrowDown');
    expect(selected()).toBe('Tokyo');
    await press(listbox(), 'ArrowUp');
    expect(selected()).toBe('Paris');
    await press(listbox(), 'Home');
    expect(selected()).toBe('Capitals');
    expect(document.activeElement).toBe(listbox());
  });

  it('goes on to the list from the filter box, on the tag selected when it is shown', async () => {
    await type(filterField(), 'r');
    expect(names()).toEqual(['Europe', 'France', 'Île-de-France', 'Montmartre', 'Paris']);
    // No tag shown is selected: the first one is.
    await press(filterField(), 'Enter');
    expect(document.activeElement).toBe(listbox());
    expect(selected()).toBe('Europe');
    await press(listbox(), 'ArrowDown');
    expect(selected()).toBe('France');

    // France stays selected while the filter changes, and the list goes on from it.
    await type(filterField(), '');
    expect(selected()).toBe('France');
    await press(filterField(), 'ArrowDown');
    expect(selected()).toBe('France');

    // Hidden by the filter, it stays in the editor, and the list starts from the top.
    await type(filterField(), 'tok');
    expect(selected()).toBeNull();
    expect(editorName()?.value).toBe('France');
    await press(filterField(), 'ArrowDown');
    expect(selected()).toBe('Tokyo');
  });

  it('selects a tag clicked in the list', async () => {
    await click(option('Paris'));
    expect(selected()).toBe('Paris');
    expect(editorName()?.value).toBe('Paris');
  });

  it('goes into the editor on Enter, and back to the list, on the same tag, on Escape', async () => {
    await press(filterField(), 'ArrowDown');
    await press(listbox(), 'ArrowDown');
    const enter = await press(listbox(), 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(editorName());
    expect(editorName()?.value).toBe('Europe');
    // Nothing to close: the editor shows the tag selected for as long as it is.
    expect(host.querySelector('[aria-label="Close tag editor"]')).toBeNull();

    await press(editorName()!, 'Escape');
    expect(document.activeElement).toBe(listbox());
    expect(selected()).toBe('Europe');
    expect(editorName()?.value).toBe('Europe');
    expect(navigations).toEqual([]);
  });

  it('goes back to the library on Escape in the list', async () => {
    await press(filterField(), 'ArrowDown');
    const escape = await press(listbox(), 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(navigations).toEqual([['/']]);
  });

  it('keeps the selected tag in view, and moves a screen at a time on PageUp and PageDown', async () => {
    const many = Array.from({ length: 500 }, (_, index) =>
      tag(index + 1, `Tag ${String(index + 1).padStart(3, '0')}`),
    );
    await changeLibrary(many);
    // Three rows on screen.
    Object.defineProperty(listbox(), 'clientHeight', { configurable: true, value: 96 });
    // Only the rows near those on screen are made.
    expect(options().length).toBeLessThan(50);
    expect(options()[0]?.getAttribute('aria-setsize')).toBe('500');

    listbox().focus();
    await press(listbox(), 'ArrowDown');
    await press(listbox(), 'PageDown');
    expect(listbox().getAttribute('aria-activedescendant')).toBe('tag-row-3');
    expect(listbox().scrollTop).toBe(0);
    await press(listbox(), 'PageDown');
    expect(listbox().getAttribute('aria-activedescendant')).toBe('tag-row-5');
    expect(listbox().scrollTop).toBe(64);

    await press(listbox(), 'End');
    expect(listbox().getAttribute('aria-activedescendant')).toBe('tag-row-500');
    expect(listbox().scrollTop).toBe(15_904);
    await press(listbox(), 'PageUp');
    expect(listbox().getAttribute('aria-activedescendant')).toBe('tag-row-498');
    await press(listbox(), 'Home');
    expect(listbox().scrollTop).toBe(0);
  });

  it('makes a new tag, selects it and puts the focus in its editor', async () => {
    const LYON = tag(8, 'Lyon', { fileCount: 0 });
    worker.respond('createTag', (): TagEditResult => {
      library = [CAPITALS, EUROPE, FRANCE, ILE_DE_FRANCE, LYON, MONTMARTRE, PARIS, TOKYO];
      return { ok: true, tag: LYON };
    });
    const opener = button('New tag');
    await click(opener);
    expect(opener?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(newTagField());

    await type(newTagField()!, '  Lyon ');
    await press(newTagField()!, 'Enter');
    expect(worker.callsTo('createTag')).toEqual([['Lyon']]);
    expect(newTagField()).toBeNull();
    expect(editorName()?.value).toBe('Lyon');
    expect(document.activeElement).toBe(editorName());

    // Once the worker says that tags changed, the list shows it, selected.
    worker.emit('tagsChanged', null);
    await render();
    expect(selected()).toBe('Lyon');
    expect(count()).toBe('8 tags');
  });

  it('says why a new tag is refused, and offers the tag that has the name', async () => {
    await click(button('New tag'));
    await type(newTagField()!, 'Paris, France');
    await press(newTagField()!, 'Enter');
    expect(worker.callsTo('createTag')).toEqual([]);
    expect(alerts()).toEqual(['A tag cannot contain a comma: commas separate tags.']);
    expect(newTagField()?.getAttribute('aria-invalid')).toBe('true');
    expect(newTagField()?.getAttribute('aria-describedby')).toBe(
      host.querySelector('.list-header [role="alert"]')?.id,
    );
    expect(newTagField()?.value).toBe('Paris, France');

    worker.respond('createTag', (): TagEditResult => ({
      ok: false,
      error: { kind: 'taken', owner: ref(PARIS), asAlias: true },
    }));
    await type(newTagField()!, 'paname');
    expect(alerts()).toEqual([]);
    await press(newTagField()!, 'Enter');
    expect(alerts()).toEqual(['“paname” is already an alias of the tag Paris.']);

    await click(button('Edit Paris'));
    expect(newTagField()).toBeNull();
    expect(selected()).toBe('Paris');
    expect(document.activeElement).toBe(editorName());
    expect(editorName()?.value).toBe('Paris');
  });

  it('empties the field of a new tag on Escape, then closes it, the focus back on New tag', async () => {
    const opener = button('New tag');
    await click(opener);
    await type(newTagField()!, 'Ly');
    await press(newTagField()!, 'Escape');
    expect(newTagField()?.value).toBe('');
    await press(newTagField()!, 'Escape');
    expect(newTagField()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(navigations).toEqual([]);
  });

  it('selects the tag that takes the place of a deleted one, the focus on the list', async () => {
    worker.respond('deleteTag', (): TagDeleteResult => ({ ok: true }));
    const deleteSelected = async (): Promise<void> => {
      await click(button('Delete tag…'));
      await click(button('Delete tag'));
    };

    await click(option('Île-de-France'));
    await deleteSelected();
    expect(worker.callsTo('deleteTag')).toEqual([[ILE_DE_FRANCE.id]]);
    expect(selected()).toBe('Montmartre');
    expect(editorName()?.value).toBe('Montmartre');
    expect(document.activeElement).toBe(listbox());
    await changeLibrary(library.filter((each) => each.id !== ILE_DE_FRANCE.id));
    expect(selected()).toBe('Montmartre');

    // The last one: the one before it.
    await click(option('Tokyo'));
    await deleteSelected();
    expect(selected()).toBe('Paris');
    expect(document.activeElement).toBe(listbox());
  });

  it('follows the tag kept when the tag selected is merged into another', async () => {
    worker.respond('getMergePreview', () => ({
      from: ref(PARIS),
      into: ref(TOKYO),
      filesMoved: 14,
      filesWithBoth: 0,
      aliases: ['Lutèce', 'Paname'],
      parents: 3,
      children: 1,
      refusal: null,
    }));
    worker.respond('mergeTags', (): TagEditResult => ({ ok: true, tag: TOKYO }));
    await click(option('Paris'));
    await click(button('Merge into…'));
    const picker = host.querySelector<HTMLInputElement>('input[aria-label="Tag to merge into"]')!;
    await type(picker, 'Tokyo');
    await press(picker, 'Enter');
    await click(button('Merge'));
    expect(worker.callsTo('mergeTags')).toEqual([[PARIS.id, TOKYO.id]]);
    expect(selected()).toBe('Tokyo');
    expect(editorName()?.value).toBe('Tokyo');
  });

  it('lists the files of a parent tag clicked in the editor, in the library', async () => {
    await click(option('Paris'));
    await click(host.querySelector<HTMLButtonElement>('ul[aria-label="Parent tags"] .chip-label'));
    expect(TestBed.inject(LibraryStore).query()).toBe('tag:Capitals');
    expect(navigations).toEqual([['/']]);
  });

  it('says when the library has no tag yet, and offers to make one', async () => {
    await changeLibrary([]);
    expect(count()).toBe('0 tags');
    const pane = host.querySelector('.editor-pane');
    expect(text(pane?.querySelector('p'))).toBe('No tag yet.');
    await click(pane?.querySelector('button'));
    expect(document.activeElement).toBe(newTagField());
  });
});
