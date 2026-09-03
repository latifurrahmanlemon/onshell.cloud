import type { Metadata } from "next";
import { PageHero, PublicShell } from "../../components/public-shell";
import { site } from "../../lib/site";
import "../home.css";
import "../legal.css";

export const metadata: Metadata = { title: "Privacy Policy", description: `How ${site.legalName} handles information for ${site.name}.` };

export default function PrivacyPage() {
  return <PublicShell>
    <PageHero eyebrow="Legal" title="Privacy Policy" lead={`${site.name} is operated by ${site.legalName}. This policy explains what information we collect, why we use it, and the choices available to you.`} />
    <section className="legal-page"><div className="lp-container legal-content">
      <p className="legal-updated">Effective: September 3, 2026</p>
      <h2>Who we are</h2><p>{site.legalName} operates {site.name} and is the entity responsible for the service and its handling of personal information. Questions or privacy requests can be sent to <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a>.</p>
      <h2>Information we collect</h2><p>We collect information you provide, such as your name, email address, organization and account details, support messages, and optional donation information. When you use the service, we may process device and browser information, IP address, authentication and security events, product usage, and session audit records created by your organization.</p>
      <h2>Payments</h2><p>Payments are processed for {site.legalName} by Stripe. We receive transaction details such as payment status, amount, billing email, and Stripe identifiers, but we do not receive or store your full card number. Stripe processes payment information under its own privacy policy.</p>
      <h2>How we use information</h2><ul><li>Provide, secure, maintain, and improve the service.</li><li>Authenticate users, administer accounts, and prevent abuse.</li><li>Process purchases and donations and provide customer support.</li><li>Send service messages and, when requested, product updates.</li><li>Meet legal, accounting, and compliance obligations.</li></ul>
      <h2>Sharing</h2><p>We share information only as needed with service providers that help us operate the service, including payment, hosting, email, security, and analytics providers; with an organization that administers your account; when required by law; or in connection with a business transfer. We do not sell personal information.</p>
      <h2>Retention and security</h2><p>We retain information for as long as needed to provide the service, meet contractual and legal obligations, resolve disputes, and protect the service. Retention for organization-controlled audit records may depend on the selected plan and administrator settings. We use technical and organizational safeguards, but no online service can guarantee absolute security.</p>
      <h2>Your choices</h2><p>You may unsubscribe from marketing emails at any time. Depending on your location, you may have rights to access, correct, delete, restrict, or receive a copy of your personal information. Contact us to make a request; we may need to verify your identity.</p>
      <h2>Changes</h2><p>We may update this policy as the service or applicable requirements change. We will post the revised policy here and update its effective date.</p>
    </div></section>
  </PublicShell>;
}
