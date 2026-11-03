import { describe, expect, it } from "vitest";
import { parseTableOfContents } from "@/lib/latex-outline";

describe("outline numbering", () => {
  it("numbers nested headings and resets subordinate counters", () => {
    const toc = parseTableOfContents(String.raw`\section{Introduction}
\subsection{Context}
\subsubsection{Details}
\subsection{Goals}
\section{Methods}
\subsection{Setup}`);
    expect(toc.map((item) => item.number)).toEqual([
      "1",
      "1.1",
      "1.1.1",
      "1.2",
      "2",
      "2.1",
    ]);
    expect(toc[5]).toMatchObject({ title: "Setup", line: 6 });
  });

  it("does not count starred or commented headings", () => {
    const toc = parseTableOfContents(String.raw`% \section{Ignored}
\section*[Short]{Preface}
\section[Short]{First} % \section{Ignored}
\section*{Acknowledgements}
\section{Second}`);
    expect(toc.map((item) => item.number)).toEqual([null, "1", null, "2"]);
    expect(toc.map((item) => item.title)).toEqual([
      "Preface",
      "First",
      "Acknowledgements",
      "Second",
    ]);
  });

  it("includes chapter counters while keeping parts independent", () => {
    const toc = parseTableOfContents(String.raw`\part{First}
\chapter{One}
\section{Section}
\subsection{Subsection}
\part{Second}
\chapter{Two}
\section{Section}`);
    expect(toc.map((item) => item.number)).toEqual([
      "I",
      "1",
      "1.1",
      "1.1.1",
      "II",
      "2",
      "2.1",
    ]);
  });
});

describe("Beamer slide outline", () => {
  it("lists frames under sections with options, overlays and nested title formatting", () => {
    const toc = parseTableOfContents(String.raw`\documentclass{beamer}
\begin{document}
\section{Results}
\begin{frame}<1->[t,fragile]{First \textbf{result}}
Body
\end{frame}
\begin{frame}
\frametitle[Short]{Second result}
Body
\end{frame}
\end{document}`);
    expect(toc).toEqual([
      { level: 2, title: "Results", line: 3, number: "1" },
      { level: 3, title: "First result", line: 4, number: "1" },
      { level: 3, title: "Second result", line: 8, number: "2" },
    ]);
  });
  it("handles title pages, untitled frames, command frames, multiline titles and comments", () => {
    const toc = parseTableOfContents(String.raw`\newcommand{\cover}{\begin{frame}\titlepage\end{frame}}
\begin{document}
% \begin{frame}{Ignored}\end{frame}
\begin{frame}[plain]\titlepage\end{frame}
\begin{frame}Body\end{frame}
\frame<2->{\frametitle{Command slide}Body}
\begin{frame}[t]
{A multiline
 title with 50\% improvement}
Body % \frametitle{Ignored}
\end{frame}`);
    expect(toc.map(({title, line}) => ({title, line}))).toEqual([
      { title: "Title slide", line: 4 },
      { title: "Slide 2", line: 5 },
      { title: "Command slide", line: 6 },
      { title: "A multiline title with 50\\% improvement", line: 7 },
    ]);
  });
  it("ignores incomplete frames while typing and parses frames in included source files", () => {
    expect(parseTableOfContents(String.raw`\begin{frame}{Incomplete}`)).toEqual([]);
    expect(parseTableOfContents(String.raw`\documentclass{article}\frame{Boxed text}`)).toEqual([]);
    expect(parseTableOfContents(String.raw`\begin{frame}{Included}\end{frame}`)[0].title).toBe("Included");
  });
});
