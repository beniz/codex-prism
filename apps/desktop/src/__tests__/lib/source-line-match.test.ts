import { expect, it } from "vitest";
import { matchSourceLine } from "@/lib/source-line-match";
it("maps unchanged and shifted source without guessing changed or repeated context", () => {
  const text = "a\nb\nc\nd\ne";
  expect(matchSourceLine(text, text, 3)).toBe(3);
  expect(matchSourceLine(text, "intro\n" + text, 3)).toBe(4);
  expect(matchSourceLine(text, text + "\n" + text, 3)).toBeNull();
  expect(matchSourceLine(text, "a\nb\nchanged\nd\ne", 3)).toBeNull();
  expect(matchSourceLine("\n", "\n", 1)).toBe(1);
});
