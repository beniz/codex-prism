import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

function Composer() {
  useKeyboardShortcuts();
  return <textarea defaultValue="Cut this text" />;
}

it.each(["ctrlKey", "metaKey"] as const)(
  "preserves native cut with %s and reserves Shift+X for Capture & Ask",
  async (modifier) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const capture = vi.fn();
    window.addEventListener("toggle-capture-mode", capture);
    try {
      await act(async () => root.render(<Composer />));
      const field = host.querySelector("textarea")!;
      field.focus();
      field.setSelectionRange(0, 4);
      const cut = new KeyboardEvent("keydown", {
        key: "x", [modifier]: true, bubbles: true, cancelable: true,
      });
      field.dispatchEvent(cut);
      expect(cut.defaultPrevented).toBe(false);
      expect(capture).not.toHaveBeenCalled();

      const shortcut = new KeyboardEvent("keydown", {
        key: "X", [modifier]: true, shiftKey: true,
        bubbles: true, cancelable: true,
      });
      field.dispatchEvent(shortcut);
      expect(shortcut.defaultPrevented).toBe(true);
      expect(capture).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      window.removeEventListener("toggle-capture-mode", capture);
      host.remove();
    }
  },
);
