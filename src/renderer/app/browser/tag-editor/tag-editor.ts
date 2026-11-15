import { formatNumber } from '@angular/common';
import {
  afterNextRender,
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  inject,
  Injector,
  linkedSignal,
  LOCALE_ID,
  model,
  output,
  resource,
  signal,
  viewChild,
} from '@angular/core';
import { createLogger } from '@shared/log';
import type { TagDetails, TagEditError, TagEditResult, TagRef } from '@shared/model';
import { describeTagNameProblem, normalizeTagName, tagKey, tagTerm } from '@shared/tag-names';
import { ipcErrorMessage } from '../../core/desktop';
import { TagsStore } from '../../core/tags-store';
import { WorkerClient } from '../../core/worker-client';
import { Icon } from '../../ui/icon/icon';
import { TagInput } from '../tag-input/tag-input';
import {
  counted,
  deleteQuestion,
  describeDeleteError,
  describeTagEditError,
  mergeQuestion,
} from './tag-edit-words';

const log = createLogger('tag-editor');

let nextId = 0;

/** A field of the editor, next to which the refusal of a change made from it is shown. */
type Field = 'name' | 'parents' | 'children' | 'aliases';

/** Why a change made from a field was not made. */
interface Refusal {
  readonly message: string;
  /** The tag that has the name typed, offered to be merged into the tag edited. */
  readonly mergeFrom: TagRef | null;
}

type Refusals = Readonly<Record<Field, Refusal | null>>;

const NO_REFUSALS: Refusals = { name: null, parents: null, children: null, aliases: null };

/** A refusal of a change, as the worker answers it. */
interface Refused {
  readonly ok: false;
  readonly error: TagEditError;
}

/** The change waiting to be confirmed. */
type Confirmation =
  | { readonly kind: 'delete' }
  | { readonly kind: 'merge'; readonly from: TagRef; readonly into: TagRef };

/**
 * Edits one tag: its name, parent tags, child tags and aliases, each change applied at once, and
 * deletes it or merges it into another. Knows nothing of the files selected: it shows in the
 * details panel, and is meant for the tags page as well.
 *
 * Escape closes it (`closed`), unless a field or a confirmation takes the key first: a field
 * holding text empties, a name being changed goes back, a confirmation is cancelled. The host puts
 * the focus back where it was before the editor opened.
 */
@Component({
  selector: 'app-tag-editor',
  imports: [Icon, TagInput],
  templateUrl: './tag-editor.html',
  styleUrl: './tag-editor.css',
  host: { '(keydown.escape)': 'onEscape($event)' },
})
export class TagEditor {
  private readonly worker = inject(WorkerClient);
  private readonly tags = inject(TagsStore);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The tag edited. The editor sets it when that tag is merged into another: it follows it. */
  readonly tagId = model.required<number>();
  /** Escape or Close: the host takes the editor away. */
  readonly closed = output();
  /**
   * The tag was deleted: the host takes the editor away. What opened it, such as the chip of the
   * tag, may go with the tag.
   */
  readonly deleted = output();
  /** The search for a parent or child tag clicked: `tag:France`. */
  readonly searchRequested = output<string>();

  private readonly nameField = viewChild<ElementRef<HTMLInputElement>>('nameField');
  private readonly parentPicker = viewChild<TagInput>('parentPicker');
  private readonly childPicker = viewChild<TagInput>('childPicker');
  private readonly aliasField = viewChild<ElementRef<HTMLInputElement>>('aliasField');
  private readonly mergePicker = viewChild<TagInput>('mergePicker');
  private readonly mergeArea = viewChild<ElementRef<HTMLElement>>('mergeArea');
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');
  private readonly goneCloseButton = viewChild<ElementRef<HTMLButtonElement>>('goneClose');

  private readonly id = nextId++;
  protected readonly titleId = `tag-editor-title-${this.id}`;
  protected readonly questionId = `tag-editor-question-${this.id}`;
  protected readonly nameRefusalId = `tag-editor-name-refusal-${this.id}`;
  protected readonly aliasRefusalId = `tag-editor-alias-refusal-${this.id}`;
  /** Bumped to read the tag again: after a change, or a refusal saying it is gone. */
  private readonly revision = signal(0);
  /** Bumped to ask for the focus in the name field once the tag is shown. */
  private readonly focusRequests = signal(0);
  /** The request and the tag the name field last took the focus for. */
  private focused = { request: -1, tagId: Number.NaN };

  private readonly details = resource({
    params: () => ({
      id: this.tagId(),
      revision: this.revision(),
      connection: this.worker.generation(),
    }),
    loader: ({ params }) => this.worker.call('getTagDetails', params.id),
  });
  /**
   * The tag on display: `null` once it no longer exists. While it is read again after a change, it
   * stays up as it was: the editor does not blink, and the field being typed in stays.
   */
  protected readonly shown = linkedSignal<
    { id: number; details: TagDetails | null | undefined },
    TagDetails | null | undefined
  >({
    source: () => ({
      id: this.tagId(),
      details: this.details.hasValue() ? this.details.value() : undefined,
    }),
    computation: ({ id, details }, previous) => {
      const kept = previous?.value;
      return details === undefined && kept?.tag.id === id ? kept : details;
    },
  });
  protected readonly tag = computed(() => this.shown()?.tag ?? null);
  /** Deleted or merged into another tag, from here or elsewhere. */
  protected readonly gone = computed(() => this.shown() === null);
  private readonly name = computed(() => this.tag()?.name ?? '');

  /** The text of the name field: the tag's name, again each time the name changes. */
  protected readonly nameText = linkedSignal(() => this.name());
  protected readonly keepOldName = linkedSignal({ source: this.name, computation: () => false });
  /**
   * The name field holds another name than the tag's own and its aliases: keeping the old name as
   * an alias means something. A change of letter case only is the same name, and an alias becomes
   * the name and the name an alias anyway.
   */
  protected readonly renaming = computed(() => {
    const tag = this.tag();
    const check = normalizeTagName(this.nameText());
    if (!tag || !check.ok) {
      return false;
    }
    const key = tagKey(check.name);
    return [tag.name, ...tag.aliases].every((name) => tagKey(name) !== key);
  });
  protected readonly aliasText = linkedSignal({ source: this.tagId, computation: () => '' });
  /** What each field was refused, said next to it until the next change made from it. */
  protected readonly refusals = linkedSignal<number, Refusals>({
    source: this.tagId,
    computation: () => NO_REFUSALS,
  });

  /** `12 files · 40 with the 3 tags below it`. */
  protected readonly counts = computed(() => {
    const details = this.shown();
    if (!details) {
      return '';
    }
    const own = counted(details.ownFiles, 'file', 'files', this.locale);
    if (details.tagsBelow === 0) {
      return own;
    }
    const below =
      details.tagsBelow === 1
        ? 'the tag'
        : `the ${counted(details.tagsBelow, 'tag', 'tags', this.locale)}`;
    return `${own} · ${formatNumber(details.filesWithBelow, this.locale)} with ${below} below it`;
  });
  /** The parent tags it has already are not offered; itself and the tags below it cannot be. */
  protected readonly parentIds = computed(
    () => new Set(this.shown()?.parents.map((parent) => parent.id)),
  );
  protected readonly parentRefusals = computed(() => {
    const tag = this.tag();
    return tag
      ? this.reasons(tag, this.tags.below(tag.id), `is below ${tag.name}`)
      : new Map<number, string>();
  });
  /** The child tags it has already are not offered; itself and the tags above it cannot be. */
  protected readonly childIds = computed(
    () => new Set(this.shown()?.children.map((child) => child.id)),
  );
  protected readonly childRefusals = computed(() => {
    const tag = this.tag();
    return tag
      ? this.reasons(tag, this.tags.above(tag.id), `is above ${tag.name}`)
      : new Map<number, string>();
  });
  protected readonly mergeRefusals = computed(() => {
    const tag = this.tag();
    return tag ? this.reasons(tag, [], '') : new Map<number, string>();
  });

  /** Merge into…: the field that asks for the tag to merge this one into. */
  protected readonly pickingMerge = linkedSignal({
    source: this.tagId,
    computation: () => false,
  });
  protected readonly confirmation = linkedSignal<number, Confirmation | null>({
    source: this.tagId,
    computation: () => null,
  });
  /** Why the change confirmed was not made: said in the confirmation, which stays. */
  protected readonly confirmError = linkedSignal<Confirmation | null, string | null>({
    source: this.confirmation,
    computation: () => null,
  });
  /** The change confirmed is on its way: the confirmation waits for its answer. */
  protected readonly confirming = signal(false);
  /** The button that asked for the confirmation, or for the merge field: the focus goes back to it. */
  private confirmOpener: HTMLElement | null = null;
  private mergeOpener: HTMLElement | null = null;

  private readonly mergePair = computed(() => {
    const confirmation = this.confirmation();
    return confirmation?.kind === 'merge' ? confirmation : undefined;
  });
  private readonly mergePreview = resource({
    params: () => this.mergePair(),
    loader: ({ params }) => this.worker.call('getMergePreview', params.from.id, params.into.id),
  });
  /** `undefined` while the numbers are read. */
  protected readonly mergeText = computed(() => {
    if (!this.mergePreview.hasValue()) {
      return undefined;
    }
    const preview = this.mergePreview.value();
    if (preview === null) {
      return { question: 'One of the two tags no longer exists.', allowed: false };
    }
    const merged = this.tags.byId().get(preview.from.id);
    const counts = {
      aliases: merged?.aliases.length ?? 0,
      parents: merged?.parentIds.length ?? 0,
      children: this.tags.below(preview.from.id).length,
    };
    return {
      question: mergeQuestion(preview, counts, this.locale),
      allowed: preview.refusal === null,
    };
  });
  protected readonly deleteText = computed(() => {
    const details = this.shown();
    return details ? deleteQuestion(details, this.locale) : '';
  });

  constructor() {
    const unsubscribe = this.worker.on('tagsChanged', () => {
      this.revision.update((value) => value + 1);
    });
    inject(DestroyRef).onDestroy(unsubscribe);

    // The name field takes the focus each time another tag is shown, and when asked to (`focus`),
    // once the tag is read: on opening, the field is not there yet.
    afterRenderEffect({
      write: () => {
        const request = this.focusRequests();
        const id = this.tagId();
        const field = this.nameField();
        if (!field || this.shown()?.tag.id !== id) {
          return;
        }
        if (request !== this.focused.request || id !== this.focused.tagId) {
          this.focused = { request, tagId: id };
          field.nativeElement.focus();
        }
      },
    });
    // Once the tag is gone, Close takes the focus if the editor had it: what had it went away.
    afterRenderEffect({
      write: () => {
        const close = this.goneCloseButton();
        if (close) {
          this.keepFocusIn(close.nativeElement);
        }
      },
    });
  }

  /** Puts the focus in the name field, once the tag is shown. */
  focus(): void {
    this.focusRequests.update((value) => value + 1);
  }

  protected onEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    // In the empty merge field: the field goes, and the focus goes back to Merge into….
    const target = event.target instanceof Node ? event.target : null;
    if (this.mergeArea()?.nativeElement.contains(target) === true) {
      this.pickingMerge.set(false);
      this.mergeOpener?.focus();
      return;
    }
    this.closed.emit();
  }

  protected close(): void {
    this.closed.emit();
  }

  /** The search that lists the files of a tag, and of the tags below it. */
  protected tagSearch(tag: TagRef): string {
    return tagTerm(tag.name);
  }

  protected searchTag(tag: TagRef): void {
    this.searchRequested.emit(this.tagSearch(tag));
  }

  protected onNameInput(event: Event): void {
    this.nameText.set((event.target as HTMLInputElement).value);
    this.refuse('name', null);
  }

  protected onNameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.rename();
    } else if (event.key === 'Escape' && this.nameText() !== this.name()) {
      // The name goes back to what it is; a second Escape closes the editor.
      event.preventDefault();
      event.stopPropagation();
      this.nameText.set(this.name());
      this.refuse('name', null);
    }
  }

  protected setKeepOldName(event: Event): void {
    this.keepOldName.set((event.target as HTMLInputElement).checked);
  }

  private async rename(): Promise<void> {
    const tag = this.tag();
    if (!tag) {
      return;
    }
    const check = normalizeTagName(this.nameText());
    if (!check.ok) {
      this.refuse('name', { message: describeTagNameProblem(check.problem), mergeFrom: null });
      return;
    }
    if (check.name === tag.name) {
      return;
    }
    const keep = this.renaming() && this.keepOldName();
    await this.apply('name', check.name, (id) =>
      this.worker.call('renameTag', id, check.name, keep),
    );
  }

  protected addParent(name: string): void {
    void this.apply('parents', null, (id) => this.worker.call('addTagParent', id, name));
  }

  protected removeParent(parent: TagRef): void {
    // The chip goes with its button: the focus goes to the field above them.
    this.parentPicker()?.focus();
    void this.apply('parents', null, (id) => this.worker.call('removeTagParent', id, parent.id));
  }

  protected addChild(name: string): void {
    void this.apply('children', null, (id) => this.worker.call('addTagChild', id, name));
  }

  protected removeChild(child: TagRef): void {
    this.childPicker()?.focus();
    void this.apply('children', null, (id) => this.worker.call('removeTagParent', child.id, id));
  }

  protected onAliasInput(event: Event): void {
    this.aliasText.set((event.target as HTMLInputElement).value);
    this.refuse('aliases', null);
  }

  protected onAliasKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.addAlias();
    } else if (event.key === 'Escape' && this.aliasText() !== '') {
      event.preventDefault();
      event.stopPropagation();
      this.aliasText.set('');
      this.refuse('aliases', null);
    }
  }

  private async addAlias(): Promise<void> {
    const typed = this.aliasText();
    // Nothing typed is no name to refuse: the field loses its spaces, without a word.
    if (typed.trim() === '') {
      this.aliasText.set('');
      return;
    }
    const check = normalizeTagName(typed);
    if (!check.ok) {
      // The text stays where it can be corrected.
      this.refuse('aliases', { message: describeTagNameProblem(check.problem), mergeFrom: null });
      return;
    }
    const added = await this.apply('aliases', check.name, (id) =>
      this.worker.call('addTagAlias', id, check.name),
    );
    if (added && this.aliasText() === typed) {
      this.aliasText.set('');
    }
  }

  protected removeAlias(alias: string): void {
    this.aliasField()?.nativeElement.focus();
    void this.apply('aliases', null, (id) => this.worker.call('removeTagAlias', id, alias));
  }

  protected toggleMergePicker(opener: HTMLElement): void {
    this.confirmation.set(null);
    this.mergeOpener = opener;
    this.pickingMerge.update((picking) => !picking);
    if (this.pickingMerge()) {
      afterNextRender(
        () => {
          this.mergePicker()?.focus();
        },
        { injector: this.injector },
      );
    }
  }

  protected pickMergeTarget(name: string): void {
    const tag = this.tag();
    const into = this.tags.resolve(name);
    if (!tag || !into) {
      return;
    }
    this.ask({ kind: 'merge', from: tag, into }, this.mergeOpener);
  }

  /** Merges the tag that has the name typed into this one, once confirmed. */
  protected offerMerge(owner: TagRef, opener: HTMLElement): void {
    const tag = this.tag();
    if (tag) {
      this.ask({ kind: 'merge', from: owner, into: tag }, opener);
    }
  }

  protected askDelete(opener: HTMLElement): void {
    this.ask({ kind: 'delete' }, opener);
  }

  private ask(confirmation: Confirmation, opener: HTMLElement | null): void {
    // One question at a time: the merge field goes, as when its tag is chosen.
    this.pickingMerge.set(false);
    this.confirmation.set(confirmation);
    this.confirmOpener = opener;
    // Cancel is the safe default for a change that cannot be undone.
    afterNextRender(
      () => {
        this.cancelButton()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  /** Cancel or Escape: nothing changes, and the focus goes back where it was. */
  protected cancel(): void {
    // Once under way, the change happens anyway: closing would say otherwise.
    if (this.confirming()) {
      return;
    }
    this.confirmation.set(null);
    this.confirmOpener?.focus();
  }

  protected onConfirmEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  }

  protected async deleteTag(): Promise<void> {
    const id = this.tagId();
    const deleted = await this.confirm(
      () => this.worker.call('deleteTag', id),
      (error) => describeDeleteError(error, this.locale),
    );
    if (deleted && this.tagId() === id) {
      this.deleted.emit();
    }
  }

  protected async merge(): Promise<void> {
    const pair = this.mergePair();
    if (!pair) {
      return;
    }
    const merged = await this.confirm(
      () => this.worker.call('mergeTags', pair.from.id, pair.into.id),
      (error) => describeTagEditError(error, null, this.locale),
    );
    if (!merged) {
      return;
    }
    // What was refused may have been the name of the tag merged in: that is settled now.
    this.refusals.set(NO_REFUSALS);
    this.confirmation.set(null);
    if (this.tagId() === pair.from.id) {
      // The tag edited went into the other one: the editor shows the tag kept.
      this.tagId.set(merged.tag.id);
    }
    // The confirmation that had the focus went.
    this.focus();
  }

  /**
   * Makes the change confirmed, and answers it once made; says why in the confirmation when it is
   * refused, and answers `null`.
   */
  private async confirm<T extends { readonly ok: true }>(
    change: () => Promise<T | Refused>,
    describe: (error: TagEditError) => string,
  ): Promise<T | null> {
    const id = this.tagId();
    this.confirming.set(true);
    this.confirmError.set(null);
    try {
      const result = await change();
      if (result.ok) {
        return result;
      }
      if (this.tagId() === id) {
        this.confirmError.set(describe(result.error));
        this.readAgainIfGone(result.error);
      }
    } catch (error) {
      log.error('Cannot change tag:', error);
      if (this.tagId() === id) {
        this.confirmError.set(`The change could not be made: ${ipcErrorMessage(error)}`);
      }
    } finally {
      this.confirming.set(false);
    }
    // Making the change disabled the button that had the focus, and Cancel until the answer came.
    afterNextRender(
      () => {
        this.keepFocusIn(this.cancelButton()?.nativeElement ?? this.host.nativeElement);
      },
      { injector: this.injector },
    );
    return null;
  }

  /**
   * Makes a change to the tag shown, from `field`; says next to it why the change was refused.
   * `typed` is the name typed in it, for a sentence that quotes it. Answers whether it was made.
   */
  private async apply(
    field: Field,
    typed: string | null,
    change: (id: number) => Promise<TagEditResult>,
  ): Promise<boolean> {
    const id = this.tagId();
    this.refuse(field, null);
    let result: TagEditResult;
    try {
      result = await change(id);
    } catch (error) {
      log.error('Cannot edit tag:', error);
      if (this.tagId() === id) {
        const message = `The change could not be made: ${ipcErrorMessage(error)}`;
        this.refuse(field, { message, mergeFrom: null });
      }
      return false;
    }
    // Another tag is shown now: what became of this change is not said of that one.
    if (this.tagId() !== id) {
      return false;
    }
    if (result.ok) {
      return true;
    }
    if (this.readAgainIfGone(result.error)) {
      return false;
    }
    const error = result.error;
    this.refuse(field, {
      message: describeTagEditError(error, typed, this.locale),
      mergeFrom: error.kind === 'taken' && error.owner.id !== id ? error.owner : null,
    });
    return false;
  }

  /**
   * After a refusal saying a tag is gone, reads the tag again: when it is the tag shown, the editor
   * says so in place of the fields; when it is another (a child tag removed meanwhile), the editor
   * shows what is left. Answers whether the refusal was `gone`.
   */
  private readAgainIfGone(error: TagEditError): boolean {
    if (error.kind !== 'gone') {
      return false;
    }
    this.revision.update((value) => value + 1);
    return true;
  }

  private refuse(field: Field, refusal: Refusal | null): void {
    this.refusals.update((refusals) => ({ ...refusals, [field]: refusal }));
  }

  /** `tag` itself, and each of `others` for `reason`: the tags a picker cannot take. */
  private reasons(
    tag: TagRef,
    others: readonly TagRef[],
    reason: string,
  ): ReadonlyMap<number, string> {
    return new Map([
      [tag.id, 'is this tag'],
      ...others.map((other): [number, string] => [other.id, reason]),
    ]);
  }

  /**
   * Gives the focus to `target`, unless the user put it elsewhere in the meantime: only when it was
   * in the editor, or went with what had it.
   */
  private keepFocusIn(target: HTMLElement): void {
    const active = this.document.activeElement;
    if (
      active === null ||
      active === this.document.body ||
      this.host.nativeElement.contains(active)
    ) {
      target.focus();
    }
  }
}
