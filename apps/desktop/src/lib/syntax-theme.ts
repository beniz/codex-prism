import { LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { styleTags, tagHighlighter, tags } from "@lezer/highlight";

import { latex, latexLanguage } from "codemirror-lang-latex";

// Add highlighting tags for common nodes the upstream grammar leaves unstyled.
// Parsing, completion and lint behavior stay the same.
export const scientificLatexLanguage = latexLanguage.configure({
  props: [
    styleTags({
      "IncludeGraphicsCtrlSeq InputCtrlSeq IncludeCtrlSeq CaptionCtrlSeq HrefCtrlSeq UrlCtrlSeq ItemCtrlSeq NewCommandCtrlSeq RenewCommandCtrlSeq NewEnvironmentCtrlSeq RenewEnvironmentCtrlSeq":
        tags.keyword,
      "MathOpening MathClosing OpenParenCtrlSym CloseParenCtrlSym OpenBracketCtrlSym CloseBracketCtrlSym":
        tags.processingInstruction,
    }),
  ],
});
export function scientificLatex() {
  const support = latex({ enableLinting: false });
  return new LanguageSupport(scientificLatexLanguage, support.support);
}

/** Shared by the source editor and LaTeX/BibTeX snippets in chat. Colours live in CSS. */
export const scientificHighlighter = tagHighlighter([
  {
    tag: [tags.keyword, tags.className, tags.typeName, tags.propertyName],
    class: "syntax-command",
  },
  { tag: [tags.string, tags.labelName, tags.quote], class: "syntax-string" },
  {
    tag: [tags.number, tags.bool, tags.null, tags.atom],
    class: "syntax-number",
  },
  {
    tag: [tags.operator, tags.processingInstruction, tags.meta],
    class: "syntax-special",
  },
  { tag: tags.comment, class: "syntax-comment" },
  { tag: tags.heading, class: "syntax-heading" },
  { tag: tags.strong, class: "syntax-strong" },
  { tag: tags.emphasis, class: "syntax-emphasis" },
  { tag: tags.invalid, class: "syntax-invalid" },
  { tag: tags.inserted, class: "syntax-inserted" },
  { tag: tags.deleted, class: "syntax-deleted" },
]);

export function scientificEditorTheme(dark: boolean) {
  return [
    syntaxHighlighting(scientificHighlighter),
    EditorView.theme(
      {
        "&": {
          color: "var(--syntax-foreground)",
          backgroundColor: "var(--background)",
        },
        ".cm-content": { caretColor: "var(--syntax-foreground)" },
        ".cm-cursor, .cm-dropCursor": {
          borderLeftColor: "var(--syntax-foreground)",
        },
        ".cm-gutters": {
          color: "var(--syntax-comment)",
          backgroundColor: "var(--background)",
          borderRight: "1px solid var(--border)",
        },
        ".cm-activeLine, .cm-activeLineGutter": {
          backgroundColor:
            "color-mix(in srgb, var(--foreground) 5%, transparent)",
        },
        ".cm-tooltip, .cm-panels": {
          color: "var(--foreground)",
          backgroundColor: "var(--popover)",
          borderColor: "var(--border)",
        },
        ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
          color: "var(--accent-foreground)",
          backgroundColor: "var(--accent)",
        },
        ".cm-foldPlaceholder": {
          color: "var(--syntax-comment)",
          backgroundColor: "var(--muted)",
          borderColor: "var(--border)",
        },
      },
      { dark },
    ),
  ];
}
