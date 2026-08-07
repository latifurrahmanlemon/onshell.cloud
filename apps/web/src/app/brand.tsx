"use client";

import { useId } from "react";

/**
 * The Onshell mark — a shell prompt (`>_`) on a gradient tile.
 * The gradient reads the live accent tokens (--grad-*), so the logo recolors
 * with the user's chosen theme everywhere it appears. Falls back to the default
 * indigo→violet→fuchsia when those vars are absent.
 *
 * Three details do the work of making it read as a crafted mark rather than a
 * clip-art tile, and all three are why the geometry below looks fussy:
 *
 * - The glyph is optically centred, not mathematically centred. `>` and `_`
 *   together span x 10.4–22, whose midpoint sits right of the tile's own centre;
 *   a prompt with its weight low-left needs that nudge to look centred at 20px.
 * - A hairline inset stroke keeps the tile's edge defined against both a white
 *   header and a near-black one, where a flat gradient rectangle dissolves.
 * - A top-down white wash (12% → 0) gives the tile a light source. Without it
 *   the gradient reads as a flat swatch at small sizes.
 */
export function OnshellMark({ size = 32, className }: { size?: number; className?: string }) {
  const gradientId = useId();
  const sheenId = useId();
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 32 32"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--grad-from, #6366f1)" />
          <stop offset="0.52" stopColor="var(--grad-via, #a855f7)" />
          <stop offset="1" stopColor="var(--grad-to, #ec4899)" />
        </linearGradient>
        <linearGradient id={sheenId} x1="16" y1="0" x2="16" y2="19" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff" stopOpacity="0.12" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* rx 9, not 8: a slightly softer corner reads as deliberate at 36px and
          keeps the tile from looking like a default rounded-rect. */}
      <rect width="32" height="32" rx="9" fill={`url(#${gradientId})`} />
      <rect width="32" height="32" rx="9" fill={`url(#${sheenId})`} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" stroke="#fff" strokeOpacity="0.18" />

      {/* Lighter stroke than before (2.3 vs 2.6): at 36px the old weight closed
          up the chevron's inner angle into a blob. */}
      <path
        d="M10.4 11.6 14.9 16 10.4 20.4"
        stroke="#fff"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M17.6 20.4H22" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
    </svg>
  );
}

/** Full lockup: mark + wordmark, used in nav and footer. */
export function OnshellLogo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: 11 }}>
      <OnshellMark size={size} />
      <span style={{ display: "grid", lineHeight: 1.1 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>Onshell.cloud</span>
      </span>
    </span>
  );
}
