import { useEffect, useLayoutEffect, useRef, useState, memo } from "react";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { createLogger } from "@/lib/debug/logger";
import { APP_VISIBILITY_RESTORED } from "@/lib/debug/log-store";
import type { StructuredTextData, LinkData } from "@/lib/mupdf/types";

const log = createLogger("mupdf-page");
const RENDER_SCALE_DEBOUNCE_MS = 260;

interface MupdfPageProps {
  docId: number;
  pageIndex: number;
  scale: number;
  pageWidth: number;
  pageHeight: number;
  isVisible: boolean;
  ownerId?: string;
  priority?: "foreground" | "background";
  overlay?: React.ReactNode;
}

export const MupdfPage = memo(function MupdfPage({
  docId,
  pageIndex,
  scale,
  pageWidth,
  pageHeight,
  isVisible,
  ownerId,
  priority = "foreground",
  overlay,
}: MupdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [textLayer, setTextLayer] = useState<{
    docId: number;
    pageIndex: number;
    data: StructuredTextData;
  }>();
  const [linkLayer, setLinkLayer] = useState<{
    docId: number;
    pageIndex: number;
    data: LinkData[];
  }>();
  const textData =
    textLayer?.docId === docId && textLayer.pageIndex === pageIndex
      ? textLayer.data
      : null;
  const links =
    linkLayer?.docId === docId && linkLayer.pageIndex === pageIndex
      ? linkLayer.data
      : [];
  const [renderResolution, setRenderResolution] = useState({
    docId,
    pageIndex,
    scale,
  });
  // A different PDF must never inherit the preceding document's debounced zoom.
  const renderScale =
    renderResolution.docId === docId && renderResolution.pageIndex === pageIndex
      ? renderResolution.scale
      : scale;
  const [pixelRatio, setPixelRatio] = useState(
    () => window.devicePixelRatio || 1,
  );
  const [restoreGeneration, setRestoreGeneration] = useState(0);
  const [renderError, setRenderError] = useState<string>();
  const renderGenRef = useRef(0);

  const cssW = pageWidth * scale;
  const cssH = pageHeight * scale;

  useEffect(() => {
    setRenderResolution((current) =>
      current.docId === docId &&
      current.pageIndex === pageIndex &&
      current.scale === scale
        ? current
        : { docId, pageIndex, scale },
    );
  }, [docId, pageIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isVisible || docId <= 0) return;
    const timeout = window.setTimeout(
      () =>
        setRenderResolution((current) =>
          current.docId === docId &&
          current.pageIndex === pageIndex &&
          current.scale === scale
            ? current
            : { docId, pageIndex, scale },
        ),
      RENDER_SCALE_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [docId, pageIndex, isVisible, scale]);

  // Display density can change without a CSS resize (monitor changes or
  // compositor restoration). Re-arm the media query for each new density.
  useEffect(() => {
    const refresh = () => setPixelRatio(window.devicePixelRatio || 1);
    const query = window.matchMedia(`(resolution: ${pixelRatio}dppx)`);
    query.addEventListener("change", refresh);
    window.addEventListener("resize", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener(APP_VISIBILITY_RESTORED, refresh);
    refresh();
    return () => {
      query.removeEventListener("change", refresh);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(APP_VISIBILITY_RESTORED, refresh);
    };
  }, [pixelRatio]);

  // Restore matching pixels before paint without waiting for either worker.
  useLayoutEffect(() => {
    if (!isVisible || docId <= 0) return;
    const cached = getMupdfClient().peekPage?.(
      docId,
      pageIndex,
      renderScale * 72 * pixelRatio,
    );
    const canvas = canvasRef.current;
    if (cached && canvas) {
      canvas.width = cached.width;
      canvas.height = cached.height;
      canvas.getContext("2d")!.putImageData(cached, 0, 0);
    }
  }, [docId, pageIndex, renderScale, pixelRatio, isVisible, restoreGeneration]);
  useEffect(() => {
    if (isVisible)
      getMupdfClient().promotePage?.(docId, pageIndex, ownerId, priority);
  }, [docId, pageIndex, ownerId, priority, isVisible]);

  // Each effect owns its request. The shared client drops aborted queued work.
  useEffect(() => {
    const abort = new AbortController();
    const gen = ++renderGenRef.current;
    setRenderError(undefined);
    if (!isVisible || docId <= 0) {
      if (canvasRef.current) {
        canvasRef.current.width = 0;
        canvasRef.current.height = 0;
      }
      return;
    }
    const current = () => !abort.signal.aborted && gen === renderGenRef.current;
    if (
      getMupdfClient().peekPage?.(
        docId,
        pageIndex,
        renderScale * 72 * pixelRatio,
      )
    )
      return;
    void getMupdfClient()
      .drawPage(docId, pageIndex, renderScale * 72 * pixelRatio, {
        signal: abort.signal,
        ownerId,
        priority,
      })
      .then(async (imageData) => {
        if (!current()) return;
        const bitmap = await createImageBitmap(imageData);
        try {
          const canvas = canvasRef.current;
          if (!current() || !canvas) return;
          canvas.width = imageData.width;
          canvas.height = imageData.height;
          canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        } finally {
          bitmap.close();
        }
      })
      .catch((err) => {
        if (current()) {
          log.error(`Render error page ${pageIndex}`, { error: String(err) });
          setRenderError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      abort.abort();
      renderGenRef.current++;
    };
  }, [
    docId,
    pageIndex,
    renderScale,
    pixelRatio,
    isVisible,
    restoreGeneration,
    ownerId,
  ]);

  // Text and link layers do not need to be refetched for every zoom change.
  useEffect(() => {
    if (!isVisible || docId <= 0) return;
    const abort = new AbortController();

    const client = getMupdfClient();

    if (!textData)
      client
        .getPageText(docId, pageIndex, {
          signal: abort.signal,
          ownerId,
          priority,
        })
        .then((data) => {
          if (abort.signal.aborted) return;
          setTextLayer({ docId, pageIndex, data });
        })
        .catch(() => {});

    if (!(linkLayer?.docId === docId && linkLayer.pageIndex === pageIndex))
      client
        .getPageLinks(docId, pageIndex, {
          signal: abort.signal,
          ownerId,
          priority,
        })
        .then((data) => {
          if (abort.signal.aborted) return;
          setLinkLayer({ docId, pageIndex, data });
        })
        .catch(() => {});

    return () => {
      abort.abort();
    };
  }, [docId, pageIndex, isVisible, ownerId]);

  // A compositor-restored canvas can be nonblank but stale or blurry.
  // Redraw visible pages instead of relying on an alpha-only blank check.
  useEffect(() => {
    const handleVisibilityRestored = () => {
      if (!isVisible || docId <= 0) return;
      setRestoreGeneration((generation) => generation + 1);
    };
    window.addEventListener(APP_VISIBILITY_RESTORED, handleVisibilityRestored);
    return () =>
      window.removeEventListener(
        APP_VISIBILITY_RESTORED,
        handleVisibilityRestored,
      );
  }, [docId, isVisible]);

  return (
    <div
      className="mupdf-page relative mb-4 shadow-lg"
      data-page-number={pageIndex + 1}
      style={{ width: cssW, height: cssH }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: cssW, height: cssH, display: "block" }}
      />

      {overlay}
      {renderError && isVisible && (
        <div
          role="status"
          className="absolute top-2 right-2 left-2 z-10 rounded bg-background/95 p-2 text-destructive text-xs shadow"
        >
          Could not render this page: {renderError}
        </div>
      )}
      {/* Text layer for selection */}
      {textData && (
        <svg
          className="mupdf-text-layer"
          viewBox={`0 0 ${pageWidth} ${pageHeight}`}
          preserveAspectRatio="none"
          style={{ width: cssW, height: cssH }}
        >
          {textData.blocks.map(
            (block, bi) =>
              block.type === "text" &&
              block.lines.map((line, li) => (
                <text
                  key={`${bi}-${li}`}
                  x={line.bbox.x}
                  y={line.y}
                  fontSize={line.font.size}
                  fontFamily={line.font.family || line.font.name || "serif"}
                  textLength={line.bbox.w > 0 ? line.bbox.w : undefined}
                  lengthAdjust="spacingAndGlyphs"
                >
                  {line.text}
                </text>
              )),
          )}
        </svg>
      )}

      {/* Link layer */}
      {links.length > 0 && (
        <div className="mupdf-link-layer">
          {links.map((link, i) => (
            <a
              key={i}
              href={link.href}
              data-external={link.isExternal ? "true" : undefined}
              style={{
                left: `${(link.x / pageWidth) * 100}%`,
                top: `${(link.y / pageHeight) * 100}%`,
                width: `${(link.w / pageWidth) * 100}%`,
                height: `${(link.h / pageHeight) * 100}%`,
              }}
            >
              <span className="sr-only">Link</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
});
