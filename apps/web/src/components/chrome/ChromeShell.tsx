import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useRenderedAppearance } from "../../hooks/useTheme";
import { useSidebar } from "../ui/sidebar";
import { mountChromeController, type ChromeController } from "./chromeController";

/** The liquid-metal frame the desktop-width shell sits in. Dark appearance only. */
export function ChromeShell() {
  const enabled = useClientSettings((settings) => settings.chromeShell);
  const appearance = useRenderedAppearance();
  const { isMobile } = useSidebar();
  if (!enabled || appearance !== "dark" || isMobile) return null;
  return <ChromeBackdrop />;
}

function ChromeBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [controller, setController] = useState<ChromeController | null>(null);
  const pathname = useLocation({ select: (location) => location.pathname });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const mounted = mountChromeController(canvas);
    // Without WebGL2 the shell keeps its regular opaque surfaces.
    if (!mounted) return;
    const root = document.documentElement;
    root.dataset.chromeShell = "";
    setController(mounted);
    return () => {
      delete root.dataset.chromeShell;
      mounted.dispose();
      setController(null);
    };
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 size-full"
        data-chrome-backdrop=""
      />
      {controller ? <ActiveThreadPulse key={pathname} controller={controller} /> : null}
    </>
  );
}

/** Keyed by pathname: each navigation sends light into the newly active sidebar row. */
function ActiveThreadPulse({ controller }: { controller: ChromeController }) {
  useEffect(() => {
    const row = document.querySelector("[data-app-sidebar] [aria-current='page']");
    if (!row) return;
    const rect = row.getBoundingClientRect();
    controller.pulse(rect.right, rect.top + rect.height / 2);
  }, [controller]);
  return null;
}
