import type { Metadata } from "next";
import { InviteFlow } from "./invite-flow";

const title = "Accept your invitation";
const description =
  "Join a workspace on Onshell.cloud from an invitation link — browser-based SSH, SFTP, and RDP access for your team.";

/**
 * Split from the flow itself only so this route can carry metadata: the card is
 * a client component (it reads the token from the URL and posts the acceptance),
 * and a client component cannot export `metadata`.
 *
 * `noindex` is set here rather than left to robots.ts — which does disallow
 * `/invite` — because a URL on this route carries a live invitation token in its
 * query string, and every extra place it could be copied to is one too many. The
 * root layout opts the whole site into indexing, so the override has to be
 * explicit.
 */
export const metadata: Metadata = {
  title,
  description,
  robots: { index: false, follow: false, nocache: true }
};

export default function InvitePage() {
  return <InviteFlow />;
}
