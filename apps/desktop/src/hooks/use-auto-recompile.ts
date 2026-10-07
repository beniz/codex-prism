import { useEffect, useRef } from "react";

/** Debounce edits, retain changes during compilation, and never retry an unchanged failure. */
export function useAutoRecompile({
  enabled,
  documentKey,
  generation,
  busy,
  compile,
}: {
  enabled: boolean;
  documentKey: string | null;
  generation: number;
  busy: boolean;
  compile: () => Promise<void>;
}) {
  const callback = useRef(compile);
  callback.current = compile;
  const observed = useRef({ documentKey, generation });

  useEffect(() => {
    // Opening a document should still load its existing PDF first.
    if (
      !enabled ||
      !documentKey ||
      observed.current.documentKey !== documentKey
    ) {
      observed.current = { documentKey, generation };
      return;
    }
    if (busy || observed.current.generation === generation) return;
    const timer = setTimeout(() => {
      observed.current = { documentKey, generation };
      void callback.current();
    }, 1000);
    return () => clearTimeout(timer);
  }, [enabled, documentKey, generation, busy]);
}
