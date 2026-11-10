import writingGuidance from "../../../../crates/prism-core/src/writing-guidance.txt?raw";

export const DEFAULT_AGENTS_MD = `# codex-prism LaTeX Project

Academic writing workspace powered by codex-prism.

## Environment

- **Compiler:** system TeX Live; pdfLaTeX by default, with XeLaTeX and LuaLaTeX selected using a TeX engine comment.
- **Build directory:** \`.prism/build/\` (managed by the application).
- **Version history:** ordinary Git history in the document repository (or its existing parent repository/worktree). Prism records accepted changes when the user clicks Keep; do not modify Git metadata or application-managed state.
- **Python:** optional. An existing project \`.venv/\` may be used; environment setup is an explicit action in workspace settings.
- **Scientific skills:** optional, loaded from \`~/.agents/skills/\` or project \`.agents/skills/\` when installed. Skills provide guidance; they do not automatically install their tools.

## Project structure

- Main document: \`main.tex\`, or the project's chosen main filename.
- Bibliography: \`references.bib\`, or the existing project bibliography.
- Reference material: \`attachments/\`; review relevant files before writing.
- Figures: reuse the project's image directory (for example \`figures/\`, \`images/\`, or \`prism-uploads/\`); create \`prism-uploads/\` if none exists. Copy external images into it and use project-relative paths with \`\\includegraphics\`; include TikZ source with \`\\input\`.
- Split large documents with \`\\input\` or \`\\include\`. Preserve matching \`\\begin\` and \`\\end\` environments.

## Writing and editing guidance

${writingGuidance.trim()}
`;
