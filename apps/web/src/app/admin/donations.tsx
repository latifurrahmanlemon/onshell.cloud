"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  HeartHandshake,
  RefreshCw,
  Search,
} from "lucide-react";
import { cx } from "@onshell/ui";
import { apiGet, errorText, formatDateTime } from "./lib";

interface Donation {
  id: string;
  amountCents: number;
  currency: string;
  donorName?: string | null;
  donorEmail?: string | null;
  message?: string | null;
  source: string;
  status: "PENDING" | "PAID" | "FAILED" | "REFUNDED";
  providerSessionId?: string | null;
  paidAt?: string | null;
  createdAt: string;
}

interface DonationResponse {
  total: number;
  take: number;
  skip: number;
  summary: { paidCount: number; raisedCents: number; currency: string };
  donations: Donation[];
}

const PAGE_SIZE = 12;
const statuses = ["all", "PAID", "PENDING", "FAILED", "REFUNDED"] as const;

function money(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100,
  );
}

function statusTone(status: Donation["status"]) {
  if (status === "PAID") return "green";
  if (status === "PENDING") return "amber";
  if (status === "REFUNDED") return "cyan";
  return "rose";
}

export function DonationsSection() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [status, setStatus] = useState<(typeof statuses)[number]>("all");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<DonationResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => setPage(1), [debouncedQuery, status]);

  const path = useMemo(() => {
    const params = new URLSearchParams({
      take: String(PAGE_SIZE),
      skip: String((page - 1) * PAGE_SIZE),
    });
    if (debouncedQuery) params.set("search", debouncedQuery);
    if (status !== "all") params.set("status", status);
    return `/admin/donations?${params}`;
  }, [debouncedQuery, page, status]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void apiGet<DonationResponse>(path)
      .then((next) => {
        if (active) setData(next);
      })
      .catch((cause) => {
        if (active) setError(errorText(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, revision]);

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="adm-stack">
      <div className="donation-summary-grid">
        <article className="donation-summary-card">
          <span>
            <CircleDollarSign aria-hidden="true" size={18} />
          </span>
          <div>
            <small>Total raised</small>
            <strong>{money(data?.summary.raisedCents ?? 0)}</strong>
          </div>
        </article>
        <article className="donation-summary-card">
          <span>
            <HeartHandshake aria-hidden="true" size={18} />
          </span>
          <div>
            <small>Completed donations</small>
            <strong>{data?.summary.paidCount ?? 0}</strong>
          </div>
        </article>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Donations</h2>
            <p>
              Guest and signed-out contributions confirmed by Stripe webhooks.
            </p>
          </div>
          <div className="adm-users-toolbar donation-tools">
            <div className="search-field">
              <Search size={15} />
              <input
                aria-label="Search donations"
                placeholder="Name, email, message…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <select
              aria-label="Filter donation status"
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as (typeof statuses)[number])
              }
            >
              {statuses.map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "All statuses" : value.toLowerCase()}
                </option>
              ))}
            </select>
            <button
              aria-label="Refresh donations"
              className="icon-button"
              disabled={loading}
              onClick={() => setRevision((value) => value + 1)}
              type="button"
            >
              <RefreshCw className={cx(loading && "adm-spin")} size={15} />
            </button>
          </div>
        </div>

        {error ? (
          <div className="donation-error" role="alert">
            <strong>Could not load donations.</strong>
            <span>{error}</span>
            <button
              className="adm-link-button"
              onClick={() => setRevision((value) => value + 1)}
              type="button"
            >
              Retry
            </button>
          </div>
        ) : loading && !data ? (
          <div className="donation-loading" role="status">
            Loading donations…
          </div>
        ) : !data?.donations.length ? (
          <div className="donation-empty">
            <HeartHandshake aria-hidden="true" size={24} />
            <strong>No donations found</strong>
            <span>
              {query || status !== "all"
                ? "Try clearing the current filters."
                : "Completed and pending checkouts will appear here."}
            </span>
          </div>
        ) : (
          <div className="donation-table-wrap">
            <table className="donation-table">
              <thead>
                <tr>
                  <th>Donor</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Message</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data.donations.map((donation) => (
                  <tr key={donation.id}>
                    <td>
                      <strong>{donation.donorName || "Anonymous"}</strong>
                      <small>
                        {donation.donorEmail || "No email provided"}
                      </small>
                    </td>
                    <td className="donation-amount">
                      {money(donation.amountCents, donation.currency)}
                    </td>
                    <td>
                      <span
                        className={cx("adm-badge", statusTone(donation.status))}
                      >
                        {donation.status.toLowerCase()}
                      </span>
                    </td>
                    <td>{donation.source}</td>
                    <td
                      className="donation-message"
                      title={donation.message ?? undefined}
                    >
                      {donation.message || "—"}
                    </td>
                    <td>
                      {formatDateTime(donation.paidAt ?? donation.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(data?.total ?? 0) > 0 && (
          <div className="adm-pagination">
            <span className="adm-pagination-info">
              {data?.total ?? 0} total · Page {page} of {totalPages}
            </span>
            <div className="adm-pagination-controls">
              <button
                aria-label="Previous page"
                className="icon-button compact"
                disabled={page <= 1 || loading}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                type="button"
              >
                <ChevronLeft size={15} />
              </button>
              <button
                aria-label="Next page"
                className="icon-button compact"
                disabled={page >= totalPages || loading}
                onClick={() =>
                  setPage((value) => Math.min(totalPages, value + 1))
                }
                type="button"
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
