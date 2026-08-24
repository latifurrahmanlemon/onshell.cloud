import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Never indexed. The page is only meaningful to one person for five minutes, and
 * a search result for "approve onshell desktop" is a ready-made phishing prop.
 */
export const metadata: Metadata = {
  title: "Approve a desktop sign-in",
  robots: { index: false, follow: false }
};

export default function DesktopAuthorizeLayout({ children }: { children: ReactNode }) {
  return children;
}
