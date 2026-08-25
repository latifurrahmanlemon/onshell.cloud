import type { Metadata } from "next";
import { SignupFlow } from "./signup-flow";

/**
 * Noindex for the same reason as /login: robots.ts disallows the route, and this
 * override stops the root layout's index:true from claiming the opposite in the
 * page itself. Search traffic for "start free" should land on the marketing
 * pages that explain the plans, not on a bare form.
 *
 * The route is a server component purely to carry this metadata — the form lives
 * in signup-flow.tsx as a client component, which cannot export any.
 */
export const metadata: Metadata = {
  title: "Create your account",
  description: "Create a free Onshell.cloud account.",
  robots: { index: false, follow: false, nocache: true }
};

export default function SignupPage() {
  return <SignupFlow />;
}
