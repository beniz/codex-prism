import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { highlightChatCode } from "./chat-code-highlighter";
import { readFileSync } from "node:fs";
const css = readFileSync("src/styles/syntax-theme.css", "utf8");

function highlighted(language: string, source: string) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <code>{highlightChatCode(language, source)}</code>,
  );
  expect(host.textContent).toBe(source);
  return host;
}
it("uses source-editor token roles for LaTeX commands, citations, comments and mathematics", () => {
  const host = highlighted(
    "tex",
    "% A comment\n\\section{Results}\nSee \\cite{smith} and $x^2$.\n",
  );
  expect(host.querySelector(".syntax-heading")?.textContent).toBe("\\section");
  expect(host.querySelector(".syntax-comment")?.textContent).toContain(
    "% A comment",
  );
  expect(host.querySelector(".syntax-string")?.textContent).toBe("\\cite");
  expect(host.querySelector(".syntax-special")?.textContent).toBe("$");
});
it("highlights BibTeX with the same parser used in the editor", () => {
  const host = highlighted(
    "bibtex",
    "@article{smith,\n title = {A paper},\n year = 2026\n}\n",
  );
  expect(host.querySelector(".syntax-command")).not.toBeNull();
  expect(host.querySelector(".syntax-string")).not.toBeNull();
});
it.each([
  ["py", 'print("result")', ".hljs-built_in"],
  ["js", "const answer = 42;", ".hljs-keyword"],
  ["ts", "const answer: number = 42;", ".hljs-keyword"],
  ["shell", 'echo "result"', ".hljs-built_in"],
  ["powershell", 'Write-Output "result"', ".hljs-string"],
  ["dos", "echo result", ".hljs-built_in"],
  ["json", '{"answer": 42}', ".hljs-number"],
  ["yaml", "answer: 42", ".hljs-number"],
  ["toml", 'title = "Report"', ".hljs-string"],
  ["diff", "-old\n+new\n", ".hljs-addition"],
])("highlights labelled %s blocks without changing their source", (language, source, selector) => {
  expect(highlighted(language, source).querySelector(selector)).not.toBeNull();
});
it("renders HTML as source rather than executable markup", () => {
  const host = highlighted(
    "html",
    '<img src=x onerror="alert(1)"><script>alert(2)</script>',
  );
  expect(host.querySelector("img, script")).toBeNull();
  expect(host.querySelector(".hljs-name")).not.toBeNull();
});

function luminance(hex: string) {
  const rgb = hex
    .slice(1)
    .match(/../g)!
    .map((v) => parseInt(v, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
it.each([
  ":root",
  ".dark",
])("keeps the %s palette readable on chat and editor backgrounds", (selector) => {
  const declarations = css.slice(css.indexOf(selector)).split("}")[0];
  const colours = Object.fromEntries(
    [...declarations.matchAll(/--syntax-([\w-]+):\s*(#[\da-f]{6})/g)].map(
      (m) => [m[1], m[2]],
    ),
  );
  for (const role of [
    "foreground",
    "command",
    "string",
    "number",
    "special",
    "comment",
    "error",
  ]) {
    for (const background of [
      colours.surface,
      selector === ":root" ? "#ffffff" : "#141414",
    ]) {
      expect(
        contrast(colours[role], background),
        `${selector} ${role}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(contrast(colours.string, colours.addition)).toBeGreaterThanOrEqual(
    4.5,
  );
  expect(contrast(colours.error, colours.deletion)).toBeGreaterThanOrEqual(4.5);
});

it("colours included figures and bracketed math delimiters", () => {
  const host = highlighted(
    "latex",
    String.raw`\includegraphics{figure.pdf} \[ x^2 \]`,
  );
  expect(host.querySelector(".syntax-command")?.textContent).toBe(
    "\\includegraphics",
  );
  expect(host.querySelector(".syntax-special")?.textContent).toBe("\\[");
});

it.each([
  ":root",
  ".dark",
])("keeps the %s file/image activity accent readable", (selector) => {
  const declarations = readFileSync("src/styles/activity-theme.css", "utf8")
    .split(selector)[1]
    .split("}")[0];
  const colour = declarations.match(/#[\da-f]{6}/)![0];
  for (const background of selector === ":root"
    ? ["#ffffff", "#f5f5f5"]
    : ["#141414", "#242424"]) {
    expect(contrast(colour, background)).toBeGreaterThanOrEqual(4.5);
  }
});
