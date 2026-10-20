export type ChromeSurfaceKind = "panel" | "sidebar" | "composer";

const surfaces = new Map<HTMLElement, ChromeSurfaceKind>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function registerChromeSurface(element: HTMLElement, kind: ChromeSurfaceKind): () => void {
  surfaces.set(element, kind);
  notify();
  return () => {
    surfaces.delete(element);
    notify();
  };
}

export function readChromeSurfaces(): ReadonlyMap<HTMLElement, ChromeSurfaceKind> {
  return surfaces;
}

export function subscribeChromeSurfaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Module-level so each ref keeps one identity across renders; a fresh callback
// would unregister and re-register the element, and repaint, on every render.
export function trackChromePanel(element: HTMLElement | null) {
  return element ? registerChromeSurface(element, "panel") : undefined;
}

export function trackChromeSidebar(element: HTMLElement | null) {
  return element ? registerChromeSurface(element, "sidebar") : undefined;
}

export function trackChromeComposer(element: HTMLElement | null) {
  return element ? registerChromeSurface(element, "composer") : undefined;
}
