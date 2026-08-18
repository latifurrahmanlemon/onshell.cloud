/**
 * Two panes, one on this computer and one on a host, with files moving between.
 *
 * The dual pane is the point. A file browser that only shows the remote side
 * makes you find the local file in a system dialog every time; showing both and
 * letting the user pick a row on each side is what makes a transfer one click.
 *
 * Neither pane knows what backs it. Local, direct SFTP, and relayed all answer
 * the same shape, so the only place the difference shows is the label and the
 * fact that a relayed pane refuses transfers — which it says, rather than
 * failing halfway through a copy.
 */
import { useCallback, useEffect, useState } from "react";
import { bridge } from "../bridge.js";
import type { FileEntry, FileSessionOpened, FileSessionTargetRequest } from "../../shared/ipc.js";

interface PaneState extends FileSessionOpened {
  path: string;
  entries: FileEntry[];
  selected?: string;
  busy: boolean;
  error?: string;
}

/** Joins a path in the style the pane's own system uses. */
function joinPath(base: string, name: string, windowsStyle: boolean) {
  if (name === "..") {
    const separator = windowsStyle ? "\\" : "/";
    const parts = base.split(/[\\/]/).filter(Boolean);
    parts.pop();
    if (windowsStyle) return parts.length > 0 ? parts.join(separator) + separator : base;
    return `/${parts.join("/")}`;
  }
  const separator = windowsStyle ? "\\" : "/";
  return base.endsWith(separator) ? `${base}${name}` : `${base}${separator}${name}`;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function usePane(target: FileSessionTargetRequest | undefined, windowsStyle: boolean) {
  const [pane, setPane] = useState<PaneState>();

  useEffect(() => {
    if (!target) return;
    let closedId: string | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const opened = await bridge.files.open(target);
        closedId = opened.fileSessionId;
        const listing = await bridge.files.list(opened.fileSessionId, opened.startPath);
        if (cancelled) return;
        setPane({ ...opened, path: listing.path, entries: listing.entries, busy: false });
      } catch (cause) {
        if (cancelled) return;
        setPane(undefined);
        // Reported through the caller's own error surface would be nicer, but a
        // pane that failed to open has nowhere of its own to put a message.
        window.setTimeout(() => {
          // eslint-disable-next-line no-alert
          alert(cause instanceof Error ? cause.message : "Could not open that location.");
        }, 0);
      }
    })();

    return () => {
      cancelled = true;
      if (closedId) void bridge.files.close(closedId);
    };
  }, [target]);

  const navigate = useCallback(
    async (to: string) => {
      if (!pane) return;
      setPane({ ...pane, busy: true, error: undefined });
      try {
        const listing = await bridge.files.list(pane.fileSessionId, to);
        setPane((current) =>
          current ? { ...current, path: listing.path, entries: listing.entries, busy: false, selected: undefined } : current
        );
      } catch (cause) {
        setPane((current) =>
          current
            ? { ...current, busy: false, error: cause instanceof Error ? cause.message : "Could not open that folder." }
            : current
        );
      }
    },
    [pane]
  );

  const refresh = useCallback(() => (pane ? navigate(pane.path) : Promise.resolve()), [pane, navigate]);

  return { pane, setPane, navigate, refresh, windowsStyle };
}

interface PaneProps {
  title: string;
  pane?: PaneState;
  windowsStyle: boolean;
  onNavigate(to: string): void;
  onSelect(name: string): void;
}

function Pane({ title, pane, windowsStyle, onNavigate, onSelect }: PaneProps) {
  if (!pane) {
    return (
      <div className="pane">
        <div className="pane__head">{title}</div>
        <div className="pane__empty hint">Nothing open.</div>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="pane__head">
        <span>{pane.label}</span>
        <span className={`tab__mode tab__mode--${pane.mode}`}>{pane.mode}</span>
      </div>
      <div className="pane__path selectable" title={pane.path}>
        {pane.path}
      </div>
      {pane.error && <div className="pane__error">{pane.error}</div>}
      <div className="pane__list">
        <button className="row row--up" onClick={() => onNavigate(joinPath(pane.path, "..", windowsStyle))}>
          ..
        </button>
        {pane.entries
          .slice()
          .sort((a, b) =>
            a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1
          )
          .map((entry) => (
            <button
              key={entry.name}
              className={`row${pane.selected === entry.name ? " row--selected" : ""}`}
              onClick={() => onSelect(entry.name)}
              onDoubleClick={() => {
                if (entry.type === "directory") onNavigate(joinPath(pane.path, entry.name, windowsStyle));
              }}
            >
              <span className="row__name">
                {entry.type === "directory" ? "📁" : "📄"} {entry.name}
              </span>
              <span className="row__size">{entry.type === "file" ? formatSize(entry.size) : ""}</span>
            </button>
          ))}
        {pane.entries.length === 0 && <div className="pane__empty hint">Empty.</div>}
      </div>
    </div>
  );
}

interface Props {
  remote: FileSessionTargetRequest;
  hostLabel: string;
  onClose(): void;
}

export function Files({ remote, hostLabel, onClose }: Props) {
  // Held in state so the target object identity is stable; a fresh object every
  // render would reopen the session on every keystroke elsewhere in the tree.
  const [localTarget] = useState<FileSessionTargetRequest>({ kind: "local" });
  const [remoteTarget] = useState<FileSessionTargetRequest>(remote);

  const localSide = usePane(localTarget, navigator.platform.startsWith("Win"));
  const remoteSide = usePane(remoteTarget, false);
  const [status, setStatus] = useState<string>();

  async function transfer(direction: "up" | "down") {
    const from = direction === "up" ? localSide.pane : remoteSide.pane;
    const to = direction === "up" ? remoteSide.pane : localSide.pane;
    if (!from || !to || !from.selected) {
      setStatus("Pick a file on the side you are copying from.");
      return;
    }

    const entry = from.entries.find((candidate) => candidate.name === from.selected);
    if (entry?.type !== "file") {
      setStatus("Only files can be transferred, not folders.");
      return;
    }

    setStatus(`Copying ${from.selected}…`);
    try {
      await bridge.files.transfer(
        from.fileSessionId,
        joinPath(from.path, from.selected, from.mode === "local" && localSide.windowsStyle),
        to.fileSessionId,
        joinPath(to.path, from.selected, to.mode === "local" && localSide.windowsStyle)
      );
      setStatus(`Copied ${from.selected}.`);
      await (direction === "up" ? remoteSide.refresh() : localSide.refresh());
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "The transfer failed.");
    }
  }

  return (
    <div className="files">
      <header className="files__head">
        <h2>Files — {hostLabel}</h2>
        <button className="button button--ghost" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="files__panes">
        <Pane
          title="This computer"
          pane={localSide.pane}
          windowsStyle={localSide.windowsStyle}
          onNavigate={(to) => void localSide.navigate(to)}
          onSelect={(name) => localSide.setPane((current) => (current ? { ...current, selected: name } : current))}
        />

        <div className="files__transfer">
          <button className="button" onClick={() => void transfer("up")} title="Copy to the host">
            →
          </button>
          <button className="button" onClick={() => void transfer("down")} title="Copy to this computer">
            ←
          </button>
        </div>

        <Pane
          title={hostLabel}
          pane={remoteSide.pane}
          windowsStyle={false}
          onNavigate={(to) => void remoteSide.navigate(to)}
          onSelect={(name) => remoteSide.setPane((current) => (current ? { ...current, selected: name } : current))}
        />
      </div>

      {status && <div className="files__status hint">{status}</div>}
    </div>
  );
}
