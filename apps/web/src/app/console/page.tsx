import type { Metadata } from "next";
import { ConsoleApp } from "./console-app";

/**
 * The console is behind a session and has nothing a crawler could read, so the
 * noindex here matches the robots.ts disallow instead of the root layout's
 * index:true. Keeping both in agreement matters most for this route: an indexed
 * console URL invites signed-out visitors into a redirect loop and leaks the
 * internal route names into search results.
 *
 * The route is a server component only to carry this metadata — the console
 * itself is console-app.tsx, a client component, which cannot export any.
 */
export const metadata: Metadata = {
  title: "Console",
  robots: { index: false, follow: false, nocache: true }
};

export default function ConsolePage() {
  return <ConsoleApp />;
}
