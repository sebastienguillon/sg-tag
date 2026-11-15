import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type {
  Tag,
  TagDeleteResult,
  TagDetails,
  TagEditError,
  TagEditResult,
  TagMergePreview,
  TagRef,
} from '@shared/model';
import { WorkerClient } from '../../core/worker-client';
import { FakeWorkerClient, settle } from '../../testing/fake-worker-client';
import { TagEditor } from './tag-editor';

const tag = (id: number, name: string, more: Partial<Tag> = {}): Tag => ({
  id,
  name,
  aliases: [],
  parentIds: [],
  fileCount: 1,
  ...more,
});
const ref = ({ id, name }: Tag): TagRef => ({ id, name });

// Europe › France › Île-de-France › Paris › Montmartre, and Lyon below France.
const EUROPE = tag(1, 'Europe');
const FRANCE = tag(2, 'France', { parentIds: [1] });
const ILE_DE_FRANCE = tag(3, 'Île-de-France', { parentIds: [2] });
const LYON = tag(4, 'Lyon', { parentIds: [2] });
const MONTMARTRE = tag(5, 'Montmartre', { parentIds: [6] });
const PARIS = tag(6, 'Paris', { parentIds: [3], aliases: ['Paname'], fileCount: 14 });
const TOKYO = tag(7, 'Tokyo');
/** In the order the worker sorts names. */
const LIBRARY = [EUROPE, FRANCE, ILE_DE_FRANCE, LYON, MONTMARTRE, PARIS, TOKYO];

const details = (of: Tag, more: Partial<TagDetails> = {}): TagDetails => ({
  tag: of,
  parents: [],
  children: [],
  tagsBelow: 0,
  ownFiles: 0,
  filesWithBelow: 0,
  taggedFiles: 0,
  forgottenFiles: 0,
  ...more,
});
const PARIS_DETAILS = details(PARIS, {
  parents: [ref(ILE_DE_FRANCE)],
  children: [ref(MONTMARTRE)],
  tagsBelow: 1,
  ownFiles: 12,
  filesWithBelow: 40,
  taggedFiles: 14,
  forgottenFiles: 2,
});
const ok = (edited: Tag): TagEditResult => ({ ok: true, tag: edited });
const refused = (error: TagEditError): { readonly ok: false; readonly error: TagEditError } => ({
  ok: false,
  error,
});

describe('TagEditor', () => {
  let fixture: ComponentFixture<TagEditor>;
  let host: HTMLElement;
  let worker: FakeWorkerClient;
  /** What `getTagDetails` answers, by tag id. */
  let library: Map<number, TagDetails>;
  /** How many times the editor asked to be closed, and said its tag was deleted. */
  let closed: number;
  let deleted: number;
  let searches: string[];

  const render = async (): Promise<void> => {
    await settle();
    await fixture.whenStable();
  };
  const nameField = (): HTMLInputElement => host.querySelector<HTMLInputElement>('.name input')!;
  const field = (label: string): HTMLInputElement =>
    host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  /** Replaces what `input` holds, as typing or pasting does. */
  const type = async (input: HTMLInputElement, text: string): Promise<void> => {
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  /** Presses a key in `target`, and answers the event: whether it was kept from the page. */
  const press = async (target: Element, key: string): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    await render();
    return event;
  };
  const button = (label: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll('button')].find(
      (candidate) => candidate.textContent.trim() === label,
    );
  const click = async (target: HTMLElement | null | undefined): Promise<void> => {
    target?.click();
    await render();
  };
  const chips = (list: string): string[] =>
    [...host.querySelectorAll(`ul[aria-label="${list}"] .chip-label`)].map((label) =>
      label.textContent.trim(),
    );
  const alerts = (): string[] =>
    [...host.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent.trim());
  /** The suggestions under a picker of the editor. */
  const suggested = (picker: HTMLInputElement): string[] =>
    [...(picker.closest('app-tag-input')?.querySelectorAll('[role="option"] .name') ?? [])].map(
      (name) => name.textContent,
    );
  const confirmation = (): HTMLElement | null =>
    host.querySelector<HTMLElement>('[role="alertdialog"]');

  beforeEach(async () => {
    worker = new FakeWorkerClient();
    library = new Map([
      [PARIS.id, PARIS_DETAILS],
      [LYON.id, details(LYON, { parents: [ref(FRANCE)], ownFiles: 3 })],
    ]);
    worker.respond('listTags', () => LIBRARY);
    worker.respond('getTagDetails', (id) => library.get(id) ?? null);
    TestBed.configureTestingModule({ providers: [{ provide: WorkerClient, useValue: worker }] });
    fixture = TestBed.createComponent(TagEditor);
    fixture.componentRef.setInput('tagId', PARIS.id);
    host = fixture.nativeElement as HTMLElement;
    closed = 0;
    deleted = 0;
    searches = [];
    fixture.componentInstance.closed.subscribe(() => {
      closed++;
    });
    fixture.componentInstance.deleted.subscribe(() => {
      deleted++;
    });
    fixture.componentInstance.searchRequested.subscribe((query) => {
      searches.push(query);
    });
    await render();
  });

  it('shows the name, counts, parent tags, child tags and aliases of the tag, the focus in its name', () => {
    expect(nameField().value).toBe('Paris');
    expect(host.querySelector('.name')?.textContent).toContain('Name');
    expect(document.activeElement).toBe(nameField());
    expect(host.querySelector('.counts')?.textContent).toBe('12 files · 40 with the tag below it');
    expect(chips('Parent tags')).toEqual(['Île-de-France']);
    expect(chips('Child tags')).toEqual(['Montmartre']);
    expect(chips('Aliases')).toEqual(['Paname']);
    expect(field('Add a parent tag').placeholder).toBe('Add a parent tag');
    expect(field('Add a child tag').placeholder).toBe('Add a child tag');
    expect(field('Add an alias').placeholder).toBe('Add an alias');
    expect(alerts()).toEqual([]);
  });

  it('counts the files with the tags below it only when it has some', async () => {
    library.set(PARIS.id, { ...PARIS_DETAILS, tagsBelow: 3, ownFiles: 1, filesWithBelow: 1_250 });
    worker.emit('tagsChanged', null);
    await render();
    expect(host.querySelector('.counts')?.textContent).toBe(
      '1 file · 1,250 with the 3 tags below it',
    );

    library.set(PARIS.id, { ...PARIS_DETAILS, tagsBelow: 0, children: [], ownFiles: 0 });
    worker.emit('tagsChanged', null);
    await render();
    expect(host.querySelector('.counts')?.textContent).toBe('0 files');
  });

  it('keeps what it shows while the tag is read again after a change', async () => {
    const answer = Promise.withResolvers<TagDetails | null>();
    worker.respond('getTagDetails', () => answer.promise);
    const shown = nameField();
    worker.emit('tagsChanged', null);
    // Not `render`: the fixture is not stable while the tag is being read.
    await settle();
    TestBed.tick();
    expect(worker.callsTo('getTagDetails')).toHaveLength(2);
    expect(nameField()).toBe(shown);
    expect(chips('Parent tags')).toEqual(['Île-de-France']);

    answer.resolve({ ...PARIS_DETAILS, parents: [ref(ILE_DE_FRANCE), ref(TOKYO)] });
    await render();
    expect(nameField()).toBe(shown);
    expect(chips('Parent tags')).toEqual(['Île-de-France', 'Tokyo']);
  });

  it('renames the tag on Enter, keeping the old name as an alias only when asked', async () => {
    worker.respond('renameTag', (_id, name) => ok({ ...PARIS, name }));
    await type(nameField(), 'Lutèce');
    const keep = host.querySelector<HTMLInputElement>('.keep input');
    expect(host.querySelector('.keep')?.textContent.trim()).toBe('Keep “Paris” as an alias');
    expect(keep?.checked).toBe(false);
    const enter = await press(nameField(), 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(worker.callsTo('renameTag')).toEqual([[PARIS.id, 'Lutèce', false]]);

    keep?.click();
    await render();
    await press(nameField(), 'Enter');
    expect(worker.callsTo('renameTag').at(-1)).toEqual([PARIS.id, 'Lutèce', true]);

    // Renamed, the field shows the new name, and there is no old name to keep any more.
    library.set(PARIS.id, { ...PARIS_DETAILS, tag: { ...PARIS, name: 'Lutèce' } });
    worker.emit('tagsChanged', null);
    await render();
    expect(nameField().value).toBe('Lutèce');
    expect(host.querySelector('.keep')).toBeNull();
  });

  it('offers to keep the old name only for a name the tag does not have', async () => {
    worker.respond('renameTag', (_id, name) => ok({ ...PARIS, name }));
    // Another letter case is the same name; an alias becomes the name, and the name an alias.
    await type(nameField(), 'PARIS');
    expect(host.querySelector('.keep')).toBeNull();
    await press(nameField(), 'Enter');
    await type(nameField(), 'paname');
    expect(host.querySelector('.keep')).toBeNull();
    await press(nameField(), 'Enter');
    expect(worker.callsTo('renameTag')).toEqual([
      [PARIS.id, 'PARIS', false],
      [PARIS.id, 'paname', false],
    ]);

    // The name it has: nothing to do.
    await type(nameField(), ' Paris ');
    await press(nameField(), 'Enter');
    expect(worker.callsTo('renameTag')).toHaveLength(2);
  });

  it('puts the name back on Escape, and closes on Escape once it is back', async () => {
    await type(nameField(), 'Lutèce');
    const first = await press(nameField(), 'Escape');
    expect(first.defaultPrevented).toBe(true);
    expect(nameField().value).toBe('Paris');
    expect(closed).toBe(0);

    const second = await press(nameField(), 'Escape');
    expect(second.defaultPrevented).toBe(true);
    expect(closed).toBe(1);
  });

  it('closes with its Close button', async () => {
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Close tag editor"]'));
    expect(closed).toBe(1);
  });

  it('says why a name is refused, next to the name field, until it changes', async () => {
    await type(nameField(), 'Paris, France');
    await press(nameField(), 'Enter');
    expect(worker.callsTo('renameTag')).toEqual([]);
    const sentence = host.querySelector('.name ~ [role="alert"]');
    expect(sentence?.textContent).toBe('A tag cannot contain a comma: commas separate tags.');
    expect(nameField().getAttribute('aria-describedby')).toBe(sentence?.id);
    expect(nameField().getAttribute('aria-invalid')).toBe('true');

    await type(nameField(), 'Paris France');
    expect(alerts()).toEqual([]);
    expect(nameField().getAttribute('aria-invalid')).toBeNull();

    worker.respond('renameTag', () => refused({ kind: 'busy' }));
    await press(nameField(), 'Enter');
    expect(alerts()).toEqual(['Tags are being exported or imported: try again once that is done.']);
    // Kept, to be tried again.
    expect(nameField().value).toBe('Paris France');
  });

  it('offers to merge the tag whose name was typed into this one, once confirmed', async () => {
    worker.respond('renameTag', () => refused({ kind: 'taken', owner: ref(LYON), asAlias: false }));
    worker.respond('getMergePreview', (from, into) => ({
      from: ref(from === LYON.id ? LYON : PARIS),
      into: ref(into === PARIS.id ? PARIS : LYON),
      filesMoved: 12,
      filesWithBoth: 3,
      refusal: null,
    }));
    worker.respond('mergeTags', () => ok(PARIS));
    await type(nameField(), 'lyon');
    await press(nameField(), 'Enter');
    expect(alerts()).toEqual(['“lyon” is already the name of the tag Lyon.']);

    const offer = button('Merge Lyon into Paris…');
    await click(offer);
    expect(worker.callsTo('getMergePreview')).toEqual([[LYON.id, PARIS.id]]);
    expect(confirmation()?.querySelector('p')?.textContent).toBe(
      'Merge “Lyon” into “Paris”? 12 files gain Paris (3 had both). Lyon becomes an alias of Paris, and its parent tags become those of Paris. This cannot be undone.',
    );
    expect(document.activeElement).toBe(button('Cancel'));

    // Cancelled, the focus goes back to the offer.
    await press(button('Cancel')!, 'Escape');
    expect(confirmation()).toBeNull();
    expect(document.activeElement).toBe(offer);
    expect(closed).toBe(0);

    await click(offer);
    await click(button('Merge'));
    expect(worker.callsTo('mergeTags')).toEqual([[LYON.id, PARIS.id]]);
    expect(confirmation()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(fixture.componentInstance.tagId()).toBe(PARIS.id);
    expect(document.activeElement).toBe(nameField());
  });

  it('offers to merge the tag that has an alias typed into this one', async () => {
    worker.respond('addTagAlias', () =>
      refused({ kind: 'taken', owner: ref(LYON), asAlias: true }),
    );
    await type(field('Add an alias'), 'Lugdunum');
    await press(field('Add an alias'), 'Enter');
    expect(alerts()).toEqual(['“Lugdunum” is already an alias of the tag Lyon.']);
    expect(field('Add an alias').value).toBe('Lugdunum');
    expect(button('Merge Lyon into Paris…')).toBeDefined();
  });

  it('adds a parent tag by its name, and offers neither the tag itself nor a tag below it', async () => {
    worker.respond('addTagParent', () => ok(PARIS));
    const picker = field('Add a parent tag');
    await type(picker, 'pari');
    expect(suggested(picker)).toEqual(['Paris: is this tag', 'pari: new tag']);
    await type(picker, 'mont');
    expect(suggested(picker)).toEqual(['Montmartre: is below Paris', 'mont: new tag']);
    // Its parent tag already: left out.
    await type(picker, 'ile');
    expect(suggested(picker)).toEqual(['ile: new tag']);

    await type(picker, 'France');
    await press(picker, 'Enter');
    // A name no tag has makes a tag: the worker does.
    await type(picker, 'Capitals');
    await press(picker, 'Enter');
    expect(worker.callsTo('addTagParent')).toEqual([
      [PARIS.id, 'France'],
      [PARIS.id, 'Capitals'],
    ]);
    expect(picker.value).toBe('');
  });

  it('says why a parent tag is refused, next to its field', async () => {
    const picker = field('Add a parent tag');
    const refuse = async (result: TagEditResult): Promise<string[]> => {
      worker.respond('addTagParent', () => result);
      await type(picker, 'France');
      await press(picker, 'Enter');
      return alerts();
    };
    const loop = {
      kind: 'loop',
      above: ref(PARIS),
      below: ref(FRANCE),
      through: ref(ILE_DE_FRANCE),
    } as const;
    expect(await refuse({ ok: false, error: loop })).toEqual([
      'France is below Paris, through Île-de-France.',
    ]);
    expect(await refuse({ ok: false, error: { ...loop, through: null } })).toEqual([
      'France is below Paris.',
    ]);
    expect(await refuse({ ok: false, error: { kind: 'limit', what: 'parents' } })).toEqual([
      'A tag cannot have more than 100 parent tags.',
    ]);
    expect(host.querySelector('app-tag-input + [role="alert"]')).not.toBeNull();

    // Gone once the next one is added.
    expect(await refuse(ok(PARIS))).toEqual([]);
  });

  it('searches a parent tag clicked, and removes one with its button', async () => {
    worker.respond('removeTagParent', () => ok(PARIS));
    await click(
      [...host.querySelectorAll<HTMLButtonElement>('ul[aria-label="Parent tags"] .chip-label')][0],
    );
    expect(searches).toEqual(['tag:Île-de-France']);

    await click(
      host.querySelector<HTMLButtonElement>('[aria-label="Remove parent tag Île-de-France"]'),
    );
    expect(worker.callsTo('removeTagParent')).toEqual([[PARIS.id, ILE_DE_FRANCE.id]]);
    // The chip goes with the button that had the focus.
    expect(document.activeElement).toBe(field('Add a parent tag'));
  });

  it('adds and removes child tags, and offers neither the tag itself nor a tag above it', async () => {
    worker.respond('addTagChild', () => ok(PARIS));
    worker.respond('removeTagParent', () => ok(MONTMARTRE));
    const picker = field('Add a child tag');
    await type(picker, 'fr');
    expect(suggested(picker)).toEqual([
      'France: is above Paris',
      'Île-de-France: is above Paris',
      'fr: new tag',
    ]);
    await type(picker, 'eu');
    expect(suggested(picker)).toEqual(['Europe: is above Paris', 'eu: new tag']);
    // Its child tag already: left out.
    await type(picker, 'montm');
    expect(suggested(picker)).toEqual(['montm: new tag']);

    await type(picker, 'Belleville');
    await press(picker, 'Enter');
    await type(picker, 'lyon');
    await press(picker, 'Enter');
    expect(worker.callsTo('addTagChild')).toEqual([
      [PARIS.id, 'Belleville'],
      [PARIS.id, 'Lyon'],
    ]);

    await click(
      [...host.querySelectorAll<HTMLButtonElement>('ul[aria-label="Child tags"] .chip-label')][0],
    );
    expect(searches).toEqual(['tag:Montmartre']);
    await click(
      host.querySelector<HTMLButtonElement>('[aria-label="Remove child tag Montmartre"]'),
    );
    expect(worker.callsTo('removeTagParent')).toEqual([[MONTMARTRE.id, PARIS.id]]);
    expect(document.activeElement).toBe(picker);
  });

  it('says why a child tag is refused, in words true from below as from above', async () => {
    // Asked to put France below Paris: France is above Paris.
    worker.respond('addTagChild', () =>
      refused({ kind: 'loop', above: ref(FRANCE), below: ref(PARIS), through: ref(ILE_DE_FRANCE) }),
    );
    const picker = field('Add a child tag');
    await type(picker, 'Tokyo');
    await press(picker, 'Enter');
    expect(alerts()).toEqual(['Paris is below France, through Île-de-France.']);
  });

  it('adds an alias on Enter, and removes one with its button', async () => {
    worker.respond('addTagAlias', () => ok(PARIS));
    worker.respond('removeTagAlias', () => ok(PARIS));
    const aliases = field('Add an alias');
    await type(aliases, '  Lutèce ');
    await press(aliases, 'Enter');
    expect(worker.callsTo('addTagAlias')).toEqual([[PARIS.id, 'Lutèce']]);
    expect(aliases.value).toBe('');

    await click(host.querySelector<HTMLButtonElement>('[aria-label="Remove alias Paname"]'));
    expect(worker.callsTo('removeTagAlias')).toEqual([[PARIS.id, 'Paname']]);
    expect(document.activeElement).toBe(aliases);
  });

  it('says why an alias is refused, and keeps it to be corrected', async () => {
    const aliases = field('Add an alias');
    await type(aliases, 'Paris, France');
    await press(aliases, 'Enter');
    expect(worker.callsTo('addTagAlias')).toEqual([]);
    expect(alerts()).toEqual(['A tag cannot contain a comma: commas separate tags.']);
    expect(aliases.getAttribute('aria-invalid')).toBe('true');

    worker.respond('addTagAlias', () => refused({ kind: 'limit', what: 'aliases' }));
    await type(aliases, 'Lutèce');
    expect(alerts()).toEqual([]);
    await press(aliases, 'Enter');
    expect(alerts()).toEqual(['A tag cannot have more than 100 aliases.']);
    expect(aliases.value).toBe('Lutèce');
  });

  it('empties the alias field on Escape, and closes on Escape once it is empty', async () => {
    const aliases = field('Add an alias');
    await type(aliases, 'Lutèce');
    await press(aliases, 'Escape');
    expect(aliases.value).toBe('');
    expect(closed).toBe(0);
    await press(aliases, 'Escape');
    expect(closed).toBe(1);
  });

  it('asks before deleting the tag, saying what it changes, and closes once it is deleted', async () => {
    worker.respond('deleteTag', (): TagDeleteResult => ({ ok: true }));
    const remove = button('Delete tag…');
    remove?.focus();
    await click(remove);
    const dialog = confirmation();
    expect(dialog?.getAttribute('aria-label')).toBe('Confirm');
    expect(
      document.getElementById(dialog?.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe(
      'Delete the tag “Paris”? 14 files lose it; 2 of them are missing from disk and will be forgotten. Its alias Paname goes too. Its child tag Montmartre moves up to Île-de-France, so that Île-de-France still finds its files. This cannot be undone.',
    );
    expect(document.activeElement).toBe(button('Cancel'));

    // Escape cancels, and the focus goes back to the button.
    const escape = await press(button('Cancel')!, 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(confirmation()).toBeNull();
    expect(document.activeElement).toBe(remove);
    expect(closed).toBe(0);
    expect(worker.callsTo('deleteTag')).toEqual([]);

    await click(remove);
    await click(button('Delete tag'));
    expect(worker.callsTo('deleteTag')).toEqual([[PARIS.id]]);
    expect(deleted).toBe(1);
    expect(closed).toBe(0);
  });

  it('says in the confirmation why the tag was not deleted', async () => {
    worker.respond('deleteTag', () => refused({ kind: 'limit', what: 'parents' }));
    await click(button('Delete tag…'));
    await click(button('Delete tag'));
    expect(confirmation()?.querySelector('[role="alert"]')?.textContent).toBe(
      'This tag cannot be deleted: one of its child tags would then have more than 100 parent tags.',
    );
    expect(document.activeElement).toBe(button('Cancel'));
    expect(deleted).toBe(0);
  });

  it('merges the tag into another once confirmed, and shows the tag kept', async () => {
    worker.respond('getMergePreview', () => ({
      from: ref(PARIS),
      into: ref(LYON),
      filesMoved: 1,
      filesWithBoth: 0,
      refusal: null,
    }));
    worker.respond('mergeTags', () => ok(LYON));
    const opener = button('Merge into…');
    await click(opener);
    expect(opener?.getAttribute('aria-expanded')).toBe('true');
    const picker = field('Tag to merge into');
    expect(document.activeElement).toBe(picker);
    // Only an existing tag, and not this one.
    await type(picker, 'pari');
    expect(suggested(picker)).toEqual(['Paris: is this tag']);
    await type(picker, 'lyo');
    expect(suggested(picker)).toEqual(['Lyon']);
    await press(picker, 'Enter');
    expect(alerts()).toEqual(['No tag is named “lyo”.']);

    await type(picker, 'lyon');
    await press(picker, 'Enter');
    expect(field('Tag to merge into')).toBeNull();
    expect(worker.callsTo('getMergePreview')).toEqual([[PARIS.id, LYON.id]]);
    expect(confirmation()?.querySelector('p')?.textContent).toBe(
      'Merge “Paris” into “Lyon”? 1 file gains Lyon. Paris and its aliases become aliases of Lyon, and its parent and child tags become those of Lyon. This cannot be undone.',
    );
    expect(document.activeElement).toBe(button('Cancel'));

    await click(button('Merge'));
    expect(worker.callsTo('mergeTags')).toEqual([[PARIS.id, LYON.id]]);
    // The tag edited is gone into Lyon: the editor follows it.
    expect(fixture.componentInstance.tagId()).toBe(LYON.id);
    expect(nameField().value).toBe('Lyon');
    expect(confirmation()).toBeNull();
    expect(document.activeElement).toBe(nameField());
    expect(closed).toBe(0);
  });

  it('says why a merge would be refused, and offers only to cancel', async () => {
    const refusal = {
      kind: 'loop',
      above: ref(FRANCE),
      below: ref(PARIS),
      through: ref(ILE_DE_FRANCE),
    } as const;
    worker.respond('getMergePreview', (): TagMergePreview => ({
      from: ref(PARIS),
      into: ref(FRANCE),
      filesMoved: 12,
      filesWithBoth: 0,
      refusal,
    }));
    await click(button('Merge into…'));
    await type(field('Tag to merge into'), 'France');
    await press(field('Tag to merge into'), 'Enter');
    expect(confirmation()?.querySelector('p')?.textContent).toBe(
      'Paris cannot be merged into France. Paris is below France, through Île-de-France.',
    );
    expect(button('Merge')).toBeUndefined();
    expect(button('Cancel')).toBeDefined();
  });

  it('closes the merge field on Escape once it is empty, the focus back on Merge into…', async () => {
    const opener = button('Merge into…');
    await click(opener);
    await type(field('Tag to merge into'), 'ly');
    await press(field('Tag to merge into'), 'Escape');
    expect(field('Tag to merge into').value).toBe('');

    await press(field('Tag to merge into'), 'Escape');
    expect(field('Tag to merge into')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(closed).toBe(0);
  });

  it('says when the tag no longer exists, and offers to close', async () => {
    worker.respond('addTagParent', () => refused({ kind: 'gone' }));
    library.delete(PARIS.id);
    await type(field('Add a parent tag'), 'France');
    await press(field('Add a parent tag'), 'Enter');
    expect(host.querySelector('.gone')?.textContent).toBe('This tag no longer exists.');
    expect(nameField()).toBeNull();
    // What had the focus went away.
    expect(document.activeElement).toBe(button('Close'));

    await click(button('Close'));
    expect(closed).toBe(1);
  });

  it('shows another tag when given its id, the focus in its name', async () => {
    fixture.componentRef.setInput('tagId', LYON.id);
    await render();
    expect(nameField().value).toBe('Lyon');
    expect(host.querySelector('.counts')?.textContent).toBe('3 files');
    expect(document.activeElement).toBe(nameField());
  });
});
