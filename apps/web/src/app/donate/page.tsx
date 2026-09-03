import type { Metadata } from "next";
import { Coffee, HeartHandshake, ShieldCheck } from "lucide-react";
import { PageHero, PublicShell } from "../../components/public-shell";
import { absoluteUrl, site } from "../../lib/site";
import { DonationForm } from "./donation-form";
import "../home.css";
import "./donate.css";

const title = "Support Onshell";
const description =
  "Make a one-time contribution to Onshell.cloud and help fund its open-source SSH, SFTP, RDP, and desktop development.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/donate" },
  openGraph: {
    type: "website",
    url: absoluteUrl("/donate"),
    title: `${title} · ${site.name}`,
    description,
  },
  twitter: {
    card: "summary_large_image",
    title: `${title} · ${site.name}`,
    description,
  },
};

export default async function DonatePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; source?: string; session_id?: string }>;
}) {
  const query = await searchParams;
  const source =
    query.source === "desktop" || query.source === "download"
      ? query.source
      : "website";
  const status =
    query.status === "success" || query.status === "cancelled"
      ? query.status
      : undefined;

  return (
    <PublicShell>
      <PageHero
        eyebrow="Community supported"
        title={
          <>
            Buy the project a <span className="lp-grad-text">coffee</span>
          </>
        }
        lead="Onshell is open source and free to start. If it saves you time, a one-time contribution helps pay for releases, infrastructure, and the unglamorous maintenance that keeps remote access dependable."
      />
      <section
        className="lp-section donate-section"
        aria-labelledby="donation-form-title"
      >
        <div className="lp-container donate-layout">
          <div className="donate-story">
            <span className="donate-icon">
              <Coffee aria-hidden="true" size={25} />
            </span>
            <h2>Small contribution, practical impact</h2>
            <p>
              Choose any amount from $1. This is a one-time donation—not a
              subscription—and you do not need an Onshell account.
            </p>
            <ul>
              <li>
                <HeartHandshake aria-hidden="true" size={18} /> Funds
                open-source product and security work
              </li>
              <li>
                <ShieldCheck aria-hidden="true" size={18} /> Card details stay
                on Stripe&apos;s hosted checkout
              </li>
              <li>
                <Coffee aria-hidden="true" size={18} /> No login, recurring
                charge, or account upgrade
              </li>
            </ul>
          </div>
          <DonationForm initialStatus={status} sessionId={query.session_id} source={source} />
        </div>
      </section>
    </PublicShell>
  );
}
