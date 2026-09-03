import type { Metadata } from "next";
import { PageHero, PublicShell } from "../../components/public-shell";
import { site } from "../../lib/site";
import "../home.css";
import "../legal.css";

export const metadata: Metadata = { title: "Terms of Service", description: `Terms for using ${site.name}, operated by ${site.legalName}.` };

export default function TermsPage() {
  return <PublicShell>
    <PageHero eyebrow="Legal" title="Terms of Service" lead={`These terms govern your use of ${site.name}, a service operated by ${site.legalName}.`} />
    <section className="legal-page"><div className="lp-container legal-content">
      <p className="legal-updated">Effective: September 3, 2026</p>
      <h2>Agreement</h2><p>By creating an account, purchasing a plan, donating, or using the service, you agree to these terms. If you use the service for an organization, you confirm that you are authorized to accept these terms for it.</p>
      <h2>The service</h2><p>{site.legalName} provides {site.name}, remote-access software and related hosted services. Features may change as we improve the service. Open-source components remain subject to their applicable licenses.</p>
      <h2>Accounts and acceptable use</h2><p>You are responsible for your account credentials, authorized users, remote hosts, and activity performed through your account. You must not use the service to access systems without authorization, distribute malware, disrupt services, evade security controls, violate law, or infringe another person’s rights.</p>
      <h2>Plans and payment</h2><p>Prices, currency, billing period, and included limits are shown before checkout. Payments are collected by Stripe for {site.legalName}. Unless checkout says otherwise, paid plans are billed for the selected period. You authorize the displayed charge and are responsible for applicable taxes. Refund eligibility is described in our <a href="/refund-policy">Refund Policy</a>.</p>
      <h2>Availability and termination</h2><p>We work to keep the service reliable but do not promise uninterrupted or error-free availability. We may suspend or terminate access when reasonably necessary to protect the service, comply with law, address nonpayment, or respond to a material breach. You may stop using the service at any time.</p>
      <h2>Disclaimers and liability</h2><p>To the extent permitted by law, the service is provided “as is” and without implied warranties. {site.legalName} is not liable for indirect, incidental, special, consequential, or punitive damages, or for lost profits, data, or business opportunities. Nothing here limits liability that cannot legally be limited.</p>
      <h2>Contact</h2><p>Questions about these terms can be sent to <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a>.</p>
    </div></section>
  </PublicShell>;
}
