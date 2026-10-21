import lockupLg1x from "~/assets/arcex-lockup-lg@1x.webp";
import lockupLg2x from "~/assets/arcex-lockup-lg@2x.webp";
import lockupLg3x from "~/assets/arcex-lockup-lg@3x.webp";
import lockup1x from "~/assets/arcex-lockup@1x.webp";
import lockup2x from "~/assets/arcex-lockup@2x.webp";
import lockup3x from "~/assets/arcex-lockup@3x.webp";
import { cn } from "~/lib/utils";

// Each size ships densities rendered from the full-size artwork, because the
// browser's own downscale breaks up the thin chrome strokes.
const SIZES = {
  md: { width: 120, height: 32, srcs: [lockup1x, lockup2x, lockup3x], className: "h-8 w-[120px]" },
  lg: {
    width: 151,
    height: 40,
    srcs: [lockupLg1x, lockupLg2x, lockupLg3x],
    className: "h-10 w-[151px]",
  },
} as const;

/** The arcex.dev chrome lockup at a fixed pixel size. */
export function ArcexLockup({
  className,
  size = "md",
}: {
  className?: string;
  size?: keyof typeof SIZES;
}) {
  const { width, height, srcs, className: sizeClassName } = SIZES[size];
  return (
    <img
      alt="Arcex"
      className={cn(sizeClassName, "shrink-0 select-none", className)}
      draggable={false}
      height={height}
      src={srcs[0]}
      srcSet={`${srcs[0]} 1x, ${srcs[1]} 2x, ${srcs[2]} 3x`}
      width={width}
    />
  );
}
