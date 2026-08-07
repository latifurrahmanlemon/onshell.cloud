"use client";

/**
 * The Onshell mark — the shield-and-prompt logo, served from /brand.
 *
 * It is a raster asset rather than the inline gradient SVG this used to draw,
 * because the artwork is the real logo and has to be pixel-identical everywhere
 * it appears: nav, footer, login, signup, console, admin, the favicon, the PWA
 * icons and the desktop installer all come from the same source file in docs/.
 *
 * Two consequences worth knowing before editing:
 *
 * - It no longer recolours with the theme. The logo carries its own light tile,
 *   which is intended — a brand mark that changes colour with a user preference
 *   is not a brand mark. It sits on both themes because that tile separates it
 *   from whatever is behind it.
 * - The file is 256px square, so it stays sharp on a 3x display at the 34-48px
 *   the interface renders it at. Serving the 512px master here would cost every
 *   page load three times the bytes for pixels nobody sees.
 */
export function OnshellMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      alt=""
      aria-hidden="true"
      className={className}
      decoding="async"
      height={size}
      src="/brand/onshell-logo.png"
      style={{ display: "block", objectFit: "contain" }}
      width={size}
    />
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
