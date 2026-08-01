/**
 * Running the agent at login.
 *
 * These are printed, not installed. Writing into a user's LaunchAgents folder
 * or their systemd units is exactly the kind of thing a remote-access program
 * should not do behind their back, and a copy-pasteable file they can read
 * first costs them thirty seconds while making the change obvious and
 * reversible. The installer (phase 7) is where automating this belongs, because
 * that is a moment the user has already consented to.
 *
 * One rule runs through all three: **per user, never machine-wide.** A session
 * on this agent has exactly the privileges of the person who installed it, and
 * a SYSTEM service or a root unit would quietly turn "a shell on my account"
 * into "a shell on this computer".
 */
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

export interface ServiceContext {
  /** Absolute path to the agent executable, or to `node`. */
  command: string;
  args: string[];
}

function launchAgentPlist({ command, args }: ServiceContext) {
  const programArguments = [command, ...args, "run"]
    .map((value) => `    <string>${value.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>cloud.onshell.agent</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), "Library", "Logs", "onshell-agent.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), "Library", "Logs", "onshell-agent.log")}</string>
</dict>
</plist>
`;
}

/**
 * Quotes a path for a command line.
 *
 * Not cosmetic: the default install location on Windows is under
 * `C:\\Program Files`, and an unquoted path with a space in it produces a
 * startup entry that silently fails to launch every time the machine boots.
 */
function quote(value: string) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function systemdUnit({ command, args }: ServiceContext) {
  return `[Unit]
Description=Onshell Agent
After=network-online.target

[Service]
ExecStart=${[command, ...args, "run"].map(quote).join(" ")}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function serviceDefinition(context: ServiceContext) {
  switch (platform()) {
    case "darwin":
      return {
        path: join(homedir(), "Library", "LaunchAgents", "cloud.onshell.agent.plist"),
        contents: launchAgentPlist(context),
        install: [
          "launchctl unload ~/Library/LaunchAgents/cloud.onshell.agent.plist 2>/dev/null",
          "launchctl load -w ~/Library/LaunchAgents/cloud.onshell.agent.plist"
        ],
        notes: [
          "Reading Documents, Desktop or Downloads will raise a permission prompt",
          "on this machine the first time. That prompt cannot be answered remotely."
        ]
      };

    case "linux":
      return {
        path: join(homedir(), ".config", "systemd", "user", "onshell-agent.service"),
        contents: systemdUnit(context),
        install: [
          "systemctl --user daemon-reload",
          "systemctl --user enable --now onshell-agent",
          `loginctl enable-linger ${userInfo().username}`
        ],
        notes: [
          "The last command is what keeps the agent reachable when nobody is",
          "logged in. Without lingering, systemd stops your user services at",
          "logout and the machine silently drops off."
        ]
      };

    default:
      return {
        path: join(
          process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
          "Microsoft",
          "Windows",
          "Start Menu",
          "Programs",
          "Startup",
          "onshell-agent.cmd"
        ),
        // The empty `""` is `start`'s window-title argument. Without it, `start`
        // reads the first quoted path as the title and launches nothing.
        contents: `@echo off\r\nstart "" /min ${[context.command, ...context.args, "run"].map(quote).join(" ")}\r\n`,
        install: ["No further step: anything in the Startup folder runs at logon."],
        notes: [
          "Deliberately the per-user Startup folder rather than a Windows service.",
          "A service would run as SYSTEM, which would hand every session on this",
          "machine administrator rights it was never meant to have."
        ]
      };
  }
}
