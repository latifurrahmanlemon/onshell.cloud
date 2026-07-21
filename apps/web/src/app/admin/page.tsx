"use client";

import "./admin.css";

import type { ChangeEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertCircle,
  ArrowLeftRight,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
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
  MailCheck,
  Package,
  PieChart,
  Plus,
  Receipt,
  RefreshCw,
  Save,
  Search,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  ShieldOff,
  TrendingUp,
  UserCog,
  UserPlus,
  Users,
  X
} from "lucide-react";
import { passwordPolicy, validatePassword } from "@onshell/shared";
import { cx } from "@onshell/ui";
import AdminGate from "./gate";
import { OnshellMark } from "../brand";
import { ThemeToggle } from "../theme";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

/* ------------------------------------------------------------------ types */

interface TrendPoint {
  date: string;
  count: number;
}

interface Overview {
  totals: {
    users: number;
    organizations: number;
    hosts: number;
    activeSubscriptions: number;
    plans: number;
  };
  series?: {
    days: number;
    users: TrendPoint[];
    hosts: TrendPoint[];
    cumulativeUsers: TrendPoint[];
  };
  breakdown?: {
    plans: Array<{ name: string; count: number }>;
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
  avatarUrl?: string | null;
  role: string;
  organizationId?: string;
  organizationName?: string | null;
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

type SectionId = "overview" | "users" | "settings";
type SettingsTab = "packages" | "smtp" | "billing" | "general";

type UserSortKey = "name" | "email" | "role" | "created";
type UserRoleFilter = "all" | "platform" | "owner" | "admin" | "devops" | "developer" | "auditor";
type UserStatusFilter = "all" | "verified" | "unverified";
type UserView = "directory" | "history";

const USERS_PAGE_SIZE = 8;

const USER_ROLE_OPTIONS: Array<{ value: "owner" | "admin" | "devops" | "developer" | "auditor"; label: string }> = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "devops", label: "DevOps" },
  { value: "developer", label: "Developer" },
  { value: "auditor", label: "Auditor" }
];

interface NewUserForm {
  name: string;
  email: string;
  role: "owner" | "admin" | "devops" | "developer" | "auditor";
  isPlatformAdmin: boolean;
  sendInvite: boolean;
  password: string;
}

const NEW_USER_DEFAULTS: NewUserForm = {
  name: "",
  email: "",
  role: "owner",
  isPlatformAdmin: false,
  sendInvite: false,
  password: ""
};

/* ------------------------------------------------------------- constants */

const adminNav: Array<{ id: SectionId; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "users", label: "Users", icon: Users },
  { id: "settings", label: "Settings", icon: Settings2 }
];

const settingsTabs: Array<{ id: SettingsTab; label: string; icon: LucideIcon }> = [
  { id: "packages", label: "Packages", icon: Package },
  { id: "smtp", label: "SMTP", icon: Mail },
  { id: "billing", label: "Billing Provider", icon: CreditCard },
  { id: "general", label: "General", icon: Settings2 }
];

const sectionMeta: Record<SectionId, { title: string; description: string }> = {
  overview: { title: "Overview", description: "Live platform totals and delivery status across the deployment." },
  users: { title: "Users", description: "All accounts across organizations, with roles and security posture." },
  settings: { title: "Settings", description: "Packages, email, billing, and platform configuration." }
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

type PackageSortKey = "name" | "price" | "users" | "hosts" | "status";
type SortDir = "asc" | "desc";

const PACKAGES_PAGE_SIZE = 8;

function comparePlans(left: AdminPlan, right: AdminPlan, key: PackageSortKey): number {
  switch (key) {
    case "name":
      return left.name.localeCompare(right.name);
    case "price":
      return left.priceMonthlyCents - right.priceMonthlyCents;
    case "users":
      return (left.maxUsers ?? Number.POSITIVE_INFINITY) - (right.maxUsers ?? Number.POSITIVE_INFINITY);
    case "hosts":
      return (left.maxHosts ?? Number.POSITIVE_INFINITY) - (right.maxHosts ?? Number.POSITIVE_INFINITY);
    case "status":
      return Number(right.isActive) - Number(left.isActive);
    default:
      return 0;
  }
}

function compareUsers(left: AdminUser, right: AdminUser, key: UserSortKey): number {
  switch (key) {
    case "name":
      return left.name.localeCompare(right.name);
    case "email":
      return left.email.localeCompare(right.email);
    case "role":
      return left.role.localeCompare(right.role);
    case "created":
      return new Date(left.createdAt ?? 0).getTime() - new Date(right.createdAt ?? 0).getTime();
    default:
      return 0;
  }
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

const AVATAR_SIZE = 256;

/** Read an image file and return a centered-square 256px JPEG data URL. */
async function fileToAvatarDataUrl(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read that image file."));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file is not a valid image."));
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image processing is not available in this browser.");
  const side = Math.min(image.width, image.height);
  const sx = (image.width - side) / 2;
  const sy = (image.height - side) / 2;
  ctx.drawImage(image, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  return canvas.toDataURL("image/jpeg", 0.85);
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

/* --------------------------------------------------------------- charts */

/** Parse a "YYYY-MM-DD" key into a local Date, then format it compactly. */
function shortDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Single-series area chart with a hover crosshair + tooltip. The card title names
 * the series, so no legend is needed. `tone` is any CSS color (e.g. var(--accent)).
 */
function TrendChart({
  title,
  icon: Icon,
  points,
  tone,
  unit
}: {
  title: string;
  icon: LucideIcon;
  points: TrendPoint[];
  tone: string;
  unit: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const width = 720;
  const height = 200;
  const padX = 6;
  const padTop = 16;
  const padBottom = 24;
  const count = points.length;
  const max = Math.max(1, ...points.map((point) => point.count));
  const total = points.reduce((sum, point) => sum + point.count, 0);

  const xAt = (index: number) => padX + (index * (width - padX * 2)) / Math.max(1, count - 1);
  const yAt = (value: number) => padTop + (1 - value / max) * (height - padTop - padBottom);

  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${xAt(index).toFixed(1)} ${yAt(point.count).toFixed(1)}`).join(" ");
  const areaPath =
    count > 0
      ? `${linePath} L ${xAt(count - 1).toFixed(1)} ${(height - padBottom).toFixed(1)} L ${xAt(0).toFixed(1)} ${(height - padBottom).toFixed(1)} Z`
      : "";

  const gradientId = `trend-grad-${title.replace(/\W/g, "")}`;
  const gridValues = [0, Math.round(max / 2), max];

  function onMove(event: ReactMouseEvent<HTMLDivElement>) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || count === 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    const index = Math.round(ratio * (count - 1));
    setHover(Math.max(0, Math.min(count - 1, index)));
  }

  const active = hover !== null ? points[hover] : null;

  return (
    <div className="panel adm-chart-card">
      <div className="adm-chart-head">
        <div className="adm-chart-title">
          <Icon size={16} />
          <div>
            <h2>{title}</h2>
            <p>Last {count} days</p>
          </div>
        </div>
        <div className="adm-chart-total">
          <strong>{total.toLocaleString()}</strong>
          <span>{unit}</span>
        </div>
      </div>

      <div className="adm-chart-plot" onMouseLeave={() => setHover(null)} onMouseMove={onMove} ref={wrapRef}>
        <svg preserveAspectRatio="none" role="img" aria-label={title} viewBox={`0 0 ${width} ${height}`}>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={tone} stopOpacity={0.28} />
              <stop offset="100%" stopColor={tone} stopOpacity={0} />
            </linearGradient>
          </defs>
          {gridValues.map((value) => (
            <line
              className="adm-chart-grid"
              key={value}
              x1={padX}
              x2={width - padX}
              y1={yAt(value)}
              y2={yAt(value)}
            />
          ))}
          {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
          {linePath && <path d={linePath} fill="none" stroke={tone} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
          {active && hover !== null && (
            <g>
              <line className="adm-chart-cursor" x1={xAt(hover)} x2={xAt(hover)} y1={padTop} y2={height - padBottom} />
              <circle cx={xAt(hover)} cy={yAt(active.count)} fill={tone} r={4} stroke="var(--surface)" strokeWidth={2} />
            </g>
          )}
        </svg>
        {active && hover !== null && (
          <div
            className="adm-chart-tooltip"
            style={{ left: `${(xAt(hover) / width) * 100}%`, top: `${(yAt(active.count) / height) * 100}%` }}
          >
            <strong>{active.count.toLocaleString()}</strong>
            <span>{shortDay(active.date)}</span>
          </div>
        )}
      </div>

      <div className="adm-chart-axis">
        <span>{count > 0 ? shortDay(points[0].date) : ""}</span>
        <span>{count > 0 ? shortDay(points[count - 1].date) : ""}</span>
      </div>
    </div>
  );
}

/** Horizontal magnitude bars — one hue, ranked longest first. */
function PlanBreakdown({ items }: { items: Array<{ name: string; count: number }> }) {
  const max = Math.max(1, ...items.map((item) => item.count));
  return (
    <div className="adm-breakdown">
      {items.map((item) => (
        <div className="adm-breakdown-row" key={item.name}>
          <span className="adm-breakdown-label" title={item.name}>
            {item.name}
          </span>
          <div className="adm-breakdown-track">
            <div className="adm-breakdown-fill" style={{ width: `${Math.max(4, (item.count / max) * 100)}%` }} />
          </div>
          <span className="adm-breakdown-value">{item.count}</span>
        </div>
      ))}
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

function Modal({
  title,
  description,
  icon: Icon,
  onClose,
  reduceMotion,
  className,
  children
}: {
  title: string;
  description?: string;
  icon: LucideIcon;
  onClose: () => void;
  reduceMotion: boolean;
  className?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      animate={{ opacity: 1 }}
      className="adm-modal-backdrop"
      exit={reduceMotion ? undefined : { opacity: 0 }}
      initial={reduceMotion ? false : { opacity: 0 }}
      onClick={onClose}
      transition={{ duration: 0.15 }}
    >
      <motion.div
        animate={{ opacity: 1, y: 0, scale: 1 }}
        aria-label={title}
        aria-modal="true"
        exit={reduceMotion ? undefined : { opacity: 0, y: 8, scale: 0.98 }}
        initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.98 }}
        className={className ? `adm-modal panel ${className}` : "adm-modal panel"}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        transition={{ duration: 0.16, ease: "easeOut" }}
      >
        <div className="adm-modal-head">
          <div className="adm-modal-title">
            <Icon size={18} />
            <div>
              <h2>{title}</h2>
              {description && <p>{description}</p>}
            </div>
          </div>
          <button aria-label="Close" className="icon-button compact" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>
        <div className="adm-modal-body">{children}</div>
      </motion.div>
    </motion.div>
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
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("packages");

  /* jump straight to a settings tab (used from overview shortcuts) */
  const goToSettingsTab = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab);
    setSection("settings");
  }, []);

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
  const [packageModalOpen, setPackageModalOpen] = useState(false);
  const [packageQuery, setPackageQuery] = useState("");
  const [packageSort, setPackageSort] = useState<{ key: PackageSortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  const [packagePage, setPackagePage] = useState(1);

  /* users */
  const [userView, setUserView] = useState<UserView>("directory");
  const [userQuery, setUserQuery] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState<UserRoleFilter>("all");
  const [userStatusFilter, setUserStatusFilter] = useState<UserStatusFilter>("all");
  const [userSort, setUserSort] = useState<{ key: UserSortKey; dir: SortDir }>({ key: "created", dir: "desc" });
  const [userPage, setUserPage] = useState(1);

  /* users — create modal */
  const [newUserModalOpen, setNewUserModalOpen] = useState(false);
  const [newUserForm, setNewUserForm] = useState<NewUserForm>(NEW_USER_DEFAULTS);
  const [creatingUser, setCreatingUser] = useState(false);

  /* users — manage modal */
  const [manageUser, setManageUser] = useState<AdminUser | null>(null);
  const [manageRole, setManageRole] = useState<NewUserForm["role"]>("owner");
  const [managePlatformAdmin, setManagePlatformAdmin] = useState(false);
  const [managePlanId, setManagePlanId] = useState("");
  const [managePlanInterval, setManagePlanInterval] = useState<"monthly" | "yearly">("monthly");
  const [manageNewPassword, setManageNewPassword] = useState("");
  const [savingUserAccess, setSavingUserAccess] = useState(false);
  const [savingUserVerify, setSavingUserVerify] = useState(false);
  const [savingUserPlan, setSavingUserPlan] = useState(false);
  const [savingUserPassword, setSavingUserPassword] = useState(false);

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

  /* account — password (modal) */
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);

  /* account — profile photo (modal) */
  const [photoModalOpen, setPhotoModalOpen] = useState(false);
  const [avatarDraft, setAvatarDraft] = useState<string | null>(null);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  /* account — session */
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

  const visiblePlans = useMemo(() => {
    const query = packageQuery.trim().toLowerCase();
    const filtered = query
      ? plans.filter(
          (plan) =>
            plan.name.toLowerCase().includes(query) ||
            plan.code.toLowerCase().includes(query) ||
            plan.description.toLowerCase().includes(query)
        )
      : plans;
    const factor = packageSort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((left, right) => factor * comparePlans(left, right, packageSort.key));
  }, [plans, packageQuery, packageSort]);

  const packageTotalPages = Math.max(1, Math.ceil(visiblePlans.length / PACKAGES_PAGE_SIZE));
  const packagePageSafe = Math.min(packagePage, packageTotalPages);
  const pagedPlans = useMemo(
    () => visiblePlans.slice((packagePageSafe - 1) * PACKAGES_PAGE_SIZE, packagePageSafe * PACKAGES_PAGE_SIZE),
    [visiblePlans, packagePageSafe]
  );

  /* keep the current page in range as the filter/sort narrows the list */
  useEffect(() => {
    setPackagePage(1);
  }, [packageQuery, packageSort]);

  const filteredUsers = useMemo(() => {
    const list = usersRes.data ?? [];
    const query = userQuery.trim().toLowerCase();
    const matched = list.filter((user) => {
      if (query) {
        const haystack = `${user.name} ${user.email} ${user.role} ${user.organizationName ?? ""}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (userRoleFilter === "platform") {
        if (!user.isPlatformAdmin) return false;
      } else if (userRoleFilter !== "all") {
        if (user.role !== userRoleFilter) return false;
      }
      if (userStatusFilter === "verified" && !user.emailVerifiedAt) return false;
      if (userStatusFilter === "unverified" && user.emailVerifiedAt) return false;
      return true;
    });
    const factor = userSort.dir === "asc" ? 1 : -1;
    return [...matched].sort((left, right) => factor * compareUsers(left, right, userSort.key));
  }, [usersRes.data, userQuery, userRoleFilter, userStatusFilter, userSort]);

  const userTotalPages = Math.max(1, Math.ceil(filteredUsers.length / USERS_PAGE_SIZE));
  const userPageSafe = Math.min(userPage, userTotalPages);
  const pagedUsers = useMemo(
    () => filteredUsers.slice((userPageSafe - 1) * USERS_PAGE_SIZE, userPageSafe * USERS_PAGE_SIZE),
    [filteredUsers, userPageSafe]
  );

  /* keep the current page in range as filters/sort narrow the list */
  useEffect(() => {
    setUserPage(1);
  }, [userQuery, userRoleFilter, userStatusFilter, userSort]);

  const groupedSettings = useMemo(() => {
    const groups = new Map<string, AppSetting[]>();
    for (const setting of settingsRes.data ?? []) {
      const list = groups.get(setting.category) ?? [];
      list.push(setting);
      groups.set(setting.category, list);
    }
    return Array.from(groups.entries());
  }, [settingsRes.data]);

  const settingsTabLoading: Record<SettingsTab, boolean> = {
    packages: plansRes.loading,
    smtp: smtpRes.loading,
    billing: paymentRes.loading,
    general: settingsRes.loading
  };

  const sectionLoading: Record<SectionId, boolean> = {
    overview: overviewRes.loading,
    users: usersRes.loading,
    settings: settingsTabLoading[settingsTab]
  };

  function reloadActiveSection() {
    if (section === "settings") {
      const tabReloaders: Record<SettingsTab, () => Promise<void>> = {
        packages: plansRes.reload,
        smtp: smtpRes.reload,
        billing: paymentRes.reload,
        general: settingsRes.reload
      };
      void tabReloaders[settingsTab]();
      return;
    }
    if (section === "users") {
      void usersRes.reload();
      void subscriptionsRes.reload();
      return;
    }
    void overviewRes.reload();
  }

  /* -------------------------------------------------------- package actions */

  function newPackage() {
    setPackageForm(emptyPackageForm(String(plans.length + 1)));
    setPackageModalOpen(true);
  }

  function editPlan(plan: AdminPlan) {
    setPackageForm(planToForm(plan));
    setPackageModalOpen(true);
  }

  function togglePackageSort(key: PackageSortKey) {
    setPackageSort((current) =>
      current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }
    );
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
      setPackageModalOpen(false);
      showToast("success", `Package "${saved.name}" ${wasEdit ? "updated" : "created"}.`);
    } catch (error) {
      showToast("error", errorText(error));
    } finally {
      setSavingPackage(false);
    }
  }

  /* ---------------------------------------------------------- user actions */

  function toggleUserSort(key: UserSortKey) {
    setUserSort((current) =>
      current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }
    );
  }

  function updateNewUser<K extends keyof NewUserForm>(field: K, value: NewUserForm[K]) {
    setNewUserForm((current) => ({ ...current, [field]: value }));
  }

  function openNewUser() {
    setNewUserForm(NEW_USER_DEFAULTS);
    setNewUserModalOpen(true);
  }

  function openManageUser(user: AdminUser) {
    setManageUser(user);
    setManageRole((user.role as NewUserForm["role"]) ?? "developer");
    setManagePlatformAdmin(user.isPlatformAdmin);
    const current = user.organizationId
      ? (subscriptionsRes.data ?? []).find((sub) => sub.organization?.id === user.organizationId)
      : undefined;
    setManagePlanId(current?.plan?.id ?? "");
    setManagePlanInterval(current?.billingInterval?.toLowerCase() === "yearly" ? "yearly" : "monthly");
    setManageNewPassword("");
  }

  /* replace a user in the cached list, preserving the client-only org name */
  function patchUserInList(updated: AdminUser) {
    usersRes.setData((current) =>
      (current ?? []).map((user) =>
        user.id === updated.id ? { ...updated, organizationName: user.organizationName ?? updated.organizationName } : user
      )
    );
    setManageUser((current) =>
      current && current.id === updated.id ? { ...updated, organizationName: current.organizationName } : current
    );
  }

  async function createUser() {
    if (newUserForm.name.trim().length < 2) {
      showToast("error", "Enter a name with at least 2 characters.");
      return;
    }
    if (!newUserForm.email.includes("@")) {
      showToast("error", "Enter a valid email address.");
      return;
    }
    if (!newUserForm.sendInvite && !validatePassword(newUserForm.password).valid) {
      showToast("error", "Set a password that meets the requirements, or switch to send invite.");
      return;
    }
    setCreatingUser(true);
    try {
      const created = await apiSend<AdminUser>("/admin/users", "POST", {
        name: newUserForm.name.trim(),
        email: newUserForm.email.trim().toLowerCase(),
        role: newUserForm.role,
        isPlatformAdmin: newUserForm.isPlatformAdmin,
        sendInvite: newUserForm.sendInvite,
        password: newUserForm.sendInvite ? undefined : newUserForm.password
      });
      usersRes.setData((current) => [
        { ...created, organizationName: `${newUserForm.name.trim()}'s Organization` },
        ...(current ?? [])
      ]);
      setNewUserModalOpen(false);
      showToast("success", `User "${created.name}" created.`);
    } catch (error) {
      showToast("error", errorText(error));
    } finally {
      setCreatingUser(false);
    }
  }

  async function saveUserAccess() {
    if (!manageUser) return;
    const roleChanged = manageRole !== manageUser.role;
    const adminChanged = managePlatformAdmin !== manageUser.isPlatformAdmin;
    if (!roleChanged && !adminChanged) {
      showToast("error", "No access changes to save.");
      return;
    }
    if (
      adminChanged &&
      !window.confirm(
        managePlatformAdmin
          ? `Grant platform admin access to ${manageUser.name}? They will be able to manage the whole platform.`
          : `Revoke platform admin access from ${manageUser.name}?`
      )
    ) {
      return;
    }
    setSavingUserAccess(true);
    try {
      const updated = await apiSend<AdminUser>(`/admin/users/${manageUser.id}`, "PATCH", {
        ...(roleChanged ? { role: manageRole } : {}),
        ...(adminChanged ? { isPlatformAdmin: managePlatformAdmin } : {})
      });
      patchUserInList(updated);
      showToast("success", "Access updated.");
    } catch (error) {
      showToast("error", errorText(error));
    } finally {
      setSavingUserAccess(false);
    }
  }

  async function markUserVerified() {
    if (!manageUser) return;
    setSavingUserVerify(true);
    try {
      const updated = await apiSend<AdminUser>(`/admin/users/${manageUser.id}`, "PATCH", { emailVerified: true });
      patchUserInList(updated);
      showToast("success", "Email marked as verified.");
    } catch (error) {
      showToast("error", errorText(error));
    } finally {
      setSavingUserVerify(false);
    }
  }

  async function assignUserPlan() {
    if (!manageUser) return;
    if (!managePlanId) {
      showToast("error", "Choose a plan to assign.");
      return;
    }
    const plan = plans.find((item) => item.id === managePlanId);
    if (
      !window.confirm(
        `Assign "${plan?.name ?? "plan"}" (${managePlanInterval}) to ${manageUser.name}'s organization? This changes their active subscription.`
      )
    ) {
      return;
    }
    setSavingUserPlan(true);
    try {
      const saved = await apiSend<AdminSubscription>(`/admin/users/${manageUser.id}/plan`, "PATCH", {
        planId: managePlanId,
        billingInterval: managePlanInterval
      });
      subscriptionsRes.setData((current) => {
        const list = current ?? [];
        const exists = list.some((sub) => sub.id === saved.id);
        return exists ? list.map((sub) => (sub.id === saved.id ? saved : sub)) : [saved, ...list];
      });
      showToast("success", `Plan assigned to ${saved.organization?.name ?? "organization"}.`);
    } catch (error) {
      showToast("error", errorText(error));
    } finally {
      setSavingUserPlan(false);
    }
  }

  async function setUserPassword() {
    if (!manageUser) return;
    if (!validatePassword(manageNewPassword).valid) {
      showToast("error", "The new password does not meet the requirements.");
      return;
    }
    if (!window.confirm(`Set a new password for ${manageUser.name}? Their other sessions will be signed out.`)) {
      return;
    }
    setSavingUserPassword(true);
    try {
      await apiSend(`/admin/users/${manageUser.id}/password`, "POST", { password: manageNewPassword });
      setManageNewPassword("");
      showToast("success", "Password updated.");
    } catch (error) {
      showToast("error", errorText(error));
    } finally {
      setSavingUserPassword(false);
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
      setPasswordModalOpen(false);
      showToast("success", "Password updated. Your other sessions have been signed out.");
    } catch (error) {
      showToast("error", passwordChangeError(errorText(error)));
    } finally {
      setSavingPassword(false);
    }
  }

  async function onAvatarPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // let the same file be re-picked later
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("error", "Please choose an image file.");
      return;
    }
    try {
      setAvatarDraft(await fileToAvatarDataUrl(file));
    } catch (error) {
      showToast("error", errorText(error));
    }
  }

  async function savePhoto() {
    setSavingPhoto(true);
    try {
      const { user } = await apiSend<{ user: AdminIdentity }>("/profile", "PATCH", { avatarUrl: avatarDraft ?? "" });
      setIdentity((current) => (current ? { ...current, avatarUrl: user.avatarUrl } : current));
      setPhotoModalOpen(false);
      showToast("success", "Profile photo updated.");
    } catch (error) {
      showToast("error", errorText(error));
    } finally {
      setSavingPhoto(false);
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
    const series = overviewRes.data?.series;
    const planBreakdown = overviewRes.data?.breakdown?.plans ?? [];
    const windowDays = series?.days ?? 30;
    const newUsers = series ? series.users.reduce((sum, point) => sum + point.count, 0) : 0;
    const newHosts = series ? series.hosts.reduce((sum, point) => sum + point.count, 0) : 0;
    const loadingFirst = overviewRes.loading && !overviewRes.data;

    return (
      <div className="adm-stack">
        {overviewRes.error && <ErrorBanner message={overviewRes.error} onRetry={overviewRes.reload} retrying={overviewRes.loading} />}
        {loadingFirst ? (
          <SkeletonTiles />
        ) : (
          <div className="metrics-grid">
            <MetricTile
              detail={series ? `+${newUsers} in ${windowDays}d` : totals ? `${totals.organizations} organization${totals.organizations === 1 ? "" : "s"}` : "No data yet"}
              icon={Users}
              label="Users"
              tone="green"
              value={totals ? totals.users.toLocaleString() : "—"}
            />
            <MetricTile
              detail={series ? `+${newHosts} in ${windowDays}d` : totals ? "Registered endpoints" : "No data yet"}
              icon={Database}
              label="Hosts"
              tone="rose"
              value={totals ? totals.hosts.toLocaleString() : "—"}
            />
            <MetricTile
              detail={totals ? `${totals.plans} package${totals.plans === 1 ? "" : "s"}` : "No data yet"}
              icon={Receipt}
              label="Active subscriptions"
              tone="amber"
              value={totals ? totals.activeSubscriptions.toLocaleString() : "—"}
            />
            <MetricTile
              detail={totals ? "Across the platform" : "No data yet"}
              icon={LayoutDashboard}
              label="Organizations"
              tone="cyan"
              value={totals ? totals.organizations.toLocaleString() : "—"}
            />
          </div>
        )}

        {loadingFirst ? (
          <div className="panel adm-chart-card adm-chart-skeleton">
            <div className="adm-skeleton adm-skeleton-line short" />
            <div className="adm-skeleton adm-chart-skeleton-plot" />
          </div>
        ) : series ? (
          <>
            <TrendChart icon={UserPlus} points={series.users} title="New users" tone="var(--accent)" unit={`new in ${windowDays} days`} />
            <div className="adm-two-col">
              <TrendChart icon={Server} points={series.hosts} title="New hosts" tone="var(--cyan)" unit={`new in ${windowDays} days`} />
              <div className="panel adm-chart-card">
                <div className="adm-chart-head">
                  <div className="adm-chart-title">
                    <PieChart size={16} />
                    <div>
                      <h2>Active plans</h2>
                      <p>Subscriptions by package</p>
                    </div>
                  </div>
                </div>
                {planBreakdown.length > 0 ? (
                  <PlanBreakdown items={planBreakdown} />
                ) : (
                  <EmptyState
                    body="No active subscriptions yet. They appear here once organizations subscribe to a package."
                    icon={Inbox}
                    title="No active plans"
                  />
                )}
              </div>
            </div>
          </>
        ) : null}

        <div className="adm-two-col">
          <div className="panel">
            <div className="panel-header tight">
              <div>
                <h2>Email delivery</h2>
                <p>Global SMTP status for transactional email.</p>
              </div>
              <button className="adm-link-button" onClick={() => goToSettingsTab("smtp")} type="button">
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
                  <button className="adm-link-button" onClick={() => goToSettingsTab("smtp")} type="button">
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
              <button className="adm-link-button" onClick={() => goToSettingsTab("billing")} type="button">
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
                  <button className="adm-link-button" onClick={() => goToSettingsTab("billing")} type="button">
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

  function packageSortHead(label: string, key: PackageSortKey) {
    const active = packageSort.key === key;
    return (
      <button
        aria-label={`Sort by ${label}${active ? (packageSort.dir === "asc" ? " descending" : " ascending") : ""}`}
        className={cx("adm-sort-head", active && "is-active")}
        onClick={() => togglePackageSort(key)}
        type="button"
      >
        <span>{label}</span>
        {active ? (
          packageSort.dir === "asc" ? (
            <ChevronUp size={13} />
          ) : (
            <ChevronDown size={13} />
          )
        ) : (
          <ChevronsUpDown className="adm-sort-idle" size={13} />
        )}
      </button>
    );
  }

  function renderPackages() {
    const total = plans.length;
    return (
      <div className="adm-stack">
        {plansRes.error && <ErrorBanner message={plansRes.error} onRetry={plansRes.reload} retrying={plansRes.loading} />}
        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Packages</h2>
              <p>Pricing and limits customers can buy from the public page.</p>
            </div>
            <div className="adm-users-toolbar">
              <div className="search-field">
                <Search size={15} />
                <input
                  aria-label="Search packages"
                  onChange={(event) => setPackageQuery(event.target.value)}
                  placeholder="Search name, code..."
                  value={packageQuery}
                />
              </div>
              <span className="adm-count">{plansRes.data ? `${visiblePlans.length} of ${total}` : ""}</span>
              <button className="secondary-button" onClick={newPackage} type="button">
                <Plus size={16} />
                <span>New Package</span>
              </button>
            </div>
          </div>

          {plansRes.loading && !plansRes.data ? (
            <SkeletonRows rows={3} />
          ) : total === 0 ? (
            <EmptyState
              body="Create your first package to get started. Active packages show up on the public pricing page immediately."
              icon={Package}
              title="No packages yet"
              action={
                <button className="secondary-button" onClick={newPackage} type="button">
                  <Plus size={16} />
                  <span>New Package</span>
                </button>
              }
            />
          ) : visiblePlans.length === 0 ? (
            <EmptyState
              body={`Nothing matches "${packageQuery}". Try a different name or code.`}
              icon={Search}
              title="No matching packages"
              action={
                <button className="adm-link-button" onClick={() => setPackageQuery("")} type="button">
                  Clear search
                </button>
              }
            />
          ) : (
            <>
              <div className="admin-table">
                <div className="admin-row table-head">
                  {packageSortHead("Name", "name")}
                  {packageSortHead("Price", "price")}
                  {packageSortHead("Users", "users")}
                  {packageSortHead("Hosts", "hosts")}
                  {packageSortHead("Status", "status")}
                  <span>Edit</span>
                </div>
                {pagedPlans.map((plan) => (
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

              {packageTotalPages > 1 && (
                <div className="adm-pagination">
                  <span className="adm-pagination-info">
                    Page {packagePageSafe} of {packageTotalPages}
                  </span>
                  <div className="adm-pagination-controls">
                    <button
                      aria-label="Previous page"
                      className="icon-button compact"
                      disabled={packagePageSafe <= 1}
                      onClick={() => setPackagePage((page) => Math.max(1, page - 1))}
                      type="button"
                    >
                      <ChevronLeft size={15} />
                    </button>
                    <button
                      aria-label="Next page"
                      className="icon-button compact"
                      disabled={packagePageSafe >= packageTotalPages}
                      onClick={() => setPackagePage((page) => Math.min(packageTotalPages, page + 1))}
                      type="button"
                    >
                      <ChevronRight size={15} />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  function userSortHead(label: string, key: UserSortKey) {
    const active = userSort.key === key;
    return (
      <button
        aria-label={`Sort by ${label}${active ? (userSort.dir === "asc" ? " descending" : " ascending") : ""}`}
        className={cx("adm-sort-head", active && "is-active")}
        onClick={() => toggleUserSort(key)}
        type="button"
      >
        <span>{label}</span>
        {active ? (
          userSort.dir === "asc" ? (
            <ChevronUp size={13} />
          ) : (
            <ChevronDown size={13} />
          )
        ) : (
          <ChevronsUpDown className="adm-sort-idle" size={13} />
        )}
      </button>
    );
  }

  function renderPurchaseHistory() {
    const subscriptions = subscriptionsRes.data ?? [];
    const memberCounts = new Map<string, number>();
    for (const user of usersRes.data ?? []) {
      if (user.organizationId) memberCounts.set(user.organizationId, (memberCounts.get(user.organizationId) ?? 0) + 1);
    }
    return (
      <div className="panel">
        <div className="panel-header tight">
          <div>
            <h2>Purchase history</h2>
            <p>Which organization bought which package, its status, and when.</p>
          </div>
          <span className="adm-count">{subscriptionsRes.data ? `${subscriptions.length} total` : ""}</span>
        </div>
        {subscriptionsRes.loading && !subscriptionsRes.data ? (
          <SkeletonRows rows={4} />
        ) : subscriptions.length === 0 ? (
          <EmptyState
            body="Purchases appear here as soon as an organization is assigned a package. Assign one from a user's manage panel, or wait for a checkout."
            icon={Receipt}
            title="No purchases yet"
          />
        ) : (
          <div>
            <div className="adm-hist-row table-head">
              <span>Organization</span>
              <span>Plan</span>
              <span>Status</span>
              <span>Interval</span>
              <span>Current period</span>
              <span>Purchased</span>
            </div>
            {subscriptions.map((subscription) => (
              <div className="adm-hist-row" key={subscription.id}>
                <div>
                  <strong>{subscription.organization?.name ?? "Unknown org"}</strong>
                  <small>
                    {memberCounts.get(subscription.organization?.id ?? "") ?? 0} member
                    {(memberCounts.get(subscription.organization?.id ?? "") ?? 0) === 1 ? "" : "s"}
                  </small>
                </div>
                <span data-label="Plan">{subscription.plan?.name ?? "—"}</span>
                <span className={cx("adm-badge", subscriptionTone(subscription.status))} data-label="Status">
                  {subscription.status.toLowerCase().replace(/_/g, " ")}
                </span>
                <span data-label="Interval">{subscription.billingInterval.toLowerCase()}</span>
                <span data-label="Current period">
                  {formatDate(subscription.currentPeriodStart)} – {formatDate(subscription.currentPeriodEnd)}
                </span>
                <span data-label="Purchased">{formatDate(subscription.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderUsers() {
    const total = usersRes.data?.length ?? 0;
    const filtersActive = userQuery.trim() !== "" || userRoleFilter !== "all" || userStatusFilter !== "all";
    return (
      <div className="adm-stack">
        <div aria-label="Users views" className="adm-segmented" role="tablist">
          <button
            aria-selected={userView === "directory"}
            className={cx("adm-segment", userView === "directory" && "is-active")}
            onClick={() => setUserView("directory")}
            role="tab"
            type="button"
          >
            <Users size={15} />
            <span>Directory</span>
          </button>
          <button
            aria-selected={userView === "history"}
            className={cx("adm-segment", userView === "history" && "is-active")}
            onClick={() => setUserView("history")}
            role="tab"
            type="button"
          >
            <Receipt size={15} />
            <span>Purchase history</span>
          </button>
        </div>

        {userView === "history" ? (
          <>
            {subscriptionsRes.error && (
              <ErrorBanner message={subscriptionsRes.error} onRetry={subscriptionsRes.reload} retrying={subscriptionsRes.loading} />
            )}
            {renderPurchaseHistory()}
          </>
        ) : (
          <>
            {usersRes.error && <ErrorBanner message={usersRes.error} onRetry={usersRes.reload} retrying={usersRes.loading} />}
            <div className="panel">
              <div className="panel-header">
                <div>
                  <h2>Directory</h2>
                  <p>Every account across organizations, with roles and security posture.</p>
                </div>
                <div className="adm-users-toolbar">
                  <div className="search-field">
                    <Search size={15} />
                    <input
                      aria-label="Search users"
                      onChange={(event) => setUserQuery(event.target.value)}
                      placeholder="Search name, email, org..."
                      value={userQuery}
                    />
                  </div>
                  <select
                    aria-label="Filter by role"
                    className="adm-filter"
                    onChange={(event) => setUserRoleFilter(event.target.value as UserRoleFilter)}
                    value={userRoleFilter}
                  >
                    <option value="all">All roles</option>
                    <option value="platform">Platform admins</option>
                    {USER_ROLE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Filter by email status"
                    className="adm-filter"
                    onChange={(event) => setUserStatusFilter(event.target.value as UserStatusFilter)}
                    value={userStatusFilter}
                  >
                    <option value="all">Any status</option>
                    <option value="verified">Email verified</option>
                    <option value="unverified">Email unverified</option>
                  </select>
                  <span className="adm-count">{usersRes.data ? `${filteredUsers.length} of ${total}` : ""}</span>
                  <button className="secondary-button" onClick={openNewUser} type="button">
                    <UserPlus size={16} />
                    <span>New User</span>
                  </button>
                </div>
              </div>

              {usersRes.loading && !usersRes.data ? (
                <SkeletonRows rows={4} />
              ) : total === 0 ? (
                <EmptyState
                  body="No accounts exist yet. Create one with New User, or wait for people to sign up or be invited."
                  icon={Users}
                  title="No users yet"
                  action={
                    <button className="secondary-button" onClick={openNewUser} type="button">
                      <UserPlus size={16} />
                      <span>New User</span>
                    </button>
                  }
                />
              ) : filteredUsers.length === 0 ? (
                <EmptyState
                  body="No users match the current search and filters. Try widening them."
                  icon={Search}
                  title="No matching users"
                  action={
                    filtersActive ? (
                      <button
                        className="adm-link-button"
                        onClick={() => {
                          setUserQuery("");
                          setUserRoleFilter("all");
                          setUserStatusFilter("all");
                        }}
                        type="button"
                      >
                        Clear filters
                      </button>
                    ) : undefined
                  }
                />
              ) : (
                <>
                  <div className="admin-table">
                    <div className="adm-dir-row table-head">
                      {userSortHead("Name", "name")}
                      {userSortHead("Email", "email")}
                      {userSortHead("Role", "role")}
                      <span>Security</span>
                      {userSortHead("Created", "created")}
                      <span>Manage</span>
                    </div>
                    {pagedUsers.map((user) => (
                      <div className="adm-dir-row" key={user.id}>
                        <div className="adm-dir-user">
                          <span className="pf-avatar">
                            {user.avatarUrl ? (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img alt="" src={user.avatarUrl} />
                            ) : (
                              <span>{initials(user.name)}</span>
                            )}
                          </span>
                          <div className="adm-dir-user-meta">
                            <strong>{user.name}</strong>
                            <small>{user.organizationName ?? "No organization"}</small>
                          </div>
                        </div>
                        <span className="adm-dir-email" data-label="Email">
                          {user.email}
                        </span>
                        <span className="adm-dir-badges" data-label="Role">
                          <span className="adm-badge">{user.role.replace(/_/g, " ")}</span>
                          {user.isPlatformAdmin && (
                            <span className="adm-badge amber">
                              <ShieldCheck size={12} />
                              Admin
                            </span>
                          )}
                        </span>
                        <span className="adm-dir-badges" data-label="Security">
                          {user.twoFactorEnabled ? (
                            <span className="adm-badge green">
                              <ShieldCheck size={12} />
                              2FA
                            </span>
                          ) : (
                            <span className="adm-badge soft">
                              <ShieldOff size={12} />
                              2FA
                            </span>
                          )}
                          {user.emailVerifiedAt ? (
                            <span className="adm-badge green">
                              <MailCheck size={12} />
                              Verified
                            </span>
                          ) : (
                            <span className="adm-badge rose">Unverified</span>
                          )}
                        </span>
                        <span className="adm-dir-joined" data-label="Created">
                          {formatDate(user.createdAt)}
                        </span>
                        <button
                          aria-label={`Manage ${user.name}`}
                          className="icon-button compact"
                          onClick={() => openManageUser(user)}
                          title={`Manage ${user.name}`}
                          type="button"
                        >
                          <UserCog size={15} />
                        </button>
                      </div>
                    ))}
                  </div>

                  {userTotalPages > 1 && (
                    <div className="adm-pagination">
                      <span className="adm-pagination-info">
                        Page {userPageSafe} of {userTotalPages}
                      </span>
                      <div className="adm-pagination-controls">
                        <button
                          aria-label="Previous page"
                          className="icon-button compact"
                          disabled={userPageSafe <= 1}
                          onClick={() => setUserPage((page) => Math.max(1, page - 1))}
                          type="button"
                        >
                          <ChevronLeft size={15} />
                        </button>
                        <button
                          aria-label="Next page"
                          className="icon-button compact"
                          disabled={userPageSafe >= userTotalPages}
                          onClick={() => setUserPage((page) => Math.min(userTotalPages, page + 1))}
                          type="button"
                        >
                          <ChevronRight size={15} />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
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

  function renderGeneralSettings() {
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

  const settingsTabRenderers: Record<SettingsTab, () => ReactNode> = {
    packages: renderPackages,
    smtp: renderSmtp,
    billing: renderBilling,
    general: renderGeneralSettings
  };

  function renderSettings() {
    return (
      <div className="adm-stack">
        <div aria-label="Settings sections" className="adm-tabs" role="tablist">
          {settingsTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = settingsTab === tab.id;
            return (
              <button
                aria-selected={isActive}
                className={cx("adm-tab", isActive && "is-active")}
                key={tab.id}
                onClick={() => setSettingsTab(tab.id)}
                role="tab"
                type="button"
              >
                <Icon size={15} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -6 }}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
            key={settingsTab}
            transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
          >
            {settingsTabRenderers[settingsTab]()}
          </motion.div>
        </AnimatePresence>
      </div>
    );
  }

  const sectionRenderers: Record<SectionId, () => ReactNode> = {
    overview: renderOverview,
    users: renderUsers,
    settings: renderSettings
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
            <button
              aria-label="Switch to user panel"
              className="icon-button"
              data-tooltip="Switch to user panel"
              onClick={() => {
                window.location.href = "/console";
              }}
              type="button"
            >
              <ArrowLeftRight size={16} />
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
                            setProfileOpen(false);
                            setCurrentPassword("");
                            setNewPassword("");
                            setConfirmPassword("");
                            setShowNewPassword(false);
                            setPasswordModalOpen(true);
                          }}
                          role="menuitem"
                          type="button"
                        >
                          <KeyRound size={15} />
                          Update password
                        </button>
                        <button
                          onClick={() => {
                            setProfileOpen(false);
                            setAvatarDraft(identity.avatarUrl);
                            setPhotoModalOpen(true);
                          }}
                          role="menuitem"
                          type="button"
                        >
                          <Camera size={15} />
                          Update profile photo
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
        {packageModalOpen && (
          <Modal
            className="adm-modal-wide"
            description={packageForm.id ? "Update pricing, limits, and visibility." : "Active packages show on the public pricing page immediately."}
            icon={Package}
            key="package-modal"
            onClose={() => setPackageModalOpen(false)}
            reduceMotion={reduceMotion}
            title={packageForm.id ? `Edit: ${packageForm.name || "package"}` : "New package"}
          >
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
              <label className="toggle-line package-toggle span-two">
                <input checked={packageForm.isActive} onChange={(event) => updatePackageForm("isActive", event.target.checked)} type="checkbox" />
                <span>Active on public pricing</span>
              </label>
              <div className="form-actions span-two">
                <button className="secondary-button" disabled={savingPackage} onClick={() => setPackageModalOpen(false)} type="button">
                  <span>Cancel</span>
                </button>
                <button className="primary-button" disabled={savingPackage} onClick={savePackage} type="button">
                  {savingPackage ? <Loader2 className="adm-spin" size={16} /> : <Save size={16} />}
                  <span>{savingPackage ? "Saving..." : "Save Package"}</span>
                </button>
              </div>
            </div>
          </Modal>
        )}
        {passwordModalOpen && (
          <Modal
            description="Saving signs out every other device."
            icon={KeyRound}
            key="password-modal"
            onClose={() => setPasswordModalOpen(false)}
            reduceMotion={reduceMotion}
            title="Update password"
          >
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
                <button className="secondary-button" disabled={savingPassword} onClick={() => setPasswordModalOpen(false)} type="button">
                  <span>Cancel</span>
                </button>
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
          </Modal>
        )}
        {photoModalOpen && (
          <Modal
            description="JPG, PNG, or GIF — resized to a 256px square."
            icon={Camera}
            key="photo-modal"
            onClose={() => setPhotoModalOpen(false)}
            reduceMotion={reduceMotion}
            title="Update profile photo"
          >
            <div className="adm-photo-editor">
              <div className="adm-photo-preview">
                {avatarDraft ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img alt="Your profile photo" src={avatarDraft} />
                ) : (
                  <span>{initials(identity?.name ?? "?")}</span>
                )}
              </div>
              <div className="adm-photo-actions">
                <input accept="image/*" hidden onChange={onAvatarPick} ref={avatarInputRef} type="file" />
                <div className="adm-photo-buttons">
                  <button className="secondary-button" onClick={() => avatarInputRef.current?.click()} type="button">
                    <Camera size={15} />
                    <span>{avatarDraft ? "Change photo" : "Upload photo"}</span>
                  </button>
                  {avatarDraft && (
                    <button className="adm-link-button" onClick={() => setAvatarDraft(null)} type="button">
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="form-actions">
              <button className="secondary-button" disabled={savingPhoto} onClick={() => setPhotoModalOpen(false)} type="button">
                <span>Cancel</span>
              </button>
              <button
                className="primary-button"
                disabled={savingPhoto || (avatarDraft ?? null) === (identity?.avatarUrl ?? null)}
                onClick={savePhoto}
                type="button"
              >
                {savingPhoto ? <Loader2 className="adm-spin" size={16} /> : <Save size={16} />}
                <span>{savingPhoto ? "Saving..." : "Save photo"}</span>
              </button>
            </div>
          </Modal>
        )}
        {newUserModalOpen && (
          <Modal
            description="Creates the account and its own organization. Active packages can be assigned afterwards."
            icon={UserPlus}
            key="new-user-modal"
            onClose={() => setNewUserModalOpen(false)}
            reduceMotion={reduceMotion}
            title="New user"
          >
            <div className="form-grid">
              <label>
                Name
                <input onChange={(event) => updateNewUser("name", event.target.value)} placeholder="Jane Doe" value={newUserForm.name} />
              </label>
              <label>
                Email
                <input
                  autoComplete="off"
                  onChange={(event) => updateNewUser("email", event.target.value)}
                  placeholder="jane@example.com"
                  type="email"
                  value={newUserForm.email}
                />
              </label>
              <label>
                Role
                <select onChange={(event) => updateNewUser("role", event.target.value as NewUserForm["role"])} value={newUserForm.role}>
                  {USER_ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="toggle-line package-toggle">
                <input
                  checked={newUserForm.isPlatformAdmin}
                  onChange={(event) => updateNewUser("isPlatformAdmin", event.target.checked)}
                  type="checkbox"
                />
                <span>Platform admin</span>
              </label>
              <label className="toggle-line package-toggle span-two">
                <input
                  checked={newUserForm.sendInvite}
                  onChange={(event) => updateNewUser("sendInvite", event.target.checked)}
                  type="checkbox"
                />
                <span>Send invite instead of setting a password (no password stored)</span>
              </label>
              {!newUserForm.sendInvite && (
                <label className="span-two">
                  Password
                  <input
                    autoComplete="new-password"
                    onChange={(event) => updateNewUser("password", event.target.value)}
                    placeholder="Temporary password"
                    type="text"
                    value={newUserForm.password}
                  />
                  {newUserForm.password.length > 0 && <PasswordChecklist password={newUserForm.password} />}
                </label>
              )}
              <div className="form-actions span-two">
                <button className="secondary-button" disabled={creatingUser} onClick={() => setNewUserModalOpen(false)} type="button">
                  <span>Cancel</span>
                </button>
                <button className="primary-button" disabled={creatingUser} onClick={createUser} type="button">
                  {creatingUser ? <Loader2 className="adm-spin" size={16} /> : <UserPlus size={16} />}
                  <span>{creatingUser ? "Creating..." : "Create User"}</span>
                </button>
              </div>
            </div>
          </Modal>
        )}
        {manageUser && (
          <Modal
            description={manageUser.email}
            icon={UserCog}
            key="manage-user-modal"
            onClose={() => setManageUser(null)}
            reduceMotion={reduceMotion}
            title={`Manage ${manageUser.name}`}
          >
            <div className="adm-manage">
              <div className="adm-manage-head">
                <span className="pf-avatar lg">
                  {manageUser.avatarUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img alt="" src={manageUser.avatarUrl} />
                  ) : (
                    <span>{initials(manageUser.name)}</span>
                  )}
                </span>
                <div className="adm-manage-meta">
                  <strong>{manageUser.name}</strong>
                  <span>{manageUser.email}</span>
                  <div className="adm-user-badges">
                    <span className="adm-badge">{manageUser.role.replace(/_/g, " ")}</span>
                    {manageUser.isPlatformAdmin && (
                      <span className="adm-badge amber">
                        <ShieldCheck size={12} />
                        Platform Admin
                      </span>
                    )}
                    {manageUser.emailVerifiedAt ? (
                      <span className="adm-badge green">
                        <MailCheck size={12} />
                        Verified
                      </span>
                    ) : (
                      <span className="adm-badge rose">Unverified</span>
                    )}
                  </div>
                  <small>{manageUser.organizationName ?? "No organization"}</small>
                </div>
              </div>

              <div className="adm-manage-section">
                <p className="adm-manage-title">Access</p>
                <div className="form-grid">
                  <label>
                    Role
                    <select onChange={(event) => setManageRole(event.target.value as NewUserForm["role"])} value={manageRole}>
                      {USER_ROLE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="toggle-line package-toggle">
                    <input
                      checked={managePlatformAdmin}
                      onChange={(event) => setManagePlatformAdmin(event.target.checked)}
                      type="checkbox"
                    />
                    <span>Platform admin</span>
                  </label>
                  <div className="form-actions span-two">
                    <button className="primary-button" disabled={savingUserAccess} onClick={saveUserAccess} type="button">
                      {savingUserAccess ? <Loader2 className="adm-spin" size={16} /> : <Save size={16} />}
                      <span>{savingUserAccess ? "Saving..." : "Save access"}</span>
                    </button>
                    {!manageUser.emailVerifiedAt && (
                      <button className="secondary-button" disabled={savingUserVerify} onClick={markUserVerified} type="button">
                        {savingUserVerify ? <Loader2 className="adm-spin" size={16} /> : <MailCheck size={16} />}
                        <span>Mark email verified</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="adm-manage-section">
                <p className="adm-manage-title">Subscription plan</p>
                <div className="form-grid">
                  <label>
                    Plan
                    <select onChange={(event) => setManagePlanId(event.target.value)} value={managePlanId}>
                      <option value="">Select a plan…</option>
                      {plans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.name}
                          {plan.isActive ? "" : " (hidden)"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Billing interval
                    <select
                      onChange={(event) => setManagePlanInterval(event.target.value as "monthly" | "yearly")}
                      value={managePlanInterval}
                    >
                      <option value="monthly">Monthly</option>
                      <option value="yearly">Yearly</option>
                    </select>
                  </label>
                  <div className="form-actions span-two">
                    <button
                      className="secondary-button"
                      disabled={savingUserPlan || !managePlanId}
                      onClick={assignUserPlan}
                      type="button"
                    >
                      {savingUserPlan ? <Loader2 className="adm-spin" size={16} /> : <CreditCard size={16} />}
                      <span>{savingUserPlan ? "Assigning..." : "Assign plan"}</span>
                    </button>
                  </div>
                </div>
              </div>

              <div className="adm-manage-section">
                <p className="adm-manage-title">Set password</p>
                <div className="form-grid">
                  <label className="span-two">
                    New password
                    <input
                      autoComplete="new-password"
                      onChange={(event) => setManageNewPassword(event.target.value)}
                      placeholder="New password for this user"
                      type="text"
                      value={manageNewPassword}
                    />
                    {manageNewPassword.length > 0 && <PasswordChecklist password={manageNewPassword} />}
                  </label>
                  <div className="form-actions span-two">
                    <button
                      className="secondary-button"
                      disabled={savingUserPassword || !validatePassword(manageNewPassword).valid}
                      onClick={setUserPassword}
                      type="button"
                    >
                      {savingUserPassword ? <Loader2 className="adm-spin" size={16} /> : <KeyRound size={16} />}
                      <span>{savingUserPassword ? "Saving..." : "Set password"}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>

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
