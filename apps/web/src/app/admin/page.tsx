"use client";

import "./admin.css";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  ArrowLeftRight,
  CheckCircle2,
  ChevronDown,
  Circle,
  CreditCard,
  Database,
  Edit3,
  Eye,
  EyeOff,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Loader2,
  LogOut,
  Mail,
  Package,
  Plus,
  Receipt,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  ShieldOff,
  UserCog,
  Users
} from "lucide-react";
import { passwordPolicy, validatePassword } from "@onshell/shared";
import { cx } from "@onshell/ui";
import AdminGate from "./gate";
import { OnshellMark } from "../brand";
import { ThemeToggle } from "../theme";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

/* ------------------------------------------------------------------ types */

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
    id?: string;
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
  organizationId?: string;
  isPlatformAdmin: boolean;
  twoFactorEnabled: boolean;
  emailVerifiedAt?: string | null;
  createdAt?: string;
}

interface AdminIdentity {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: string;
  isPlatformAdmin: boolean;
}

interface AdminSubscription {
  id: string;
  status: string;
  billingInterval: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndsAt?: string | null;
  cancelAt?: string | null;
  createdAt: string;
  organization: { id: string; name: string };
  plan: { id: string; name: string; code?: string };
  invoices: Array<{ id: string; amountCents: number; currency: string; status: string }>;
}

interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  username?: string | null;
  fromEmail: string;
  fromName: string;
  enabled: boolean;
  testRecipient?: string | null;
  hasPassword?: boolean;
}

interface SmtpFormState {
  host: string;
  port: string;
  secure: boolean;
  username: string;
  fromEmail: string;
  fromName: string;
  enabled: boolean;
  testRecipient: string;
}

interface PaymentSettings {
  id?: string;
  provider: string;
  mode: string;
  publicKey?: string | null;
  enabled: boolean;
  hasSecretKey?: boolean;
  hasWebhookSecret?: boolean;
}

interface AppSetting {
  key: string;
  category: string;
  value: unknown;
  isSecret: boolean;
  updatedAt?: string;
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

type SettingKind = "string" | "number" | "boolean" | "json";

interface NewSettingForm {
  key: string;
  category: string;
  kind: SettingKind;
  value: string;
  isSecret: boolean;
}

type SectionId = "overview" | "packages" | "subscriptions" | "users" | "smtp" | "billing" | "settings" | "account";

/* ------------------------------------------------------------- constants */

const adminNav: Array<{ id: SectionId; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "packages", label: "Packages", icon: Package },
  { id: "subscriptions", label: "Subscriptions", icon: Receipt },
  { id: "users", label: "Users", icon: Users },
  { id: "smtp", label: "SMTP", icon: Mail },
  { id: "billing", label: "Billing Provider", icon: CreditCard },
  { id: "settings", label: "Settings", icon: Settings2 },
  { id: "account", label: "Account", icon: UserCog }
];

const sectionMeta: Record<SectionId, { title: string; description: string }> = {
  overview: { title: "Overview", description: "Live platform totals and delivery status across the deployment." },
  packages: { title: "Packages", description: "Pricing and limits customers can buy from the public page." },
  subscriptions: { title: "Subscriptions", description: "Every organization subscription with billing period and invoices." },
  users: { title: "Users", description: "All accounts across organizations, with roles and security posture." },
  smtp: { title: "SMTP", description: "Email delivery for invitations, password resets, invoices, and alerts." },
  billing: { title: "Billing Provider", description: "Connect Stripe, Paddle, SSLCommerz, or manual invoicing." },
  settings: { title: "Settings", description: "Brand and platform settings stored as key-value configuration." },
  account: { title: "Account", description: "Change your admin password and sign out of this session." }
};

const SMTP_FALLBACK: SmtpSettings = {
  host: "",
  port: 465,
  secure: true,
  username: "",
  fromEmail: "",
  fromName: "",
  enabled: false,
  testRecipient: "",
  hasPassword: false
};

const SMTP_FORM_DEFAULTS: SmtpFormState = {
  host: "",
  port: "465",
  secure: true,
  username: "",
  fromEmail: "",
  fromName: "",
  enabled: false,
  testRecipient: ""
};

const PAYMENT_DEFAULTS: PaymentSettings = {
  provider: "stripe",
  mode: "test",
  publicKey: "",
  enabled: false
};

const NEW_SETTING_DEFAULTS: NewSettingForm = {
  key: "",
  category: "platform",
  kind: "string",
  value: "",
  isSecret: false
};

/* ------------------------------------------------------------ api helpers */

function friendlyError(payload: { error?: string; message?: string }, status: number) {
  if (status === 403 || payload.error === "forbidden") {
    return "Access denied. Sign in with a platform admin account, then retry.";
  }
  return payload.message ?? payload.error ?? `Request failed (${status}).`;
}

function errorText(error: unknown) {
  if (error instanceof TypeError) return "Cannot reach the API server. Check that it is running, then retry.";
  return error instanceof Error ? error.message : "Request failed.";
}

function passwordChangeError(raw: string): string {
  switch (raw) {
    case "invalid_current_password":
      return "Your current password is incorrect.";
    case "password_policy_violation":
      return "The new password does not meet the requirements below.";
    case "password_reuse":
      return "Choose a password different from your current one.";
    case "password_not_set":
      return "This account signs in with Google, so it has no password to change.";
    case "unauthorized":
      return "Your session expired. Please sign in again.";
    default:
      return raw;
  }
}

async function apiSend<T>(path: string, method: "POST" | "PATCH", body: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(friendlyError(payload, response.status));
  return payload;
}

interface ResourceState<T> {
  data?: T;
  loading: boolean;
  error?: string;
}

function useAdminResource<T>(path: string, fallbackOn404?: T) {
  const [state, setState] = useState<ResourceState<T>>({ loading: true });
  const fallbackRef = useRef(fallbackOn404);

  const load = useCallback(async () => {
    setState((current) => ({ data: current.data, loading: true }));
    try {
      const response = await fetch(`${apiBaseUrl}${path}`, { credentials: "include" });
      if (response.status === 404 && fallbackRef.current !== undefined) {
        setState({ data: fallbackRef.current, loading: false });
        return;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(friendlyError(payload, response.status));
      }
      const data = (await response.json()) as T;
      setState({ data, loading: false });
    } catch (error) {
      setState((current) => ({ data: current.data, loading: false, error: errorText(error) }));
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const setData = useCallback((updater: (current: T | undefined) => T | undefined) => {
    setState((current) => ({ ...current, data: updater(current.data) }));
  }, []);

  return { ...state, reload: load, setData };
}

/* -------------------------------------------------------------- utilities */

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

function smtpToForm(settings: SmtpSettings): SmtpFormState {
  return {
    host: settings.host ?? "",
    port: String(settings.port ?? 465),
    secure: Boolean(settings.secure),
    username: settings.username ?? "",
    fromEmail: settings.fromEmail ?? "",
    fromName: settings.fromName ?? "",
    enabled: Boolean(settings.enabled),
    testRecipient: settings.testRecipient ?? ""
  };
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function subscriptionTone(status: string) {
  const normalized = status.toLowerCase();
  if (normalized.includes("active")) return "green";
  if (normalized.includes("trial")) return "cyan";
  if (normalized.includes("past") || normalized.includes("unpaid") || normalized.includes("incomplete")) return "amber";
  if (normalized.includes("cancel") || normalized.includes("expire")) return "rose";
  return "soft";
}

function kindOf(value: unknown): SettingKind {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return "json";
}

function settingKind(setting: AppSetting): SettingKind {
  return setting.isSecret ? "string" : kindOf(setting.value);
}

function serializeSetting(setting: AppSetting): string {
  if (setting.isSecret) return "";
  const kind = kindOf(setting.value);
  if (kind === "boolean") return setting.value ? "true" : "false";
  if (kind === "number" || kind === "string") return String(setting.value);
  return JSON.stringify(setting.value, null, 2);
}

function parseSettingDraft(kind: SettingKind, draft: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (kind === "boolean") return { ok: true, value: draft === "true" };
  if (kind === "number") {
    const parsed = Number(draft);
    return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false, error: "Enter a valid number." };
  }
  if (kind === "json") {
    try {
      return { ok: true, value: JSON.parse(draft) };
    } catch {
      return { ok: false, error: "Value must be valid JSON." };
    }
  }
  return { ok: true, value: draft };
}

/* ------------------------------------------------------- shared components */

function MetricTile({
  icon: Icon,
  tone,
  label,
  value,
  detail
}: {
  icon: LucideIcon;
  tone: "green" | "cyan" | "amber" | "rose";
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className={cx("metric", tone)}>
      <Icon size={20} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function ErrorBanner({ message, onRetry, retrying }: { message: string; onRetry: () => void; retrying?: boolean }) {
  return (
    <div className="adm-error-banner" role="alert">
      <AlertCircle size={16} />
      <span>{message}</span>
      <button className="secondary-button" disabled={retrying} onClick={onRetry} type="button">
        {retrying ? <Loader2 className="adm-spin" size={14} /> : <RefreshCw size={14} />}
        <span>Retry</span>
      </button>
    </div>
  );
}

function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden className="adm-skeleton-list">
      {Array.from({ length: rows }, (_, index) => (
        <div className="adm-skeleton-row" key={index}>
          <div className="adm-skeleton adm-skeleton-line wide" />
          <div className="adm-skeleton adm-skeleton-line short" />
        </div>
      ))}
    </div>
  );
}

function SkeletonTiles({ count = 4 }: { count?: number }) {
  return (
    <div aria-hidden className="metrics-grid">
      {Array.from({ length: count }, (_, index) => (
        <div className="metric adm-skeleton-tile" key={index}>
          <div className="adm-skeleton adm-skeleton-icon" />
          <div>
            <div className="adm-skeleton adm-skeleton-line short" />
            <div className="adm-skeleton adm-skeleton-line wide" />
            <div className="adm-skeleton adm-skeleton-line short" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon: Icon, title, body, action }: { icon: LucideIcon; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="adm-empty">
      <Icon size={26} />
      <strong>{title}</strong>
      <p>{body}</p>
      {action}
    </div>
  );
}

function passwordRequirements(password: string): Array<{ label: string; met: boolean }> {
  const reqs = [{ label: `At least ${passwordPolicy.minLength} characters`, met: password.length >= passwordPolicy.minLength }];
  if (passwordPolicy.requireLowercase) reqs.push({ label: "One lowercase letter", met: /[a-z]/.test(password) });
  if (passwordPolicy.requireUppercase) reqs.push({ label: "One uppercase letter", met: /[A-Z]/.test(password) });
  if (passwordPolicy.requireDigit) reqs.push({ label: "One number", met: /[0-9]/.test(password) });
  if (passwordPolicy.requireSymbol) reqs.push({ label: "One symbol (!@#?…)", met: /[^a-zA-Z0-9]/.test(password) });
  return reqs;
}

function PasswordChecklist({ password }: { password: string }) {
  return (
    <ul className="adm-pw-reqs">
      {passwordRequirements(password).map((requirement) => (
        <li className={cx("adm-pw-req", requirement.met ? "met" : "unmet")} key={requirement.label}>
          {requirement.met ? <CheckCircle2 size={13} /> : <Circle size={13} />}
          <span>{requirement.label}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------- page */

export default function AdminPage() {
  return (
    <AdminGate>
      <AdminPanel />
    </AdminGate>
  );
}

function AdminPanel() {
  const reduceMotionPreference = useReducedMotion();
  const reduceMotion = reduceMotionPreference ?? false;

  const [section, setSection] = useState<SectionId>("overview");

  /* signed-in identity (for the sidebar) */
  const [identity, setIdentity] = useState<AdminIdentity | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/auth/me`, { credentials: "include" });
        if (!response.ok) return;
        const data = (await response.json()) as { user?: AdminIdentity };
        if (active && data.user) setIdentity(data.user);
      } catch {
        // Best-effort — the sidebar identity is non-critical.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const overviewRes = useAdminResource<Overview>("/admin/overview");
  const plansRes = useAdminResource<AdminPlan[]>("/admin/plans");
  const subscriptionsRes = useAdminResource<AdminSubscription[]>("/admin/subscriptions");
  const usersRes = useAdminResource<AdminUser[]>("/admin/users");
  const smtpRes = useAdminResource<SmtpSettings>("/admin/smtp", SMTP_FALLBACK);
  const paymentRes = useAdminResource<PaymentSettings[]>("/admin/payment-settings");
  const settingsRes = useAdminResource<AppSetting[]>("/admin/settings");

  /* toast */
  const [toast, setToast] = useState<{ id: number; tone: "success" | "error"; text: string } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = useCallback((tone: "success" | "error", text: string) => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), tone, text });
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  /* packages */
  const [packageForm, setPackageForm] = useState<PackageForm>(() => emptyPackageForm());
  const [savingPackage, setSavingPackage] = useState(false);

  /* users */
  const [userQuery, setUserQuery] = useState("");

  /* smtp */
  const [smtpForm, setSmtpForm] = useState<SmtpFormState>(SMTP_FORM_DEFAULTS);
  const [smtpPassword, setSmtpPassword] = useState("");
  const [savingSmtp, setSavingSmtp] = useState(false);
  const [sendingSmtpTest, setSendingSmtpTest] = useState(false);

  /* billing */
  const [paymentForm, setPaymentForm] = useState<PaymentSettings>(PAYMENT_DEFAULTS);
  const [paymentSecretKey, setPaymentSecretKey] = useState("");
  const [paymentWebhookSecret, setPaymentWebhookSecret] = useState("");
  const [savingPayment, setSavingPayment] = useState(false);

  /* settings */
  const [settingDrafts, setSettingDrafts] = useState<Record<string, string>>({});
  const [savingSettingKey, setSavingSettingKey] = useState<string | null>(null);
  const [newSetting, setNewSetting] = useState<NewSettingForm>(NEW_SETTING_DEFAULTS);
  const [savingNewSetting, setSavingNewSetting] = useState(false);

  /* account */
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    if (!profileOpen) return;
    const onDocClick = () => setProfileOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileOpen(false);
    };
    const raf = window.setTimeout(() => document.addEventListener("click", onDocClick), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(raf);
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [profileOpen]);

  useEffect(() => {
    if (smtpRes.data) setSmtpForm(smtpToForm(smtpRes.data));
  }, [smtpRes.data]);

  useEffect(() => {
    const first = paymentRes.data?.[0];
    if (first) setPaymentForm(first);
  }, [paymentRes.data]);

  const plans = useMemo(() => sortPlans(plansRes.data ?? []), [plansRes.data]);

  const filteredUsers = useMemo(() => {
    const list = usersRes.data ?? [];
    const query = userQuery.trim().toLowerCase();
    if (!query) return list;
    return list.filter(
      (user) =>
        user.name.toLowerCase().includes(query) ||
        user.email.toLowerCase().includes(query) ||
        user.role.toLowerCase().includes(query)
    );
  }, [usersRes.data, userQuery]);

  const groupedSettings = useMemo(() => {
    const groups = new Map<string, AppSetting[]>();
    for (const setting of settingsRes.data ?? []) {
      const list = groups.get(setting.category) ?? [];
      list.push(setting);
      groups.set(setting.category, list);
    }
    return Array.from(groups.entries());
  }, [settingsRes.data]);

  const sectionLoading: Record<SectionId, boolean> = {
    overview: overviewRes.loading,
    packages: plansRes.loading,
    subscriptions: subscriptionsRes.loading,
    users: usersRes.loading,
    smtp: smtpRes.loading,
    billing: paymentRes.loading,
    settings: settingsRes.loading,
    account: false
  };

  function reloadActiveSection() {
    const reloaders: Record<SectionId, () => Promise<void>> = {
      overview: overviewRes.reload,
      packages: plansRes.reload,
      subscriptions: subscriptionsRes.reload,
      users: usersRes.reload,
      smtp: smtpRes.reload,
      billing: paymentRes.reload,
      settings: settingsRes.reload,
      account: async () => {}
    };
    void reloaders[section]();
  }

  /* -------------------------------------------------------- package actions */

  function newPackage() {
    setPackageForm(emptyPackageForm(String(plans.length + 1)));
  }

  function editPlan(plan: AdminPlan) {
    setPackageForm(planToForm(plan));
  }

  function updatePackageForm<K extends keyof PackageForm>(field: K, value: PackageForm[K]) {
    setPackageForm((current) => ({ ...current, [field]: value }));
  }

  async function savePackage() {
    if (packageForm.code.trim().length < 2 || packageForm.name.trim().length < 2) {
      showToast("error", "Package code and name need at least 2 characters.");
      return;
    }
    if (packageForm.description.trim().length < 10) {
      showToast("error", "Package description needs at least 10 characters.");
      return;
    }
    const original = packageForm.id ? plans.find((plan) => plan.id === packageForm.id) : undefined;
    if (
      original?.isActive &&
      !packageForm.isActive &&
      !window.confirm(`Hide "${original.name}" from the public pricing page? Existing subscribers keep their plan.`)
    ) {
      return;
    }

    setSavingPackage(true);
    try {
      const saved = await apiSend<AdminPlan>(
        `/admin/plans${packageForm.id ? `/${packageForm.id}` : ""}`,
        packageForm.id ? "PATCH" : "POST",
        {
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
        }
      );
      const wasEdit = Boolean(packageForm.id);
      plansRes.setData((current) => {
        const list = current ?? [];
        return sortPlans(wasEdit ? list.map((plan) => (plan.id === saved.id ? saved : plan)) : [...list, saved]);
      });
      setPackageForm(planToForm(saved));
      showToast("success", `Package "${saved.name}" ${wasEdit ? "updated" : "created"}.`);
    } catch (error) {
      showToast("error", errorText(error));
    } finally {
      setSavingPackage(false);
    }
  }

  /* ----------------------------------------------------------- smtp actions */

  function updateSmtp<K extends keyof SmtpFormState>(field: K, value: SmtpFormState[K]) {
    setSmtpForm((current) => ({ ...current, [field]: value }));
  }

  async function saveSmtpSettings() {
    const port = Number(smtpForm.port);
    if (smtpForm.host.trim().length < 2) {
      showToast("error", "Enter an SMTP host.");
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      showToast("error", "Port must be between 1 and 65535.");
      return;
    }
    if (!smtpForm.fromEmail.includes("@")) {
      showToast("error", "Enter a valid from email address.");
      return;
    }
    if (smtpForm.fromName.trim().length < 2) {
      showToast("error", "From name needs at least 2 characters.");
      return;
    }
    if (
      smtpRes.data?.enabled &&
      !smtpForm.enabled &&
      !window.confirm("Disable SMTP delivery? Invitations, password resets, and alerts will stop sending.")
    ) {
      return;
    }

    setSavingSmtp(true);
    try {
      const saved = await apiSend<SmtpSettings>("/admin/smtp", "PATCH", {
        host: smtpForm.host.trim(),
        port,
        secure: smtpForm.secure,
        username: smtpForm.username || undefined,
        password: smtpPassword || undefined,
        fromEmail: smtpForm.fromEmail.trim(),
        fromName: smtpForm.fromName.trim(),
        enabled: smtpForm.enabled,
        testRecipient: smtpForm.testRecipient.trim() || undefined
      });
      smtpRes.setData(() => saved);
      setSmtpPassword("");
      showToast("success", "SMTP settings saved.");
    } catch (error) {
      showToast("error", errorText(error));
    } finally {
      setSavingSmtp(false);
    }
  }

  async function sendSmtpTest() {
    const recipient = smtpForm.testRecipient.trim() || smtpForm.fromEmail.trim();
    if (!recipient.includes("@")) {
      showToast("error", "Add a test recipient (or from email) first.");
      return;
    }
    setSendingSmtpTest(true);
    try {
      const result = await apiSend<{ messageId?: string }>("/admin/smtp/test", "POST", { recipient });
      showToast("success", `Test email sent to ${recipient}${result.messageId ? ` (${result.messageId})` : ""}.`);
    } catch (error) {
      showToast("error", errorText(error));
    } finally {
      setSendingSmtpTest(false);
    }
  }

  /* -------------------------------------------------------- billing actions */

  function updatePayment<K extends keyof PaymentSettings>(field: K, value: PaymentSettings[K]) {
    setPaymentForm((current) => ({ ...current, [field]: value }));
  }

  async function savePaymentSettings() {
    const original = paymentRes.data?.find(
      (setting) =>
        (paymentForm.id && setting.id === paymentForm.id) ||
        (setting.provider.toLowerCase() === paymentForm.provider.toLowerCase() && setting.mode === paymentForm.mode)
    );
    if (
      original?.enabled &&
      !paymentForm.enabled &&
      !window.confirm("Disable this billing provider? New checkouts through it will stop working.")
    ) {
      return;
    }

    setSavingPayment(true);
    try {
      const saved = await apiSend<PaymentSettings>("/admin/payment-settings", "PATCH", {
        provider: paymentForm.provider.toLowerCase(),
        mode: paymentForm.mode,
        publicKey: paymentForm.publicKey || undefined,
        secretKey: paymentSecretKey || undefined,
        webhookSecret: paymentWebhookSecret || undefined,
        enabled: paymentForm.enabled
      });
      paymentRes.setData((current) => {
        const list = current ?? [];
        const exists = list.some((setting) => setting.id === saved.id);
        return exists ? list.map((setting) => (setting.id === saved.id ? saved : setting)) : [...list, saved];
      });
      setPaymentForm(saved);
      setPaymentSecretKey("");
      setPaymentWebhookSecret("");
      showToast("success", "Billing provider settings saved.");
    } catch (error) {
      showToast("error", errorText(error));
    } finally {
      setSavingPayment(false);
    }
  }

  /* ------------------------------------------------------- settings actions */

  function draftFor(setting: AppSetting) {
    return settingDrafts[setting.key] ?? serializeSetting(setting);
  }

  function setDraft(key: string, value: string) {
    setSettingDrafts((current) => ({ ...current, [key]: value }));
  }

  function settingIsDirty(setting: AppSetting) {
    const draft = settingDrafts[setting.key];
    return draft !== undefined && draft !== serializeSetting(setting);
  }

  async function saveSetting(setting: AppSetting) {
    const draft = draftFor(setting);
    if (setting.isSecret && draft.trim() === "") {
      showToast("error", "Enter a new value to update this secret setting.");
      return;
    }
    const parsed = parseSettingDraft(settingKind(setting), draft);
    if (!parsed.ok) {
      showToast("error", parsed.error);
      return;
    }
    setSavingSettingKey(setting.key);
    try {
      const saved = await apiSend<AppSetting>("/admin/settings", "PATCH", {
        key: setting.key,
        category: setting.category,
        value: parsed.value,
        isSecret: setting.isSecret
      });
      settingsRes.setData((current) => (current ?? []).map((item) => (item.key === saved.key ? saved : item)));
      setSettingDrafts((current) => {
        const next = { ...current };
        delete next[setting.key];
        return next;
      });
      showToast("success", `Setting "${setting.key}" saved.`);
    } catch (error) {
      showToast("error", errorText(error));
    } finally {
      setSavingSettingKey(null);
    }
  }

  async function saveNewSetting() {
    if (newSetting.key.trim().length < 2 || newSetting.category.trim().length < 2) {
      showToast("error", "Setting key and category need at least 2 characters.");
      return;
    }
    if (newSetting.isSecret && newSetting.value.trim() === "") {
      showToast("error", "Secret settings need a value.");
      return;
    }
    const parsed = parseSettingDraft(newSetting.kind, newSetting.value);
    if (!parsed.ok) {
      showToast("error", parsed.error);
      return;
    }
    setSavingNewSetting(true);
    try {
      const saved = await apiSend<AppSetting>("/admin/settings", "PATCH", {
        key: newSetting.key.trim(),
        category: newSetting.category.trim(),
        value: parsed.value,
        isSecret: newSetting.isSecret
      });
      settingsRes.setData((current) => {
        const list = current ?? [];
        const exists = list.some((item) => item.key === saved.key);
        const next = exists ? list.map((item) => (item.key === saved.key ? saved : item)) : [...list, saved];
        return [...next].sort((left, right) => left.category.localeCompare(right.category) || left.key.localeCompare(right.key));
      });
      setNewSetting(NEW_SETTING_DEFAULTS);
      showToast("success", `Setting "${saved.key}" saved.`);
    } catch (error) {
      showToast("error", errorText(error));
    } finally {
      setSavingNewSetting(false);
    }
  }

  /* --------------------------------------------------------- account actions */

  const newPasswordValid = validatePassword(newPassword).valid;
  const passwordsMatch = newPassword === confirmPassword;

  async function changePassword() {
    if (!currentPassword) {
      showToast("error", "Enter your current password.");
      return;
    }
    if (!newPasswordValid) {
      showToast("error", "The new password does not meet the requirements.");
      return;
    }
    if (!passwordsMatch) {
      showToast("error", "New password and confirmation do not match.");
      return;
    }
    if (currentPassword === newPassword) {
      showToast("error", "Choose a password different from your current one.");
      return;
    }
    setSavingPassword(true);
    try {
      await apiSend("/auth/password/change", "POST", { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      showToast("success", "Password updated. Your other sessions have been signed out.");
    } catch (error) {
      showToast("error", passwordChangeError(errorText(error)));
    } finally {
      setSavingPassword(false);
    }
  }

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch(`${apiBaseUrl}/auth/logout`, { method: "POST", credentials: "include" });
    } catch {
      // Ignore network errors — send the admin to the sign-in screen regardless.
    } finally {
      // Reload /admin so the gate re-checks the (now cleared) session and shows sign-in.
      window.location.href = "/admin";
    }
  }

  /* --------------------------------------------------------- section render */

  function renderOverview() {
    const totals = overviewRes.data?.totals;
    const providers = overviewRes.data?.paymentProviders ?? [];
    const smtpStatus = overviewRes.data?.smtp;

    return (
      <div className="adm-stack">
        {overviewRes.error && <ErrorBanner message={overviewRes.error} onRetry={overviewRes.reload} retrying={overviewRes.loading} />}
        {overviewRes.loading && !overviewRes.data ? (
          <SkeletonTiles />
        ) : (
          <div className="metrics-grid">
            <MetricTile
              detail={totals ? `${totals.organizations} organization${totals.organizations === 1 ? "" : "s"}` : "No data yet"}
              icon={Users}
              label="Users"
              tone="green"
              value={totals ? String(totals.users) : "—"}
            />
            <MetricTile
              detail={totals ? "Published offers" : "No data yet"}
              icon={Package}
              label="Packages"
              tone="cyan"
              value={totals ? String(totals.plans) : "—"}
            />
            <MetricTile
              detail={totals ? "Currently active" : "No data yet"}
              icon={Receipt}
              label="Subscriptions"
              tone="amber"
              value={totals ? String(totals.activeSubscriptions) : "—"}
            />
            <MetricTile
              detail={totals ? "Registered endpoints" : "No data yet"}
              icon={Database}
              label="Hosts"
              tone="rose"
              value={totals ? String(totals.hosts) : "—"}
            />
          </div>
        )}

        <div className="adm-two-col">
          <div className="panel">
            <div className="panel-header tight">
              <div>
                <h2>Email delivery</h2>
                <p>Global SMTP status for transactional email.</p>
              </div>
              <button className="adm-link-button" onClick={() => setSection("smtp")} type="button">
                Configure
              </button>
            </div>
            {overviewRes.loading && !overviewRes.data ? (
              <SkeletonRows rows={1} />
            ) : smtpStatus ? (
              <div className="adm-status-row">
                <Mail size={16} />
                <strong>{smtpStatus.host || "SMTP"}</strong>
                <small>{smtpStatus.fromEmail}</small>
                <span className={cx("adm-badge", smtpStatus.enabled ? "green" : "soft")}>
                  {smtpStatus.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
            ) : (
              <EmptyState
                body="Transactional email is not set up. Configure a host so invites and password resets can send."
                icon={Mail}
                title="SMTP not configured"
                action={
                  <button className="adm-link-button" onClick={() => setSection("smtp")} type="button">
                    Set up SMTP
                  </button>
                }
              />
            )}
          </div>

          <div className="panel">
            <div className="panel-header tight">
              <div>
                <h2>Billing providers</h2>
                <p>Configured payment integrations and their mode.</p>
              </div>
              <button className="adm-link-button" onClick={() => setSection("billing")} type="button">
                Configure
              </button>
            </div>
            {overviewRes.loading && !overviewRes.data ? (
              <SkeletonRows rows={2} />
            ) : providers.length > 0 ? (
              providers.map((provider) => (
                <div className="adm-status-row" key={provider.id ?? `${provider.provider}-${provider.mode}`}>
                  <CreditCard size={16} />
                  <strong>{provider.provider.toLowerCase().replace("_", " ")}</strong>
                  <span className={cx("adm-badge", provider.mode === "live" ? "amber" : "cyan")}>{provider.mode}</span>
                  <span className={cx("adm-badge", provider.enabled ? "green" : "soft")}>
                    {provider.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
              ))
            ) : (
              <EmptyState
                body="No payment integration yet. Connect a provider to start accepting subscriptions."
                icon={CreditCard}
                title="No billing provider"
                action={
                  <button className="adm-link-button" onClick={() => setSection("billing")} type="button">
                    Connect a provider
                  </button>
                }
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderPackages() {
    return (
      <div className="adm-stack">
        {plansRes.error && <ErrorBanner message={plansRes.error} onRetry={plansRes.reload} retrying={plansRes.loading} />}
        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Packages</h2>
              <p>Pricing and limits customers can buy from the public page.</p>
            </div>
            <button className="secondary-button" onClick={newPackage} type="button">
              <Plus size={16} />
              <span>New Package</span>
            </button>
          </div>

          {plansRes.loading && !plansRes.data ? (
            <SkeletonRows rows={3} />
          ) : plans.length === 0 ? (
            <EmptyState
              body="Create your first package below. Active packages show up on the public pricing page immediately."
              icon={Package}
              title="No packages yet"
            />
          ) : (
            <div className="admin-table">
              <div className="admin-row table-head">
                <span>Name</span>
                <span>Price</span>
                <span>Users</span>
                <span>Hosts</span>
                <span>Status</span>
                <span>Edit</span>
              </div>
              {plans.map((plan) => (
                <div className="admin-row" key={plan.id}>
                  <strong>{plan.name}</strong>
                  <span>${Math.round(plan.priceMonthlyCents / 100)}/mo</span>
                  <span>{plan.maxUsers?.toString() ?? "Custom"}</span>
                  <span>{plan.maxHosts?.toString() ?? "Custom"}</span>
                  <span className={cx("session-state", !plan.isActive && "pending")}>{plan.isActive ? "active" : "hidden"}</span>
                  <button
                    aria-label={`Edit ${plan.name}`}
                    className="icon-button compact"
                    onClick={() => editPlan(plan)}
                    title={`Edit ${plan.name}`}
                    type="button"
                  >
                    <Edit3 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="package-editor">
            <div className="adm-editor-head">
              <span>{packageForm.id ? `Editing: ${packageForm.name || "package"}` : "New package"}</span>
              {packageForm.id && (
                <button className="adm-link-button" onClick={newPackage} type="button">
                  Start a new package instead
                </button>
              )}
            </div>
            <div className="form-grid">
              <label>
                Code
                <input onChange={(event) => updatePackageForm("code", event.target.value)} placeholder="business" value={packageForm.code} />
              </label>
              <label>
                Name
                <input onChange={(event) => updatePackageForm("name", event.target.value)} placeholder="Business" value={packageForm.name} />
              </label>
              <label className="span-two">
                Description
                <input
                  onChange={(event) => updatePackageForm("description", event.target.value)}
                  placeholder="Package description (at least 10 characters)"
                  value={packageForm.description}
                />
              </label>
              <label>
                Monthly Price
                <input inputMode="decimal" onChange={(event) => updatePackageForm("monthlyPrice", event.target.value)} value={packageForm.monthlyPrice} />
              </label>
              <label>
                Yearly Price
                <input inputMode="decimal" onChange={(event) => updatePackageForm("yearlyPrice", event.target.value)} value={packageForm.yearlyPrice} />
              </label>
              <label>
                Currency
                <input maxLength={3} onChange={(event) => updatePackageForm("currency", event.target.value)} value={packageForm.currency} />
              </label>
              <label>
                Display Order
                <input inputMode="numeric" onChange={(event) => updatePackageForm("displayOrder", event.target.value)} value={packageForm.displayOrder} />
              </label>
              <label>
                Max Users
                <input
                  inputMode="numeric"
                  onChange={(event) => updatePackageForm("maxUsers", event.target.value)}
                  placeholder="Blank for custom"
                  value={packageForm.maxUsers}
                />
              </label>
              <label>
                Max Hosts
                <input
                  inputMode="numeric"
                  onChange={(event) => updatePackageForm("maxHosts", event.target.value)}
                  placeholder="Blank for custom"
                  value={packageForm.maxHosts}
                />
              </label>
              <label>
                Concurrent Sessions
                <input
                  inputMode="numeric"
                  onChange={(event) => updatePackageForm("maxConcurrentSessions", event.target.value)}
                  placeholder="Blank for custom"
                  value={packageForm.maxConcurrentSessions}
                />
              </label>
              <label>
                Audit Retention Days
                <input inputMode="numeric" onChange={(event) => updatePackageForm("auditRetentionDays", event.target.value)} value={packageForm.auditRetentionDays} />
              </label>
              <label className="span-two">
                Features (one per line)
                <textarea onChange={(event) => updatePackageForm("featuresText", event.target.value)} rows={4} value={packageForm.featuresText} />
              </label>
              <label className="toggle-line package-toggle">
                <input checked={packageForm.isActive} onChange={(event) => updatePackageForm("isActive", event.target.checked)} type="checkbox" />
                <span>Active on public pricing</span>
              </label>
              <div className="form-actions">
                <button className="primary-button" disabled={savingPackage} onClick={savePackage} type="button">
                  {savingPackage ? <Loader2 className="adm-spin" size={16} /> : <Save size={16} />}
                  <span>{savingPackage ? "Saving..." : "Save Package"}</span>
                </button>
                <button className="secondary-button" disabled={savingPackage} onClick={newPackage} type="button">
                  <Plus size={16} />
                  <span>Clear</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderSubscriptions() {
    const subscriptions = subscriptionsRes.data ?? [];
    return (
      <div className="adm-stack">
        {subscriptionsRes.error && (
          <ErrorBanner message={subscriptionsRes.error} onRetry={subscriptionsRes.reload} retrying={subscriptionsRes.loading} />
        )}
        <div className="panel">
          <div className="panel-header tight">
            <div>
              <h2>Subscriptions</h2>
              <p>Read-only view of every organization subscription.</p>
            </div>
            <span className="adm-count">
              {subscriptionsRes.data ? `${subscriptions.length} total` : ""}
            </span>
          </div>
          {subscriptionsRes.loading && !subscriptionsRes.data ? (
            <SkeletonRows rows={4} />
          ) : subscriptions.length === 0 ? (
            <EmptyState
              body="Subscriptions appear here as soon as an organization signs up for a package. Make sure a billing provider is enabled."
              icon={Inbox}
              title="No subscriptions yet"
              action={
                <button className="adm-link-button" onClick={() => setSection("billing")} type="button">
                  Check billing provider
                </button>
              }
            />
          ) : (
            <div>
              <div className="adm-sub-row table-head">
                <span>Organization</span>
                <span>Plan</span>
                <span>Status</span>
                <span>Interval</span>
                <span>Period ends</span>
                <span>Invoices</span>
              </div>
              {subscriptions.map((subscription) => (
                <div className="adm-sub-row" key={subscription.id}>
                  <div>
                    <strong>{subscription.organization?.name ?? "Unknown org"}</strong>
                    <small>Since {formatDate(subscription.createdAt)}</small>
                  </div>
                  <span data-label="Plan">{subscription.plan?.name ?? "—"}</span>
                  <span className={cx("adm-badge", subscriptionTone(subscription.status))} data-label="Status">
                    {subscription.status.toLowerCase().replace(/_/g, " ")}
                  </span>
                  <span data-label="Interval">{subscription.billingInterval.toLowerCase()}</span>
                  <span data-label="Period ends">{formatDate(subscription.currentPeriodEnd)}</span>
                  <span data-label="Invoices" title="Latest invoices on record">
                    {subscription.invoices.length}
                    {subscription.invoices.length === 5 ? "+" : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderUsers() {
    const total = usersRes.data?.length ?? 0;
    return (
      <div className="adm-stack">
        {usersRes.error && <ErrorBanner message={usersRes.error} onRetry={usersRes.reload} retrying={usersRes.loading} />}
        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Users</h2>
              <p>All accounts across organizations. Read-only directory.</p>
            </div>
            <div className="adm-users-toolbar">
              <div className="search-field">
                <Search size={15} />
                <input
                  aria-label="Search users"
                  onChange={(event) => setUserQuery(event.target.value)}
                  placeholder="Search name, email, role..."
                  value={userQuery}
                />
              </div>
              <span className="adm-count">
                {usersRes.data ? `${filteredUsers.length} of ${total}` : ""}
              </span>
            </div>
          </div>
          {usersRes.loading && !usersRes.data ? (
            <SkeletonRows rows={4} />
          ) : total === 0 ? (
            <EmptyState
              body="No accounts exist yet. Users appear here after they sign up or are invited into an organization."
              icon={Users}
              title="No users yet"
            />
          ) : filteredUsers.length === 0 ? (
            <EmptyState
              body={`Nothing matches "${userQuery}". Try a different name, email, or role.`}
              icon={Search}
              title="No matching users"
              action={
                <button className="adm-link-button" onClick={() => setUserQuery("")} type="button">
                  Clear search
                </button>
              }
            />
          ) : (
            filteredUsers.map((user) => (
              <div className="adm-user-row" key={user.id}>
                <div>
                  <strong>{user.name}</strong>
                  <small>{user.email}</small>
                </div>
                <div className="adm-user-badges">
                  <span className="adm-badge">{user.role.replace(/_/g, " ")}</span>
                  {user.isPlatformAdmin && (
                    <span className="adm-badge amber">
                      <ShieldCheck size={12} />
                      Platform Admin
                    </span>
                  )}
                  {user.twoFactorEnabled ? (
                    <span className="adm-badge green">
                      <ShieldCheck size={12} />
                      2FA on
                    </span>
                  ) : (
                    <span className="adm-badge soft">
                      <ShieldOff size={12} />
                      2FA off
                    </span>
                  )}
                  {!user.emailVerifiedAt && <span className="adm-badge rose">Email unverified</span>}
                </div>
                <span className="adm-user-joined">Joined {formatDate(user.createdAt)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  function renderSmtp() {
    return (
      <div className="adm-stack">
        {smtpRes.error && <ErrorBanner message={smtpRes.error} onRetry={smtpRes.reload} retrying={smtpRes.loading} />}
        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>SMTP</h2>
              <p>Email delivery for invitations, password resets, invoices, and alerts.</p>
            </div>
            <label className="toggle-line">
              <input checked={smtpForm.enabled} onChange={(event) => updateSmtp("enabled", event.target.checked)} type="checkbox" />
              <span>Enabled</span>
            </label>
          </div>
          {smtpRes.loading && !smtpRes.data ? (
            <SkeletonRows rows={4} />
          ) : (
            <div className="form-grid">
              <label>
                Host
                <input onChange={(event) => updateSmtp("host", event.target.value)} placeholder="smtp.example.com" value={smtpForm.host} />
              </label>
              <label>
                Port
                <input inputMode="numeric" onChange={(event) => updateSmtp("port", event.target.value)} value={smtpForm.port} />
              </label>
              <label>
                From Email
                <input onChange={(event) => updateSmtp("fromEmail", event.target.value)} placeholder="noreply@onshell.cloud" value={smtpForm.fromEmail} />
              </label>
              <label>
                From Name
                <input onChange={(event) => updateSmtp("fromName", event.target.value)} placeholder="Onshell.cloud" value={smtpForm.fromName} />
              </label>
              <label>
                Username
                <input onChange={(event) => updateSmtp("username", event.target.value)} value={smtpForm.username} />
              </label>
              <label>
                Password
                <input
                  onChange={(event) => setSmtpPassword(event.target.value)}
                  placeholder={smtpRes.data?.hasPassword ? "Stored, leave blank to keep" : "SMTP password"}
                  type="password"
                  value={smtpPassword}
                />
              </label>
              <label>
                Test Recipient
                <input onChange={(event) => updateSmtp("testRecipient", event.target.value)} placeholder="you@example.com" value={smtpForm.testRecipient} />
              </label>
              <label className="toggle-line package-toggle">
                <input checked={smtpForm.secure} onChange={(event) => updateSmtp("secure", event.target.checked)} type="checkbox" />
                <span>Use TLS/SSL (secure)</span>
              </label>
              <div className="form-actions span-two">
                <button className="primary-button" disabled={savingSmtp || sendingSmtpTest} onClick={saveSmtpSettings} type="button">
                  {savingSmtp ? <Loader2 className="adm-spin" size={16} /> : <Save size={16} />}
                  <span>{savingSmtp ? "Saving..." : "Save SMTP"}</span>
                </button>
                <button className="secondary-button" disabled={savingSmtp || sendingSmtpTest} onClick={sendSmtpTest} type="button">
                  {sendingSmtpTest ? <Loader2 className="adm-spin" size={16} /> : <Send size={16} />}
                  <span>{sendingSmtpTest ? "Sending..." : "Send Test"}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderBilling() {
    const providers = paymentRes.data ?? [];
    return (
      <div className="adm-stack">
        {paymentRes.error && <ErrorBanner message={paymentRes.error} onRetry={paymentRes.reload} retrying={paymentRes.loading} />}
        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Billing Provider</h2>
              <p>Connect Stripe, Paddle, SSLCommerz, or manual invoicing.</p>
            </div>
            <label className="toggle-line">
              <input checked={paymentForm.enabled} onChange={(event) => updatePayment("enabled", event.target.checked)} type="checkbox" />
              <span>Enabled</span>
            </label>
          </div>

          {paymentRes.loading && !paymentRes.data ? (
            <SkeletonRows rows={3} />
          ) : (
            <>
              {providers.length > 0 && (
                <div>
                  {providers.map((setting) => (
                    <button
                      className="adm-provider-row"
                      key={setting.id ?? `${setting.provider}-${setting.mode}`}
                      onClick={() => {
                        setPaymentForm(setting);
                        setPaymentSecretKey("");
                        setPaymentWebhookSecret("");
                      }}
                      type="button"
                    >
                      <CreditCard size={15} />
                      <strong>{setting.provider.toLowerCase().replace("_", " ")}</strong>
                      <span className={cx("adm-badge", setting.mode === "live" ? "amber" : "cyan")}>{setting.mode}</span>
                      <span className={cx("adm-badge", setting.enabled ? "green" : "soft")}>
                        {setting.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="form-grid single">
                <label>
                  Provider
                  <select onChange={(event) => updatePayment("provider", event.target.value)} value={paymentForm.provider.toLowerCase()}>
                    <option value="stripe">Stripe</option>
                    <option value="paddle">Paddle</option>
                    <option value="ssl_commerz">SSLCommerz</option>
                    <option value="manual">Manual</option>
                  </select>
                </label>
                <label>
                  Mode
                  <select onChange={(event) => updatePayment("mode", event.target.value)} value={paymentForm.mode}>
                    <option value="test">Test</option>
                    <option value="live">Live</option>
                  </select>
                </label>
                <label>
                  Public Key
                  <input onChange={(event) => updatePayment("publicKey", event.target.value)} placeholder="pk_test_..." value={paymentForm.publicKey ?? ""} />
                </label>
                <label>
                  Secret Key
                  <input
                    onChange={(event) => setPaymentSecretKey(event.target.value)}
                    placeholder={paymentForm.hasSecretKey ? "Stored, leave blank to keep" : "sk_test_..."}
                    type="password"
                    value={paymentSecretKey}
                  />
                </label>
                <label>
                  Webhook Secret
                  <input
                    onChange={(event) => setPaymentWebhookSecret(event.target.value)}
                    placeholder={paymentForm.hasWebhookSecret ? "Stored, leave blank to keep" : "whsec_..."}
                    type="password"
                    value={paymentWebhookSecret}
                  />
                </label>
                <div className="form-actions">
                  <button className="primary-button" disabled={savingPayment} onClick={savePaymentSettings} type="button">
                    {savingPayment ? <Loader2 className="adm-spin" size={16} /> : <Save size={16} />}
                    <span>{savingPayment ? "Saving..." : "Save Payment"}</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  function renderSettingEditor(setting: AppSetting) {
    const kind = settingKind(setting);
    const draft = draftFor(setting);
    if (kind === "boolean") {
      return (
        <label className="toggle-line">
          <input
            checked={draft === "true"}
            onChange={(event) => setDraft(setting.key, event.target.checked ? "true" : "false")}
            type="checkbox"
          />
          <span>{draft === "true" ? "Enabled" : "Disabled"}</span>
        </label>
      );
    }
    if (kind === "json") {
      return (
        <textarea
          aria-label={`Value for ${setting.key}`}
          onChange={(event) => setDraft(setting.key, event.target.value)}
          rows={3}
          spellCheck={false}
          value={draft}
        />
      );
    }
    return (
      <input
        aria-label={`Value for ${setting.key}`}
        inputMode={kind === "number" ? "decimal" : undefined}
        onChange={(event) => setDraft(setting.key, event.target.value)}
        placeholder={setting.isSecret ? "Hidden value, enter a new one to change" : undefined}
        type={setting.isSecret ? "password" : "text"}
        value={draft}
      />
    );
  }

  function renderSettings() {
    const settings = settingsRes.data ?? [];
    return (
      <div className="adm-stack">
        {settingsRes.error && <ErrorBanner message={settingsRes.error} onRetry={settingsRes.reload} retrying={settingsRes.loading} />}
        <div className="panel">
          <div className="panel-header tight">
            <div>
              <h2>Platform settings</h2>
              <p>Brand and platform configuration stored as key-value pairs.</p>
            </div>
            <span className="adm-count">{settingsRes.data ? `${settings.length} settings` : ""}</span>
          </div>
          {settingsRes.loading && !settingsRes.data ? (
            <SkeletonRows rows={4} />
          ) : settings.length === 0 ? (
            <EmptyState
              body="No settings stored yet. Add your first one below, for example brand.name or platform.supportEmail."
              icon={Settings2}
              title="No settings yet"
            />
          ) : (
            groupedSettings.map(([category, items]) => (
              <div key={category}>
                <p className="adm-settings-cat">{category}</p>
                {items.map((setting) => (
                  <div className="adm-setting-row" key={setting.key}>
                    <span className="adm-setting-key">
                      {setting.isSecret && <KeyRound size={13} />}
                      {setting.key}
                    </span>
                    {renderSettingEditor(setting)}
                    <button
                      className="secondary-button"
                      disabled={savingSettingKey === setting.key || !settingIsDirty(setting)}
                      onClick={() => saveSetting(setting)}
                      type="button"
                    >
                      {savingSettingKey === setting.key ? <Loader2 className="adm-spin" size={14} /> : <Save size={14} />}
                      <span>Save</span>
                    </button>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="panel">
          <div className="panel-header tight">
            <div>
              <h2>Add setting</h2>
              <p>Create or overwrite a setting by key.</p>
            </div>
          </div>
          <div className="form-grid">
            <label>
              Key
              <input onChange={(event) => setNewSetting((current) => ({ ...current, key: event.target.value }))} placeholder="brand.name" value={newSetting.key} />
            </label>
            <label>
              Category
              <input onChange={(event) => setNewSetting((current) => ({ ...current, category: event.target.value }))} placeholder="platform" value={newSetting.category} />
            </label>
            <label>
              Type
              <select
                onChange={(event) => setNewSetting((current) => ({ ...current, kind: event.target.value as SettingKind }))}
                value={newSetting.kind}
              >
                <option value="string">String</option>
                <option value="number">Number</option>
                <option value="boolean">Boolean</option>
                <option value="json">JSON</option>
              </select>
            </label>
            {newSetting.kind === "boolean" ? (
              <label>
                Value
                <select onChange={(event) => setNewSetting((current) => ({ ...current, value: event.target.value }))} value={newSetting.value === "true" ? "true" : "false"}>
                  <option value="true">True</option>
                  <option value="false">False</option>
                </select>
              </label>
            ) : (
              <label>
                Value
                <input
                  onChange={(event) => setNewSetting((current) => ({ ...current, value: event.target.value }))}
                  placeholder={newSetting.kind === "json" ? '{"key": "value"}' : "Value"}
                  type={newSetting.isSecret ? "password" : "text"}
                  value={newSetting.value}
                />
              </label>
            )}
            <label className="toggle-line package-toggle">
              <input checked={newSetting.isSecret} onChange={(event) => setNewSetting((current) => ({ ...current, isSecret: event.target.checked }))} type="checkbox" />
              <span>Secret (masked in this panel)</span>
            </label>
            <div className="form-actions">
              <button className="primary-button" disabled={savingNewSetting} onClick={saveNewSetting} type="button">
                {savingNewSetting ? <Loader2 className="adm-spin" size={16} /> : <Plus size={16} />}
                <span>{savingNewSetting ? "Saving..." : "Add Setting"}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderAccount() {
    return (
      <div className="adm-stack">
        <div className="panel">
          <div className="panel-header tight">
            <div>
              <h2>Change password</h2>
              <p>Update the password for your admin account. Saving signs out every other device.</p>
            </div>
            <KeyRound size={18} />
          </div>
          <div className="form-grid">
            <label className="span-two">
              Current password
              <input
                autoComplete="current-password"
                onChange={(event) => setCurrentPassword(event.target.value)}
                placeholder="Your current password"
                type="password"
                value={currentPassword}
              />
            </label>
            <label>
              New password
              <span className="adm-pw-field">
                <input
                  autoComplete="new-password"
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="New password"
                  type={showNewPassword ? "text" : "password"}
                  value={newPassword}
                />
                <button
                  aria-label={showNewPassword ? "Hide password" : "Show password"}
                  aria-pressed={showNewPassword}
                  className="adm-pw-reveal"
                  onClick={() => setShowNewPassword((visible) => !visible)}
                  type="button"
                >
                  {showNewPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </span>
            </label>
            <label>
              Confirm new password
              <input
                autoComplete="new-password"
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Re-enter new password"
                type={showNewPassword ? "text" : "password"}
                value={confirmPassword}
              />
            </label>
            {newPassword.length > 0 && (
              <div className="span-two">
                <PasswordChecklist password={newPassword} />
                {confirmPassword.length > 0 && !passwordsMatch && (
                  <p className="adm-pw-mismatch">
                    <AlertCircle size={13} />
                    Passwords do not match.
                  </p>
                )}
              </div>
            )}
            <div className="form-actions span-two">
              <button
                className="primary-button"
                disabled={savingPassword || !currentPassword || !newPasswordValid || !passwordsMatch}
                onClick={changePassword}
                type="button"
              >
                {savingPassword ? <Loader2 className="adm-spin" size={16} /> : <KeyRound size={16} />}
                <span>{savingPassword ? "Updating..." : "Update password"}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header tight">
            <div>
              <h2>Session</h2>
              <p>Sign out of the admin panel on this device.</p>
            </div>
            <LogOut size={18} />
          </div>
          <div className="form-actions">
            <button className="secondary-button adm-signout" disabled={loggingOut} onClick={logout} type="button">
              {loggingOut ? <Loader2 className="adm-spin" size={16} /> : <LogOut size={16} />}
              <span>{loggingOut ? "Signing out..." : "Sign out"}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  const sectionRenderers: Record<SectionId, () => ReactNode> = {
    overview: renderOverview,
    packages: renderPackages,
    subscriptions: renderSubscriptions,
    users: renderUsers,
    smtp: renderSmtp,
    billing: renderBilling,
    settings: renderSettings,
    account: renderAccount
  };

  /* ------------------------------------------------------------------ shell */

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <div className="brand-row">
          <OnshellMark size={34} />
          <div>
            <p className="brand-name">Admin Panel</p>
            <p className="brand-domain">Onshell.cloud</p>
          </div>
        </div>
        <nav className="nav-list" aria-label="Admin sections">
          {adminNav.map((item) => {
            const Icon = item.icon;
            const isActive = section === item.id;
            return (
              <button
                aria-current={isActive ? "page" : undefined}
                className={cx("nav-item", isActive && "is-active")}
                key={item.id}
                onClick={() => setSection(item.id)}
                type="button"
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="adm-sidebar-foot">
          <span className="adm-sidebar-hint">Every change here is audit-logged.</span>
        </div>
      </aside>

      <section className="admin-workspace">
        <header className="topbar">
          <div>
            <h1>{sectionMeta[section].title}</h1>
            <p>{sectionMeta[section].description}</p>
          </div>
          <div className="adm-topbar-tools">
            <ThemeToggle />
            <button
              aria-label="Refresh section data"
              className="icon-button"
              data-tooltip="Refresh"
              disabled={sectionLoading[section]}
              onClick={reloadActiveSection}
              type="button"
            >
              <RefreshCw className={cx(sectionLoading[section] && "adm-spin")} size={16} />
            </button>
            {identity && (
              <div className="profile-menu">
                <button
                  aria-expanded={profileOpen}
                  aria-haspopup="menu"
                  className={cx("profile-trigger", profileOpen && "is-open")}
                  onClick={(event) => {
                    event.stopPropagation();
                    setProfileOpen((open) => !open);
                  }}
                  type="button"
                >
                  <span className="pf-avatar">
                    {identity.avatarUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img alt="" src={identity.avatarUrl} />
                    ) : (
                      <span>{initials(identity.name)}</span>
                    )}
                  </span>
                  <span className="profile-name">{identity.name.split(" ")[0]}</span>
                  <ChevronDown className="profile-chevron" size={15} />
                </button>
                <AnimatePresence>
                  {profileOpen && (
                    <motion.div
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      className="profile-dropdown"
                      exit={reduceMotion ? undefined : { opacity: 0, y: -6, scale: 0.98 }}
                      initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
                      onClick={(event) => event.stopPropagation()}
                      role="menu"
                      transition={{ duration: 0.14, ease: "easeOut" }}
                    >
                      <div className="profile-head">
                        <span className="pf-avatar lg">
                          {identity.avatarUrl ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img alt="" src={identity.avatarUrl} />
                          ) : (
                            <span>{initials(identity.name)}</span>
                          )}
                        </span>
                        <div className="profile-head-meta">
                          <strong>{identity.name}</strong>
                          <span>{identity.email}</span>
                          <span className="profile-role">Platform admin</span>
                        </div>
                      </div>
                      <div className="profile-actions">
                        <button
                          onClick={() => {
                            window.location.href = "/console";
                          }}
                          role="menuitem"
                          type="button"
                        >
                          <ArrowLeftRight size={15} />
                          Switch to user panel
                        </button>
                        <div className="profile-divider" />
                        <button
                          className="danger"
                          disabled={loggingOut}
                          onClick={() => {
                            setProfileOpen(false);
                            logout();
                          }}
                          role="menuitem"
                          type="button"
                        >
                          <LogOut size={15} />
                          Sign out
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </div>
        </header>

        <AnimatePresence initial={false} mode="wait">
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -6 }}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
            key={section}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
          >
            {sectionRenderers[section]()}
          </motion.div>
        </AnimatePresence>
      </section>

      <AnimatePresence>
        {toast && (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className={cx("adm-toast", toast.tone)}
            exit={{ opacity: 0, y: reduceMotion ? 0 : 12 }}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 12 }}
            key={toast.id}
            role="status"
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
          >
            {toast.tone === "success" ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            <span>{toast.text}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
