# Moving an OpenAI Prism project to codex-prism

You can continue writing a Prism report, paper, or slide deck in codex-prism using its exported LaTeX files. Start with one project. Keep a copy of its last PDF so you can check the local build before making your first edit.

**Export your files before January 1, 2027.** OpenAI has announced that Prism will shut down on that date and that Prism data will be deleted after shutdown. [OpenAI shutdown notice](https://openai.com/index/introducing-prism/) · [OpenAI export guide](https://help.openai.com/en/articles/20001615-prism-to-codex-migration-guide)

## 1. Save the project and its reference PDF

1. In Prism, open the project-title menu and choose **Export (zip)**. To back up all projects you own, use **Settings → Data Controls → Export all projects (zip) → Download zip**. If a project is missing from the bulk export, check `export-errors.json` and try that project's export menu.
2. Open the latest successful preview in Prism and choose **Download PDF**. Store that PDF alongside the original ZIP. Keeping it outside the working folder makes it easy to compare the two versions later.
3. Save unresolved inline comments and any earlier versions you need separately. If you use Zotero, refresh or export the project's `.bib` file. The live Zotero connection, Prism revision history, and collaborator permissions do not transfer. A bulk export may contain conversation JSON files you can read for reference.

## 2. Open the extracted folder in codex-prism

1. Download codex-prism and follow the setup instructions for your OS. The app uses a local TeX installation to build the PDF and the Codex CLI for chat. [Installation and quickstart](../README.md#quickstart)
2. Extract the ZIP into a working folder. Preserve the directory structure so the main document can still find its chapters, figures, bibliography, and custom style files.
3. Launch codex-prism. In the project picker, click **Import** and select the extracted folder for **one document**. For example, if the export contains `projects/validation-report/main.tex` and `projects/validation-report/figures/`, select `validation-report`. **Import** opens that folder in place.

## 3. Build and compare the PDF

Open the main `.tex` file, usually the one containing `\documentclass`. In the PDF pane, click **Compile**, or **Recompile** if a preview is already visible. This gives you a local build to compare with the PDF you saved from Prism.

Check one page you know well. Look at the figure and its caption, follow a citation to the bibliography, and check a numbered cross-reference. Then compare the page count and any layout that matters for delivery, such as a report cover or a slide with a full-width figure.

| What you see | What to check first |
| --- | --- |
| A missing figure, class, or style file | Compare the path and filename in the first error with the extracted files, including capitalization. Restore project files from the export. For a missing TeX package, install it in your local TeX distribution. |
| A font or engine error | The default is pdfLaTeX. If the project uses XeLaTeX or LuaLaTeX, put `% !TEX program = xelatex` or `% !TEX program = lualatex` within the main file’s first 20 lines. Check that the required fonts are installed. |
| Question marks in place of citations | Check that the referenced `.bib` file contains the cited key and that the bibliography tool the project uses (BibTeX or Biber) is installed. Recompile. |

See the [local compilation guide](../README_AGENTS.md#latex-compilation).

## 4. Review your first edit

Once the local PDF looks right, choose **Connection → Sign in** and try a small request on a passage you know.

> Shorten the opening paragraph by one sentence. Keep all measurements, citations, and conclusions intact.

Read the proposed paragraph in the PDF. Choose **Keep** to accept the proposal and record it in Git history, or **Discard changes** to return to the accepted version. Project files and compilation are local. When you use chat, Codex sends the prompt and the content it uses to your configured AI provider. [Files and privacy](../README.md#your-files-and-privacy)

If you wrote with colleagues in Prism, you can now set up asynchronous review through GitHub or Gitea and grant your collaborators access to that repository. [Collaboration setup](collaboration.md)
