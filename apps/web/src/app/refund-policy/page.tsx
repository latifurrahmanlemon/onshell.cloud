import type { Metadata } from "next";
import { PageHero, PublicShell } from "../../components/public-shell";
import { site } from "../../lib/site";
import "../home.css";
import "../legal.css";

export const metadata: Metadata = { title: "Refund Policy", description: `Refund policy for payments to ${site.legalName} through ${site.name}.` };

export default function RefundPolicyPage() {
  return <PublicShell>
    <PageHero eyebrow="Legal" title="Refund Policy" lead={`Payments for ${site.name} are received by ${site.legalName}. This policy explains how refunds work.`} />
    <section className="legal-page"><div className="lp-container legal-content">
      <p className="legal-updated">Effective: September 3, 2026</p>
      <h2>Paid plans</h2><p>If the service does not work as described, you were charged incorrectly, or you purchased a plan by mistake, contact us within 14 days of the charge. We will review the request and, when approved, return the eligible amount to the original payment method. Usage already consumed, abuse, and violations of the Terms of Service may affect eligibility where permitted by law.</p>
      <h2>Donations</h2><p>Donations are voluntary one-time contributions and are generally non-refundable. If a donation was duplicated or made in error, contact us within 14 days and we will review the request.</p>
      <h2>How to request a refund</h2><p>Email <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a> with the account or payment email, payment date, amount, and reason for the request. Do not send card details. Approved refunds are submitted promptly, but your bank or card issuer controls when the credit appears.</p>
      <h2>Legal rights</h2><p>This policy does not limit any refund, cancellation, or consumer rights that apply under law.</p>
    </div></section>
  </PublicShell>;
}
