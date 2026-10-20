import {
  createChromeRenderer,
  type ChromeRenderer,
  type ChromeSurfaceRect,
} from "./chromeRenderer";
import { observeResize } from "~/lib/observeResize";

import { readChromeSurfaces, subscribeChromeSurfaces } from "./chromeSurfaces";

// Highlights stay sharp at 1.5x and the fill cost drops by almost half on 2x
// displays compared with full device resolution.
const MAX_PIXEL_RATIO = 1.5;
const POINTER_SMOOTHING_MS = 110;
// The pointer only lights metal it can see: the frame and a band just inside
// each panel edge. Anywhere deeper, moving the mouse never repaints.
const POINTER_EDGE_REACH = 56;
const PULSE_DURATION_MS = 820;

// Matches --background under html[data-chrome-shell] in index.css.
const PANEL_BASE: readonly [number, number, number] = [5 / 255, 6 / 255, 8 / 255];

export interface ChromeController {
  /** Sends a short light pulse into a point on screen, in CSS pixels. */
  readonly pulse: (x: number, y: number) => void;
  readonly dispose: () => void;
}

function roundRectDistance(x: number, y: number, surface: ChromeSurfaceRect): number {
  const halfWidth = surface.width / 2;
  const halfHeight = surface.height / 2;
  const qx = Math.abs(x - surface.x - halfWidth) - halfWidth + surface.radius;
  const qy = Math.abs(y - surface.y - halfHeight) - halfHeight + surface.radius;
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - surface.radius
  );
}

function measureSurfaces(): ChromeSurfaceRect[] {
  const measured: ChromeSurfaceRect[] = [];
  for (const [element, kind] of readChromeSurfaces()) {
    // The sidebar container pads its rounded inner panel off the window edge.
    const target =
      kind === "sidebar"
        ? (element.querySelector<HTMLElement>(":scope > [data-slot='sidebar-inner']") ?? element)
        : element;
    const rect = target.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || rect.right <= 0) continue;
    const radius = Number.parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
    measured.push({
      kind,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      radius: Math.min(radius, rect.width / 2, rect.height / 2),
    });
  }
  return measured;
}

export function mountChromeController(canvas: HTMLCanvasElement): ChromeController | null {
  let renderer: ChromeRenderer | null = createChromeRenderer(canvas);
  if (!renderer) return null;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let surfaces: ChromeSurfaceRect[] = [];
  let layoutDirty = true;
  const pointer = { x: 0, y: 0, strength: 0, targetX: 0, targetY: 0, targetStrength: 0 };
  let activePulse: { x: number; y: number; startedAt: number } | null = null;
  let frameHandle = 0;
  let lastFrameTime = 0;

  const step = (time: number) => {
    frameHandle = 0;
    const elapsed = lastFrameTime === 0 ? 16 : Math.min(time - lastFrameTime, 64);
    lastFrameTime = time;
    if (layoutDirty) {
      surfaces = measureSurfaces();
      layoutDirty = false;
    }

    const blend = 1 - Math.exp(-elapsed / POINTER_SMOOTHING_MS);
    pointer.x += (pointer.targetX - pointer.x) * blend;
    pointer.y += (pointer.targetY - pointer.y) * blend;
    pointer.strength += (pointer.targetStrength - pointer.strength) * blend;
    const pointerSettled =
      Math.abs(pointer.strength - pointer.targetStrength) < 0.004 &&
      (pointer.targetStrength === 0 ||
        Math.hypot(pointer.targetX - pointer.x, pointer.targetY - pointer.y) < 0.4);
    if (pointerSettled) {
      pointer.x = pointer.targetX;
      pointer.y = pointer.targetY;
      pointer.strength = pointer.targetStrength;
    }

    let pulseProgress = 0;
    if (activePulse) {
      pulseProgress = (time - activePulse.startedAt) / PULSE_DURATION_MS;
      if (pulseProgress >= 1) activePulse = null;
    }

    renderer?.render({
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
      surfaces,
      pointer: { x: pointer.x, y: pointer.y, strength: pointer.strength },
      pulse: activePulse
        ? { x: activePulse.x, y: activePulse.y, progress: pulseProgress, strength: 1 }
        : { x: 0, y: 0, progress: 0, strength: 0 },
      base: PANEL_BASE,
    });

    if (!pointerSettled || activePulse) {
      schedule();
    } else {
      lastFrameTime = 0;
    }
  };

  const schedule = () => {
    if (frameHandle === 0) frameHandle = requestAnimationFrame(step);
  };

  const invalidateLayout = () => {
    layoutDirty = true;
    schedule();
  };

  let stopObservingSurfaces = () => {};
  const observeSurfaces = () => {
    stopObservingSurfaces();
    const observed = new Set<Element>();
    for (const [element, kind] of readChromeSurfaces()) {
      observed.add(element);
      // The composer moves without resizing when a terminal drawer or side
      // panel reshapes the column around it; its ancestors do resize.
      if (kind !== "composer") continue;
      for (
        let ancestor = element.parentElement;
        ancestor && ancestor !== document.body && !observed.has(ancestor);
        ancestor = ancestor.parentElement
      ) {
        observed.add(ancestor);
        if (ancestor.dataset.slot === "sidebar-inset") break;
      }
    }
    stopObservingSurfaces = observeResize([...observed], invalidateLayout);
    invalidateLayout();
  };
  observeSurfaces();
  const unsubscribeSurfaces = subscribeChromeSurfaces(observeSurfaces);

  const onPointerMove = (event: PointerEvent) => {
    if (reducedMotion.matches || event.pointerType === "touch") return;
    let nearest = Number.POSITIVE_INFINITY;
    for (const surface of surfaces) {
      if (surface.kind === "composer") continue;
      nearest = Math.min(nearest, roundRectDistance(event.clientX, event.clientY, surface));
    }
    const targetStrength = nearest > -POINTER_EDGE_REACH ? 1 : 0;
    if (targetStrength === 0 && pointer.targetStrength === 0) return;
    pointer.targetX = event.clientX;
    pointer.targetY = event.clientY;
    if (pointer.strength === 0) {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    }
    pointer.targetStrength = targetStrength;
    schedule();
  };
  const onPointerLeave = () => {
    if (pointer.targetStrength === 0) return;
    pointer.targetStrength = 0;
    schedule();
  };

  const onContextLost = (event: Event) => {
    event.preventDefault();
    renderer = null;
  };
  const onContextRestored = () => {
    renderer = createChromeRenderer(canvas);
    invalidateLayout();
  };

  window.addEventListener("resize", invalidateLayout);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  return {
    pulse(x, y) {
      if (reducedMotion.matches) return;
      activePulse = { x, y, startedAt: performance.now() };
      schedule();
    },
    dispose() {
      if (frameHandle !== 0) cancelAnimationFrame(frameHandle);
      stopObservingSurfaces();
      unsubscribeSurfaces();
      window.removeEventListener("resize", invalidateLayout);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      renderer?.dispose();
      renderer = null;
    },
  };
}
