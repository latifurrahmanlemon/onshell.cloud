"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, ChevronLeft, ChevronRight, Clock3, Eye, Globe2, MonitorSmartphone, RefreshCw, Users } from "lucide-react";
import { cx } from "@onshell/ui";
import { formatDateTime, useAdminResource } from "./lib";

type Range = "7d" | "30d" | "90d";

interface AnalyticsData {
  range: Range;
  totals: { views: number; visitors: number; sessions: number; averageDurationMs: number; totalDurationMs: number; bounceRate: number };
  trend: Array<{ day: string; views: number; visitors: number; sessions: number }>;
  pages: Array<{ path: string; views: number; averageDurationMs: number }>;
  countries: Array<{ name: string; views: number }>;
  browsers: Array<{ name: string; views: number }>;
  devices: Array<{ name: string; views: number }>;
  sources: Array<{ name: string; views: number }>;
  activeUsers: Array<{ path: string; createdAt: string; user: { id: string; name: string; email: string } | null }>;
  recent: {
    total: number;
    take: number;
    skip: number;
    rows: Array<{
      id: string; path: string; country: string | null; city: string | null; sessionId: string | null;
      visitorId: string | null; durationMs: number; deviceType: string | null; browser: string | null;
      createdAt: string; user: { name: string; email: string } | null;
    }>;
  };
}

function duration(value: number) {
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00Z`));
}

function Metric({ icon: Icon, label, value, note }: { icon: typeof Eye; label: string; value: string; note: string }) {
  return <article className="analytics-metric"><span className="analytics-metric-icon" aria-hidden="true"><Icon size={17} /></span><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article>;
}

function TrendChart({ points }: { points: AnalyticsData["trend"] }) {
  const width = 840;
  const height = 250;
  const padding = { top: 18, right: 18, bottom: 28, left: 48 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(1, ...points.flatMap((point) => [point.views, point.visitors, point.sessions]));
  const ceiling = Math.max(5, Math.ceil(maxValue / 5) * 5);
  const coordinate = (value: number, index: number) => ({
    x: padding.left + (index * chartWidth) / Math.max(1, points.length - 1),
    y: padding.top + chartHeight - (value / ceiling) * chartHeight
  });
  const views = points.map((point, index) => ({ ...point, ...coordinate(point.views, index) }));
  const visitors = points.map((point, index) => ({ ...point, ...coordinate(point.visitors, index) }));
  const sessions = points.map((point, index) => ({ ...point, ...coordinate(point.sessions, index) }));
  const viewsLine = views.map((point) => `${point.x},${point.y}`).join(" ");
  const visitorsLine = visitors.map((point) => `${point.x},${point.y}`).join(" ");
  const sessionsLine = sessions.map((point) => `${point.x},${point.y}`).join(" ");
  const area = views.length ? `${padding.left},${padding.top + chartHeight} ${viewsLine} ${views.at(-1)?.x},${padding.top + chartHeight}` : "";
  const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter((index) => index >= 0);

  if (points.length === 0) return <p className="admin-empty">No traffic data in this period.</p>;

  return <div className="analytics-chart-wrap">
    <div className="analytics-chart-legend" aria-hidden="true"><span><i className="is-views" />Page views</span><span><i className="is-visitors" />Visitors</span><span><i className="is-sessions" />Sessions</span></div>
    <svg className="analytics-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="analytics-trend-title analytics-trend-desc">
      <title id="analytics-trend-title">Page views and visitors over time</title>
      <desc id="analytics-trend-desc">Daily traffic from {points[0]?.day} through {points.at(-1)?.day}. Peak value {maxValue}.</desc>
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => { const y = padding.top + ratio * chartHeight; return <g key={ratio}><line x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="analytics-gridline" /><text x={padding.left - 10} y={y + 4} className="analytics-axis-label" textAnchor="end">{Math.round(ceiling * (1 - ratio))}</text></g>; })}
      <polygon points={area} className="analytics-area" />
      <polyline points={viewsLine} className="analytics-line is-views" />
      <polyline points={visitorsLine} className="analytics-line is-visitors" />
      <polyline points={sessionsLine} className="analytics-line is-sessions" />
      {views.map((point) => <circle key={point.day} cx={point.x} cy={point.y} r={points.length <= 31 ? 3 : 2} className="analytics-dot is-views"><title>{shortDate(point.day)}: {point.views} views, {point.visitors} visitors</title></circle>)}
      {labelIndexes.map((index) => <text key={index} x={views[index]?.x} y={height - 5} className="analytics-axis-label" textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>{shortDate(points[index]!.day)}</text>)}
    </svg>
  </div>;
}

function Breakdown({ title, rows }: { title: string; rows: Array<{ name: string; views: number }> }) {
  const max = Math.max(1, ...rows.map((row) => row.views));
  const total = rows.reduce((sum, row) => sum + row.views, 0);
  return <section className="admin-card analytics-breakdown">
    <div className="admin-card-head"><div><h2>{title}</h2><p>Share of page views in this period.</p></div></div>
    <div className="analytics-bars">{rows.length ? rows.map((row) => <div className="analytics-bar-row" key={row.name}><div><span title={row.name}>{row.name}</span><strong>{row.views.toLocaleString()} <small>{total ? Math.round((row.views / total) * 100) : 0}%</small></strong></div><div className="analytics-bar-track" aria-hidden="true"><span style={{ width: `${(row.views / max) * 100}%` }} /></div></div>) : <p className="admin-empty">No data in this period.</p>}</div>
  </section>;
}

export function AnalyticsSection() {
  const [range, setRange] = useState<Range>("30d");
  const [livePage, setLivePage] = useState(1);
  const [livePageSize, setLivePageSize] = useState(20);
  const resource = useAdminResource<AnalyticsData>(`/admin/analytics/overview?range=${range}&recentTake=${livePageSize}&recentSkip=${(livePage - 1) * livePageSize}`);
  const data = resource.data;
  const pageRows = useMemo(() => data?.pages ?? [], [data]);
  const liveTotalPages = Math.max(1, Math.ceil((data?.recent.total ?? 0) / livePageSize));

  useEffect(() => setLivePage(1), [range, livePageSize]);
  useEffect(() => { if (livePage > liveTotalPages) setLivePage(liveTotalPages); }, [livePage, liveTotalPages]);

  return <div className="analytics-dashboard">
    <div className="analytics-toolbar">
      <div className="analytics-ranges" role="group" aria-label="Analytics date range">{(["7d", "30d", "90d"] as const).map((value) => <button key={value} type="button" className={cx("analytics-range", range === value && "is-active")} aria-pressed={range === value} onClick={() => setRange(value)}>{value.replace("d", " days")}</button>)}</div>
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
        <Metric icon={Clock3} label="Total active time" value={duration(data.totals.totalDurationMs)} note="Across every recorded visit" />
        <Metric icon={Globe2} label="Views per visitor" value={(data.totals.views / Math.max(1, data.totals.visitors)).toFixed(1)} note="Content depth per visitor" />
      </section>

      <section className="admin-card analytics-trend-card"><div className="admin-card-head"><div><h2><Activity size={17} />Traffic trend</h2><p>Daily page views and unique visitors, including zero-traffic days.</p></div></div><TrendChart points={data.trend} /></section>

      <div className="analytics-primary-grid">
        <section className="admin-card analytics-pages"><div className="admin-card-head"><div><h2>Top pages</h2><p>Most visited routes and their average active time.</p></div></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Page</th><th>Views</th><th>Share</th><th>Avg. time</th></tr></thead><tbody>{pageRows.map((row) => <tr key={row.path}><th className="analytics-path" data-label="Page" title={row.path}>{row.path}</th><td data-label="Views">{row.views.toLocaleString()}</td><td data-label="Share">{data.totals.views ? Math.round((row.views / data.totals.views) * 100) : 0}%</td><td data-label="Avg. time">{duration(row.averageDurationMs)}</td></tr>)}</tbody></table></div></section>
        <section className="admin-card analytics-active-users"><div className="admin-card-head"><div><h2><Users size={17} />Active users</h2><p>Recently identified users in this period.</p></div></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>User</th><th>Last page</th><th>Last seen</th></tr></thead><tbody>{data.activeUsers.map((row) => <tr key={row.user!.id}><th data-label="User"><span className="analytics-user"><strong>{row.user!.name}</strong><small>{row.user!.email}</small></span></th><td className="analytics-path" data-label="Last page" title={row.path}>{row.path}</td><td data-label="Last seen">{formatDateTime(row.createdAt)}</td></tr>)}</tbody></table>{data.activeUsers.length === 0 && <p className="admin-empty">No signed-in visitors in this period.</p>}</div></section>
      </div>

      <div className="analytics-grid"><Breakdown title="Traffic sources" rows={data.sources} /><Breakdown title="Countries" rows={data.countries} /><Breakdown title="Browsers" rows={data.browsers} /><Breakdown title="Devices" rows={data.devices} /></div>

      <section className="admin-card analytics-live-card">
        <div className="admin-card-head"><div><h2><Globe2 size={17} />Live visit stream</h2><p>Full visit history for the selected period, newest first.</p></div><span className="adm-count">{data.recent.total.toLocaleString()} visits</span></div>
        <div className="admin-table-wrap"><table className="admin-table analytics-recent"><thead><tr><th>Visitor</th><th>Page</th><th>Location</th><th>Device</th><th>Active time</th><th>When</th></tr></thead><tbody>{data.recent.rows.map((row) => <tr key={row.id}><th data-label="Visitor">{row.user ? <span>{row.user.name}<small>{row.user.email}</small></span> : <span>Anonymous<small>visitor {row.visitorId?.slice(0, 8) ?? "unknown"} · session {row.sessionId?.slice(0, 8) ?? "unknown"}</small></span>}</th><td className="analytics-path" data-label="Page" title={row.path}>{row.path}</td><td data-label="Location">{[row.city, row.country].filter(Boolean).join(", ") || "Unknown"}</td><td data-label="Device">{[row.browser, row.deviceType].filter(Boolean).join(" · ") || "Unknown"}</td><td data-label="Active time">{duration(row.durationMs)}</td><td data-label="When">{formatDateTime(row.createdAt)}</td></tr>)}</tbody></table></div>
        <div className="adm-pagination"><label className="adm-page-size">Rows per page<select aria-label="Live visits rows per page" value={livePageSize} onChange={(event) => setLivePageSize(Number(event.target.value))}>{[10, 20, 50].map((size) => <option key={size} value={size}>{size}</option>)}</select></label><span className="adm-pagination-info">Page {livePage} of {liveTotalPages}</span><div className="adm-pagination-controls"><button aria-label="Previous live visits page" className="icon-button compact" disabled={livePage <= 1 || resource.loading} onClick={() => setLivePage((page) => Math.max(1, page - 1))} type="button"><ChevronLeft size={15} /></button><button aria-label="Next live visits page" className="icon-button compact" disabled={livePage >= liveTotalPages || resource.loading} onClick={() => setLivePage((page) => page + 1)} type="button"><ChevronRight size={15} /></button></div></div>
      </section>
    </>}
  </div>;
}
