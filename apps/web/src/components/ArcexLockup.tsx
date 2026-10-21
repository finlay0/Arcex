import lockup1x from "~/assets/arcex-lockup@1x.webp";
import lockup2x from "~/assets/arcex-lockup@2x.webp";
import lockup3x from "~/assets/arcex-lockup@3x.webp";
import { cn } from "~/lib/utils";

/**
 * The arcex.dev chrome lockup at a fixed 120×32. Each density is rendered from
 * the full-size artwork, because the browser's own downscale breaks up the
 * thin chrome strokes.
 */
export function ArcexLockup({ className }: { className?: string }) {
  return (
    <img
      alt="Arcex"
      className={cn("h-8 w-[120px] shrink-0 select-none", className)}
      draggable={false}
      height={32}
      src={lockup1x}
      srcSet={`${lockup1x} 1x, ${lockup2x} 2x, ${lockup3x} 3x`}
      width={120}
    />
  );
}
