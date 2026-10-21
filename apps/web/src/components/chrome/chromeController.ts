import { observeResize } from "~/lib/observeResize";

import {
  createChromeRenderer,
  type ChromeRenderer,
  type ChromeSurfaceRect,
} from "./chromeRenderer";
import { readChromeSurfaces, subscribeChromeSurfaces } from "./chromeSurfaces";

// Highlights stay sharp at 1.5x and the fill cost drops by almost half on 2x
// displays compared with full device resolution.
const MAX_PIXEL_RATIO = 1.5;
// The ambient drift moves a few pixels a second, which reads as smooth at
// 30fps; rendering at the display's refresh rate would only burn GPU. Bursts
// (settling, pulses, focus) still render every frame.
const AMBIENT_FRAME_MS = 1000 / 30;
const FOCUS_EASING_MS = 260;
const SETTLE_DECAY_PER_SECOND = 3.2;
const SETTLE_KICK = 0.35;
const PULSE_DURATION_MS = 820;

// Matches --background under html[data-chrome-shell] in index.css.
const PANEL_BASE: readonly [number, number, number] = [5 / 255, 6 / 255, 8 / 255];

export interface ChromeController {
  /** Sends a short light pulse into a point on screen, in CSS pixels. */
  readonly pulse: (x: number, y: number) => void;
  readonly dispose: () => void;
}

function measureSurfaces(): ChromeSurfaceRect[] {
  const measured: ChromeSurfaceRect[] = [];
  for (const [element, kind] of readChromeSurfaces()) {
    // The sidebar registers its container; the content column is the inner element.
    const target =
      kind === "sidebar"
        ? (element.querySelector<HTMLElement>(":scope > [data-slot='sidebar-inner']") ?? element)
        : element;
    const rect = target.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || rect.right <= 0) continue;
    const style = getComputedStyle(target);
    const limit = Math.min(rect.width, rect.height) / 2;
    const corner = (value: string) => Math.min(Number.parseFloat(value) || 0, limit);
    measured.push({
      kind,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      radii: [
        corner(style.borderTopLeftRadius),
        corner(style.borderTopRightRadius),
        corner(style.borderBottomRightRadius),
        corner(style.borderBottomLeftRadius),
      ],
    });
  }
  // Routes mount their panel after the shell, so during boot and route swaps
  // stand one in where it will land instead of flashing bare metal.
  if (!measured.some((surface) => surface.kind === "panel")) {
    const root = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: number) =>
      Number.parseFloat(root.getPropertyValue(name)) || fallback;
    const gap = token("--chrome-gap", 12);
    const radius = token("--chrome-radius", 18);
    const sidebar = measured.find((surface) => surface.kind === "sidebar");
    const left = (sidebar ? sidebar.x + sidebar.width : 0) + gap;
    measured.push({
      kind: "panel",
      x: left,
      y: gap,
      width: Math.max(0, window.innerWidth - left - gap),
      height: Math.max(0, window.innerHeight - 2 * gap),
      radii: [
        token("--chrome-panel-radius-start", radius),
        radius,
        radius,
        token("--chrome-panel-radius-end", radius),
      ],
    });
  }
  return measured;
}

function composerHasFocus(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  for (const [element, kind] of readChromeSurfaces()) {
    if (kind === "composer" && element.contains(active)) return true;
  }
  return false;
}

export function mountChromeController(canvas: HTMLCanvasElement): ChromeController | null {
  let renderer: ChromeRenderer | null = createChromeRenderer(canvas);
  if (!renderer) return null;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let windowFocused = document.hasFocus();
  let surfaces: ChromeSurfaceRect[] = [];
  let layoutDirty = true;
  let hasMeasured = false;
  let ambientTime = 0;
  let settle = { phase: 0, energy: 0 };
  let focus = composerHasFocus() ? 1 : 0;
  let focusTarget = focus;
  let activePulse: { x: number; y: number; startedAt: number } | null = null;
  let frameHandle = 0;
  let lastFrameTime = 0;
  let lastRenderTime = 0;

  const ambientRunning = () => windowFocused && !reducedMotion.matches;

  const step = (time: number) => {
    frameHandle = 0;
    const elapsedMs = lastFrameTime === 0 ? 16 : Math.min(time - lastFrameTime, 64);
    lastFrameTime = time;
    const elapsed = elapsedMs / 1000;

    if (layoutDirty) {
      surfaces = measureSurfaces();
      layoutDirty = false;
      // The first measurement is the shell appearing, not the user adjusting it.
      if (hasMeasured && !reducedMotion.matches) {
        settle.energy = Math.min(1, settle.energy + SETTLE_KICK);
      }
      hasMeasured = true;
    }

    const ambient = ambientRunning();
    if (ambient) ambientTime += elapsed;

    if (settle.energy > 0) {
      settle = {
        phase: settle.phase + elapsed,
        energy: settle.energy * Math.exp(-elapsed * SETTLE_DECAY_PER_SECOND),
      };
      if (settle.energy < 0.01) settle = { phase: 0, energy: 0 };
    }

    focus += (focusTarget - focus) * (1 - Math.exp(-elapsedMs / FOCUS_EASING_MS));
    if (Math.abs(focusTarget - focus) < 0.004) focus = focusTarget;

    let pulseProgress = 0;
    if (activePulse) {
      pulseProgress = (time - activePulse.startedAt) / PULSE_DURATION_MS;
      if (pulseProgress >= 1) activePulse = null;
    }

    const bursting = settle.energy > 0 || activePulse !== null || focus !== focusTarget;
    const due = bursting || !ambient || time - lastRenderTime >= AMBIENT_FRAME_MS - 2;
    if (due) {
      lastRenderTime = time;
      renderer?.render({
        width: window.innerWidth,
        height: window.innerHeight,
        pixelRatio: Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
        surfaces,
        time: ambientTime,
        composerFocus: focus,
        settle,
        pulse: activePulse
          ? { x: activePulse.x, y: activePulse.y, progress: pulseProgress, strength: 1 }
          : { x: 0, y: 0, progress: 0, strength: 0 },
        base: PANEL_BASE,
      });
    }

    if (bursting || ambient) {
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

  const onFocusChange = () => {
    const next = composerHasFocus() ? 1 : 0;
    if (next === focusTarget) return;
    focusTarget = next;
    schedule();
  };
  const onWindowFocus = () => {
    windowFocused = true;
    schedule();
  };
  const onWindowBlur = () => {
    windowFocused = false;
  };
  const onMotionPreferenceChange = () => schedule();

  const onContextLost = (event: Event) => {
    event.preventDefault();
    renderer = null;
  };
  const onContextRestored = () => {
    renderer = createChromeRenderer(canvas);
    invalidateLayout();
  };

  window.addEventListener("resize", invalidateLayout);
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("blur", onWindowBlur);
  document.addEventListener("focusin", onFocusChange);
  document.addEventListener("focusout", onFocusChange);
  reducedMotion.addEventListener("change", onMotionPreferenceChange);
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
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("focusin", onFocusChange);
      document.removeEventListener("focusout", onFocusChange);
      reducedMotion.removeEventListener("change", onMotionPreferenceChange);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      renderer?.dispose();
      renderer = null;
    },
  };
}
