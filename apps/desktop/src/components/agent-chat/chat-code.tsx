import { TranscriptActivity } from "./transcript-activity";
import { memo, useContext, useEffect, useState, type ReactNode } from "react";

const MAX_HIGHLIGHT_LENGTH = 20_000;
let modulePromise:
  | Promise<typeof import("@/lib/chat-code-highlighter")>
  | undefined;
function loadHighlighter() {
  modulePromise ??= import("@/lib/chat-code-highlighter").catch((error) => {
    modulePromise = undefined;
    throw error;
  });
  return modulePromise;
}

/** Text updates immediately. Colouring waits for a brief pause in streaming. */
export const ChatCode = memo(function ChatCode({
  code,
  language,
  className,
}: {
  code: string;
  language?: string;
  className?: string;
}) {
  const active = useContext(TranscriptActivity);
  const [highlighted, setHighlighted] = useState<{
    code: string;
    language: string;
    nodes: ReactNode;
  }>();
  useEffect(() => {
    if (highlighted?.code === code && highlighted.language === language) return;
    if (!active || !language || code.length > MAX_HIGHLIGHT_LENGTH) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadHighlighter()
        .then((highlighter) => {
          if (!cancelled)
            setHighlighted({
              code,
              language,
              nodes: highlighter.highlightChatCode(language, code),
            });
        })
        .catch(() => {
          /* Highlighting is optional; keep the exact source visible. */
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, language, active, highlighted]);
  return (
    <code
      className={[language ? "chat-code" : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      {highlighted?.code === code && highlighted.language === language
        ? highlighted.nodes
        : code}
    </code>
  );
});
