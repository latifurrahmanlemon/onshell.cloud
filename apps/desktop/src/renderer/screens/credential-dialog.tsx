import { useState } from "react";
import type { CredentialSummary } from "@onshell/api-client";
import { bridge } from "../bridge.js";

export function CredentialDialog({ onClose, onCreated }: {
  onClose(): void;
  onCreated(credential: CredentialSummary): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const credential = await bridge.console.createCredential({
        name: String(data.get("name")),
        kind: data.get("kind") as "password" | "ssh_key",
        secret: String(data.get("secret")),
        attachedHostIds: []
      });
      onCreated(credential);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create credential.");
    } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <form className="snippet-modal" role="dialog" aria-modal="true" aria-label="Create host credential" onSubmit={(event) => void submit(event)} onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } }}>
      <header><strong>Create credential</strong><button className="button button--ghost" type="button" disabled={busy} onClick={onClose}>Close</button></header>
      <p className="hint">Your host details are saved in the form behind this dialog.</p>
      <label>Name<input autoFocus name="name" required minLength={2} /></label>
      <label>Type<select name="kind"><option value="password">Password</option><option value="ssh_key">SSH key</option></select></label>
      <label>Secret<textarea name="secret" required rows={4} /></label>
      {error && <p role="alert">{error}</p>}
      <footer><button className="button button--ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button button--primary" disabled={busy} type="submit">{busy ? "Saving…" : "Save credential"}</button></footer>
    </form>
  </div>;
}
