"use client";

import { useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Cloud,
  Database,
  FileText,
  Gauge,
  HardDrive,
  KeyRound,
  LockKeyhole,
  MonitorUp,
  MoreHorizontal,
  Network,
  Play,
  Plus,
  RefreshCcw,
  Search,
  Server,
  ShieldCheck,
  SquareTerminal,
  Upload,
  Users,
  XCircle
} from "lucide-react";
import { cx } from "@onshell/ui";

type Protocol = "ssh" | "rdp" | "vnc";
type Environment = "production" | "staging" | "development";
type Health = "online" | "degraded" | "offline";

interface HostRow {
  id: string;
  name: string;
  protocol: Protocol;
  address: string;
  port: number;
  owner: string;
  environment: Environment;
  tags: string[];
  health: Health;
  credential: string;
}

interface ActiveSession {
  id: string;
  host: string;
  protocol: Protocol;
  user: string;
  started: string;
  status: "active" | "pending";
}

const hosts: HostRow[] = [
  {
    id: "host_prod_bastion",
    name: "Production Bastion",
    protocol: "ssh",
    address: "10.20.0.10",
    port: 22,
    owner: "DevOps",
    environment: "production",
    tags: ["linux", "bastion"],
    health: "online",
    credential: "Prod Deploy Key"
  },
  {
    id: "host_finance_rdp",
    name: "Finance RDP",
    protocol: "rdp",
    address: "10.20.4.12",
    port: 3389,
    owner: "Operations",
    environment: "production",
    tags: ["windows", "rdp"],
    health: "degraded",
    credential: "RDP Admin Vault"
  },
  {
    id: "host_stage_web",
    name: "Staging Web",
    protocol: "ssh",
    address: "10.30.1.24",
    port: 22,
    owner: "Platform",
    environment: "staging",
    tags: ["nginx", "api"],
    health: "online",
    credential: "Staging SSH Key"
  },
  {
    id: "host_legacy_vnc",
    name: "Legacy Console",
    protocol: "vnc",
    address: "10.40.7.8",
    port: 5900,
    owner: "Support",
    environment: "development",
    tags: ["legacy", "vnc"],
    health: "offline",
    credential: "Support Vault"
  }
];

const snippets = [
  { name: "Release Status", command: "systemctl status onshell-api --no-pager" },
  { name: "Disk Pressure", command: "df -h && du -sh /var/log" },
  { name: "Docker Tail", command: "docker compose logs -f --tail=200" }
];

const auditEvents = [
  { action: "ssh.session.open", actor: "owner@onshell.cloud", target: "Production Bastion", time: "14:58" },
  { action: "credential.rotate", actor: "owner@onshell.cloud", target: "Prod Deploy Key", time: "14:41" },
  { action: "rdp.session.close", actor: "ops@onshell.cloud", target: "Finance RDP", time: "13:19" },
  { action: "host.update", actor: "admin@onshell.cloud", target: "Staging Web", time: "12:05" }
];

const initialSessions: ActiveSession[] = [
  { id: "sess_1", host: "Production Bastion", protocol: "ssh", user: "owner@onshell.cloud", started: "14:58", status: "active" },
  { id: "sess_2", host: "Finance RDP", protocol: "rdp", user: "ops@onshell.cloud", started: "14:22", status: "pending" }
];

const navItems = [
  { label: "Overview", icon: Gauge, active: true },
  { label: "Hosts", icon: Server },
  { label: "Terminal", icon: SquareTerminal },
  { label: "Files", icon: HardDrive },
  { label: "RDP", icon: MonitorUp },
  { label: "Vault", icon: LockKeyhole },
  { label: "Audit", icon: ShieldCheck },
  { label: "Team", icon: Users }
];

const protocolLabels: Array<"all" | Protocol> = ["all", "ssh", "rdp", "vnc"];

export default function DashboardPage() {
  const [protocol, setProtocol] = useState<"all" | Protocol>("all");
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState(initialSessions);
  const [selectedHostId, setSelectedHostId] = useState(hosts[0].id);
  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? hosts[0];

  const filteredHosts = useMemo(() => {
    return hosts.filter((host) => {
      const matchesProtocol = protocol === "all" || host.protocol === protocol;
      const matchesQuery = `${host.name} ${host.address} ${host.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase());
      return matchesProtocol && matchesQuery;
    });
  }, [protocol, query]);

  function launchSession(host: HostRow) {
    const nextSession: ActiveSession = {
      id: `sess_${Date.now()}`,
      host: host.name,
      protocol: host.protocol,
      user: "owner@onshell.cloud",
      started: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      status: "active"
    };
    setSelectedHostId(host.id);
    setSessions((current) => [nextSession, ...current].slice(0, 6));
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">
            <Cloud size={18} />
          </div>
          <div>
            <p className="brand-name">Onshell.cloud</p>
            <p className="brand-domain">onshell.cloud</p>
          </div>
        </div>

        <nav className="nav-list" aria-label="Primary">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.label} className={cx("nav-item", item.active && "is-active")} type="button" title={item.label}>
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-status">
          <div className="status-line">
            <span>Gateway</span>
            <strong>Healthy</strong>
          </div>
          <div className="status-meter">
            <span style={{ width: "72%" }} />
          </div>
          <div className="status-grid">
            <span>API 18ms</span>
            <span>Redis ok</span>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>Remote Access Console</h1>
            <p>Production workspace / Asia-Dhaka control plane.</p>
          </div>
          <div className="topbar-actions">
            <button className="icon-button" type="button" title="Refresh status">
              <RefreshCcw size={17} />
            </button>
            <button className="primary-button" type="button">
              <Plus size={17} />
              <span>Add Host</span>
            </button>
          </div>
        </header>

        <section className="metrics-grid" aria-label="System summary">
          <Metric icon={Server} label="Hosts" value="24" tone="green" detail="19 online" />
          <Metric icon={Activity} label="Active Sessions" value={String(sessions.length)} tone="cyan" detail="2 pending review" />
          <Metric icon={KeyRound} label="Vault Items" value="41" tone="amber" detail="3 rotate soon" />
          <Metric icon={Database} label="Audit Events" value="1.8k" tone="rose" detail="24h window" />
        </section>

        <section className="content-grid">
          <div className="main-column">
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2>Hosts</h2>
                  <p>{filteredHosts.length} visible</p>
                </div>
                <div className="table-tools">
                  <div className="segmented" aria-label="Protocol filter">
                    {protocolLabels.map((item) => (
                      <button
                        key={item}
                        className={cx(protocol === item && "selected")}
                        type="button"
                        onClick={() => setProtocol(item)}
                      >
                        {item.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <label className="search-field">
                    <Search size={16} />
                    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search hosts" />
                  </label>
                </div>
              </div>

              <div className="host-table">
                <div className="host-row table-head">
                  <span>Host</span>
                  <span>Address</span>
                  <span>Env</span>
                  <span>Health</span>
                  <span>Action</span>
                </div>
                {filteredHosts.map((host) => (
                  <div
                    className={cx("host-row", selectedHostId === host.id && "is-selected")}
                    key={host.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedHostId(host.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedHostId(host.id);
                      }
                    }}
                  >
                    <span className="host-title">
                      <ProtocolIcon protocol={host.protocol} />
                      <span>
                        <strong>{host.name}</strong>
                        <small>{host.owner}</small>
                      </span>
                    </span>
                    <span>
                      {host.address}:{host.port}
                    </span>
                    <span className={cx("env-pill", host.environment)}>{host.environment}</span>
                    <HealthBadge health={host.health} />
                    <span className="row-actions">
                      <button
                        className="icon-button compact"
                        type="button"
                        title={`Launch ${host.protocol.toUpperCase()}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          launchSession(host);
                        }}
                      >
                        <Play size={15} />
                      </button>
                      <button className="icon-button compact" type="button" title="More actions">
                        <MoreHorizontal size={15} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel terminal-panel">
              <div className="panel-header">
                <div>
                  <h2>{selectedHost.name}</h2>
                  <p>
                    {selectedHost.protocol.toUpperCase()} at {selectedHost.address}:{selectedHost.port}
                  </p>
                </div>
                <div className="terminal-actions">
                  <button className="secondary-button" type="button">
                    <Clipboard size={16} />
                    <span>Paste Snippet</span>
                  </button>
                  <button className="primary-button" type="button" onClick={() => launchSession(selectedHost)}>
                    <Play size={16} />
                    <span>Launch</span>
                  </button>
                </div>
              </div>
              <div className="terminal-window" aria-label="Terminal preview">
                <div className="terminal-bar">
                  <span />
                  <span />
                  <span />
                  <strong>{selectedHost.name}</strong>
                </div>
                <pre>
{`$ ssh ${selectedHost.address}
Onshell.cloud gateway prepared session token
host_key: verified
vault: ${selectedHost.credential}
status: ready`}
                </pre>
              </div>
            </section>
          </div>

          <aside className="side-column">
            <section className="panel">
              <div className="panel-header tight">
                <h2>Sessions</h2>
                <span className="count-pill">{sessions.length}</span>
              </div>
              <div className="session-list">
                {sessions.map((session) => (
                  <div className="session-row" key={session.id}>
                    <ProtocolIcon protocol={session.protocol} />
                    <div>
                      <strong>{session.host}</strong>
                      <small>{session.user}</small>
                    </div>
                    <span className={cx("session-state", session.status)}>{session.status}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-header tight">
                <h2>Snippets</h2>
                <button className="icon-button compact" type="button" title="Upload snippet">
                  <Upload size={15} />
                </button>
              </div>
              <div className="snippet-list">
                {snippets.map((snippet) => (
                  <button className="snippet-row" key={snippet.name} type="button" title={snippet.command}>
                    <FileText size={16} />
                    <span>
                      <strong>{snippet.name}</strong>
                      <small>{snippet.command}</small>
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-header tight">
                <h2>Audit</h2>
                <ShieldCheck size={17} />
              </div>
              <div className="audit-list">
                {auditEvents.map((event) => (
                  <div className="audit-row" key={`${event.action}-${event.time}`}>
                    <span>{event.time}</span>
                    <div>
                      <strong>{event.action}</strong>
                      <small>
                        {event.actor} {"->"} {event.target}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </section>
      </section>
    </main>
  );
}

function Metric({ icon: Icon, label, value, detail, tone }: { icon: LucideIcon; label: string; value: string; detail: string; tone: string }) {
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

function ProtocolIcon({ protocol }: { protocol: Protocol }) {
  if (protocol === "rdp") return <MonitorUp className="protocol-icon rdp" size={17} />;
  if (protocol === "vnc") return <Network className="protocol-icon vnc" size={17} />;
  return <SquareTerminal className="protocol-icon ssh" size={17} />;
}

function HealthBadge({ health }: { health: Health }) {
  const Icon = health === "online" ? CheckCircle2 : health === "degraded" ? AlertTriangle : XCircle;
  return (
    <span className={cx("health-badge", health)}>
      <Icon size={15} />
      {health}
    </span>
  );
}
