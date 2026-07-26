import type { Metadata } from "next";
import { BookOpen, LifeBuoy, ShieldCheck, Sparkles } from "lucide-react";
import { PageHero, PublicShell } from "../../components/public-shell";
import { absoluteUrl, site } from "../../lib/site";
import { ContactForm } from "./contact-form";
import "../home.css";
import "../auth.css";
import "./contact.css";

const title = "Contact us";
const description =
  "Talk to the Onshell.cloud team about browser-based SSH, SFTP, and RDP for your team — pricing, security reviews, migrations, or technical support. We reply within one business day.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/contact" },
  openGraph: {
    type: "website",
    url: absoluteUrl("/contact"),
    title: `${title} · ${site.name}`,
    description
  },
  twitter: { card: "summary_large_image", title: `${title} · ${site.name}`, description }
};

const channels = [
  {
    icon: LifeBuoy,
    title: "Technical support",
    text: "Trouble connecting a host, a session that won't open, or an SFTP transfer that fails? Send the host type and what you see.",
    action: { label: "support@onshell.cloud", href: "mailto:support@onshell.cloud" }
  },
  {
    icon: Sparkles,
    title: "Pricing & plans",
    text: "Not sure whether Team or Business fits, or need more than 50 seats? We'll size it with you — no sales theatre.",
    action: { label: "sales@onshell.cloud", href: "mailto:sales@onshell.cloud" }
  },
  {
    icon: ShieldCheck,
    title: "Security & compliance",
    text: "Vendor questionnaires, penetration-test reports, data-residency questions, or a responsible-disclosure report.",
    action: { label: "security@onshell.cloud", href: "mailto:security@onshell.cloud" }
  },
  {
    icon: BookOpen,
    title: "Try it first",
    text: "The Free plan covers one person and three hosts with no card. Often the fastest way to answer your own question.",
    action: { label: "Start free", href: "/signup" }
  }
];

/**
 * Structured data so the contact route is eligible for a ContactPage result and
 * so AI crawlers can extract the right address for each kind of enquiry.
 */
const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "ContactPage",
      "@id": `${absoluteUrl("/contact")}#webpage`,
      url: absoluteUrl("/contact"),
      name: `${title} · ${site.name}`,
      description,
      isPartOf: { "@id": `${site.url}/#website` },
      breadcrumb: { "@id": `${absoluteUrl("/contact")}#breadcrumb` }
    },
    {
      "@type": "BreadcrumbList",
      "@id": `${absoluteUrl("/contact")}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: site.url },
        { "@type": "ListItem", position: 2, name: "Contact", item: absoluteUrl("/contact") }
      ]
    },
    {
      "@type": "Organization",
      "@id": `${site.url}/#organization`,
      name: site.name,
      url: site.url,
      contactPoint: [
        {
          "@type": "ContactPoint",
          contactType: "customer support",
          email: site.supportEmail,
          availableLanguage: ["English"]
        },
        {
          "@type": "ContactPoint",
          contactType: "sales",
          email: site.salesEmail,
          availableLanguage: ["English"]
        },
        {
          "@type": "ContactPoint",
          contactType: "technical support",
          email: site.securityEmail,
          availableLanguage: ["English"]
        }
      ]
    }
  ]
};

export default function ContactPage() {
  return (
    <PublicShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />

      <PageHero
        eyebrow="We reply within one business day"
        title={
          <>
            Talk to the team behind <span className="lp-grad-text">Onshell.cloud</span>
          </>
        }
        lead="Whether you're evaluating a browser SSH client for your team, running a security review, or stuck on a stubborn host — send us the details and a real engineer will answer."
      />

      <section className="lp-section contact-section">
        <div className="lp-container contact-layout">
          <div className="contact-form-col">
            <div className="lp-heading contact-heading">
              <h2>Send us a message</h2>
              <p>One form, routed to the right person based on the topic you pick.</p>
            </div>
            <ContactForm />
          </div>

          <aside className="contact-aside" aria-label="Other ways to reach us">
            <h2 className="contact-aside-title">Other ways to reach us</h2>
            <div className="contact-channels">
              {channels.map(({ icon: Icon, title: channelTitle, text, action }) => (
                <article className="contact-channel" key={channelTitle}>
                  <span className="lp-feature-icon">
                    <Icon aria-hidden="true" size={18} />
                  </span>
                  <div>
                    <h3>{channelTitle}</h3>
                    <p>{text}</p>
                    <a href={action.href}>{action.label}</a>
                  </div>
                </article>
              ))}
            </div>
          </aside>
        </div>
      </section>
    </PublicShell>
  );
}
