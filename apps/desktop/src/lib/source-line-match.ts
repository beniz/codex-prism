/** Match editor text only to an unchanged, unambiguous captured neighborhood. */
export function matchSourceLine(current: string, captured: string, line: number): number | null {
  const lines = current.split(/\r?\n/);
  const index = line - 1;
  if (index < 0 || index >= lines.length) return null;
  if (current === captured) return line;
  if (!lines[index].trim()) return null;
  const start = Math.max(0, index - 2);
  const context = lines.slice(start, index + 3);
  const built = captured.split(/\r?\n/);
  const matches: number[] = [];
  for (let i = 0; i <= built.length - context.length; i++) {
    if (context.every((text, j) => built[i + j] === text)) matches.push(i + index - start + 1);
  }
  return matches.length === 1 ? matches[0] : null;
}
