export const DEFAULT_AGENTS_MD = `# Codex-Prism LaTeX Project

Academic writing workspace powered by Codex-Prism. You are assisting with a LaTeX document project.

## Environment

- **LaTeX Engine**: Tectonic (handles packages and fonts automatically — no manual \`tlmgr\` needed)
- **Python**: Available via \`uv\` with project-local \`.venv/\`. Use \`uv pip install <pkg>\` to add packages, \`uv run <script>\` to execute.
- **Build Directory**: \`.prism/build/\` (persistent, do not modify directly)
- **Version History**: \`.claudeprism/\` (automatic snapshots, do not modify)

## Project Structure

\`\`\`
.
├── main.tex              # Primary document (or custom-named .tex)
├── references.bib        # Bibliography (if applicable)
├── attachments/           # Reference files (PDFs, images, data)
├── .venv/                 # Python virtual environment (auto-detected)
└── figures/               # Generated figures and plots
\`\`\`

## Commands

\`\`\`bash
# Python (data analysis, plotting, computation)
uv pip install numpy matplotlib pandas scipy     # Install packages
uv run python script.py                          # Run a script

# LaTeX is compiled automatically by Codex-Prism — no manual build commands needed.
\`\`\`

## Writing Guidelines

- Treat scientific publications as the default writing target unless the user or project specifies another purpose. Use precise, evidence-based academic prose appropriate to the intended discipline and venue, and distinguish established findings from hypotheses and original contributions.
- Add references to relevant academic works when supporting substantive claims, describing prior work or methods, or comparing results. Prefer primary research and authoritative reviews; cite sources where they support the text and follow the project's existing bibliography and citation style.
- Verify that each added reference exists, its bibliographic metadata is accurate, and it supports the associated claim, using accessible source material or trusted scholarly records. Never invent papers, authors, DOIs, citations, or findings. If a reference cannot be verified, flag the gap to the user instead of presenting it as verified.
- Edit \`.tex\` files directly. Codex-Prism auto-compiles and shows a live PDF preview.
- Use \`\\input{filename}\` or \`\\include{filename}\` to split large documents into multiple files.
- Place images in a \`figures/\` directory and reference with \`\\includegraphics{figures/name}\`.
- For bibliography, add entries to \`references.bib\` and cite with \`\\cite{key}\`.
- When adding new packages, add \`\\usepackage{pkg}\` to the preamble — Tectonic installs them automatically.

## Scientific Skills

If scientific skills are installed (\`~/.agents/skills/\` or \`.agents/skills/\`), you have access to 100+ domain-specific tools:

- **Data Analysis**: pandas, numpy, scipy, statsmodels, scikit-learn, polars
- **Visualization**: matplotlib, seaborn, plotly (save figures to \`figures/\` directory)
- **Bioinformatics**: scanpy, biopython, pydeseq2, pysam
- **Chemistry**: rdkit, datamol, deepchem
- **Symbolic Math**: sympy
- **Statistical Modeling**: pymc, statsmodels, scikit-survival

For technical drawings and other structured figures (such as schematics, geometry, flowcharts, and architecture diagrams), use LaTeX's \`tikzpicture\` environment unless the user requests another format. Keep the editable TikZ source in the document or in \`figures/<descriptive-name>.tex\`, included with \`\\input{figures/<descriptive-name>}\`. Add \`\\usepackage{tikz}\` and only the required TikZ libraries to the preamble. Match the document's fonts and notation, and check that the figure compiles and its labels remain readable at the intended size. Continue using suitable plotting libraries for data-driven charts.

When generating figures with Python, always:
1. Save to \`figures/<descriptive-name>.pdf\` (vector) or \`.png\` (raster, 300 dpi)
2. Add corresponding \`\\includegraphics\` in the \`.tex\` file
3. Use publication-quality formatting (proper labels, legends, font sizes)

## Gotchas

- Tectonic compiles with pdfTeX by default. For Unicode-heavy documents, add \`% !TEX program = xelatex\` or \`lualatex\` at the top of \`main.tex\`.
- Do NOT create or modify files in \`.prism/\`, \`.claudeprism/\`, or \`.venv/\` — these are managed automatically.
- When modifying LaTeX, ensure matching \`\\begin{}\` / \`\\end{}\` pairs — mismatches cause hard-to-debug compile errors.
- Large tables and figures should use \`\\begin{table}[htbp]\` / \`\\begin{figure}[htbp]\` for proper float placement.
- If the user provides reference files in \`attachments/\`, review them before writing — they contain key context.
`;
