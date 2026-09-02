"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  Eye,
  Globe,
  LogIn,
  MailCheck,
  RefreshCw,
  Search,
  X
} from "lucide-react";
import { cx } from "@onshell/ui";
import { apiGet, errorText, formatDateTime, useAdminResource } from "./lib";

/* ------------------------------------------------------------------ types */

interface LogUser {
  id: string;
  name: string;
  email: string;
}

interface VisitorRow {
  id: string;
  path: string;
  country: string | null;
  createdAt: string;
  user: LogUser | null;
}

interface VisitorDetail extends VisitorRow {
  userId: string | null;
  referrer: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

type AuthEventType = "LOGIN" | "LOGOUT" | "LOGIN_FAILED" | "TWO_FACTOR_COMPLETED";
type AuthEventMethod = "PASSWORD" | "GOOGLE" | "TWO_FACTOR" | "SESSION";

interface AuthEventRow {
  id: string;
  email: string;
  event: AuthEventType;
  method: AuthEventMethod;
  success: boolean;
  createdAt: string;
  user: LogUser | null;
}

interface AuthEventDetail extends AuthEventRow {
  userId: string | null;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

type EmailLogStatus = "SENT" | "FAILED" | "SKIPPED";

interface EmailRow {
  id: string;
  recipient: string;
  subject: string;
  kind: string;
  status: EmailLogStatus;
  createdAt: string;
}

interface EmailDetail extends EmailRow {
  providerMessageId: string | null;
  error: string | null;
}

interface LogListResponse<Row> {
  total: number;
  take: number;
  skip: number;
  rows: Row[];
}

interface EmailListResponse extends LogListResponse<EmailRow> {
  /** Template identifiers present in the table, for the kind filter. */
  kinds: string[];
}

/* --------------------------------------------------------------- constants */

type LogTab = "visitors" | "auth" | "emails";

const DEFAULT_LOGS_PAGE_SIZE = 25;
const LOGS_PAGE_SIZES = [10, 25, 50, 100] as const;

const LOG_TABS: Array<{ id: LogTab; label: string; icon: typeof Globe }> = [
  { id: "visitors", label: "Visitor log", icon: Globe },
  { id: "auth", label: "Login log", icon: LogIn },
  { id: "emails", label: "Email log", icon: MailCheck }
];

const AUTH_EVENT_LABELS: Record<AuthEventType, string> = {
  LOGIN: "Login",
  LOGOUT: "Logout",
  LOGIN_FAILED: "Failed login",
  TWO_FACTOR_COMPLETED: "2FA completed"
};

const AUTH_METHOD_LABELS: Record<AuthEventMethod, string> = {
  PASSWORD: "Password",
  GOOGLE: "Google",
  TWO_FACTOR: "2FA",
  SESSION: "Session"
};

const EMAIL_STATUS_LABELS: Record<EmailLogStatus, string> = {
  SENT: "Sent",
  FAILED: "Failed",
  SKIPPED: "Skipped"
};

const EMAIL_STATUS_TONES: Record<EmailLogStatus, string> = {
  SENT: "green",
  FAILED: "rose",
  SKIPPED: "soft"
};

/* ------------------------------------------------------------ generic table */

interface LogColumn<Row> {
  label: string;
  render: (row: Row) => ReactNode;
  /** Server-side sort key. Omit to leave the column unsortable. */
  sortKey?: string;
  className?: string;
}

interface LogFilterSpec {
  param: string;
  label: string;
  /** The first option should be the "any" case, with an empty value. */
  options: Array<{ value: string; label: string }>;
}

interface LogDetailField {
  label: string;
  value: ReactNode;
  /** Spans both columns — for user agents, referrers, and error text. */
  wide?: boolean;
}

/**
 * Paged, sorted, filtered log table with a details drawer.
 *
 * Everything except rendering happens on the server: these tables are expected
 * to reach millions of rows, so the client only ever holds one page.
 */
function LogTable<Row extends { id: string }, Detail extends { id: string }, List extends LogListResponse<Row>>({
  resource,
  title,
  description,
  searchPlaceholder,
  emptyText,
  columns,
  defaultSort,
  filters,
  detailTitle,
  detailFields
}: {
  resource: string;
  title: string;
  description: string;
  searchPlaceholder: string;
  emptyText: string;
  columns: Array<LogColumn<Row>>;
  defaultSort: string;
  /** Given the current payload so options can be derived from the data. */
  filters?: (list: List | undefined) => LogFilterSpec[];
  detailTitle: string;
  detailFields: (detail: Detail) => LogDetailField[];
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sort, setSort] = useState<{ key: string; direction: "asc" | "desc" }>({
    key: defaultSort,
    direction: "desc"
  });
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [range, setRange] = useState({ from: "", to: "" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_LOGS_PAGE_SIZE);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ loading: boolean; data?: Detail; error?: string }>({ loading: false });

  // Debounce so typing in the search box does not fire a request per keystroke.
  // Any narrowing invalidates the current offset, hence the page reset here and
  // in every other control below.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      take: String(pageSize),
      skip: String((page - 1) * pageSize),
      sort: sort.key,
      direction: sort.direction
    });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    for (const [param, value] of Object.entries(filterValues)) {
      if (value) params.set(param, value);
    }
    return params.toString();
  }, [page, pageSize, sort, debouncedSearch, range, filterValues]);

  const { data, loading, error, reload } = useAdminResource<List>(`/admin/logs/${resource}?${query}`);

  useEffect(() => {
    if (!detailId) {
      setDetail({ loading: false });
      return;
    }

    let active = true;
    setDetail({ loading: true });
    apiGet<Detail>(`/admin/logs/${resource}/${detailId}`)
      .then((loaded) => {
        if (active) setDetail({ loading: false, data: loaded });
      })
      .catch((caught: unknown) => {
        if (active) setDetail({ loading: false, error: errorText(caught) });
      });

    return () => {
      active = false;
    };
  }, [detailId, resource]);

  useEffect(() => {
    if (!detailId) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDetailId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailId]);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const filterSpecs = filters?.(data) ?? [];
  const filtersActive =
    debouncedSearch !== "" || range.from !== "" || range.to !== "" || Object.values(filterValues).some(Boolean);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  function toggleSort(key: string) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "desc" }
    );
    setPage(1);
  }

  function setFilter(param: string, value: string) {
    setFilterValues((current) => ({ ...current, [param]: value }));
    setPage(1);
  }

  function setRangeBound(bound: "from" | "to", value: string) {
    setRange((current) => ({ ...current, [bound]: value }));
    setPage(1);
  }

  function clearFilters() {
    setSearch("");
    setFilterValues({});
    setRange({ from: "", to: "" });
    setPage(1);
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <div className="logs-toolbar">
          <div className="search-field">
            <Search size={15} />
            <input
              aria-label={searchPlaceholder}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
              value={search}
            />
          </div>
          {filterSpecs.map((filter) => (
            <select
              aria-label={filter.label}
              className="adm-filter"
              key={filter.param}
              onChange={(event) => setFilter(filter.param, event.target.value)}
              value={filterValues[filter.param] ?? ""}
            >
              {filter.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ))}
          <label className="logs-date-field">
            <span>From</span>
            <input onChange={(event) => setRangeBound("from", event.target.value)} type="date" value={range.from} />
          </label>
          <label className="logs-date-field">
            <span>To</span>
            <input onChange={(event) => setRangeBound("to", event.target.value)} type="date" value={range.to} />
          </label>
          <span className="adm-count">{data ? `${total.toLocaleString()} entries` : ""}</span>
          <button
            aria-label={`Reload ${title.toLowerCase()}`}
            className="icon-button compact"
            disabled={loading}
            onClick={() => void reload()}
            type="button"
          >
            <RefreshCw className={cx(loading && "adm-spin")} size={15} />
          </button>
        </div>
      </div>

      {error && (
        <p className="logs-error" role="alert">
          <AlertCircle aria-hidden="true" size={15} />
          {error}
        </p>
      )}

      {rows.length === 0 && !loading ? (
        <div className="adm-empty">
          <strong>{filtersActive ? "No matching entries" : "Nothing logged yet"}</strong>
          <p>{filtersActive ? "No entries match the current search and filters." : emptyText}</p>
          {filtersActive && (
            <button className="adm-link-button" onClick={clearFilters} type="button">
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="logs-table-scroll">
            <table className="logs-table">
              <thead>
                <tr>
                  {columns.map((column) => {
                    const active = column.sortKey !== undefined && column.sortKey === sort.key;
                    return (
                      <th
                        aria-sort={
                          column.sortKey === undefined ? undefined : active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
                        }
                        key={column.label}
                        scope="col"
                      >
                        {column.sortKey === undefined ? (
                          column.label
                        ) : (
                          <button
                            aria-label={`Sort by ${column.label}${active ? (sort.direction === "asc" ? " descending" : " ascending") : ""}`}
                            className={cx("adm-sort-head", active && "is-active")}
                            onClick={() => toggleSort(column.sortKey as string)}
                            type="button"
                          >
                            <span>{column.label}</span>
                            {active ? (
                              sort.direction === "asc" ? (
                                <ChevronUp size={13} />
                              ) : (
                                <ChevronDown size={13} />
                              )
                            ) : (
                              <ChevronsUpDown className="adm-sort-idle" size={13} />
                            )}
                          </button>
                        )}
                      </th>
                    );
                  })}
                  <th scope="col">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    {columns.map((column) => (
                      <td className={column.className} key={column.label}>
                        {column.render(row)}
                      </td>
                    ))}
                    <td className="logs-row-action">
                      <button
                        aria-label="View full details"
                        className="icon-button compact"
                        onClick={() => setDetailId(row.id)}
                        title="View full details"
                        type="button"
                      >
                        <Eye size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="adm-pagination">
            <label className="adm-page-size">
              Rows per page
              <select
                aria-label={`${title} rows per page`}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
                value={pageSize}
              >
                {LOGS_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <span className="adm-pagination-info">
              Page {page} of {totalPages} · {total.toLocaleString()} entries
            </span>
            <div className="adm-pagination-controls">
              <button
                aria-label="Previous page"
                className="icon-button compact"
                disabled={page <= 1 || loading}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                type="button"
              >
                <ChevronLeft size={15} />
              </button>
              <button
                aria-label="Next page"
                className="icon-button compact"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((current) => current + 1)}
                type="button"
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        </>
      )}

      {detailId && (
        <div className="logs-drawer-backdrop">
          <aside
            aria-label={detailTitle}
            aria-modal="true"
            className="logs-drawer"
            role="dialog"
          >
            <div className="logs-drawer-head">
              <h3>{detailTitle}</h3>
              <button aria-label="Close details" className="icon-button compact" onClick={() => setDetailId(null)} type="button">
                <X size={15} />
              </button>
            </div>
            {detail.loading && <p className="logs-drawer-note">Loading details…</p>}
            {detail.error && (
              <p className="logs-error" role="alert">
                <AlertCircle aria-hidden="true" size={15} />
                {detail.error}
              </p>
            )}
            {detail.data && (
              <dl className="logs-detail-list">
                {detailFields(detail.data).map((field) => (
                  <div className={cx(field.wide && "is-wide")} key={field.label}>
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ shared */

/** Renders a nullable value without leaving an empty cell. */
function orDash(value: ReactNode) {
  return value === null || value === undefined || value === "" ? "—" : value;
}

function mono(value: string | null) {
  return value ? <span className="logs-mono">{value}</span> : "—";
}

function visitorName(row: { user: LogUser | null }) {
  return row.user ? (
    <span className="logs-visitor">
      <strong>{row.user.name}</strong>
      <small>{row.user.email}</small>
    </span>
  ) : (
    <span className="adm-badge soft">Anonymous</span>
  );
}

/* -------------------------------------------------------------------- tabs */

function VisitorLogTable() {
  return (
    <LogTable<VisitorRow, VisitorDetail, LogListResponse<VisitorRow>>
      resource="visitors"
      title="Visitor log"
      description="Every page view on the public site, attributed to an account when the visitor was signed in."
      searchPlaceholder="Search path, IP, or visitor..."
      emptyText="Page views appear here as soon as the public site receives traffic."
      defaultSort="createdAt"
      columns={[
        { label: "When", sortKey: "createdAt", render: (row) => formatDateTime(row.createdAt) },
        { label: "Path", sortKey: "path", className: "logs-cell-path", render: (row) => mono(row.path) },
        { label: "Visitor", render: visitorName },
        { label: "Country", sortKey: "country", render: (row) => orDash(row.country) }
      ]}
      filters={() => [
        {
          param: "visitor",
          label: "Filter by visitor",
          options: [
            { value: "", label: "All visitors" },
            { value: "user", label: "Signed in" },
            { value: "anonymous", label: "Anonymous" }
          ]
        }
      ]}
      detailTitle="Visit details"
      detailFields={(row) => [
        { label: "When", value: formatDateTime(row.createdAt) },
        { label: "Path", value: mono(row.path) },
        { label: "Visitor", value: row.user ? `${row.user.name} (${row.user.email})` : "Anonymous" },
        { label: "User ID", value: mono(row.userId) },
        { label: "IP address", value: mono(row.ipAddress) },
        { label: "Country", value: orDash(row.country) },
        { label: "Referrer", value: orDash(row.referrer), wide: true },
        { label: "User agent", value: orDash(row.userAgent), wide: true },
        { label: "Log ID", value: mono(row.id), wide: true }
      ]}
    />
  );
}

function AuthLogTable() {
  return (
    <LogTable<AuthEventRow, AuthEventDetail, LogListResponse<AuthEventRow>>
      resource="auth-events"
      title="Login log"
      description="Sign-ins, sign-outs, failed attempts, and completed two-factor challenges."
      searchPlaceholder="Search email, IP, or reason..."
      emptyText="Sign-in activity appears here as soon as someone authenticates."
      defaultSort="createdAt"
      columns={[
        { label: "When", sortKey: "createdAt", render: (row) => formatDateTime(row.createdAt) },
        {
          label: "Account",
          sortKey: "email",
          render: (row) =>
            row.user ? (
              <span className="logs-visitor">
                <strong>{row.user.name}</strong>
                <small>{row.email}</small>
              </span>
            ) : (
              // Failed attempts against an address with no account still matter.
              <span className="logs-visitor">
                <strong>{row.email}</strong>
                <small>No account</small>
              </span>
            )
        },
        { label: "Event", sortKey: "event", render: (row) => AUTH_EVENT_LABELS[row.event] },
        { label: "Method", sortKey: "method", render: (row) => AUTH_METHOD_LABELS[row.method] },
        {
          label: "Outcome",
          sortKey: "success",
          render: (row) => (
            <span className={cx("adm-badge", row.success ? "green" : "rose")}>{row.success ? "Success" : "Failure"}</span>
          )
        }
      ]}
      filters={() => [
        {
          param: "event",
          label: "Filter by event",
          options: [
            { value: "", label: "All events" },
            ...(Object.keys(AUTH_EVENT_LABELS) as AuthEventType[]).map((event) => ({
              value: event,
              label: AUTH_EVENT_LABELS[event]
            }))
          ]
        },
        {
          param: "method",
          label: "Filter by method",
          options: [
            { value: "", label: "All methods" },
            ...(Object.keys(AUTH_METHOD_LABELS) as AuthEventMethod[]).map((method) => ({
              value: method,
              label: AUTH_METHOD_LABELS[method]
            }))
          ]
        },
        {
          param: "outcome",
          label: "Filter by outcome",
          options: [
            { value: "", label: "Any outcome" },
            { value: "success", label: "Success only" },
            { value: "failure", label: "Failures only" }
          ]
        }
      ]}
      detailTitle="Login event details"
      detailFields={(row) => [
        { label: "When", value: formatDateTime(row.createdAt) },
        { label: "Event", value: AUTH_EVENT_LABELS[row.event] },
        { label: "Method", value: AUTH_METHOD_LABELS[row.method] },
        { label: "Outcome", value: row.success ? "Success" : "Failure" },
        { label: "Email", value: row.email },
        { label: "Account", value: row.user ? row.user.name : "No matching account" },
        { label: "User ID", value: mono(row.userId) },
        { label: "Reason", value: orDash(row.reason) },
        { label: "IP address", value: mono(row.ipAddress) },
        { label: "User agent", value: orDash(row.userAgent), wide: true },
        { label: "Log ID", value: mono(row.id), wide: true }
      ]}
    />
  );
}

function EmailLogTable() {
  return (
    <LogTable<EmailRow, EmailDetail, EmailListResponse>
      resource="emails"
      title="Email log"
      description="Every outbound message. Subjects and delivery status only — bodies are never stored."
      searchPlaceholder="Search recipient, subject, or template..."
      emptyText="Delivery records appear here the first time the platform sends an email."
      defaultSort="createdAt"
      columns={[
        { label: "When", sortKey: "createdAt", render: (row) => formatDateTime(row.createdAt) },
        { label: "Recipient", sortKey: "recipient", render: (row) => row.recipient },
        { label: "Subject", sortKey: "subject", className: "logs-cell-subject", render: (row) => row.subject },
        { label: "Template", sortKey: "kind", render: (row) => mono(row.kind) },
        {
          label: "Status",
          sortKey: "status",
          render: (row) => (
            <span className={cx("adm-badge", EMAIL_STATUS_TONES[row.status])}>{EMAIL_STATUS_LABELS[row.status]}</span>
          )
        }
      ]}
      filters={(list) => [
        {
          param: "status",
          label: "Filter by status",
          options: [
            { value: "", label: "Any status" },
            ...(Object.keys(EMAIL_STATUS_LABELS) as EmailLogStatus[]).map((status) => ({
              value: status,
              label: EMAIL_STATUS_LABELS[status]
            }))
          ]
        },
        {
          param: "kind",
          label: "Filter by template",
          // Derived from the rows actually stored, so adding a template needs no
          // change here.
          options: [
            { value: "", label: "All templates" },
            ...(list?.kinds ?? []).map((kind) => ({ value: kind, label: kind }))
          ]
        }
      ]}
      detailTitle="Email details"
      detailFields={(row) => [
        { label: "When", value: formatDateTime(row.createdAt) },
        { label: "Status", value: EMAIL_STATUS_LABELS[row.status] },
        { label: "Recipient", value: row.recipient },
        { label: "Template", value: mono(row.kind) },
        { label: "Subject", value: row.subject, wide: true },
        { label: "Provider message ID", value: mono(row.providerMessageId), wide: true },
        { label: "Error", value: orDash(row.error), wide: true },
        { label: "Log ID", value: mono(row.id), wide: true }
      ]}
    />
  );
}

/* ----------------------------------------------------------------- section */

/**
 * Activity logs for the platform: public traffic, sign-in events, and outbound
 * email. Each tab is independent, so switching tabs starts a fresh query rather
 * than carrying one tab's filters into another.
 */
export function LogsSection() {
  const [tab, setTab] = useState<LogTab>("visitors");

  return (
    <div className="adm-stack">
      <div aria-label="Log views" className="adm-segmented" role="tablist">
        {LOG_TABS.map((entry) => {
          const Icon = entry.icon;
          const isActive = tab === entry.id;
          return (
            <button
              aria-selected={isActive}
              className={cx("adm-segment", isActive && "is-active")}
              key={entry.id}
              onClick={() => setTab(entry.id)}
              role="tab"
              type="button"
            >
              <Icon size={15} />
              <span>{entry.label}</span>
            </button>
          );
        })}
      </div>

      {tab === "visitors" && <VisitorLogTable />}
      {tab === "auth" && <AuthLogTable />}
      {tab === "emails" && <EmailLogTable />}
    </div>
  );
}
