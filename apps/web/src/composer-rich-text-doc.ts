import { Extension } from "@tiptap/core";
import { Mark, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Code } from "@tiptap/extension-code";
import { TaskItem } from "@tiptap/extension-task-item";

import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";
import { parseInlineMarkdown, RICH_TEXT_DELIMITERS, type RichTextMark } from "~/composer-rich-text";
import { collectInlineContextIds } from "~/lib/composerContextReferences";

/**
 * Pure document model for the rich text (Tiptap) composer.
 *
 * The stored prompt stays markdown (`**bold**`, `@file` chips as canonical
 * links). The Tiptap document holds styled text plus inline atom chips, so
 * this module translates both ways and maps cursor offsets between the three
 * coordinate spaces the composer speaks:
 *
 * - flat document offsets (styled markers excluded, chips count 1),
 * - collapsed cursor offsets (markers literal, chips count 1 — the coordinate
 *   the draft store and mention detection use),
 * - markdown offsets (markers literal, chips expand to their source).
 *
 * DOM-free on purpose: unit tests build a real ProseMirror document from the
 * JSON this produces and assert the round trip without a browser.
 */

export type SkillMeta = { label: string; description: string | null };

/** Outermost mark first, so closers mirror openers when nested. */
const MARK_NESTING_ORDER: RichTextMark[] = ["strike", "bold", "italic", "code"];

const MARK_TO_TIPTAP: Record<RichTextMark, string> = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  code: "code",
};

const TIPTAP_TO_MARK: Record<string, RichTextMark> = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  code: "code",
};

/**
 * Tiptap's code mark excludes every other mark, which rejects the `bold+code`
 * spans markdown like `**\`x\`**` parses into and drops the whole insert.
 * Code nests inside emphasis here, so it only excludes itself like the rest.
 */
export const ComposerCodeExtension = Code.extend({
  excludes: "code",
  // ArrowRight leaves code through the caret stops at styled edges, so the
  // stock exit (inserting a space at the end of a line) is not needed.
  exitable: false,
});

/**
 * Task list items keep their exact source indent in an attribute so nesting
 * round-trips byte-identically. Checkbox case (`[X]`) normalizes to `[x]` —
 * the same fixed-point deal as `__bold__` becoming `**bold**`.
 */
export const ComposerTaskItemExtension = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      indent: { default: "" },
      markerSpace: { default: " " },
      contentSpace: { default: null },
    };
  },
}).configure({ nested: true });

/**
 * Bullet and ordered list items keep their source layout the same way task
 * items do. The bullet character and the ordered delimiter live on the list
 * (a different one starts a new list, as in CommonMark). Ordered items keep
 * their literal number so lazy `1. 1. 1.` numbering round-trips; an item
 * split off with Enter has none and counts on from the previous sibling.
 */
export const ComposerListAttributesExtension = Extension.create({
  name: "composer-list-attributes",
  addGlobalAttributes() {
    return [
      {
        types: ["listItem"],
        attributes: {
          indent: { default: "", rendered: false },
          markerSpace: { default: " ", rendered: false },
          number: { default: null, rendered: false, keepOnSplit: false },
        },
      },
      { types: ["bulletList"], attributes: { bullet: { default: "-", rendered: false } } },
      { types: ["orderedList"], attributes: { delimiter: { default: ".", rendered: false } } },
    ];
  },
});

const LIST_NODE_NAMES = new Set(["taskList", "bulletList", "orderedList"]);

function randomNodeKey(): string {
  return `tiptap-${Math.random().toString(36).slice(2)}`;
}

interface TaskLinePrefix {
  indent: string;
  checked: boolean;
  markerSpace: string;
  contentSpace: string;
}

function parseTaskPrefix(head: string): { prefix: TaskLinePrefix; markerLength: number } | null {
  const match = head.match(/^([ \t]*)-([ \t]+)\[([ xX])\]([ \t]*)/);
  if (!match) return null;
  const after = head.slice(match[0].length);
  if (after.length > 0 && !match[4]) return null;
  return {
    prefix: {
      indent: match[1] ?? "",
      checked: (match[3] ?? " ").toLowerCase() === "x",
      markerSpace: match[2]!,
      contentSpace: match[4]!,
    },
    markerLength: match[0].length,
  };
}

type ListLinePrefix =
  | ({ kind: "task" } & TaskLinePrefix)
  | { kind: "bullet"; indent: string; bullet: string; markerSpace: string }
  | { kind: "ordered"; indent: string; number: string; delimiter: string; markerSpace: string };

function parseListPrefix(head: string): { prefix: ListLinePrefix; markerLength: number } | null {
  const task = parseTaskPrefix(head);
  if (task) return { prefix: { kind: "task", ...task.prefix }, markerLength: task.markerLength };
  const bullet = head.match(/^([ \t]*)([-*+])([ \t]+)/);
  if (bullet) {
    return {
      prefix: { kind: "bullet", indent: bullet[1]!, bullet: bullet[2]!, markerSpace: bullet[3]! },
      markerLength: bullet[0].length,
    };
  }
  const ordered = head.match(/^([ \t]*)(\d{1,9})([.)])([ \t]+)/);
  if (ordered) {
    return {
      prefix: {
        kind: "ordered",
        indent: ordered[1]!,
        number: ordered[2]!,
        delimiter: ordered[3]!,
        markerSpace: ordered[4]!,
      },
      markerLength: ordered[0].length,
    };
  }
  return null;
}

type InlineJson = Record<string, unknown>;

interface DocLine {
  list: ListLinePrefix | null;
  inline: InlineJson[];
}

function atomJsonForSegment(
  segment: Exclude<ReturnType<typeof splitPromptIntoComposerSegments>[number], { type: "text" }>,
  skillLabelFor: (name: string) => SkillMeta,
): InlineJson {
  if (segment.type === "mention") {
    return {
      type: "composer-mention",
      attrs: { path: segment.path, source: segment.source },
    };
  }
  if (segment.type === "skill") {
    const meta = skillLabelFor(segment.name);
    return {
      type: "composer-skill",
      attrs: {
        skillName: segment.name,
        skillLabel: meta.label,
        skillDescription: meta.description,
      },
    };
  }
  if (segment.type === "citation") {
    return {
      type: "composer-citation",
      attrs: { citation: segment.citation, source: segment.source, citeKey: randomNodeKey() },
    };
  }
  return {
    type: "composer-context-reference",
    attrs: {
      kind: segment.kind,
      contextId: segment.contextId,
      label: segment.label,
      source: segment.source,
    },
  };
}

interface PendingListItem {
  prefix: ListLinePrefix;
  content: InlineJson[];
  children: PendingList[];
}

interface PendingList {
  /** The first item's prefix decides the list's kind and marker. */
  prefix: ListLinePrefix;
  items: PendingListItem[];
}

function continuesList(list: PendingList, prefix: ListLinePrefix): boolean {
  const first = list.prefix;
  if (first.kind === "bullet") return prefix.kind === "bullet" && prefix.bullet === first.bullet;
  if (first.kind === "ordered") {
    return prefix.kind === "ordered" && prefix.delimiter === first.delimiter;
  }
  return prefix.kind === "task";
}

function appendListItem(lists: PendingList[], item: PendingListItem): void {
  const last = lists[lists.length - 1];
  if (last && continuesList(last, item.prefix)) last.items.push(item);
  else lists.push({ prefix: item.prefix, items: [item] });
}

function listItemJson(item: PendingListItem): InlineJson {
  const { prefix } = item;
  const content = [{ type: "paragraph", content: item.content }, ...item.children.map(listJson)];
  if (prefix.kind === "task") {
    return {
      type: "taskItem",
      attrs: {
        checked: prefix.checked,
        indent: prefix.indent,
        markerSpace: prefix.markerSpace,
        contentSpace: prefix.contentSpace,
      },
      content,
    };
  }
  return {
    type: "listItem",
    attrs: {
      indent: prefix.indent,
      markerSpace: prefix.markerSpace,
      number: prefix.kind === "ordered" ? prefix.number : null,
    },
    content,
  };
}

function listJson(list: PendingList): InlineJson {
  const { prefix } = list;
  const content = list.items.map(listItemJson);
  if (prefix.kind === "task") return { type: "taskList", content };
  if (prefix.kind === "bullet") {
    return { type: "bulletList", attrs: { bullet: prefix.bullet }, content };
  }
  return {
    type: "orderedList",
    attrs: { start: Number(prefix.number), delimiter: prefix.delimiter },
    content,
  };
}

function textJsonForSpan(text: string, marks: RichTextMark[]): Record<string, unknown> {
  const json: Record<string, unknown> = { type: "text", text };
  if (marks.length > 0) {
    json.marks = [...marks]
      .sort((a, b) => MARK_NESTING_ORDER.indexOf(a) - MARK_NESTING_ORDER.indexOf(b))
      .map((mark) => ({ type: MARK_TO_TIPTAP[mark] }));
  }
  return json;
}

export function buildTiptapContent(
  value: string,
  skillLabelFor: (name: string) => SkillMeta,
  options?: { styling?: boolean },
): Record<string, unknown>[] {
  const styling = options?.styling ?? true;
  // Hide token source from the markdown parser, then restore the atoms with
  // the marks of their surrounding text. Choose a sentinel absent from input.
  let sentinel = "\uFFFC";
  for (let codePoint = 0xe000; value.includes(sentinel); codePoint += 1) {
    sentinel = String.fromCodePoint(codePoint);
  }
  const atoms: InlineJson[] = [];
  const text = splitPromptIntoComposerSegments(value)
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      atoms.push(atomJsonForSegment(segment, skillLabelFor));
      return sentinel;
    })
    .join("");
  let atomIndex = 0;
  const lines: DocLine[] = text.split("\n").map((line) => {
    const parsed = styling ? parseListPrefix(line) : null;
    const content = parsed ? line.slice(parsed.markerLength) : line;
    const spans = styling ? parseInlineMarkdown(content) : [{ text: content, marks: [] }];
    const inline: InlineJson[] = [];
    for (const span of spans) {
      span.text.split(sentinel).forEach((piece, index) => {
        if (index > 0) {
          const atom = atoms[atomIndex++]!;
          inline.push({ ...atom, marks: textJsonForSpan("", span.marks).marks });
        }
        if (piece) inline.push(textJsonForSpan(piece, span.marks));
      });
    }
    return { list: parsed?.prefix ?? null, inline };
  });

  // Pass 2: consecutive list lines group into (possibly nested) lists by
  // indent prefix; everything else stays a paragraph.
  const blocks: Record<string, unknown>[] = [];
  let stack: { indent: string; lists: PendingList[] }[] = [];
  const flushLists = () => {
    if (stack.length > 0) {
      blocks.push(...stack[0]!.lists.map(listJson));
      stack = [];
    }
  };
  for (const line of lines) {
    if (!line.list) {
      flushLists();
      blocks.push({ type: "paragraph", content: line.inline });
      continue;
    }
    const item: PendingListItem = { prefix: line.list, content: line.inline, children: [] };
    const indent = item.prefix.indent;
    for (;;) {
      const top = stack[stack.length - 1];
      if (!top) {
        // A leading indented item with no parent flattens but keeps indent.
        stack.push({ indent, lists: [] });
        continue;
      }
      if (top.indent === indent) {
        appendListItem(top.lists, item);
        break;
      }
      if (top.indent !== "" && !indent.startsWith(top.indent)) {
        if (stack.length > 1) {
          stack.pop();
          continue;
        }
        top.indent = indent;
        appendListItem(top.lists, item);
        break;
      }
      const parent = top.lists.at(-1)?.items.at(-1);
      if (!parent) {
        appendListItem(top.lists, item);
        break;
      }
      appendListItem(parent.children, item);
      stack.push({ indent, lists: parent.children });
      break;
    }
  }
  flushLists();
  return blocks;
}

export function buildDocJson(
  value: string,
  skillLabelFor: (name: string) => SkillMeta,
  options?: { styling?: boolean },
) {
  return { type: "doc", content: buildTiptapContent(value, skillLabelFor, options) };
}

export interface RichRun {
  kind: "text" | "token" | "break" | "prefix";
  /** Flat document offset (atoms count 1, markers excluded). */
  flatStart: number;
  docLen: number;
  /** Collapsed cursor length (markers literal, tokens count 1). */
  collapsedLen: number;
  /** Markdown length (tokens expand to their source). */
  mdLen: number;
  /** Marker layout inside text runs. */
  openLen: number;
  closeLen: number;
  /** ProseMirror position of the run start. */
  pmPos: number;
  mdStart: number;
  collapsedStart: number;
  nodeName?: string;
}

export interface RichDocMap {
  value: string;
  runs: RichRun[];
  docLength: number;
  contextIds: string[];
}

function readAtomSource(node: ProseMirrorNode): string {
  const attrs = node.attrs as Record<string, unknown>;
  switch (node.type.name) {
    case "composer-mention":
    case "composer-citation":
    case "composer-context-reference":
      return typeof attrs.source === "string" ? attrs.source : "";
    case "composer-skill": {
      const name = typeof attrs.skillName === "string" ? attrs.skillName : "";
      return name ? `$${name}` : "";
    }
    default:
      return "";
  }
}

interface RichAccumulator {
  runs: RichRun[];
  value: string;
  flat: number;
  collapsed: number;
  md: number;
}

function pushBreakRun(acc: RichAccumulator, position?: number): void {
  const previous = acc.runs[acc.runs.length - 1];
  const pmPos = position ?? (previous ? previous.pmPos + previous.docLen : 1);
  // Block boundary: one newline in every coordinate space.
  acc.runs.push({
    kind: "break",
    flatStart: acc.flat,
    docLen: 1,
    collapsedLen: 1,
    mdLen: 1,
    openLen: 0,
    closeLen: 0,
    pmPos,
    mdStart: acc.md,
    collapsedStart: acc.collapsed,
  });
  acc.value += "\n";
  acc.flat += 1;
  acc.collapsed += 1;
  acc.md += 1;
}

function appendInlineRuns(
  container: ProseMirrorNode,
  contentStart: number,
  acc: RichAccumulator,
): void {
  const children: ProseMirrorNode[] = [];
  container.forEach((child) => {
    if (!child.isText || child.marks.some((mark) => mark.type.name === "code")) {
      children.push(child);
      return;
    }
    // Separate boundary whitespace so delimiters can move past it without
    // changing the document offsets or marks on the visible text.
    const text = child.text!;
    const start = text.length - text.trimStart().length;
    const end = Math.max(start, text.trimEnd().length);
    let offset = 0;
    for (const boundary of [start, end, text.length]) {
      if (boundary > offset) children.push(child.cut(offset, boundary));
      offset = boundary;
    }
  });
  // Emphasis cannot open or close next to whitespace. Retain a whitespace
  // mark only when its range has visible content on both sides.
  for (const mark of MARK_NESTING_ORDER) {
    if (mark === "code") continue;
    for (const direction of [1, -1]) {
      let hasContent = false;
      for (
        let index = direction === 1 ? 0 : children.length - 1;
        index >= 0 && index < children.length;
        index += direction
      ) {
        const child = children[index]!;
        if (
          child.type.name === "hardBreak" ||
          !child.marks.some((item) => item.type.name === mark)
        ) {
          hasContent = false;
        } else if (
          child.isText &&
          !child.marks.some((item) => item.type.name === "code") &&
          /^\s+$/.test(child.text!)
        ) {
          if (!hasContent)
            children[index] = child.mark(child.marks.filter((item) => item.type.name !== mark));
        } else {
          hasContent = true;
        }
      }
    }
  }
  // Longer shared marks surround shorter ones. This keeps both nested
  // formatting and formatting across chips inside a single delimiter pair.
  const markEnds = new Map<RichTextMark, number>();
  const orderedMarks: RichTextMark[][] = [];
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]!;
    const marks =
      child.type.name === "hardBreak"
        ? []
        : child.marks
            .map((mark) => TIPTAP_TO_MARK[mark.type.name])
            .filter((mark): mark is RichTextMark => Boolean(mark));
    for (const mark of MARK_NESTING_ORDER) {
      if (!marks.includes(mark)) markEnds.delete(mark);
      else if (!markEnds.has(mark)) markEnds.set(mark, index);
    }
    orderedMarks[index] = marks.sort(
      (a, b) =>
        markEnds.get(b)! - markEnds.get(a)! ||
        MARK_NESTING_ORDER.indexOf(a) - MARK_NESTING_ORDER.indexOf(b),
    );
  }
  for (let index = 1; index < orderedMarks.length; index += 1) {
    const marks = orderedMarks[index]!;
    const retained: RichTextMark[] = [];
    for (const mark of orderedMarks[index - 1]!) {
      if (!marks.includes(mark)) break;
      retained.push(mark);
    }
    orderedMarks[index] = [...retained, ...marks.filter((mark) => !retained.includes(mark))];
  }
  const commonLength = (left: RichTextMark[], right: RichTextMark[]) => {
    let index = 0;
    while (index < left.length && left[index] === right[index]) index += 1;
    return index;
  };
  let inlineOffset = 0;
  children.forEach((child, index) => {
    const pmPos = contentStart + inlineOffset;
    inlineOffset += child.nodeSize;
    if (child.type.name === "hardBreak") {
      pushBreakRun(acc, pmPos);
      return;
    }
    const marks = orderedMarks[index]!;
    const open = marks
      .slice(commonLength(marks, orderedMarks[index - 1] ?? []))
      .map((mark) => RICH_TEXT_DELIMITERS[mark])
      .join("");
    const close = marks
      .slice(commonLength(marks, orderedMarks[index + 1] ?? []))
      .toReversed()
      .map((mark) => RICH_TEXT_DELIMITERS[mark])
      .join("");
    const source = child.isText ? child.text! : readAtomSource(child);
    const docLen = child.isText ? source.length : 1;
    const mdText = open + source + close;
    const collapsedLen = open.length + docLen + close.length;
    acc.runs.push({
      kind: child.isText ? "text" : "token",
      flatStart: acc.flat,
      docLen,
      collapsedLen,
      mdLen: mdText.length,
      openLen: open.length,
      closeLen: close.length,
      pmPos,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
      ...(child.isText ? {} : { nodeName: child.type.name }),
    });
    acc.value += mdText;
    acc.flat += docLen;
    acc.collapsed += collapsedLen;
    acc.md += mdText.length;
  });
  // Empty paragraphs have an editable position even though they emit no text.
  if (children.length === 0) {
    acc.runs.push({
      kind: "text",
      flatStart: acc.flat,
      docLen: 0,
      collapsedLen: 0,
      mdLen: 0,
      openLen: 0,
      closeLen: 0,
      pmPos: contentStart,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
    });
  }
}

interface ListWalk {
  /** Normalized indent of the enclosing item; null at the top level. */
  parentIndent: string | null;
  /** Normalized indent of the previous item in the same container. */
  previousIndent: string | null;
}

/**
 * Indent for an item, corrected so the parser reads the same structure back.
 * Native list commands (Enter splitting a nested item, Shift+Tab lifting one)
 * move items without touching their stored indent.
 */
function normalizedItemIndent(stored: string, walk: ListWalk): string {
  const { parentIndent, previousIndent } = walk;
  if (parentIndent !== null) {
    // Nested siblings share one indent, which must extend the parent's.
    if (previousIndent !== null) return previousIndent;
    return stored !== parentIndent && stored.startsWith(parentIndent)
      ? stored
      : `${parentIndent}  `;
  }
  // A top-level item indented past the previous one would nest under it.
  if (previousIndent !== null && stored !== previousIndent && stored.startsWith(previousIndent)) {
    return previousIndent;
  }
  return stored;
}

function listItemPrefix(
  list: ProseMirrorNode,
  item: ProseMirrorNode,
  indent: string,
  previousNumber: number | null,
): { prefix: string; number: number | null } {
  const attrs = item.attrs as Record<string, unknown>;
  const first = item.firstChild;
  const empty = first?.type.name === "paragraph" && first.content.childCount === 0;
  const markerSpace =
    typeof attrs.markerSpace === "string" && attrs.markerSpace ? attrs.markerSpace : " ";
  if (item.type.name === "taskItem") {
    const contentSpace =
      typeof attrs.contentSpace === "string"
        ? attrs.contentSpace || (empty ? "" : " ")
        : empty
          ? ""
          : " ";
    const checkbox = `[${attrs.checked === true ? "x" : " "}]`;
    return { prefix: `${indent}-${markerSpace}${checkbox}${contentSpace}`, number: null };
  }
  const listAttrs = list.attrs as Record<string, unknown>;
  if (list.type.name === "orderedList") {
    const delimiter = listAttrs.delimiter === ")" ? ")" : ".";
    if (typeof attrs.number === "string") {
      return {
        prefix: `${indent}${attrs.number}${delimiter}${markerSpace}`,
        number: Number(attrs.number),
      };
    }
    const start = typeof listAttrs.start === "number" ? listAttrs.start : 1;
    const number = previousNumber === null ? start : previousNumber + 1;
    return { prefix: `${indent}${number}${delimiter}${markerSpace}`, number };
  }
  const bullet = typeof listAttrs.bullet === "string" ? listAttrs.bullet : "-";
  return { prefix: `${indent}${bullet}${markerSpace}`, number: null };
}

/** Serializes one list and returns the last item's indent. */
function walkList(
  list: ProseMirrorNode,
  listStart: number,
  acc: RichAccumulator,
  walk: ListWalk,
): string | null {
  let itemPos = listStart + 1;
  let firstItem = true;
  let previousIndent = walk.previousIndent;
  let previousNumber: number | null = null;
  list.content.forEach((item) => {
    // Sibling items are separated by one newline in every coordinate space.
    if (!firstItem) pushBreakRun(acc);
    firstItem = false;
    const itemContentStart = itemPos + 1;
    const storedIndent =
      typeof (item.attrs as Record<string, unknown>).indent === "string"
        ? ((item.attrs as Record<string, unknown>).indent as string)
        : "";
    const indent = normalizedItemIndent(storedIndent, {
      parentIndent: walk.parentIndent,
      previousIndent,
    });
    previousIndent = indent;
    const { prefix, number } = listItemPrefix(list, item, indent, previousNumber);
    previousNumber = number;
    // The marker owns no document characters; every prefix offset clamps to
    // the start of the item text, exactly like style markers.
    acc.runs.push({
      kind: "prefix",
      flatStart: acc.flat,
      docLen: 0,
      collapsedLen: prefix.length,
      mdLen: prefix.length,
      openLen: 0,
      closeLen: 0,
      pmPos: itemContentStart + 1,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
    });
    acc.value += prefix;
    acc.collapsed += prefix.length;
    acc.md += prefix.length;
    let childPos = itemContentStart;
    let firstBlock = true;
    let childIndent: string | null = null;
    item.content.forEach((child) => {
      if (!firstBlock) pushBreakRun(acc);
      firstBlock = false;
      if (LIST_NODE_NAMES.has(child.type.name)) {
        childIndent = walkList(child, childPos, acc, {
          parentIndent: indent,
          previousIndent: childIndent,
        });
      } else if (child.type.name === "paragraph") {
        appendInlineRuns(child, childPos + 1, acc);
      }
      childPos += child.nodeSize;
    });
    itemPos += item.nodeSize;
  });
  return previousIndent;
}

export function serializeEditorDoc(doc: ProseMirrorNode): RichDocMap {
  const acc: RichAccumulator = { runs: [], value: "", flat: 0, collapsed: 0, md: 0 };
  const blocks: ProseMirrorNode[] = [];
  doc.content.forEach((node) => {
    blocks.push(node);
  });

  let pmBlockStart = 0;
  let previousIndent: string | null = null;
  blocks.forEach((block, blockIndex) => {
    if (blockIndex > 0) pushBreakRun(acc);
    if (LIST_NODE_NAMES.has(block.type.name)) {
      previousIndent = walkList(block, pmBlockStart, acc, { parentIndent: null, previousIndent });
    } else if (block.type.name === "paragraph") {
      previousIndent = null;
      appendInlineRuns(block, pmBlockStart + 1, acc);
    }
    pmBlockStart += block.nodeSize;
  });

  return {
    value: acc.value,
    runs: acc.runs,
    docLength: acc.flat,
    contextIds: Array.from(new Set(collectInlineContextIds(acc.value))),
  };
}

function lastRunEnd(map: RichDocMap, space: "collapsed" | "md"): number {
  const last = map.runs[map.runs.length - 1];
  if (!last) return 0;
  return space === "collapsed"
    ? last.collapsedStart + last.collapsedLen
    : last.mdStart + last.mdLen;
}

export function flatToCollapsed(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (bounded < run.flatStart + run.docLen) {
      if (run.kind === "text" || run.kind === "token") {
        return run.collapsedStart + run.openLen + (bounded - run.flatStart);
      }
      return run.collapsedStart + (bounded - run.flatStart);
    }
  }
  return lastRunEnd(map, "collapsed");
}

export function flatToMarkdown(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (bounded < run.flatStart + run.docLen) {
      if (run.kind === "text" || run.kind === "token") {
        return run.mdStart + run.openLen + (bounded - run.flatStart);
      }
      return run.mdStart + (bounded - run.flatStart);
    }
  }
  return lastRunEnd(map, "md");
}

export function collapsedToFlat(map: RichDocMap, collapsedOffset: number): number {
  for (const run of map.runs) {
    if (collapsedOffset < run.collapsedStart + run.collapsedLen) {
      // Checkbox prefixes and style markers are shown, never edited: every
      // offset inside them clamps to the adjacent document position.
      if (run.kind === "prefix") return run.flatStart;
      if (run.kind === "text" || run.kind === "token") {
        const within = collapsedOffset - run.collapsedStart;
        // Marker characters clamp to the styled edge: they are shown, never edited.
        if (within <= run.openLen) return run.flatStart;
        if (within >= run.openLen + run.docLen) return run.flatStart + run.docLen;
        return run.flatStart + (within - run.openLen);
      }
      return run.flatStart + (collapsedOffset - run.collapsedStart);
    }
  }
  return map.docLength;
}

export function flatToPm(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (bounded < run.flatStart + run.docLen) {
      return run.pmPos + (bounded - run.flatStart);
    }
  }
  const last = map.runs[map.runs.length - 1];
  if (!last) return 1;
  return last.pmPos + last.docLen;
}

export function pmToFlat(map: RichDocMap, pmPos: number): number {
  for (const run of map.runs) {
    if (pmPos >= run.pmPos && pmPos <= run.pmPos + run.docLen) {
      // A position on a chip's trailing edge belongs after the chip.
      if (run.kind === "token" && pmPos === run.pmPos + run.docLen) {
        return run.flatStart + run.docLen;
      }
      return run.flatStart + Math.min(pmPos - run.pmPos, run.docLen);
    }
  }
  // A paragraph boundary position belongs to the newline between paragraphs.
  let best = 0;
  for (const run of map.runs) {
    if (run.pmPos <= pmPos) best = run.flatStart + run.docLen;
  }
  return Math.max(0, Math.min(best, map.docLength));
}

// ── Caret stops at styled edges ────────────────────────────────────────────
//
// Markers are decorations, not text, so the position where styled text meets
// unstyled text (or a paragraph edge) is a single document position. The
// caret gets two stops there: one that types with the marks before the edge
// and one that types with the marks after it. Stored marks pick the stop, and
// the revealed markers render on the matching side of the caret, so a pasted
// `**bold**` at the start of a line can still be typed in front of.

function styledEdge(state: EditorState) {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (!$from.parent.inlineContent) return null;
  const before = $from.nodeBefore?.marks ?? Mark.none;
  const after = $from.nodeAfter?.marks ?? Mark.none;
  if (Mark.sameSet(before, after)) return null;
  return { before, after, current: state.storedMarks ?? $from.marks() };
}

/** True when the caret sits on a styled edge and types with the marks before it. */
export function caretTakesMarksBefore(state: EditorState): boolean {
  const edge = styledEdge(state);
  return edge !== null && Mark.sameSet(edge.current, edge.before);
}

/**
 * Moves the caret to the other stop of the styled edge it sits on, toward
 * `direction`. Returns null when there is no stop to take, so the arrow key
 * moves the caret as usual.
 */
export function stepCaretAcrossStyledEdge(
  state: EditorState,
  direction: -1 | 1,
): Transaction | null {
  const edge = styledEdge(state);
  if (!edge) return null;
  // Marks the user toggled by hand (neither stop) are theirs: move as usual.
  if (!Mark.sameSet(edge.current, edge.before) && !Mark.sameSet(edge.current, edge.after)) {
    return null;
  }
  const target = direction === -1 ? edge.before : edge.after;
  if (Mark.sameSet(edge.current, target)) return null;
  return state.tr.setStoredMarks(target);
}
