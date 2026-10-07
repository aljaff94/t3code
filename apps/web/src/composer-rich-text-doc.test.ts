import { getSchemaByResolvedExtensions, Node, resolveExtensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskList } from "@tiptap/extension-task-list";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDocJson,
  caretTakesMarksBefore,
  collapsedToFlat,
  ComposerCodeExtension,
  ComposerListAttributesExtension,
  ComposerTaskItemExtension,
  flatToCollapsed,
  flatToMarkdown,
  flatToPm,
  pmToFlat,
  serializeEditorDoc,
  stepCaretAcrossStyledEdge,
} from "./composer-rich-text-doc";

function stubAtom(name: string, attrs: Record<string, { default: unknown }>) {
  return Node.create({
    name,
    group: "inline",
    inline: true,
    atom: true,
    addAttributes: () => attrs,
  });
}

const schema = getSchemaByResolvedExtensions(
  resolveExtensions([
    StarterKit.configure({
      blockquote: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
      code: false,
    }),
    ComposerCodeExtension,
    ComposerListAttributesExtension,
    stubAtom("composer-mention", { path: { default: "" }, source: { default: "" } }),
    stubAtom("composer-skill", {
      skillName: { default: "" },
      skillLabel: { default: "" },
      skillDescription: { default: null },
    }),
    stubAtom("composer-citation", {
      citation: { default: null },
      source: { default: "" },
      citeKey: { default: "" },
    }),
    stubAtom("composer-context-reference", {
      kind: { default: "" },
      contextId: { default: "" },
      label: { default: "" },
      source: { default: "" },
    }),
    TaskList,
    ComposerTaskItemExtension,
  ]),
);

function roundTrip(value: string) {
  const json = buildDocJson(value, (name) => ({ label: name, description: null }));
  const doc = ProseMirrorNode.fromJSON(schema, json);
  // `insertContent` validates every node against the schema; `fromJSON` does not.
  doc.check();
  return serializeEditorDoc(doc);
}

// Plain mode: the same engine with the mark extensions off. Markers stay
// literal characters and task lines stay paragraphs.
const plainSchema = getSchemaByResolvedExtensions(
  resolveExtensions([
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      orderedList: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
      bold: false,
      italic: false,
      strike: false,
      code: false,
    }),
    stubAtom("composer-mention", { path: { default: "" }, source: { default: "" } }),
    stubAtom("composer-skill", {
      skillName: { default: "" },
      skillLabel: { default: "" },
      skillDescription: { default: null },
    }),
    stubAtom("composer-citation", {
      citation: { default: null },
      source: { default: "" },
      citeKey: { default: "" },
    }),
    stubAtom("composer-context-reference", {
      kind: { default: "" },
      contextId: { default: "" },
      label: { default: "" },
      source: { default: "" },
    }),
    TaskList,
    ComposerTaskItemExtension,
  ]),
);

function roundTripPlain(value: string) {
  const json = buildDocJson(value, (name) => ({ label: name, description: null }), {
    styling: false,
  });
  const doc = ProseMirrorNode.fromJSON(plainSchema, json);
  return serializeEditorDoc(doc);
}

describe("composer rich text document model", () => {
  it.each(["€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "canonicalizes %s skill aliases while preserving amounts",
    (prefix) => {
      const value = `Use ${prefix}my-skill for ${prefix}20 please`;
      const expected = `Use $my-skill for ${prefix}20 please`;
      expect(roundTrip(value).value).toBe(expected);
      expect(roundTripPlain(value).value).toBe(expected);
    },
  );

  it.each([
    "",
    "\n\n",
    "plain text",
    "hello **bold** world",
    "a *italic* word and `code` here",
    "struck ~~out~~ now",
    "**`x`**",
    "*`x`*",
    "~~`x`~~",
    "**a `code` c**",
    "***bold italic*** keeps nesting",
    "line one\nline two",
    "trailing newline\n",
    "1. foo\n2. asdf\n",
    "- [ ] buy milk",
    "-   [ ]  buy milk",
    "\t-\t[x]\t\titem",
    "- [ ]  ",
    "- [ ]\n  - [ ] child",
    "  - [ ] first\n - [ ] second\n  - [ ] child",
    "**before @README.md after**",
    "*a **b** c*",
    "*a**b***",
    "**a*b***",
    "**a *b* c**",
    "literal \uFFFC **before @README.md after**",
    "- [x] done\n- [ ] next",
    "- [ ] parent\n  - [ ] child\n  - [ ] sibling\n- [ ] uncle",
    "- [ ] empty task follows\n- [ ]",
    "- [ ] **bold** task with @README.md",
    "para\n- [ ] task\npara",
    "- [ ]No space stays literal",
    "-[ ] also literal",
    "@README.md explain this",
    '@"docs/My File.md" and $my-skill please',
    "snake_case stays literal",
    "unmatched ** stays literal",
    "**bold** then @README.md then *italic*",
    "- bullet",
    "* star\n* bullets",
    "+   wide  marker space",
    "- \n- ",
    "- a\n* b\n+ c",
    "1. one\n1. lazy\n1. numbering",
    "3) three\n7) seven",
    "007. padded",
    "- parent\n  - child\n    - grandchild\n- uncle",
    "1. step\n   - detail\n   - [ ] todo\n2. next",
    "- [ ] task\n- bullet\n1. ordered",
    "para\n- **bold** item with @README.md\npara",
    "  - leading indent\n - dedent\n  - child",
    "* * *",
    "2024. was a year",
  ])("round-trips %s through a real ProseMirror document", (value) => {
    expect(roundTrip(value).value).toBe(value);
  });

  it.each([
    "",
    "\n",
    "text\n\n",
    "- [ ]\n- [ ] next\n",
    "- [ ] parent\n  - [ ] child\n- [ ]",
    "para\n- [ ] task\npara",
    "**before @README.md after**",
    "- \n- next\n",
    "1. step\n   - detail\n2. next",
  ])("maps editable positions in %s", (value) => {
    const doc = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson(value, (name) => ({ label: name, description: null })),
    );
    const map = serializeEditorDoc(doc);
    for (let flat = 0; flat <= map.docLength; flat += 1) {
      const position = flatToPm(map, flat);
      expect(doc.resolve(position).parent.isTextblock).toBe(true);
      expect(pmToFlat(map, position)).toBe(flat);
      expect(collapsedToFlat(map, flatToCollapsed(map, flat))).toBe(flat);
    }
  });

  it("keeps the caret after a trailing hard break inside the same paragraph", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("a"), schema.node("hardBreak")]),
    ]);
    const map = serializeEditorDoc(doc);
    expect(flatToPm(map, map.docLength)).toBe(3);
    expect(doc.resolve(flatToPm(map, map.docLength)).parent.isTextblock).toBe(true);
  });

  it("renders a leading task dedent as siblings and nests under the new indent", () => {
    const doc = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson("  - [ ] first\n - [ ] second\n  - [ ] child", (name) => ({
        label: name,
        description: null,
      })),
    );
    const list = doc.firstChild!;
    expect(list.childCount).toBe(2);
    expect(list.child(0).childCount).toBe(1);
    expect(list.child(1).child(1).firstChild!.textContent).toBe("child");
  });

  it("groups list lines into nested bullet, ordered, and task lists", () => {
    const doc = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson("1. step\n   - detail\n   - [ ] todo\n2. next\n- after", (name) => ({
        label: name,
        description: null,
      })),
    );
    expect(doc.childCount).toBe(2);
    const ordered = doc.child(0);
    expect(ordered.type.name).toBe("orderedList");
    expect(ordered.childCount).toBe(2);
    const nested = ordered.child(0);
    expect(nested.childCount).toBe(3);
    expect(nested.child(1).type.name).toBe("bulletList");
    expect(nested.child(2).type.name).toBe("taskList");
    expect(doc.child(1).type.name).toBe("bulletList");
  });

  it("starts a new list when the bullet character changes", () => {
    const doc = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson("- a\n* b", (name) => ({ label: name, description: null })),
    );
    expect(doc.childCount).toBe(2);
    expect(doc.child(1).attrs.bullet).toBe("*");
  });

  it("numbers items split off an ordered list from the previous sibling", () => {
    const listItem = (text: string, attrs: Record<string, unknown>) =>
      schema.node("listItem", attrs, [schema.node("paragraph", null, [schema.text(text)])]);
    const doc = schema.node("doc", null, [
      schema.node("orderedList", { start: 3, delimiter: ")" }, [
        listItem("first", { number: null }),
        listItem("second", { number: null }),
        listItem("kept", { number: "9" }),
        listItem("after", { number: null }),
      ]),
    ]);
    expect(serializeEditorDoc(doc).value).toBe("3) first\n4) second\n9) kept\n10) after");
  });

  it("re-derives indents for items that native list commands moved", () => {
    const listItem = (text: string, indent: string, children: ProseMirrorNode[] = []) =>
      schema.node("listItem", { indent }, [
        schema.node("paragraph", null, [schema.text(text)]),
        ...children,
      ]);
    // Tab sank "child" without changing its stored indent; Shift+Tab lifted
    // "lifted" out of a nested list and kept the nested indent.
    const doc = schema.node("doc", null, [
      schema.node("bulletList", null, [
        listItem("parent", "", [schema.node("bulletList", null, [listItem("child", "")])]),
        listItem("lifted", "  "),
      ]),
    ]);
    const serialized = serializeEditorDoc(doc).value;
    expect(serialized).toBe("- parent\n  - child\n- lifted");
    const rebuilt = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson(serialized, (name) => ({ label: name, description: null })),
    );
    expect(rebuilt.firstChild!.childCount).toBe(2);
    expect(rebuilt.firstChild!.child(0).child(1).type.name).toBe("bulletList");
  });

  it("applies a shared mark to text on both sides of a chip", () => {
    const doc = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson("**before @README.md after**", (name) => ({ label: name, description: null })),
    );
    expect(doc.firstChild!.childCount).toBe(3);
    doc.firstChild!.forEach((child) =>
      expect(child.marks.map((mark) => mark.type.name)).toContain("bold"),
    );
    expect(serializeEditorDoc(doc).value).toBe("**before @README.md after**");
  });

  it.each([
    [["bold"], ["bold", "italic"], ["italic"]],
    [["italic"], ["bold", "italic"], ["bold"]],
    [["bold"], ["bold", "strike"], ["strike"]],
    [["strike"], ["bold", "strike"], ["bold"]],
  ])("preserves crossing mark ranges %j through controlled rebuilds", (...marks) => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        null,
        marks.map((names, index) =>
          schema.text(
            String.fromCharCode(97 + index),
            names.map((name) => schema.mark(name)),
          ),
        ),
      ),
    ]);
    const serialized = serializeEditorDoc(doc).value;
    const rebuilt = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson(serialized, (name) => ({ label: name, description: null })),
    );
    expect(rebuilt.eq(doc)).toBe(true);
    expect(serializeEditorDoc(rebuilt).value).toBe(serialized);
  });

  it.each([
    { parts: [{ text: "hello ", marks: ["bold"] }], expected: "**hello** " },
    { parts: [{ text: "  ", marks: ["bold"] }], expected: "  " },
    { parts: [{ text: " left ", marks: ["bold", "italic"] }], expected: " ***left*** " },
    {
      parts: [
        { text: "one ", marks: ["bold"] },
        { text: " two ", marks: ["bold", "italic"] },
        { text: " three", marks: ["bold"] },
      ],
      expected: "**one  *two*  three**",
    },
    {
      parts: [
        { text: "hello ", marks: ["bold"] },
        { text: "world ", marks: ["bold", "italic"] },
      ],
      expected: "**hello *world*** ",
    },
    { parts: [{ text: " hello ", marks: ["code"] }], expected: "` hello `" },
    { parts: [{ text: " hello ", marks: ["bold", "code"] }], expected: "**` hello `**" },
    { parts: [{ text: " ", marks: ["bold", "code"] }], expected: "**` `**" },
  ])("keeps boundary whitespace outside emphasis in $expected", ({ parts, expected }) => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        null,
        parts.map(({ text, marks }) =>
          schema.text(
            text,
            marks.map((name) => schema.mark(name)),
          ),
        ),
      ),
    ]);
    const map = serializeEditorDoc(doc);
    expect(map.value).toBe(expected);
    const rebuilt = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson(map.value, (name) => ({ label: name, description: null })),
    );
    expect(rebuilt.textContent).toBe(doc.textContent);
    expect(serializeEditorDoc(rebuilt).value).toBe(map.value);
    for (let flat = 0; flat <= map.docLength; flat += 1) {
      expect(pmToFlat(map, flatToPm(map, flat))).toBe(flat);
      expect(collapsedToFlat(map, flatToCollapsed(map, flat))).toBe(flat);
      if (flat < map.docLength && !/\s/.test(doc.textContent[flat]!)) {
        expect(rebuilt.resolve(flat + 1).nodeAfter!.marks.map((mark) => mark.type.name)).toEqual(
          doc.resolve(flat + 1).nodeAfter!.marks.map((mark) => mark.type.name),
        );
      }
    }
  });

  it("keeps chip sources canonical through the document", () => {
    const map = roundTrip("explain @README.md with **care**\nsecond line *here*");
    expect(map.value).toBe("explain @README.md with **care**\nsecond line *here*");
    expect(
      map.runs.some((run) => run.kind === "token" && run.nodeName === "composer-mention"),
    ).toBe(true);
  });

  it("normalizes uppercase checkboxes to lowercase", () => {
    expect(roundTrip("- [X] done").value).toBe("- [x] done");
  });

  it.each([
    "plain text",
    "hello **bold** stays literal",
    "a *italic* stays literal",
    "some `code` stays literal",
    "struck ~~out~~ stays literal",
    "- [ ] stays a paragraph",
    "- [x] stays a paragraph",
    "- bullets stay a paragraph",
    "1. numbers stay a paragraph",
    "line one\nline two",
    "@README.md explain this",
    "**bold** then @README.md then *italic*",
  ])("round-trips %s byte-identically in plain mode", (value) => {
    expect(roundTripPlain(value).value).toBe(value);
  });

  it("maps every document offset through collapsed coordinates and back", () => {
    const value = "hi **bold** @README.md bye";
    const map = roundTrip(value);
    expect(map.value).toBe(value);
    for (let flat = 0; flat <= map.docLength; flat += 1) {
      expect(collapsedToFlat(map, flatToCollapsed(map, flat))).toBe(flat);
    }
  });

  it("maps markdown offsets at styled edges onto document text", () => {
    const value = "a **bold** c";
    const map = roundTrip(value);
    expect(map.value).toBe(value);
    // document text is "a bold c" (flat), markdown has the markers.
    expect(flatToMarkdown(map, 2)).toBe(4);
    expect(flatToMarkdown(map, 6)).toBe(10);
    expect(collapsedToFlat(map, 3)).toBe(2);
    expect(collapsedToFlat(map, 9)).toBe(6);
  });
});

describe("caret stops at styled edges", () => {
  function stateAt(value: string, pmPos: number) {
    const doc = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson(value, (name) => ({ label: name, description: null })),
    );
    return EditorState.create({ doc, selection: TextSelection.create(doc, pmPos) });
  }

  function typed(state: EditorState, text: string) {
    return serializeEditorDoc(state.apply(state.tr.insertText(text)).doc).value;
  }

  it("lets the caret step out in front of bold that starts the line", () => {
    const inside = stateAt("**bold** tail", 1);
    expect(caretTakesMarksBefore(inside)).toBe(false);
    expect(typed(inside, "x")).toBe("**xbold** tail");

    const step = stepCaretAcrossStyledEdge(inside, -1);
    expect(step).not.toBeNull();
    const outside = inside.apply(step!);
    expect(caretTakesMarksBefore(outside)).toBe(true);
    expect(typed(outside, "x")).toBe("x**bold** tail");
    // Already outside: the next ArrowLeft moves the caret as usual.
    expect(stepCaretAcrossStyledEdge(outside, -1)).toBeNull();

    const back = outside.apply(stepCaretAcrossStyledEdge(outside, 1)!);
    expect(typed(back, "x")).toBe("**xbold** tail");
  });

  it("lets the caret step out after bold that ends the line", () => {
    const inside = stateAt("head **bold**", 10);
    expect(caretTakesMarksBefore(inside)).toBe(true);
    expect(typed(inside, "x")).toBe("head **boldx**");
    expect(stepCaretAcrossStyledEdge(inside, -1)).toBeNull();

    const outside = inside.apply(stepCaretAcrossStyledEdge(inside, 1)!);
    expect(caretTakesMarksBefore(outside)).toBe(false);
    expect(typed(outside, "x")).toBe("head **bold**x");
  });

  it("offers both stops where styled text meets plain text mid-line", () => {
    // Caret after "a ": types plain until ArrowRight steps into the bold.
    const plain = stateAt("a **b** c", 3);
    expect(caretTakesMarksBefore(plain)).toBe(true);
    expect(typed(plain, "x")).toBe("a x**b** c");
    const bold = plain.apply(stepCaretAcrossStyledEdge(plain, 1)!);
    expect(typed(bold, "x")).toBe("a **xb** c");
  });

  it("offers the plain stop between bold text and a chip right after it", () => {
    // Markdown needs a space before a mention, but deleting it leaves them adjacent.
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("bold", [schema.marks.bold!.create()]),
        schema.nodes["composer-mention"]!.create({ path: "README.md", source: "@README.md" }),
      ]),
    ]);
    const inside = EditorState.create({ doc, selection: TextSelection.create(doc, 5) });
    expect(caretTakesMarksBefore(inside)).toBe(true);
    const outside = inside.apply(stepCaretAcrossStyledEdge(inside, 1)!);
    expect(caretTakesMarksBefore(outside)).toBe(false);
    const withText = outside.apply(outside.tr.insertText("x")).doc;
    expect(withText.child(0).child(1).text).toBe("x");
    expect(withText.child(0).child(1).marks).toEqual([]);
  });

  it("steps out of inline code at the end of a line without inserting a space", () => {
    expect(ComposerCodeExtension.config.exitable).toBe(false);
    const inside = stateAt("`code`", 5);
    const outside = inside.apply(stepCaretAcrossStyledEdge(inside, 1)!);
    expect(typed(outside, "x")).toBe("`code`x");
    expect(stepCaretAcrossStyledEdge(outside, 1)).toBeNull();
  });

  it("keeps marks the user toggled at an edge and lets the arrow move", () => {
    const inside = stateAt("a **b** c", 3);
    const toggled = inside.apply(
      inside.tr.setStoredMarks([schema.marks.bold!.create(), schema.marks.italic!.create()]),
    );
    expect(stepCaretAcrossStyledEdge(toggled, 1)).toBeNull();
    expect(stepCaretAcrossStyledEdge(toggled, -1)).toBeNull();
  });

  it("leaves arrow keys alone away from styled edges", () => {
    expect(stepCaretAcrossStyledEdge(stateAt("**bold** tail", 3), -1)).toBeNull();
    expect(stepCaretAcrossStyledEdge(stateAt("plain text", 1), -1)).toBeNull();
    expect(caretTakesMarksBefore(stateAt("plain text", 1))).toBe(false);
  });
});
