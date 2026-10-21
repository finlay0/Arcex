import type { SVGProps } from "react";

/** The Arcex "A" as a single-colour glyph for icon sizes; the chrome lockup is a raster asset. */
export function ArcexMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 64 40" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M1 39.5C9.5 24 20.5 6 31.5 1.6C36.4-.4 40.2 2.2 43.4 10.6C46.2 18 48.6 28 50.6 39.6C47.4 28.4 43.8 17.6 39.6 12.6C37.8 10.5 36.4 9.8 34.8 9.9C25.8 10.6 14 24.2 1 39.5Z"
        fill="currentColor"
      />
      <path
        d="M14.5 17.6C28.8 15.6 43.4 22.6 54.2 33.2L59.4 39.4C48.4 30.4 34.4 22.6 14.5 17.6Z"
        fill="currentColor"
      />
    </svg>
  );
}
