import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoRecompile } from "@/hooks/use-auto-recompile";

let root: Root;
let container: HTMLDivElement;
const compile = vi.fn(async () => {});
let props: Parameters<typeof useAutoRecompile>[0];
function Harness() {
  useAutoRecompile(props);
  return null;
}
function render(update = {}) {
  props = { ...props, ...update };
  act(() => root.render(<Harness />));
}
function tick() {
  act(() => vi.advanceTimersByTime(1000));
}
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  compile.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
  props = {
    enabled: true,
    documentKey: "paper",
    generation: 0,
    busy: false,
    compile,
  };
  render();
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});
it("loads existing PDFs without compiling and debounces edits", () => {
  tick();
  expect(compile).not.toHaveBeenCalled();
  render({ generation: 1 });
  act(() => vi.advanceTimersByTime(500));
  render({ generation: 2 });
  act(() => vi.advanceTimersByTime(500));
  expect(compile).not.toHaveBeenCalled();
  tick();
  expect(compile).toHaveBeenCalledTimes(1);
});
it("cancels queued compilation when disabled or switching documents", () => {
  render({ generation: 1 });
  render({ enabled: false });
  tick();
  expect(compile).not.toHaveBeenCalled();
  render({ enabled: true, generation: 2 });
  render({ documentKey: "another" });
  tick();
  expect(compile).not.toHaveBeenCalled();
});
it("waits for ongoing compilation or review and compiles the latest edits once", () => {
  render({ busy: true, generation: 1 });
  tick();
  render({ generation: 2 });
  tick();
  expect(compile).not.toHaveBeenCalled();
  render({ busy: false });
  tick();
  expect(compile).toHaveBeenCalledTimes(1);
  render({ busy: true });
  render({ busy: false });
  tick();
  expect(compile).toHaveBeenCalledTimes(1);
});
