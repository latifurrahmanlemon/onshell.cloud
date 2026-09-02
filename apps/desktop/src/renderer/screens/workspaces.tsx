import { useEffect, useState, type DragEvent } from "react";
import type { Host, HostWorkspace } from "@onshell/api-client";
import { bridge } from "../bridge.js";
import { Icon } from "../icons.js";

export const WORKSPACE_HOST_DRAG_TYPE = "application/x-onshell-workspace-host";
const WORKSPACE_ORDER_DRAG_TYPE = "application/x-onshell-workspace-order";
const MAX_WORKSPACE_HOSTS = 20;

export function beginWorkspaceHostDrag(
  dataTransfer: DataTransfer,
  hostId: string,
) {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(WORKSPACE_HOST_DRAG_TYPE, hostId);
}

interface Props {
  hosts: Host[];
  currentHostIds: string[];
  onOpen(ids: string[]): void;
}

export function Workspaces({ hosts, currentHostIds, onOpen }: Props) {
  const [items, setItems] = useState<HostWorkspace[]>([]);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState(() =>
    currentHostIds.slice(0, MAX_WORKSPACE_HOSTS),
  );
  const [dropActive, setDropActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    void bridge.console
      .workspaces()
      .then(setItems)
      .catch(() => setMessage("Saved workspaces could not be loaded."));
  }, []);

  function add(hostId: string, at = draft.length) {
    if (!hosts.some((host) => host.id === hostId)) return;
    if (draft.length >= MAX_WORKSPACE_HOSTS) {
      setMessage(
        `A workspace can contain at most ${MAX_WORKSPACE_HOSTS} terminals.`,
      );
      return;
    }
    setDraft((current) => {
      const next = [...current];
      next.splice(Math.max(0, Math.min(at, next.length)), 0, hostId);
      return next;
    });
    setMessage(undefined);
  }

  function move(from: number, to: number) {
    setDraft((current) => {
      if (
        from < 0 ||
        from >= current.length ||
        to < 0 ||
        to >= current.length ||
        from === to
      )
        return current;
      const next = [...current];
      const [item] = next.splice(from, 1);
      if (item) next.splice(to, 0, item);
      return next;
    });
  }

  function drop(event: DragEvent<HTMLElement>, at = draft.length) {
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    const order = event.dataTransfer.getData(WORKSPACE_ORDER_DRAG_TYPE);
    if (order !== "") {
      move(Number(order), Math.min(at, Math.max(0, draft.length - 1)));
      return;
    }
    const hostId = event.dataTransfer.getData(WORKSPACE_HOST_DRAG_TYPE);
    if (hostId) add(hostId, at);
  }

  async function save() {
    if (busy || !name.trim() || draft.length === 0) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const saved = await bridge.console.createWorkspace({
        name: name.trim(),
        hostIds: draft,
      });
      setItems((current) => [...current, saved]);
      setName("");
      setDraft([]);
      setMessage(`Saved “${saved.name}”.`);
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : "The workspace could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="desktop-workspaces">
      <header>
        <div>
          <p>Layouts</p>
          <h1>Workspaces</h1>
          <span>
            Drag open remote terminals or saved hosts here, arrange them, then
            save the layout.
          </span>
        </div>
      </header>

      <div className="workspace-builder">
        <label className="workspace-name">
          <span>Workspace name</span>
          <input
            aria-label="Workspace name"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="Production watch"
            value={name}
          />
        </label>
        <button
          className="button button--primary"
          disabled={busy || name.trim().length < 2 || draft.length === 0}
          onClick={() => void save()}
          type="button"
        >
          {busy ? "Saving…" : "Save workspace"}
        </button>

        <div
          className={`workspace-dropzone${dropActive ? " is-active" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            )
              setDropActive(false);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
              WORKSPACE_ORDER_DRAG_TYPE,
            )
              ? "move"
              : "copy";
          }}
          onDrop={(event) => drop(event)}
        >
          <div className="workspace-dropzone__head">
            <strong>Terminal order</strong>
            <span>
              {draft.length}/{MAX_WORKSPACE_HOSTS}
            </span>
          </div>
          {draft.length === 0 ? (
            <div className="workspace-dropzone__empty">
              <Icon name="split" size={20} />
              <span>Drop a remote terminal or host here</span>
            </div>
          ) : (
            <ol className="workspace-draft">
              {draft.map((id, index) => {
                const host = hosts.find((candidate) => candidate.id === id);
                return (
                  <li
                    draggable
                    key={`${id}-${index}`}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(
                        WORKSPACE_ORDER_DRAG_TYPE,
                        String(index),
                      );
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => drop(event, index)}
                  >
                    <span className="workspace-draft__index">{index + 1}</span>
                    <span className="workspace-draft__copy">
                      <strong>{host?.name ?? "Unavailable host"}</strong>
                      <small>
                        {host
                          ? `${host.username ? `${host.username}@` : ""}${host.address}`
                          : id}
                      </small>
                    </span>
                    <span className="workspace-draft__actions">
                      <button
                        disabled={index === 0}
                        onClick={() => move(index, index - 1)}
                        type="button"
                        aria-label={`Move ${host?.name ?? "host"} earlier`}
                      >
                        <Icon
                          className="workspace-chevron workspace-chevron--back"
                          name="chevron-right"
                          size={14}
                        />
                      </button>
                      <button
                        disabled={index === draft.length - 1}
                        onClick={() => move(index, index + 1)}
                        type="button"
                        aria-label={`Move ${host?.name ?? "host"} later`}
                      >
                        <Icon
                          className="workspace-chevron"
                          name="chevron-right"
                          size={14}
                        />
                      </button>
                      <button
                        onClick={() =>
                          setDraft((current) =>
                            current.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          )
                        }
                        type="button"
                        aria-label={`Remove ${host?.name ?? "host"}`}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <div className="workspace-host-pool">
          <strong>Available hosts</strong>
          <span>Click to add, or drag into the order above.</span>
          <div>
            {hosts.map((host) => (
              <button
                draggable
                key={host.id}
                onClick={() => add(host.id)}
                onDragStart={(event) =>
                  beginWorkspaceHostDrag(event.dataTransfer, host.id)
                }
                type="button"
              >
                <Icon name="host" size={14} />
                <span>{host.name}</span>
                <Icon name="plus" size={13} />
              </button>
            ))}
            {hosts.length === 0 && (
              <span className="hint">
                Add a host before building a workspace.
              </span>
            )}
          </div>
        </div>
        {message && (
          <p className="workspace-message" role="status">
            {message}
          </p>
        )}
      </div>

      <div className="workspace-cards">
        {items.map((workspace) => (
          <article key={workspace.id}>
            <div>
              <strong>{workspace.name}</strong>
              <p>
                {workspace.hostIds
                  .map(
                    (id) =>
                      hosts.find((host) => host.id === id)?.name ??
                      "Unavailable",
                  )
                  .join(" · ")}
              </p>
            </div>
            <button
              className="button"
              onClick={() => onOpen(workspace.hostIds)}
              type="button"
            >
              <Icon name="split" size={14} />
              Open
            </button>
            <button
              aria-label={`Delete ${workspace.name}`}
              className="icon icon--danger"
              onClick={() =>
                void bridge.console
                  .deleteWorkspace(workspace.id)
                  .then(() =>
                    setItems((current) =>
                      current.filter((item) => item.id !== workspace.id),
                    ),
                  )
              }
              type="button"
            >
              <Icon name="close" size={13} />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
