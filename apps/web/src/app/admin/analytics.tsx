"use client";

import { useMemo, useState } from "react";
import { Activity, Clock3, Eye, Globe2, MonitorSmartphone, RefreshCw, Users } from "lucide-react";
import { cx } from "@onshell/ui";
import { formatDateTime, useAdminResource } from "./lib";

type Range = "7d" | "30d" | "90d";

interface AnalyticsData {
  range: Range;
  totals: {
    views: number;
    visitors: number;
    sessions: number;
    averageDurationMs: number;
    totalDurationMs: number;
    bounceRate: number;
  };
  trend: Array<{ day: string; views: number; visitors: number; sessions: number }>;
  pages: Array<{ path: string; views: number; averageDurationMs: number }>;
  countries: Array<{ name: string; views: number }>;
  browsers: Array<{ name: string; views: number }>;
  devices: Array<{ name: string; views: number }>;
  sources: Array<{ name: string; views: number }>;
  recent: Array<{
    id: string;
    path: string;
    country: string | null;
    city: string | null;
    sessionId: string | null;
    visitorId: string | null;
    durationMs: number;
    deviceType: string | null;
    browser: string | null;
    createdAt: string;
    user: { name: string; email: string } | null;
  }>;
}

function duration(value: number) {
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function Metric({ icon: Icon, label, value, note }: { icon: typeof Eye; label: string; value: string; note: string }) {
  return (
    <article className="analytics-metric">
      <span className="analytics-metric-icon" aria-hidden="true"><Icon size={17} /></span>
      <div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>
    </article>
  );
}

function TrendChart({ points }: { points: AnalyticsData["trend"] }) {
  const width = 760;
  const height = 220;
  const pad = 28;
  const max = Math.max(1, ...points.map((point) => point.views));
  const coordinates = points.map((point, index) => ({
    ...point,
    x: pad + (index * (width - pad * 2)) / Math.max(1, points.length - 1),
    y: height - pad - (point.views / max) * (height - pad * 2)
  }));
  const line = coordinates.map((point) => `${point.x},${point.y}`).join(" ");
  const area = coordinates.length ? `${pad},${height - pad} ${line} ${coordinates.at(-1)?.x},${height - pad}` : "";

  return (
    <div className="analytics-chart-wrap">
      <svg className="analytics-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="analytics-trend-title analytics-trend-desc">
        <title id="analytics-trend-title">Page views over time</title>
        <desc id="analytics-trend-desc">{points.map((point) => `${point.day}: ${point.views} views`).join(", ")}</desc>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => <line key={ratio} x1={pad} x2={width - pad} y1={pad + ratio * (height - pad * 2)} y2={pad + ratio * (height - pad * 2)} className="analytics-gridline" />)}
        <polygon points={area} className="analytics-area" />
        <polyline points={line} className="analytics-line" />
        {coordinates.map((point) => <circle key={point.day} cx={point.x} cy={point.y} r="3.5" className="analytics-dot"><title>{point.day}: {point.views} views, {point.visitors} visitors</title></circle>)}
      </svg>
      <div className="analytics-chart-axis"><span>{points[0]?.day ?? ""}</span><span>{points.at(-1)?.day ?? ""}</span></div>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: Array<{ name: string; views: number }> }) {
  const max = Math.max(1, ...rows.map((row) => row.views));
  return (
    <section className="admin-card analytics-breakdown">
      <div className="admin-card-head"><div><h2>{title}</h2><p>Share of page views in this period.</p></div></div>
      <div className="analytics-bars">
        {rows.length ? rows.map((row) => (
          <div className="analytics-bar-row" key={row.name}>
            <div><span title={row.name}>{row.name}</span><strong>{row.views.toLocaleString()}</strong></div>
            <div className="analytics-bar-track" aria-hidden="true"><span style={{ width: `${(row.views / max) * 100}%` }} /></div>
          </div>
        )) : <p className="admin-empty">No data in this period.</p>}
      </div>
    </section>
  );
}

export function AnalyticsSection() {
  const [range, setRange] = useState<Range>("30d");
  const resource = useAdminResource<AnalyticsData>(`/admin/analytics/overview?range=${range}`);
  const data = resource.data;
  const pageRows = useMemo(() => data?.pages ?? [], [data]);

  return (
    <div className="analytics-dashboard">
      <div className="analytics-toolbar">
        <div className="analytics-ranges" role="group" aria-label="Analytics date range">
          {(["7d", "30d", "90d"] as const).map((value) => <button key={value} type="button" className={cx("analytics-range", range === value && "is-active")} aria-pressed={range === value} onClick={() => setRange(value)}>{value.replace("d", " days")}</button>)}
        </div>
        <button className="admin-button" type="button" onClick={() => void resource.reload()} disabled={resource.loading}><RefreshCw className={cx(resource.loading && "is-spinning")} size={15} />Refresh</button>
      </div>

      {resource.error && <p className="admin-inline-error" role="alert">{resource.error}</p>}
      {!data && resource.loading ? <div className="analytics-loading" aria-label="Loading analytics"><span /><span /><span /><span /></div> : data && <>
        <section className="analytics-metrics" aria-label="Analytics summary">
          <Metric icon={Eye} label="Page views" value={data.totals.views.toLocaleString()} note="Every route view" />
          <Metric icon={Users} label="Visitors" value={data.totals.visitors.toLocaleString()} note="First-party anonymous IDs" />
          <Metric icon={Activity} label="Sessions" value={data.totals.sessions.toLocaleString()} note="30-minute inactivity window" />
          <Metric icon={Clock3} label="Avg. active time" value={duration(data.totals.averageDurationMs)} note="Visible-tab time only" />
          <Metric icon={MonitorSmartphone} label="Bounce rate" value={`${data.totals.bounceRate}%`} note="Single view under 10 seconds" />
        </section>

        <section className="admin-card analytics-trend-card">
          <div className="admin-card-head"><div><h2><Activity size={17} />Traffic trend</h2><p>Views per day; hover a point for visitors and views.</p></div></div>
          <TrendChart points={data.trend} />
        </section>

        <div className="analytics-grid">
          <section className="admin-card analytics-pages">
            <div className="admin-card-head"><div><h2>Top pages</h2><p>Most visited routes and their average active time.</p></div></div>
            <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Page</th><th>Views</th><th>Avg. time</th></tr></thead><tbody>{pageRows.map((row) => <tr key={row.path}><th className="analytics-path" title={row.path}>{row.path}</th><td>{row.views.toLocaleString()}</td><td>{duration(row.averageDurationMs)}</td></tr>)}</tbody></table></div>
          </section>
          <Breakdown title="Traffic sources" rows={data.sources} />
          <Breakdown title="Countries" rows={data.countries} />
          <Breakdown title="Browsers" rows={data.browsers} />
          <Breakdown title="Devices" rows={data.devices} />
        </div>

        <section className="admin-card">
          <div className="admin-card-head"><div><h2><Globe2 size={17} />Live visit stream</h2><p>Latest attributed and anonymous page views across the application.</p></div></div>
          <div className="admin-table-wrap"><table className="admin-table analytics-recent"><thead><tr><th>Visitor</th><th>Page</th><th>Location</th><th>Device</th><th>Active time</th><th>When</th></tr></thead><tbody>{data.recent.map((row) => <tr key={row.id}><th>{row.user ? <span>{row.user.name}<small>{row.user.email}</small></span> : <span>Anonymous<small>visitor {row.visitorId?.slice(0, 8) ?? "unknown"} · session {row.sessionId?.slice(0, 8) ?? "unknown"}</small></span>}</th><td className="analytics-path" title={row.path}>{row.path}</td><td>{[row.city, row.country].filter(Boolean).join(", ") || "Unknown"}</td><td>{[row.browser, row.deviceType].filter(Boolean).join(" · ")}</td><td>{duration(row.durationMs)}</td><td>{formatDateTime(row.createdAt)}</td></tr>)}</tbody></table></div>
        </section>
      </>}
    </div>
  );
}
