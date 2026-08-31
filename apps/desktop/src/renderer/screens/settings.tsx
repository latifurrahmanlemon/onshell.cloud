/**
 * Settings, and the device list.
 *
 * The device list is the reason this screen matters rather than being a
 * preferences afterthought: direct connections hand credential material to
 * machines, and this is where a person sees which of their machines have been
 * handed any and cuts one off.
 */
import { useEffect, useState } from "react";
import { bridge } from "../bridge.js";
import type { AppState, ApprovalMode, DesktopDeviceSummary, SharingState, UpdateStatus } from "../../shared/ipc.js";

const APPROVAL_LABELS: Record<ApprovalMode, string> = {
  trusted: "Anyone in the workspace",
  ask: "Only me — everyone else has to ask",
  always: "Always ask, including me"
};

interface Props {
  state: AppState;
  onClose(): void;
}

function when(value?: string) {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

export function Settings({ state, onClose }: Props) {
  const [devices, setDevices] = useState<DesktopDeviceSummary[]>([]);
  const [sharing, setSharing] = useState<SharingState>();
  const [sharingBusy, setSharingBusy] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void bridge.updates.check().then(setUpdate, () => undefined);
    void bridge.devices
      .list()
      .then(setDevices)
      .catch(() => setError("Could not load your devices."));
    void bridge.sharing.state().then(setSharing, () => undefined);
  }, []);

  async function runSharing(action: () => Promise<SharingState>) {
    setSharingBusy(true);
    setError(undefined);
    try {
      setSharing(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work.");
    } finally {
      setSharingBusy(false);
    }
  }

  async function revoke(device: DesktopDeviceSummary) {
    setError(undefined);
    try {
      await bridge.devices.revoke(device.id);
      setDevices(await bridge.devices.list());
    } catch {
      setError(`Could not revoke ${device.name}.`);
    }
  }

  return (
    <div className="settings">
      <header className="settings__head">
        <h1>Settings</h1>
        <button className="button button--ghost" onClick={onClose}>
          Done
        </button>
      </header>

      <section className="settings__section">
        <h2>Connections</h2>
        <p className="hint">
          Direct connections go from this computer straight to your host — Onshell authorises and records them but is
          not on the wire. Through the gateway is what the browser console does, and it is what reaches hosts this
          machine has no route to.
        </p>
        <div className="settings__choices">
          {(["direct", "relay"] as const).map((mode) => (
            <button
              key={mode}
              className={`choice${state.connectionMode === mode ? " choice--active" : ""}`}
              onClick={() => void bridge.settings.update({ connectionMode: mode })}
            >
              <strong>{mode === "direct" ? "Connect directly" : "Through the gateway"}</strong>
              <span className="hint">
                {mode === "direct"
                  ? "Private by default. Falls back only when you say so."
                  : "Every byte through Onshell, where your workspace can audit it."}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="settings__section">
        <h2>Appearance</h2>
        <div className="settings__choices">
          {(["system", "dark", "light"] as const).map((theme) => (
            <button
              key={theme}
              className={`choice choice--compact${state.appearance.theme === theme ? " choice--active" : ""}`}
              onClick={() => void bridge.settings.update({ appearance: { theme } })}
            >
              <strong>{theme}</strong>
            </button>
          ))}
        </div>
        <div className="field field--inline">
          <label htmlFor="fontSize">Terminal font size</label>
          <input
            id="fontSize"
            type="number"
            min={9}
            max={28}
            value={state.appearance.fontSize}
            onChange={(event) => {
              const fontSize = Number(event.target.value);
              if (Number.isFinite(fontSize)) void bridge.settings.update({ appearance: { fontSize } });
            }}
          />
        </div>
      </section>

      <section className="settings__section">
        <h2>Share this computer</h2>
        <p className="hint">
          Lets someone in your workspace open a terminal <em>on this machine</em> from a browser — the opposite
          direction from everything else here. It is off until you switch it on, the tray icon stays visible while it is
          on, quitting Onshell stops every session, and every one of them is written to a log on this machine that only
          you can read.
        </p>

        {sharing && (
          <>
            <div className="settings__choices">
              <button
                className={`choice${sharing.running ? " choice--active" : ""}`}
                disabled={sharingBusy}
                onClick={() =>
                  void runSharing(() =>
                    sharing.running
                      ? bridge.sharing.stop()
                      : sharing.paired
                        ? bridge.sharing.resume()
                        : bridge.sharing.start()
                  )
                }
              >
                <strong>
                  {sharing.running ? "Sharing — stop" : sharing.paired ? "Start sharing" : "Share this computer"}
                </strong>
                <span className="hint">
                  {sharing.running
                    ? `This machine is reachable from your workspace${sharing.ownerEmail ? ` as ${sharing.ownerEmail}` : ""}.`
                    : sharing.paired
                      ? "Paired already — this only brings the connection back up."
                      : "Pairs this machine with your account and starts serving."}
                </span>
              </button>
            </div>

            {sharing.paired && (
              <>
                <h3 className="settings__subhead">Who may connect without asking</h3>
                <div className="settings__choices">
                  {(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((mode) => (
                    <button
                      key={mode}
                      className={`choice choice--compact${sharing.approval === mode ? " choice--active" : ""}`}
                      disabled={sharingBusy}
                      onClick={() => void runSharing(() => bridge.sharing.setApproval(mode))}
                    >
                      <strong>{APPROVAL_LABELS[mode]}</strong>
                    </button>
                  ))}
                </div>
                <p className="hint">
                  This setting lives on this machine, not on the server. A consent rule your workspace admin could
                  change remotely would not be consent.
                </p>
                <button className="button" onClick={() => void bridge.sharing.openLog()}>
                  Open activity log
                </button>
              </>
            )}
          </>
        )}
      </section>

      <section className="settings__section">
        <h2>Your machines</h2>
        <p className="hint">
          Machines you have signed in on that can be handed credential material for direct connections. Revoking one
          stops it getting any more; it does not end sessions it already opened, because those connections belong to
          that machine and not to us.
        </p>
        {error && <p className="error">{error}</p>}
        {devices.length === 0 && <p className="hint">No machines enrolled yet.</p>}
        <ul className="devices">
          {devices.map((device) => (
            <li key={device.id} className={device.revokedAt ? "device device--revoked" : "device"}>
              <div>
                <div className="device__name">{device.name}</div>
                <div className="hint">
                  {device.platform}
                  {device.appVersion ? ` · ${device.appVersion}` : ""} · last used {when(device.lastSeenAt)}
                </div>
              </div>
              {device.revokedAt ? (
                <span className="hint">revoked</span>
              ) : (
                <button className="button" onClick={() => void revoke(device)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="settings__section">
        <h2>Server</h2>
        <p className="hint selectable">{state.server?.apiBaseUrl}</p>
        <p className="hint">
          Onshell Desktop {state.version} · {state.platform}
          {state.keychainAvailable ? "" : " · no system keychain, so sessions last until you quit"}
        </p>

        {update?.available ? (
          <p className="hint">
            Version {update.latest} is available.{" "}
            <button className="button button--ghost" onClick={() => update.url && void bridge.openExternal(update.url)}>
              Open the release page
            </button>
            <br />
            Nothing downloads or installs itself. Current macOS releases use a verified ad-hoc integrity signature and
            publish SHA-256 checksums; automated updates stay disabled until Developer ID notarization, signed update
            metadata, and rollback protection are implemented.
          </p>
        ) : (
          <button className="button" onClick={() => void bridge.updates.check(true).then(setUpdate)}>
            Check for updates
          </button>
        )}
      </section>
    </div>
  );
}
