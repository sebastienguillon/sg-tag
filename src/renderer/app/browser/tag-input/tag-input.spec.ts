import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { Tag } from '@shared/model';
import { WorkerClient } from '../../core/worker-client';
import { FakeWorkerClient, settle } from '../../testing/fake-worker-client';
import { TagInput } from './tag-input';

const tag = (id: number, name: string, fileCount: number): Tag => ({
  id,
  name,
  aliases: [],
  parentIds: [],
  fileCount,
});

/** The tags of the library of these tests. */
const TAGS: readonly Tag[] = [
  tag(1, 'Japan', 5),
  tag(2, 'jazz', 9),
  tag(3, 'ninja', 1),
  tag(4, 'New York', 2),
];

describe('TagInput', () => {
  let fixture: ComponentFixture<TagInput>;
  let worker: FakeWorkerClient;
  let host: HTMLElement;
  let input: HTMLInputElement;
  /** The names the field asked to add, in order. */
  let added: string[];

  const render = async (): Promise<void> => {
    await settle();
    await fixture.whenStable();
  };
  /** Replaces what the field holds, as typing or pasting does. */
  const type = async (text: string): Promise<void> => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  /** Presses a key in the field, and answers the event: whether the field kept it for itself. */
  const press = async (key: string): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    await render();
    return event;
  };
  const suggested = (): string[] =>
    [...host.querySelectorAll('[role="option"] .name')].map((name) => name.textContent);
  /** The suggestion the field points to, for the eyes and for assistive technology alike. */
  const highlighted = (): string | null => {
    const option = host.querySelector('[role="option"][aria-selected="true"]');
    expect(input.getAttribute('aria-activedescendant')).toBe(option?.id ?? null);
    expect(option?.querySelector('button')?.classList.contains('active') ?? false).toBe(
      option !== null,
    );
    return option?.querySelector('.name')?.textContent ?? null;
  };
  /**
   * What the field says of a text that cannot be a tag, to the eyes and to assistive technology
   * alike; `null` when it says nothing.
   */
  const problem = (): string | null => {
    const line = host.querySelector('[role="alert"]');
    expect(input.getAttribute('aria-invalid')).toBe(line ? 'true' : null);
    expect(input.getAttribute('aria-describedby')).toBe(line?.id ?? null);
    return line?.textContent ?? null;
  };

  beforeEach(async () => {
    worker = new FakeWorkerClient();
    worker.respond('listTags', () => TAGS);
    TestBed.configureTestingModule({ providers: [{ provide: WorkerClient, useValue: worker }] });
    fixture = TestBed.createComponent(TagInput);
    host = fixture.nativeElement as HTMLElement;
    added = [];
    fixture.componentInstance.add.subscribe((name) => {
      added.push(name);
    });
    await render();
    input = host.querySelector('input')!;
    input.focus();
    await render();
  });

  it('asks for a tag, and suggests nothing until something is typed', () => {
    expect(input.placeholder).toBe('Add a tag');
    expect(input.getAttribute('aria-label')).toBe('Add a tag');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('suggests the tags whose name holds what is typed, with how many files have each', async () => {
    await type('ja');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(host.querySelector('[role="listbox"]')?.id);
    expect(suggested()).toEqual(['jazz', 'Japan', 'ninja']);
    expect([...host.querySelectorAll('.count')].map((count) => count.textContent)).toEqual([
      '9',
      '5',
      '1',
    ]);
    expect(highlighted()).toBeNull();

    await type('xyz');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('moves through the suggestions with the arrows, round from either end', async () => {
    await type('ja');
    const down = await press('ArrowDown');
    // The caret stays where it is in the text.
    expect(down.defaultPrevented).toBe(true);
    expect(highlighted()).toBe('jazz');
    await press('ArrowDown');
    await press('ArrowDown');
    expect(highlighted()).toBe('ninja');
    await press('ArrowDown');
    expect(highlighted()).toBe('jazz');

    const up = await press('ArrowUp');
    expect(up.defaultPrevented).toBe(true);
    expect(highlighted()).toBe('ninja');
    await press('ArrowUp');
    expect(highlighted()).toBe('Japan');
  });

  it('starts from the last suggestion on ↑, and from none again once the text changes', async () => {
    await type('ja');
    await press('ArrowUp');
    expect(highlighted()).toBe('ninja');

    await type('jap');
    expect(suggested()).toEqual(['Japan']);
    expect(highlighted()).toBeNull();
  });

  it('leaves the arrows to the text when nothing is suggested', async () => {
    await type('xyz');
    expect((await press('ArrowDown')).defaultPrevented).toBe(false);
    expect((await press('ArrowUp')).defaultPrevented).toBe(false);
  });

  it('adds the highlighted suggestion on Enter, and empties the field', async () => {
    await type('ja');
    await press('ArrowDown');
    await press('ArrowDown');
    const enter = await press('Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(added).toEqual(['Japan']);
    expect(input.value).toBe('');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('adds what is typed on Enter when no suggestion is highlighted, without the spaces around it', async () => {
    await type('  jap ');
    expect(suggested()).toEqual(['Japan']);
    await press('Enter');
    expect(added).toEqual(['jap']);
    expect(input.value).toBe('');
  });

  it('adds a name as a tag stores it: composed, its spaces collapsed', async () => {
    await type('Rio  de   Janeiro');
    await press('Enter');
    // Typed with combining accents, as some keyboards do.
    await type('E\u0301te\u0301');
    await press('Enter');
    expect(added).toEqual(['Rio de Janeiro', '\u00C9t\u00E9']);
  });

  it('suggests a tag whatever characters nobody sees are typed or stored, and adds it by its name', async () => {
    // Stored as pasted from a web page, with a zero-width space after it.
    worker.respond('listTags', () => [...TAGS, tag(5, 'Paris\u200B', 3)]);
    worker.emit('tagsChanged', null);
    await type('paris');
    expect(suggested()).toEqual(['Paris\u200B']);
    await press('ArrowDown');
    await press('Enter');

    // The other way round: typed with a soft hyphen, stored without.
    await type('Ja\u00ADpan');
    expect(suggested()).toEqual(['Japan']);
    await press('ArrowDown');
    await press(',');
    // The tag there is, by its name as stored: no second tag is asked for, made of what was typed.
    expect(added).toEqual(['Paris\u200B', 'Japan']);
    expect(input.value).toBe('');

    // Once every selected file has it, it is suggested no more, under either spelling.
    fixture.componentRef.setInput('exclude', new Set([5]));
    await type('Pa\u00ADris');
    expect(suggested()).toEqual([]);
  });

  it('adds on a comma as on Enter, and keeps the comma out of the field', async () => {
    await type('New');
    const comma = await press(',');
    expect(comma.defaultPrevented).toBe(true);
    expect(added).toEqual(['New']);
    expect(input.value).toBe('');

    await type('ne');
    await press('ArrowDown');
    await press(',');
    expect(added).toEqual(['New', 'New York']);
  });

  it('adds nothing when only spaces are typed', async () => {
    await press('Enter');
    await type('   ');
    await press('Enter');
    await press(',');
    expect(added).toEqual([]);
    expect(input.value).toBe('');
  });

  it('keeps a text that cannot be the name of a tag, and says why under the field', async () => {
    // Pasted: a comma typed would have added what comes before it.
    await type('Paris, France');
    expect(problem()).toBeNull();
    const enter = await press('Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(added).toEqual([]);
    expect(input.value).toBe('Paris, France');
    expect(problem()).toBe('A tag cannot contain a comma: commas separate tags.');
    expect(document.activeElement).toBe(input);

    // Corrected where it stands, it is added.
    await type('Paris');
    expect(problem()).toBeNull();
    await press('Enter');
    expect(added).toEqual(['Paris']);
    expect(input.value).toBe('');
    expect(problem()).toBeNull();
  });

  it('says what is wrong with each text that cannot be a tag, on Enter or on a comma', async () => {
    const refused: [text: string, sentence: string][] = [
      ['say "cheese"', 'A tag cannot contain a double quote.'],
      ['=France', 'A tag cannot start with “=”.'],
      ['x'.repeat(1_025), 'A tag cannot be longer than 1,024 characters.'],
      // Nothing to see, though not nothing: a zero-width space, as a text copied from a web page
      // may hold, and an accent alone.
      ['\u200B', 'A tag needs a name.'],
      ['\u0301', 'A tag needs a name.'],
    ];
    for (const [text, sentence] of refused) {
      for (const key of ['Enter', ',']) {
        await type('');
        await type(text);
        await press(key);
        expect(problem(), `${JSON.stringify(text)} then ${key}`).toBe(sentence);
        expect(input.value).toBe(text);
      }
    }
    expect(added).toEqual([]);
  });

  it('takes back what it said as soon as the text changes, and on Escape', async () => {
    await type('=France');
    await press('Enter');
    expect(problem()).toBe('A tag cannot start with “=”.');
    await type('=Franc');
    expect(problem()).toBeNull();

    await press('Enter');
    expect(problem()).toBe('A tag cannot start with “=”.');
    const escape = await press('Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(input.value).toBe('');
    expect(problem()).toBeNull();
    expect(added).toEqual([]);
  });

  it('adds the suggestion clicked under a text that cannot be a tag', async () => {
    // No tag can be named `=ja`, and one holds it.
    worker.respond('listTags', () => [...TAGS, tag(5, 'a=jazz', 3)]);
    worker.emit('tagsChanged', null);
    await type('=ja');
    await press('Enter');
    expect(problem()).toBe('A tag cannot start with “=”.');
    expect(suggested()).toEqual(['a=jazz']);

    host.querySelector<HTMLButtonElement>('[role="option"] button')?.click();
    await render();
    expect(added).toEqual(['a=jazz']);
    expect(input.value).toBe('');
    expect(problem()).toBeNull();
  });

  it('keeps the highlight on its tag when the suggestions are worked out again without typing', async () => {
    await type('ja');
    await press('ArrowDown');
    await press('ArrowDown');
    expect(highlighted()).toBe('Japan');

    // The details panel hands over a new set of tags to leave out each time it reloads, when a
    // thumbnail is made for the selected file for instance.
    fixture.componentRef.setInput('exclude', new Set<number>());
    await render();
    expect(highlighted()).toBe('Japan');

    // A tag made meanwhile comes first in the list: the highlight goes down with its tag.
    worker.respond('listTags', () => [...TAGS, tag(5, 'java', 20)]);
    worker.emit('tagsChanged', null);
    await render();
    expect(suggested()).toEqual(['java', 'jazz', 'Japan', 'ninja']);
    expect(highlighted()).toBe('Japan');

    // The tag chosen, not the letters typed.
    await press('Enter');
    expect(added).toEqual(['Japan']);
  });

  it('drops the highlight when its tag is no longer suggested: Enter adds what is typed', async () => {
    await type('ja');
    await press('ArrowDown');
    expect(highlighted()).toBe('jazz');

    // Given meanwhile to every selected file.
    fixture.componentRef.setInput('exclude', new Set([2]));
    await render();
    expect(suggested()).toEqual(['Japan', 'ninja']);
    expect(highlighted()).toBeNull();

    await press('Enter');
    expect(added).toEqual(['ja']);
  });

  it('drops the highlight when the text changes, though its tag is still suggested', async () => {
    await type('ja');
    await press('ArrowDown');
    await press('ArrowDown');
    expect(highlighted()).toBe('Japan');

    await type('jap');
    expect(suggested()).toEqual(['Japan']);
    expect(highlighted()).toBeNull();
    await press('Enter');
    expect(added).toEqual(['jap']);
  });

  it('leaves Tab alone, so that it moves the focus on: nothing is completed or added', async () => {
    await type('ja');
    const plain = await press('Tab');
    expect(plain.defaultPrevented).toBe(false);
    expect(input.value).toBe('ja');

    await press('ArrowDown');
    const onSuggestion = await press('Tab');
    expect(onSuggestion.defaultPrevented).toBe(false);
    expect(input.value).toBe('ja');
    expect(added).toEqual([]);
  });

  it('empties the field on Escape, and lets Escape through only once it is empty', async () => {
    // How many times the key is heard outside the field.
    let escapes = 0;
    const countEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        escapes++;
      }
    };
    document.addEventListener('keydown', countEscape);
    onTestFinished(() => {
      document.removeEventListener('keydown', countEscape);
    });

    await type('ja');
    await press('ArrowDown');
    const first = await press('Escape');
    expect(first.defaultPrevented).toBe(true);
    expect(escapes).toBe(0);
    expect(input.value).toBe('');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(added).toEqual([]);

    const second = await press('Escape');
    expect(second.defaultPrevented).toBe(false);
    expect(escapes).toBe(1);
  });

  it('leaves out of the suggestions the tags whose id it is given', async () => {
    fixture.componentRef.setInput('exclude', new Set([2]));
    await type('ja');
    expect(suggested()).toEqual(['Japan', 'ninja']);

    // Left out, a tag can still be typed in full and added.
    await type('jazz');
    expect(suggested()).toEqual([]);
    await press('Enter');
    expect(added).toEqual(['jazz']);
  });

  it('adds the suggestion clicked, without taking the focus from the field', async () => {
    await type('ja');
    const japan = [...host.querySelectorAll<HTMLButtonElement>('[role="option"] button')][1];
    // Pressing the mouse on a button would move the focus to it, and close the suggestions.
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    japan?.dispatchEvent(mousedown);
    expect(mousedown.defaultPrevented).toBe(true);
    japan?.click();
    await render();
    expect(added).toEqual(['Japan']);
    expect(input.value).toBe('');
  });

  it('closes the suggestions when the field loses the focus, and shows them again when it is back', async () => {
    await type('ja');
    input.blur();
    await render();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[role="listbox"]')).toBeNull();

    fixture.componentInstance.focus();
    await render();
    expect(document.activeElement).toBe(input);
    expect(suggested()).toEqual(['jazz', 'Japan', 'ninja']);
  });
});
