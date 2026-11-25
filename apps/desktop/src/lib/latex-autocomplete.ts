import {
  biblatexCitations,
  natbibCitations,
  referenceKeyContext,
} from "./latex-citation-context";
import type { IndexQuery, IndexResult } from "./latex-completion-index";
import {
  acceptCompletion,
  insertCompletionText,
  autocompletion,
  pickedCompletion,
  type Completion,
  CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import {
  latexCompletions,
  latexCompletionSource,
  snippets,
} from "codemirror-lang-latex";

// Each row groups commands with the same number of required brace arguments.
// Unspecified signatures (including TeX primitives) insert the name alone.
const catalog: [string, number, string][] = [
  [
    "LaTeX",
    1,
    "footnote footnotetext thanks marginpar title author date part chapter section subsection subsubsection paragraph subparagraph label ref pageref eqref cite nocite bibitem bibliography bibliographystyle documentclass usepackage input include includeonly caption emph textnormal textbf textit texttt textsf textrm textsc textsl textup underline overline mbox fbox hspace vspace hphantom vphantom phantom mathrm mathbf mathit mathsf mathtt mathcal mathnormal ensuremath sqrt vec hat bar dot ddot tilde widehat widetilde symbol",
  ],
  [
    "LaTeX",
    2,
    "frac setlength addtolength rule raisebox setcounter addtocounter parbox",
  ],
  [
    "LaTeX",
    0,
    "appendix appendixname footnotemark footnotesize tiny scriptsize small normalsize large Large LARGE huge Huge centering raggedright raggedleft noindent indent par newline linebreak nolinebreak pagebreak nopagebreak newpage clearpage cleardoublepage bigskip medskip smallskip hfill vfill hss vss noalign noexpand expandafter csname endcsname providecommand newtheorem newcounter newlength newif makeatletter makeatother protected edef gdef xdef long global obeylines listoffigures listoftables today linewidth textwidth textheight baselineskip parskip parindent itemsep columnwidth arraystretch LaTeX TeX",
  ],
  [
    "LaTeX",
    0,
    "addcontentsline addtocontents protect relax linebreak nobreakspace smallskipamount normalsize normalfont centering raggedbottom flushbottom sloppy fussy frontmatter mainmatter backmatter listtablename figurename chaptername refname contentsname baselinestretch textbackslash textasciitilde textasciicircum copyright pounds ellipsis ldots cdots vdots ddots dots dagger ddagger Re Im forall exists neg land lor leq geq neq approx equiv sim simeq cong propto subset supset subseteq supseteq in notin ni cup cap emptyset times div cdot pm mp ast star circ bullet oplus otimes wedge vee setminus angle parallel perp mid to mapsto gets rightarrow leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow longrightarrow longleftarrow uparrow downarrow nabla top bot aleph hbar ell imath jmath sin cos tan cot sec csc sinh cosh tanh log ln exp det gcd max min inf sup ker dim hom Pr bmod limits nolimits left right middle big Big bigg Bigg",
  ],
  [
    "LaTeX",
    1,
    "textsuperscript textsubscript textsl MakeUppercase MakeLowercase uppercase lowercase phantom smash mathop mathbin mathrel mathord mathopen mathclose mathpunct overbrace underbrace acute grave breve check ddot tilde underline vphantom includeonly pagecolor pagestyle thispagestyle pagenumbering index",
  ],
  ["LaTeX", 2, "markboth settowidth settoheight settodepth addtocontents"],
  ["LaTeX", 3, "addcontentsline"],
  ["LaTeX", 3, "multicolumn"],
  [
    "amsmath",
    1,
    "text operatorname boldsymbol boxed tag substack eqref intertext mathring overleftrightarrow underleftrightarrow",
  ],
  [
    "amsmath",
    2,
    "dfrac tfrac binom dbinom tbinom overset underset stackrel DeclareMathOperator numberwithin cfrac",
  ],
  [
    "amsmath",
    0,
    "notag nonumber displaystyle textstyle scriptstyle scriptscriptstyle dots dotsc dotsb dotsm dotsi dotso iint iiint iiiint idotsint injlim projlim varlimsup varliminf limsup liminf mod bmod colon implies impliedby iff",
  ],
  ["amssymb", 1, "mathbb mathfrak"],
  ["graphicx", 1, "includegraphics graphicspath DeclareGraphicsExtensions"],
  ["graphicx", 2, "rotatebox scalebox"],
  ["graphicx", 3, "resizebox"],
  ["graphicx", 1, "reflectbox"],
  ["hyperref", 1, "url nolinkurl autoref autopageref nameref hypersetup path"],
  ["hyperref", 2, "href hypertarget hyperlink texorpdfstring pdfstringdef"],
  ["hyperref", 0, "hyperref"],
  ["cleveref", 1, "cref Cref cpageref Cpageref labelcref namecref nameCref"],
  ["cleveref", 2, "crefrange Crefrange cpagerefrange Cpagerefrange"],
  ["biblatex", 1, "addbibresource " + biblatexCitations],
  ["biblatex", 2, "citefield citelist citename"],
  ["natbib", 2, "defcitealias"],
  ["bibentry", 1, "bibentry"],
  ["biblatex", 0, "printbibliography printbibheading bibsetup AtEveryBibitem"],
  ["natbib", 1, natbibCitations],
  [
    "beamer",
    1,
    "frametitle framesubtitle institute subtitle titlegraphic usetheme usecolortheme usefonttheme useinnertheme useoutertheme alert structure column",
  ],
  ["beamer", 2, "setbeamertemplate setbeamercolor setbeamerfont"],
  [
    "beamer",
    0,
    "frame pause only uncover visible invisible onslide titlepage insertframenumber inserttotalframenumber",
  ],
];
const commands = new Map<string, { args: number; group: string }>();
for (const name of [
  ...latexCompletions.commands,
  ...latexCompletions.mathCommands,
])
  commands.set(name, { args: 0, group: "LaTeX" });
for (const [group, args, names] of catalog)
  for (const name of names.split(" "))
    commands.set(`\\${name}`, { args, group });

function commandOption(
  label: string,
  args: number,
  detail: string,
  boost = 0,
): Completion {
  return {
    label,
    type: "function",
    detail,
    boost,
    apply(view, completion, from, to) {
      const line = view.state.doc.lineAt(to);
      to += /^[a-zA-Z@]*/.exec(line.text.slice(to - line.from))![0].length;
      const next = view.state.sliceDoc(to, to + 1);
      const addArguments = args > 0 && !["{", "[", "*"].includes(next);
      const insert = label + (addArguments ? "{}".repeat(args) : "");
      view.dispatch({
        changes: { from, to, insert },
        selection: {
          anchor:
            from +
            label.length +
            Number(addArguments || (args > 0 && next === "{")),
        },
        annotations: pickedCompletion.of(completion),
        userEvent: "input.complete",
      });
    },
  };
}
const builtins = Array.from(commands, ([name, { args, group }]) =>
  commandOption(name, args, group),
);
const upstream = latexCompletionSource(true);
function ignored(context: CompletionContext) {
  if (context.view?.scrollDOM.classList.contains("cm-vimMode")) return true;
  // The grammar recovers an unfinished inline verb as ordinary commands
  // until its closing delimiter is typed.
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const verbs = /\\\\|\\verb\*?([^\w\s])/g;
  for (let m = verbs.exec(before); m; m = verbs.exec(before)) {
    if (!m[1]) continue;
    const end = before.indexOf(m[1], verbs.lastIndex);
    if (end < 0) return true;
    verbs.lastIndex = end + 1;
  }
  for (
    let node = syntaxTree(context.state).resolveInner(context.pos, -1);
    node;
  ) {
    if (/Comment|VerbatimContent|VerbContent/.test(node.name)) return true;
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}
type ProjectLookup = (
  query: IndexQuery,
  aborted: () => boolean,
) => Promise<IndexResult | null>;
async function complete(
  context: CompletionContext,
  active: string,
  lookup?: ProjectLookup,
): Promise<CompletionResult | null> {
  if (ignored(context)) return null;
  const token = context.matchBefore(/\\[A-Za-z@]*$/);
  if (!token) {
    const reference = referenceKeyContext(context);
    if (reference && lookup) {
      context.addEventListener("abort", () => {}, { onDocChange: true });
      const index = await lookup(
        reference.kind === "labels"
          ? { active, kind: "labels" }
          : { active, kind: "citations", term: reference.term },
        () => context.aborted,
      );
      if (!index || context.aborted) return null;
      if (reference.kind === "labels") {
        return {
          from: reference.from,
          to: context.pos,
          // Filter the typed prefix only; replace any remaining key suffix on accept.
          options: (index.labels ?? []).map(({ key, paths }) => ({
            label: key,
            type: "reference",
            detail: paths.join(", "),
            apply(view, completion, from, to) {
              const line = view.state.doc.lineAt(to);
              const suffix = /^[^{}\s%\\]*/.exec(
                line.text.slice(to - line.from),
              )![0];
              view.dispatch(
                insertCompletionText(view.state, key, from, to + suffix.length),
                {
                  annotations: pickedCompletion.of(completion),
                  userEvent: "input.complete",
                },
              );
            },
          })),
          validFor: /^[^{}\s%\\]*$/,
        };
      }
      return {
        from: reference.from,
        to: reference.to,
        filter: false,
        options: (index.citations ?? []).map(({ key, metadata, paths }) => ({
          label: key,
          type: "reference",
          detail: metadata,
          info: paths.join(", "),
          apply: key,
        })),
      };
    }
    return upstream(
      context.explicit
        ? context
        : new CompletionContext(context.state, context.pos, true),
    );
  }
  const previous = context.state.doc.lineAt(token.from);
  const precedingSlashes =
    previous.text.slice(0, token.from - previous.from).match(/\\+$/)?.[0]
      .length ?? 0;
  if (precedingSlashes % 2) return null;
  const index = await lookup?.(
    { active, kind: "commands" },
    () => context.aborted,
  );
  if (context.aborted) return null;
  const packages = new Set(index?.packages);
  const options = new Map(
    builtins.map((c) => [
      c.label,
      packages.has(c.detail!) ? { ...c, boost: 3 } : c,
    ]),
  );
  for (const [label, args] of index?.commands ?? []) {
    const defined = args !== null;
    if (label === token.text && !defined) continue;
    if (defined || !options.has(label))
      options.set(
        label,
        commandOption(
          label,
          args ?? 0,
          defined ? "Project definition" : "Used in project",
          defined ? 8 : 0,
        ),
      );
  }
  return {
    from: token.from,
    options: [...options.values(), ...snippets],
    validFor: /^\\[A-Za-z@]*$/,
  };
}
export function latexAutocomplete(active = "", lookup?: ProjectLookup) {
  return [
    autocompletion({
      override: [(context) => complete(context, active, lookup)],
      activateOnCompletion: (c) =>
        c.type === "function" && commands.has(c.label),
    }),
    Prec.high(keymap.of([{ key: "Tab", run: acceptCompletion }])),
  ];
}
