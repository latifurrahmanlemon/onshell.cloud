"use client";

import { useId } from "react";

/**
 * The Onshell mark — a shell prompt (`>_`) on a gradient tile.
 * The gradient reads the live accent tokens (--grad-*), so the logo recolors
 * with the user's chosen theme everywhere it appears. Falls back to the default
 * indigo→violet→fuchsia when those vars are absent.
 */
export function OnshellMark({ size = 32, className }: { size?: number; className?: string }) {
  const gradientId = useId();
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
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${gradientId})`} />
      <path
        d="M9.5 11 14.5 16 9.5 21"
        stroke="#fff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M16.5 21h6.5" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
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
