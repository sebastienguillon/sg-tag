import { formatNumber } from '@angular/common';
import type { TagDetails, TagEditError, TagMergePreview, TagRef } from '@shared/model';
import { describeTagNameProblem, MAX_TAG_ALIASES, MAX_TAG_PARENTS } from '@shared/tag-names';
import { quote } from '../../ui/format/quote';

/** Names listed in full in a sentence, at most; past that, the first ones and how many others. */
const LISTED_NAMES = 5;

/** `1 file`, `3,410 files`: the number as the `number` pipe writes it. */
export function counted(count: number, one: string, many: string, locale: string): string {
  return `${formatNumber(count, locale)} ${count === 1 ? one : many}`;
}

/** `A`, `A and B`, `A, B and C`; past five names, `A, B, C, D and 7 others`. */
export function nameList(names: readonly string[], locale: string): string {
  if (names.length > LISTED_NAMES) {
    const others = names.length - (LISTED_NAMES - 1);
    return `${names.slice(0, LISTED_NAMES - 1).join(', ')} and ${formatNumber(others, locale)} others`;
  }
  const last = names.at(-1) ?? '';
  return names.length < 2 ? last : `${names.slice(0, -1).join(', ')} and ${last}`;
}

/**
 * Why a change to a tag was refused, as a sentence to show next to the field it came from. `typed`
 * is the name typed, quoted when another tag has it (`taken`).
 *
 * A `loop` is worded from the tag below, so that it reads true from either side: `France is below
 * Paris` says why France cannot be a parent tag of Paris, and why Paris cannot be a child tag of
 * France.
 */
export function describeTagEditError(
  error: TagEditError,
  typed: string | null,
  locale: string,
): string {
  switch (error.kind) {
    case 'gone':
      return 'This tag no longer exists.';
    case 'busy':
      return 'Tags are being exported or imported: try again once that is done.';
    case 'invalid':
      return describeTagNameProblem(error.problem);
    case 'taken':
      return `“${quote(typed ?? error.owner.name)}” is already ${error.asAlias ? 'an alias' : 'the name'} of the tag ${quote(error.owner.name)}.`;
    case 'loop': {
      if (error.above.id === error.below.id) {
        return 'A tag cannot be below itself.';
      }
      const loop = `${quote(error.below.name)} is below ${quote(error.above.name)}`;
      return error.through === null ? `${loop}.` : `${loop}, through ${quote(error.through.name)}.`;
    }
    case 'limit':
      return error.what === 'aliases'
        ? `A tag cannot have more than ${formatNumber(MAX_TAG_ALIASES, locale)} aliases.`
        : `A tag cannot have more than ${formatNumber(MAX_TAG_PARENTS, locale)} parent tags.`;
  }
}

/**
 * Why deleting a tag was refused. A `limit` is that of one of its child tags, which would get the
 * parent tags of the deleted tag on top of its own.
 */
export function describeDeleteError(error: TagEditError, locale: string): string {
  return error.kind === 'limit'
    ? `This tag cannot be deleted: one of its child tags would then have more than ${formatNumber(MAX_TAG_PARENTS, locale)} parent tags.`
    : describeTagEditError(error, null, locale);
}

/**
 * What deleting the tag of `details` does, asked as one paragraph: the files that lose it, and
 * those forgotten with it; its aliases; and its child tags, which move up to its parent tags so
 * that these still find their files.
 *
 * Built here rather than in the template: each part may be missing, and its grammar depends on the
 * numbers.
 */
export function deleteQuestion(details: TagDetails, locale: string): string {
  const { tag, children, parents, taggedFiles, forgottenFiles } = details;
  const sentences = [`Delete the tag “${quote(tag.name)}”?`];

  if (taggedFiles === 0) {
    sentences.push('No file has it.');
  } else {
    const lose = `${counted(taggedFiles, 'file loses', 'files lose', locale)} it`;
    if (forgottenFiles === 0) {
      sentences.push(`${lose}.`);
    } else if (forgottenFiles === taggedFiles) {
      const all = taggedFiles === 1 ? 'it is' : 'they are all';
      sentences.push(`${lose}; ${all} missing from disk and will be forgotten.`);
    } else {
      const some = `${formatNumber(forgottenFiles, locale)} of them ${forgottenFiles === 1 ? 'is' : 'are'}`;
      sentences.push(`${lose}; ${some} missing from disk and will be forgotten.`);
    }
  }

  if (tag.aliases.length > 0) {
    const one = tag.aliases.length === 1;
    const aliases = nameList(tag.aliases, locale);
    sentences.push(`Its ${one ? 'alias' : 'aliases'} ${aliases} ${one ? 'goes' : 'go'} too.`);
  }

  if (children.length > 0) {
    const one = children.length === 1;
    const childTags = `Its ${one ? 'child tag' : 'child tags'} ${refList(children, locale)}`;
    if (parents.length === 0) {
      sentences.push(`${childTags} ${one ? 'becomes a tag' : 'become tags'} without a parent.`);
    } else {
      const parentTags = refList(parents, locale);
      const find = parents.length === 1 ? 'finds' : 'find';
      sentences.push(
        `${childTags} ${one ? 'moves' : 'move'} up to ${parentTags}, so that ${parentTags} still ${find} ${one ? 'its' : 'their'} files.`,
      );
    }
  }

  sentences.push('This cannot be undone.');
  return sentences.join(' ');
}

/** What the tag merged away brings to the tag kept, read from the list of tags. */
export interface MergedTag {
  readonly aliases: number;
  readonly parents: number;
  readonly children: number;
}

/**
 * The question that confirms merging `preview.from` into `preview.into`: the files that gain the
 * tag kept, and what becomes of the names and the parent and child tags of the tag merged away.
 * When the merge would be refused, why, and no question.
 */
export function mergeQuestion(preview: TagMergePreview, merged: MergedTag, locale: string): string {
  const from = quote(preview.from.name);
  const into = quote(preview.into.name);
  if (preview.refusal !== null) {
    return `${from} cannot be merged into ${into}. ${describeTagEditError(preview.refusal, null, locale)}`;
  }
  const sentences = [`Merge “${from}” into “${into}”?`];

  const gain =
    preview.filesMoved === 0
      ? `No file gains ${into}`
      : `${counted(preview.filesMoved, 'file gains', 'files gain', locale)} ${into}`;
  sentences.push(
    preview.filesWithBoth === 0
      ? `${gain}.`
      : `${gain} (${formatNumber(preview.filesWithBoth, locale)} had both).`,
  );

  const names =
    merged.aliases === 0
      ? `${from} becomes an alias of ${into}`
      : `${from} and its aliases become aliases of ${into}`;
  const related = [
    ...(merged.parents > 0 ? ['parent'] : []),
    ...(merged.children > 0 ? ['child'] : []),
  ];
  sentences.push(
    related.length === 0
      ? `${names}.`
      : `${names}, and its ${related.join(' and ')} tags become those of ${into}.`,
  );

  sentences.push('This cannot be undone.');
  return sentences.join(' ');
}

function refList(refs: readonly TagRef[], locale: string): string {
  return nameList(
    refs.map((ref) => quote(ref.name)),
    locale,
  );
}
