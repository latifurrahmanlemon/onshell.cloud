"use client";

import { Gift, Mail, RefreshCw, TrendingUp, Users } from "lucide-react";
import { formatDate, useAdminResource } from "./lib";

interface GrowthResponse {
  newsletter: {
    total: number;
    active: number;
    recent: Array<{
      id: string;
      email: string;
      source: string;
      unsubscribedAt: string | null;
      createdAt: string;
    }>;
  };
  referrals: Array<{
    id: string;
    name: string;
    email: string;
    referralCode: string | null;
    referrals: number;
  }>;
  funnel: {
    freeWorkspaces: number;
    paidWorkspaces: number;
    conversionRate: number;
  };
}

/** Newsletter list, referral leaderboard, and the free-to-paid conversion rate. */
export function GrowthSection() {
  const { data, loading, error, reload } = useAdminResource<GrowthResponse>("/admin/growth");

  if (loading && !data) return <p className="admin-empty">Loading growth data…</p>;
  if (!data) return <p className="admin-inline-error">{error ?? "Could not load growth data."}</p>;

  const conversionPercent = (data.funnel.conversionRate * 100).toFixed(1);

  return (
    <div className="growth-admin">
      <div className="admin-card">
        <div className="admin-card-head">
          <div>
            <h2>
              <TrendingUp aria-hidden="true" size={17} />
              Freemium funnel
            </h2>
            <p>How many workspaces stay free versus convert to a paid plan.</p>
          </div>
          <button className="admin-icon-button" type="button" aria-label="Reload" onClick={() => void reload()}>
            <RefreshCw aria-hidden="true" size={15} />
          </button>
        </div>

        <div className="growth-stats">
          <div className="growth-stat">
            <span>Free workspaces</span>
            <strong>{data.funnel.freeWorkspaces}</strong>
          </div>
          <div className="growth-stat">
            <span>Paid workspaces</span>
            <strong>{data.funnel.paidWorkspaces}</strong>
          </div>
          <div className="growth-stat is-accent">
            <span>Conversion rate</span>
            <strong>{conversionPercent}%</strong>
          </div>
          <div className="growth-stat">
            <span>Newsletter subscribers</span>
            <strong>{data.newsletter.active}</strong>
          </div>
        </div>
      </div>

      <div className="admin-card">
        <div className="admin-card-head">
          <div>
            <h2>
              <Gift aria-hidden="true" size={17} />
              Referral leaderboard
            </h2>
            <p>Users whose referral link has produced at least one signup.</p>
          </div>
        </div>

        {data.referrals.length === 0 ? (
          <p className="admin-empty">No referral signups yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <caption className="sr-only">Users ranked by referral signups</caption>
              <thead>
                <tr>
                  <th scope="col">User</th>
                  <th scope="col">Code</th>
                  <th scope="col">Signups</th>
                </tr>
              </thead>
              <tbody>
                {data.referrals.map((referrer) => (
                  <tr key={referrer.id}>
                    <th scope="row">
                      <span className="growth-user">
                        <Users aria-hidden="true" size={13} />
                        <span>
                          <strong>{referrer.name}</strong>
                          <small>{referrer.email}</small>
                        </span>
                      </span>
                    </th>
                    <td className="inbox-mono">{referrer.referralCode ?? "—"}</td>
                    <td>{referrer.referrals}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="admin-card">
        <div className="admin-card-head">
          <div>
            <h2>
              <Mail aria-hidden="true" size={17} />
              Newsletter subscribers
            </h2>
            <p>
              {data.newsletter.total} total · {data.newsletter.active} active. Showing the 25 most recent.
            </p>
          </div>
        </div>

        {data.newsletter.recent.length === 0 ? (
          <p className="admin-empty">No subscribers yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <caption className="sr-only">Most recent newsletter subscribers</caption>
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Source</th>
                  <th scope="col">Status</th>
                  <th scope="col">Joined</th>
                </tr>
              </thead>
              <tbody>
                {data.newsletter.recent.map((subscriber) => (
                  <tr key={subscriber.id}>
                    <th scope="row">{subscriber.email}</th>
                    <td>{subscriber.source}</td>
                    <td>
                      <span className={subscriber.unsubscribedAt ? "growth-pill is-off" : "growth-pill"}>
                        {subscriber.unsubscribedAt ? "Unsubscribed" : "Active"}
                      </span>
                    </td>
                    <td>{formatDate(subscriber.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
