import type { Metadata } from "next";
import { LoginFlow } from "./login-flow";

/**
 * The sign-in screen is disallowed in robots.ts, and this override says the same
 * thing in the page's own headers. Both are needed: robots.txt asks crawlers not
 * to fetch the route, while a noindex directive keeps it out of the index if one
 * reaches it anyway — through a shared link, a referrer, or a crawler that reads
 * the rules loosely. Without it the page inherits index:true from the root
 * layout, so the two signals contradict each other and the looser one wins.
 *
 * The route only exists as a server component to carry this metadata; the whole
 * screen lives in login-flow.tsx, which is a client component and therefore
 * cannot export any.
 */
export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your Onshell.cloud account.",
  robots: { index: false, follow: false, nocache: true }
};

export default function LoginPage() {
  return <LoginFlow />;
}
