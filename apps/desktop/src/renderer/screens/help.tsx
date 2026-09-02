import { bridge } from "../bridge.js";
import { Icon } from "../icons.js";

export function Help({
  version,
  onClose,
}: {
  version: string;
  onClose(): void;
}) {
  return (
    <div className="desktop-help">
      <header className="settings__head">
        <div>
          <p className="desktop-help__eyebrow">Onshell Desktop {version}</p>
          <h1>Help &amp; support</h1>
        </div>
        <button className="button button--ghost" onClick={onClose}>
          Done
        </button>
      </header>
      <div className="desktop-help__intro">
        <span className="empty__icon">
          <Icon name="help" size={25} />
        </span>
        <div>
          <h2>Where can we help?</h2>
          <p>
            Open the Onshell website for product guides and contact details, or
            support continued open-source development with a one-time donation.
          </p>
        </div>
      </div>
      <div className="desktop-help__cards">
        <button
          onClick={() => void bridge.openExternal("https://onshell.cloud")}
          type="button"
        >
          <span>
            <Icon name="external" size={18} />
          </span>
          <strong>Onshell website</strong>
          <small>Guides, security, downloads, and contact</small>
        </button>
        <button
          onClick={() =>
            void bridge.openExternal(
              "https://onshell.cloud/donate?source=desktop",
            )
          }
          type="button"
        >
          <span>
            <Icon name="heart" size={18} />
          </span>
          <strong>Support Onshell</strong>
          <small>Make a secure one-time donation from $1</small>
        </button>
      </div>
      <p className="hint">
        Links always open in your default browser. The desktop app never embeds
        a payment page or receives card details.
      </p>
    </div>
  );
}
