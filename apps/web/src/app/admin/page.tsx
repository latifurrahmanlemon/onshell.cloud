"use client";

import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  CreditCard,
  Database,
  Edit3,
  Mail,
  Package,
  Plus,
  Save,
  ServerCog,
  Settings,
  ShieldCheck,
  Users
} from "lucide-react";
import { cx } from "@onshell/ui";

const packages = [
  { name: "Starter", price: "$19", users: "5", hosts: "20", status: "active" },
  { name: "Business", price: "$49", users: "25", hosts: "150", status: "active" },
  { name: "Enterprise", price: "$149", users: "Custom", hosts: "Custom", status: "active" }
];

const users = [
  { name: "Latifur Admin", email: "latifur.tech@gmial.com", role: "Platform Admin", status: "active" },
  { name: "Onshell Owner", email: "owner@onshell.cloud", role: "Owner", status: "active" },
  { name: "Ops User", email: "ops@onshell.cloud", role: "DevOps", status: "invited" }
];

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

interface Overview {
  totals: {
    users: number;
    organizations: number;
    hosts: number;
    activeSubscriptions: number;
    plans: number;
  };
  smtp?: {
    enabled: boolean;
    host: string;
    fromEmail: string;
  };
  paymentProviders?: Array<{
    provider: string;
    mode: string;
    enabled: boolean;
  }>;
}

interface AdminPlan {
  id: string;
  code: string;
  name: string;
  description: string;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  currency: string;
  maxUsers?: number | null;
  maxHosts?: number | null;
  maxConcurrentSessions?: number | null;
  auditRetentionDays: number;
  features: string[];
  isActive: boolean;
  displayOrder: number;
}

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  isPlatformAdmin: boolean;
  twoFactorEnabled: boolean;
}

interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  fromEmail: string;
  fromName: string;
  enabled: boolean;
  testRecipient?: string;
}

interface PaymentSettings {
  provider: string;
  mode: string;
  publicKey?: string;
  enabled: boolean;
  hasSecretKey?: boolean;
  hasWebhookSecret?: boolean;
}

interface PackageForm {
  id?: string;
  code: string;
  name: string;
  description: string;
  monthlyPrice: string;
  yearlyPrice: string;
  currency: string;
  maxUsers: string;
  maxHosts: string;
  maxConcurrentSessions: string;
  auditRetentionDays: string;
  featuresText: string;
  isActive: boolean;
  displayOrder: string;
}

const adminNav: Array<{ label: string; icon: LucideIcon }> = [
  { label: "Overview", icon: Activity },
  { label: "Packages", icon: Package },
  { label: "Users", icon: Users },
  { label: "SMTP", icon: Mail },
  { label: "Billing", icon: CreditCard },
  { label: "Security", icon: ShieldCheck },
  { label: "Settings", icon: Settings }
];

export default function AdminPage() {
  const [smtpEnabled, setSmtpEnabled] = useState(false);
  const [paymentEnabled, setPaymentEnabled] = useState(false);
  const [overview, setOverview] = useState<Overview | undefined>();
  const [livePlans, setLivePlans] = useState<AdminPlan[]>([]);
  const [liveUsers, setLiveUsers] = useState<AdminUser[]>([]);
  const [smtp, setSmtp] = useState<SmtpSettings | undefined>();
  const [payment, setPayment] = useState<PaymentSettings | undefined>();
  const [smtpPassword, setSmtpPassword] = useState("");
  const [paymentSecretKey, setPaymentSecretKey] = useState("");
  const [paymentWebhookSecret, setPaymentWebhookSecret] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [packageForm, setPackageForm] = useState<PackageForm>(() => emptyPackageForm());

  useEffect(() => {
    let active = true;
    async function loadAdminData() {
      const request = (path: string) =>
        fetch(`${apiBaseUrl}${path}`, {
          credentials: "include"
        }).then((response) => (response.ok ? response.json() : undefined));

      const [overviewPayload, planPayload, userPayload, smtpPayload] = await Promise.all([
        request("/admin/overview"),
        request("/admin/plans"),
        request("/admin/users"),
        request("/admin/smtp")
      ]);
      const paymentPayload = await request("/admin/payment-settings");

      if (!active) return;
      if (overviewPayload) {
        setOverview(overviewPayload);
        setPaymentEnabled(Boolean(overviewPayload.paymentProviders?.some((provider: { enabled: boolean }) => provider.enabled)));
      }
      if (Array.isArray(planPayload)) {
        setLivePlans(planPayload);
        if (planPayload[0]) setPackageForm(planToForm(planPayload[0]));
      }
      if (Array.isArray(userPayload)) setLiveUsers(userPayload);
      if (smtpPayload) {
        setSmtp(smtpPayload);
        setSmtpEnabled(Boolean(smtpPayload.enabled));
      }
      if (Array.isArray(paymentPayload) && paymentPayload[0]) {
        setPayment(paymentPayload[0]);
        setPaymentEnabled(Boolean(paymentPayload[0].enabled));
      }
    }

    loadAdminData().catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const packageRows =
    livePlans.length > 0
      ? livePlans.map((plan) => ({
          id: plan.id,
          name: plan.name,
          price: `$${Math.round(plan.priceMonthlyCents / 100)}`,
          users: plan.maxUsers?.toString() ?? "Custom",
          hosts: plan.maxHosts?.toString() ?? "Custom",
          status: plan.isActive ? "active" : "hidden",
          source: plan as AdminPlan | undefined
        }))
      : packages.map((plan) => ({
          id: plan.name,
          ...plan,
          source: undefined as AdminPlan | undefined
        }));

  const userRows =
    liveUsers.length > 0
      ? liveUsers.map((user) => ({
          name: user.name,
          email: user.email,
          role: user.isPlatformAdmin ? "Platform Admin" : user.role,
          status: user.twoFactorEnabled ? "2FA on" : "active"
        }))
      : users;

  async function saveSmtpSettings() {
    if (!smtp) return;
    setStatusMessage("Saving SMTP settings...");
    const response = await fetch(`${apiBaseUrl}/admin/smtp`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...smtp,
        enabled: smtpEnabled,
        port: Number(smtp.port),
        password: smtpPassword || undefined
      })
    });
    const payload = await response.json();
    if (response.ok) {
      setSmtp(payload);
      setSmtpPassword("");
      setStatusMessage("SMTP settings saved.");
    } else {
      setStatusMessage(payload.error ?? "SMTP save failed.");
    }
  }

  async function sendSmtpTest() {
    const recipient = smtp?.testRecipient || smtp?.fromEmail;
    if (!recipient) return;
    setStatusMessage("Sending SMTP test email...");
    const response = await fetch(`${apiBaseUrl}/admin/smtp/test`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient })
    });
    const payload = await response.json();
    setStatusMessage(response.ok ? `SMTP test sent: ${payload.messageId}` : payload.error ?? "SMTP test failed.");
  }

  async function savePaymentSettings() {
    setStatusMessage("Saving payment settings...");
    const response = await fetch(`${apiBaseUrl}/admin/payment-settings`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: (payment?.provider ?? "stripe").toLowerCase(),
        mode: payment?.mode ?? "test",
        publicKey: payment?.publicKey || undefined,
        secretKey: paymentSecretKey || undefined,
        webhookSecret: paymentWebhookSecret || undefined,
        enabled: paymentEnabled
      })
    });
    const payload = await response.json();
    if (response.ok) {
      setPayment(payload);
      setPaymentSecretKey("");
      setPaymentWebhookSecret("");
      setStatusMessage("Payment settings saved.");
    } else {
      setStatusMessage(payload.error ?? "Payment save failed.");
    }
  }

  function newPackage() {
    setPackageForm(emptyPackageForm(String(livePlans.length + 1)));
    setStatusMessage("Ready to create a new package.");
  }

  function editPlan(plan: AdminPlan) {
    setPackageForm(planToForm(plan));
    setStatusMessage(`Editing ${plan.name}.`);
  }

  function updatePackageForm<K extends keyof PackageForm>(field: K, value: PackageForm[K]) {
    setPackageForm((current) => ({ ...current, [field]: value }));
  }

  async function savePackage() {
    setStatusMessage("Saving package...");
    const response = await fetch(`${apiBaseUrl}/admin/plans${packageForm.id ? `/${packageForm.id}` : ""}`, {
      method: packageForm.id ? "PATCH" : "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: packageForm.code.trim(),
        name: packageForm.name.trim(),
        description: packageForm.description.trim(),
        priceMonthlyCents: dollarsToCents(packageForm.monthlyPrice),
        priceYearlyCents: dollarsToCents(packageForm.yearlyPrice),
        currency: packageForm.currency.trim().toUpperCase() || "USD",
        maxUsers: optionalPositiveInt(packageForm.maxUsers),
        maxHosts: optionalPositiveInt(packageForm.maxHosts),
        maxConcurrentSessions: optionalPositiveInt(packageForm.maxConcurrentSessions),
        auditRetentionDays: requiredPositiveInt(packageForm.auditRetentionDays, 30),
        features: packageForm.featuresText
          .split("\n")
          .map((feature) => feature.trim())
          .filter(Boolean),
        isActive: packageForm.isActive,
        displayOrder: requiredInt(packageForm.displayOrder, 0)
      })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      setStatusMessage(payload.error ?? "Package save failed.");
      return;
    }

    setLivePlans((current) => {
      const next = packageForm.id
        ? current.map((plan) => (plan.id === payload.id ? payload : plan))
        : [...current, payload];
      return sortPlans(next);
    });
    setPackageForm(planToForm(payload));
    setStatusMessage(`Package saved: ${payload.name}.`);
  }

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <div className="brand-row">
          <div className="brand-mark">
            <ServerCog size={18} />
          </div>
          <div>
            <p className="brand-name">Admin Panel</p>
            <p className="brand-domain">Onshell.cloud</p>
          </div>
        </div>
        <nav className="nav-list" aria-label="Admin">
          {adminNav.map((item, index) => {
            const Icon = item.icon;
            return (
            <button className={cx("nav-item", index === 0 && "is-active")} key={item.label} type="button">
              <Icon size={17} />
              <span>{item.label}</span>
            </button>
          );
          })}
        </nav>
      </aside>

      <section className="admin-workspace">
        <header className="topbar">
          <div>
            <h1>Business Control Center</h1>
            <p>Manage packages, users, SMTP, billing, subscriptions, and platform settings.</p>
          </div>
          <button className="primary-button" type="button">
            <Save size={17} />
            <span>Save Changes</span>
          </button>
        </header>
        {statusMessage && <p className="admin-status">{statusMessage}</p>}

        <section className="metrics-grid">
          <AdminMetric icon={Users} label="Users" value={String(overview?.totals.users ?? 128)} detail={`${overview?.totals.organizations ?? 14} organizations`} />
          <AdminMetric icon={Package} label="Packages" value={String(overview?.totals.plans ?? 3)} detail="Published offers" />
          <AdminMetric icon={CreditCard} label="MRR" value="$8.4k" detail="Mock billing" />
          <AdminMetric icon={Database} label="Hosts" value={String(overview?.totals.hosts ?? "42")} detail={`${overview?.totals.activeSubscriptions ?? 0} active subscriptions`} />
        </section>

        <section className="admin-grid">
          <div className="panel">
            <div className="panel-header">
              <div>
                <h2>Packages</h2>
                <p>Pricing and limits customers can buy from the public page.</p>
              </div>
              <button className="secondary-button" type="button" onClick={newPackage}>
                <Plus size={16} />
                <span>New Package</span>
              </button>
            </div>
            <div className="admin-table">
              <div className="admin-row table-head">
                <span>Name</span>
                <span>Price</span>
                <span>Users</span>
                <span>Hosts</span>
                <span>Status</span>
                <span>Edit</span>
              </div>
              {packageRows.map((item) => (
                <div className="admin-row" key={item.id}>
                  <strong>{item.name}</strong>
                  <span>{item.price}/mo</span>
                  <span>{item.users}</span>
                  <span>{item.hosts}</span>
                  <span className={cx("session-state", item.status !== "active" && "pending")}>{item.status}</span>
                  <button
                    aria-label={`Edit ${item.name}`}
                    className="icon-button compact"
                    disabled={!item.source}
                    onClick={() => item.source && editPlan(item.source)}
                    title={`Edit ${item.name}`}
                    type="button"
                  >
                    <Edit3 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="package-editor">
              <div className="form-grid">
                <label>
                  Code
                  <input value={packageForm.code} onChange={(event) => updatePackageForm("code", event.target.value)} placeholder="business" />
                </label>
                <label>
                  Name
                  <input value={packageForm.name} onChange={(event) => updatePackageForm("name", event.target.value)} placeholder="Business" />
                </label>
                <label className="span-two">
                  Description
                  <input value={packageForm.description} onChange={(event) => updatePackageForm("description", event.target.value)} placeholder="Package description" />
                </label>
                <label>
                  Monthly Price
                  <input value={packageForm.monthlyPrice} onChange={(event) => updatePackageForm("monthlyPrice", event.target.value)} inputMode="decimal" />
                </label>
                <label>
                  Yearly Price
                  <input value={packageForm.yearlyPrice} onChange={(event) => updatePackageForm("yearlyPrice", event.target.value)} inputMode="decimal" />
                </label>
                <label>
                  Currency
                  <input value={packageForm.currency} onChange={(event) => updatePackageForm("currency", event.target.value)} maxLength={3} />
                </label>
                <label>
                  Display Order
                  <input value={packageForm.displayOrder} onChange={(event) => updatePackageForm("displayOrder", event.target.value)} inputMode="numeric" />
                </label>
                <label>
                  Max Users
                  <input value={packageForm.maxUsers} onChange={(event) => updatePackageForm("maxUsers", event.target.value)} inputMode="numeric" placeholder="Blank for custom" />
                </label>
                <label>
                  Max Hosts
                  <input value={packageForm.maxHosts} onChange={(event) => updatePackageForm("maxHosts", event.target.value)} inputMode="numeric" placeholder="Blank for custom" />
                </label>
                <label>
                  Concurrent Sessions
                  <input value={packageForm.maxConcurrentSessions} onChange={(event) => updatePackageForm("maxConcurrentSessions", event.target.value)} inputMode="numeric" placeholder="Blank for custom" />
                </label>
                <label>
                  Audit Retention Days
                  <input value={packageForm.auditRetentionDays} onChange={(event) => updatePackageForm("auditRetentionDays", event.target.value)} inputMode="numeric" />
                </label>
                <label className="span-two">
                  Features
                  <textarea value={packageForm.featuresText} onChange={(event) => updatePackageForm("featuresText", event.target.value)} rows={4} />
                </label>
                <label className="toggle-line package-toggle">
                  <input checked={packageForm.isActive} onChange={(event) => updatePackageForm("isActive", event.target.checked)} type="checkbox" />
                  <span>Active on public pricing</span>
                </label>
                <div className="form-actions">
                  <button className="primary-button" type="button" onClick={savePackage}>
                    <Save size={16} />
                    <span>Save Package</span>
                  </button>
                  <button className="secondary-button" type="button" onClick={newPackage}>
                    <Plus size={16} />
                    <span>Clear</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <h2>SMTP</h2>
                <p>Email delivery for invitations, password resets, invoices, and alerts.</p>
              </div>
              <label className="toggle-line">
                <input checked={smtpEnabled} onChange={(event) => setSmtpEnabled(event.target.checked)} type="checkbox" />
                <span>Enabled</span>
              </label>
            </div>
            <div className="form-grid">
              <label>
                Host
                <input value={smtp?.host ?? ""} onChange={(event) => setSmtp((current) => ({ ...(current ?? fallbackSmtp()), host: event.target.value }))} />
              </label>
              <label>
                Port
                <input value={String(smtp?.port ?? 465)} onChange={(event) => setSmtp((current) => ({ ...(current ?? fallbackSmtp()), port: Number(event.target.value) }))} />
              </label>
              <label>
                From Email
                <input value={smtp?.fromEmail ?? ""} onChange={(event) => setSmtp((current) => ({ ...(current ?? fallbackSmtp()), fromEmail: event.target.value }))} />
              </label>
              <label>
                From Name
                <input value={smtp?.fromName ?? ""} onChange={(event) => setSmtp((current) => ({ ...(current ?? fallbackSmtp()), fromName: event.target.value }))} />
              </label>
              <label>
                Username
                <input value={smtp?.username ?? ""} onChange={(event) => setSmtp((current) => ({ ...(current ?? fallbackSmtp()), username: event.target.value }))} />
              </label>
              <label>
                Password
                <input value={smtpPassword} onChange={(event) => setSmtpPassword(event.target.value)} placeholder="Leave blank to keep existing" type="password" />
              </label>
              <label>
                Test Recipient
                <input value={smtp?.testRecipient ?? ""} onChange={(event) => setSmtp((current) => ({ ...(current ?? fallbackSmtp()), testRecipient: event.target.value }))} />
              </label>
              <div className="form-actions">
                <button className="primary-button" type="button" onClick={saveSmtpSettings}>Save SMTP</button>
                <button className="secondary-button" type="button" onClick={sendSmtpTest}>Send Test</button>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <h2>Users</h2>
                <p>Platform admins, owners, DevOps users, developers, and auditors.</p>
              </div>
            </div>
            <div className="user-list">
              {userRows.map((user) => (
                <div className="user-row" key={user.email}>
                  <div>
                    <strong>{user.name}</strong>
                    <small>{user.email}</small>
                  </div>
                  <span>{user.role}</span>
                  <span className={cx("session-state", user.status === "invited" && "pending")}>{user.status}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <h2>Billing Provider</h2>
                <p>Connect Stripe, Paddle, SSLCommerz, or manual invoicing.</p>
              </div>
              <label className="toggle-line">
                <input checked={paymentEnabled} onChange={(event) => setPaymentEnabled(event.target.checked)} type="checkbox" />
                <span>Enabled</span>
              </label>
            </div>
            <div className="form-grid single">
              <label>
                Provider
                <select value={(payment?.provider ?? "STRIPE").toLowerCase()} onChange={(event) => setPayment((current) => ({ ...(current ?? fallbackPayment()), provider: event.target.value }))}>
                  <option value="stripe">Stripe</option>
                  <option value="paddle">Paddle</option>
                  <option value="ssl_commerz">SSLCommerz</option>
                  <option value="manual">Manual</option>
                </select>
              </label>
              <label>
                Mode
                <select value={payment?.mode ?? "test"} onChange={(event) => setPayment((current) => ({ ...(current ?? fallbackPayment()), mode: event.target.value }))}>
                  <option value="test">Test</option>
                  <option value="live">Live</option>
                </select>
              </label>
              <label>
                Public Key
                <input value={payment?.publicKey ?? ""} onChange={(event) => setPayment((current) => ({ ...(current ?? fallbackPayment()), publicKey: event.target.value }))} placeholder="pk_test_..." />
              </label>
              <label>
                Secret Key
                <input value={paymentSecretKey} onChange={(event) => setPaymentSecretKey(event.target.value)} placeholder={payment?.hasSecretKey ? "Stored, leave blank to keep" : "sk_test_..."} type="password" />
              </label>
              <label>
                Webhook Secret
                <input value={paymentWebhookSecret} onChange={(event) => setPaymentWebhookSecret(event.target.value)} placeholder={payment?.hasWebhookSecret ? "Stored, leave blank to keep" : "whsec_..."} type="password" />
              </label>
              <button className="primary-button" type="button" onClick={savePaymentSettings}>Save Payment</button>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

function fallbackSmtp(): SmtpSettings {
  return {
    host: "smtp.example.com",
    port: 465,
    secure: true,
    fromEmail: "noreply@onshell.cloud",
    fromName: "Onshell.cloud",
    enabled: false
  };
}

function fallbackPayment(): PaymentSettings {
  return {
    provider: "stripe",
    mode: "test",
    enabled: false
  };
}

function emptyPackageForm(displayOrder = "0"): PackageForm {
  return {
    code: "",
    name: "",
    description: "",
    monthlyPrice: "19",
    yearlyPrice: "190",
    currency: "USD",
    maxUsers: "",
    maxHosts: "",
    maxConcurrentSessions: "",
    auditRetentionDays: "30",
    featuresText: "",
    isActive: true,
    displayOrder
  };
}

function planToForm(plan: AdminPlan): PackageForm {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    monthlyPrice: centsToDollars(plan.priceMonthlyCents),
    yearlyPrice: centsToDollars(plan.priceYearlyCents),
    currency: plan.currency,
    maxUsers: plan.maxUsers?.toString() ?? "",
    maxHosts: plan.maxHosts?.toString() ?? "",
    maxConcurrentSessions: plan.maxConcurrentSessions?.toString() ?? "",
    auditRetentionDays: plan.auditRetentionDays.toString(),
    featuresText: plan.features.join("\n"),
    isActive: plan.isActive,
    displayOrder: plan.displayOrder.toString()
  };
}

function centsToDollars(cents: number) {
  const amount = cents / 100;
  return Number.isInteger(amount) ? amount.toString() : amount.toFixed(2);
}

function dollarsToCents(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

function optionalPositiveInt(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function requiredPositiveInt(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function requiredInt(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function sortPlans(plans: AdminPlan[]) {
  return [...plans].sort((left, right) => left.displayOrder - right.displayOrder || left.name.localeCompare(right.name));
}

function AdminMetric({ icon: Icon, label, value, detail }: { icon: LucideIcon; label: string; value: string; detail: string }) {
  return (
    <div className="metric green">
      <Icon size={20} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}
