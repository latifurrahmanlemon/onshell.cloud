import { useEffect, useState } from "react";
import type { Host, HostWorkspace } from "@onshell/api-client";
import { bridge } from "../bridge.js";
import { Icon } from "../icons.js";

export function Workspaces({ hosts, currentHostIds, onOpen }: { hosts: Host[]; currentHostIds: string[]; onOpen(ids: string[]): void }) {
  const [items, setItems] = useState<HostWorkspace[]>([]);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState(currentHostIds);
  useEffect(() => { void bridge.console.workspaces().then(setItems); }, []);
  function move(from: number, to: number) { setDraft((current) => { const next = [...current]; const [item] = next.splice(from, 1); if (item) next.splice(to, 0, item); return next; }); }
  async function save() { if (!name.trim() || draft.length === 0) return; const saved = await bridge.console.createWorkspace({ name: name.trim(), hostIds: draft }); setItems((current) => [...current, saved]); setName(""); }
  return <section className="desktop-workspaces"><header><div><p>Layouts</p><h1>Workspaces</h1><span>Open several hosts together and preserve their order.</span></div></header><div className="workspace-builder"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Workspace name"/><button className="button button--primary" onClick={() => void save()}>Save current</button><div>{draft.map((id, index) => <span draggable key={`${id}-${index}`} onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => move(Number(event.dataTransfer.getData("text/plain")), index)}>{hosts.find((host) => host.id === id)?.name ?? "Host"}</span>)}</div></div><div className="workspace-cards">{items.map((workspace) => <article key={workspace.id}><div><strong>{workspace.name}</strong><p>{workspace.hostIds.map((id) => hosts.find((host) => host.id === id)?.name ?? "Unavailable").join(" · ")}</p></div><button className="button" onClick={() => onOpen(workspace.hostIds)}><Icon name="split" size={14}/>Open</button><button className="icon icon--danger" onClick={() => void bridge.console.deleteWorkspace(workspace.id).then(() => setItems((current) => current.filter((item) => item.id !== workspace.id)))}><Icon name="close" size={13}/></button></article>)}</div></section>;
}
