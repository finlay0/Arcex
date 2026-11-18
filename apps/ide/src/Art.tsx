/**
 * The light art behind the start screens: two very large curved planes and a beam, each catching light along its edge.
 * Drawn in the theme's ink colour at low strength, so it reads as silver on black and as soft grey on white.
 */
export function Art() {
  const ink = "rgb(var(--art))";
  const stop = (offset: string, opacity: number) => <stop offset={offset} style={{ stopColor: ink, stopOpacity: opacity }} />;
  return (
    <svg className="art" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id="art-fill-a" cx="62%" cy="6%" r="62%">
          {stop("0%", 0.22)}
          {stop("45%", 0.08)}
          {stop("100%", 0)}
        </radialGradient>
        <radialGradient id="art-fill-b" cx="18%" cy="88%" r="60%">
          {stop("0%", 0.17)}
          {stop("50%", 0.06)}
          {stop("100%", 0)}
        </radialGradient>
        <linearGradient id="art-rim-a" x1="0" y1="0.2" x2="1" y2="0">
          {stop("0%", 0)}
          {stop("38%", 1)}
          {stop("70%", 0.4)}
          {stop("100%", 0)}
        </linearGradient>
        <linearGradient id="art-rim-b" x1="0" y1="1" x2="0.6" y2="0">
          {stop("0%", 0)}
          {stop("45%", 0.85)}
          {stop("100%", 0)}
        </linearGradient>
        <linearGradient id="art-beam" x1="0.2" y1="0" x2="0.9" y2="0.8">
          {stop("0%", 0.15)}
          {stop("60%", 0.05)}
          {stop("100%", 0)}
        </linearGradient>
        <filter id="art-soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
      </defs>
      {/* A beam falling from the top towards the right edge. */}
      <path d="M560 0 L1600 470 L1600 0 Z" fill="url(#art-beam)" />
      {/* The plane rising from the lower left. */}
      <circle cx="-160" cy="1240" r="840" fill="url(#art-fill-a)" />
      <circle cx="-160" cy="1240" r="840" fill="none" stroke="url(#art-rim-a)" strokeWidth="16" filter="url(#art-soft)" opacity="0.8" />
      <circle cx="-160" cy="1240" r="840" fill="none" stroke="url(#art-rim-a)" strokeWidth="1.6" />
      {/* The plane leaning in from the upper right. */}
      <circle cx="2060" cy="-560" r="1000" fill="url(#art-fill-b)" />
      <circle cx="2060" cy="-560" r="1000" fill="none" stroke="url(#art-rim-b)" strokeWidth="14" filter="url(#art-soft)" opacity="0.65" />
      <circle cx="2060" cy="-560" r="1000" fill="none" stroke="url(#art-rim-b)" strokeWidth="1.4" />
    </svg>
  );
}
