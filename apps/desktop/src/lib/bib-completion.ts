// Read literal BibTeX/BibLaTeX entries. Unknown string macros remain readable
// as written; this index never invokes a bibliography processor.
export interface BibEntry {
  key: string;
  metadata: string;
  search: string;
}
export function bibliographyEntries(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const header = /@([a-z][\w-]*)\s*([{(])/gi;
  const field = /\s*,?\s*([\w-]+)\s*=\s*/y;
  let entry: RegExpExecArray | null;
  while ((entry = header.exec(text))) {
    let i = header.lastIndex;
    const close = entry[2] === "{" ? "}" : ")";
    if (/^(?:comment|preamble|string)$/i.test(entry[1])) {
      let depth = 1;
      for (; depth && i < text.length; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === entry[2]) depth++;
        else if (text[i] === close) depth--;
      }
      header.lastIndex = i;
      continue;
    }
    const keyPattern = /\s*([^\s{},()@]+)\s*,/y;
    keyPattern.lastIndex = i;
    const key = keyPattern.exec(text)?.[1];
    if (!key) continue;
    i = keyPattern.lastIndex;
    const values = new Map<string, string>();
    let closed = false;
    while (i < text.length) {
      while (/[\s,]/.test(text[i] ?? "")) i++;
      if (text[i] === close) {
        i++;
        closed = true;
        break;
      }
      if (text[i] === "%") {
        const newline = text.indexOf("\n", i);
        i = newline < 0 ? text.length : newline + 1;
        continue;
      }
      field.lastIndex = i;
      const name = field.exec(text)?.[1].toLowerCase();
      if (!name) break;
      i = field.lastIndex;
      let value = "";
      do {
        if (text[i] === "#") i++;
        while (/\s/.test(text[i] ?? "")) i++;
        const open = text[i];
        if (open === "{" || open === '"') {
          const start = ++i;
          let nested = 0;
          while (i < text.length) {
            if (text[i] === "\\") {
              i += 2;
              continue;
            }
            if (!nested && text[i] === (open === "{" ? "}" : '"')) break;
            if (text[i] === "{") nested++;
            if (text[i] === "}" && nested) nested--;
            i++;
          }
          value += text.slice(start, i++);
        } else {
          const start = i;
          while (i < text.length && !/[\s,#})]/.test(text[i])) i++;
          value += text.slice(start, i);
        }
        while (/\s/.test(text[i] ?? "")) i++;
      } while (text[i] === "#");
      if (["author", "title", "date", "year"].includes(name))
        values.set(
          name,
          value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim(),
        );
    }
    if (!closed) continue; // Resume at the next entry after malformed input.
    header.lastIndex = i;
    const metadata = [
      values.get("author"),
      values.get("year") ?? values.get("date"),
      values.get("title"),
    ]
      .filter(Boolean)
      .join(" · ");
    entries.push({ key, metadata, search: metadata.toLowerCase() });
  }
  return entries;
}
