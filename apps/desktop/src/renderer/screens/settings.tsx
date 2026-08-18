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
import type { AppState, DesktopDeviceSummary } from "../../shared/ipc.js";

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
  const [error, setError] = useState<string>();

  useEffect(() => {
    void bridge.devices
      .list()
      .then(setDevices)
      .catch(() => setError("Could not load your devices."));
  }, []);

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
          Direct connections go from this computer straight to your host — Onshell authorises and records
          them but is not on the wire. Through the gateway is what the browser console does, and it is what
          reaches hosts this machine has no route to.
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
        <h2>Your machines</h2>
        <p className="hint">
          Machines you have signed in on that can be handed credential material for direct connections.
          Revoking one stops it getting any more; it does not end sessions it already opened, because those
          connections belong to that machine and not to us.
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
      </section>
    </div>
  );
}
