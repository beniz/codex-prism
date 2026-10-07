import { getCurrentWebview } from "@/lib/backend/desktop-host";

export const APP_ZOOM_STORAGE_KEY = "claude-prism-app-zoom";
export const LOCAL_ZOOM_SHORTCUTS_ATTR = "data-local-zoom-shortcuts";
export const DEFAULT_APP_ZOOM = 1;
export const MIN_APP_ZOOM = 0.5;
export const MAX_APP_ZOOM = 3;
export const APP_ZOOM_STEP = 0.1;

let nativeWheelZoomGuardInstalled = false;

export type AppZoomAction = "in" | "out" | "reset";

type ZoomShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "key" | "metaKey"
>;

function roundZoom(value: number): number {
  return Math.round(value * 100) / 100;
}

export function clampAppZoom(value: number): number {
  return roundZoom(Math.min(MAX_APP_ZOOM, Math.max(MIN_APP_ZOOM, value)));
}

export function readStoredAppZoom(): number {
  const raw = window.localStorage.getItem(APP_ZOOM_STORAGE_KEY);
  if (raw === null) return DEFAULT_APP_ZOOM;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_APP_ZOOM;

  return clampAppZoom(parsed);
}

async function applyAppZoom(value: number): Promise<number> {
  const zoom = clampAppZoom(value);
  await getCurrentWebview().setZoom(zoom);
  return zoom;
}

export async function persistAppZoom(value: number): Promise<number> {
  const zoom = await applyAppZoom(value);
  window.localStorage.setItem(APP_ZOOM_STORAGE_KEY, zoom.toString());
  return zoom;
}

export function initializeAppZoom(): Promise<number> {
  installNativeWheelZoomGuard();
  window.localStorage.removeItem(APP_ZOOM_STORAGE_KEY);
  return applyAppZoom(DEFAULT_APP_ZOOM);
}

export function zoomInApp(): Promise<number> {
  return persistAppZoom(readStoredAppZoom() + APP_ZOOM_STEP);
}

export function zoomOutApp(): Promise<number> {
  return persistAppZoom(readStoredAppZoom() - APP_ZOOM_STEP);
}

export function resetAppZoom(): Promise<number> {
  return persistAppZoom(DEFAULT_APP_ZOOM);
}

export function getAppZoomAction(
  event: ZoomShortcutEvent,
): AppZoomAction | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) {
    return null;
  }

  if (
    event.key === "+" ||
    event.key === "=" ||
    event.code === "Equal" ||
    event.code === "NumpadAdd"
  ) {
    return "in";
  }

  if (
    event.key === "-" ||
    event.key === "_" ||
    event.code === "Minus" ||
    event.code === "NumpadSubtract"
  ) {
    return "out";
  }

  if (
    event.key === "0" ||
    event.code === "Digit0" ||
    event.code === "Numpad0"
  ) {
    return "reset";
  }

  return null;
}

export function shouldHandleAppZoomShortcut(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return true;
  return !target.closest(`[${LOCAL_ZOOM_SHORTCUTS_ATTR}]`);
}

function hasLocalZoomSurfaceAtPoint(event: WheelEvent): boolean {
  if (typeof document.elementsFromPoint !== "function") return false;

  return document
    .elementsFromPoint(event.clientX, event.clientY)
    .some((element) => element.closest(`[${LOCAL_ZOOM_SHORTCUTS_ATTR}]`));
}

function hasLocalZoomSurfaceInPath(event: WheelEvent): boolean {
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof Element &&
        !!target.closest(`[${LOCAL_ZOOM_SHORTCUTS_ATTR}]`),
    );
}

function shouldHandleNativeWheelZoom(event: WheelEvent): boolean {
  return (
    shouldHandleAppZoomShortcut(event.target) &&
    !hasLocalZoomSurfaceInPath(event) &&
    !hasLocalZoomSurfaceAtPoint(event)
  );
}

export function installNativeWheelZoomGuard(): void {
  if (nativeWheelZoomGuardInstalled || typeof document === "undefined") return;
  nativeWheelZoomGuardInstalled = true;

  document.addEventListener(
    "wheel",
    (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (!shouldHandleNativeWheelZoom(event)) return;
      event.preventDefault();
    },
    { passive: false },
  );
}
