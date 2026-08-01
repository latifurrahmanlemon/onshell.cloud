/**
 * Onshell Agent entry point.
 *
 * A browser cannot open a shell on the machine it is running on — that is the
 * sandbox boundary the whole web security model rests on. This program is what
 * makes "open my own PC's terminal from onshell.cloud" possible, by being
 * installed deliberately by the person who owns the machine.
 *
 * Because it hands remote shell access to somebody's personal computer, it runs
 * as that user (never as SYSTEM or root), it announces what it is doing, and it
 * only ever starts a shell from the fixed list in shells.ts.
 *
 * See docs/agent.md.
 */
import { hostname } from "node:os";
import { auditPath, readAudit, recordAudit } from "./audit.js";
import { AGENT_VERSION, configPath, loadAgentConfig, saveAgentConfig } from "./config.js";
import { APPROVAL_MODES, isApprovalMode, type ApprovalMode } from "./consent.js";
import { pair } from "./pair.js";
import { serviceDefinition } from "./service.js";
import { discoverShells } from "./shells.js";
import { AgentTunnel } from "./tunnel.js";

const USAGE = `onshell-agent ${AGENT_VERSION}

  onshell-agent run            Connect this machine to Onshell and stay running
  onshell-agent pair <code> [name]
                               Pair this machine with an Onshell account
  onshell-agent status         Show what this machine is configured to do
  onshell-agent log [count]    Show this machine's own record of what was done to it
  onshell-agent service        Print the login-item definition for this platform
  onshell-agent approval <mode>
                               Who may start a session here without you agreeing:
                                 trusted  anyone in the workspace, no prompt
                                 ask      only the account that paired this
                                          machine; everyone else prompts (default)
                                 always   prompt for everyone, including you
  onshell-agent --version      Print the version

Environment:
  ONSHELL_API_URL              API base URL (default https://onshell.cloud/api)
  ONSHELL_GATEWAY_URL          Gateway base URL (default https://onshell.cloud/gateway)
  ONSHELL_APPROVAL             trusted | ask | always (overrides the stored setting)
`;

const APPROVAL_SUMMARY: Record<ApprovalMode, string> = {
  trusted: "anyone in the workspace can connect without asking",
  ask: "only the account that paired this machine; everyone else needs someone here to allow it",
  always: "every session asks first, including yours"
};

async function run() {
  const config = await loadAgentConfig();
  const shells = await discoverShells();

  if (shells.length === 0) {
    console.error("[onshell-agent] no usable shell found on this machine — nothing to serve");
    process.exitCode = 1;
    return;
  }

  // Printed every start, on purpose. Remote access that nobody can see is the
  // property that separates a support tool from spyware, and the tray indicator
  // that makes this visible during a session is still to come (phase 6).
  console.log(`[onshell-agent] ${AGENT_VERSION} on ${hostname()}`);
  console.log(`[onshell-agent] gateway: ${config.gatewayBaseUrl}`);
  console.log(`[onshell-agent] shells:  ${shells.map((shell) => shell.token).join(", ")}`);
  console.log(`[onshell-agent] access:  ${APPROVAL_SUMMARY[config.approval]}`);
  console.log(`[onshell-agent] log:     ${auditPath()}`);
  console.log("[onshell-agent] while this is running, authorised users on your Onshell account can open a");
  console.log("[onshell-agent] terminal on THIS machine, with your account's privileges. Stop it with Ctrl+C.");

  await recordAudit("agent.started", { version: AGENT_VERSION, approval: config.approval });

  const tunnel = new AgentTunnel(config, shells);
  await tunnel.start();

  const shutdown = (signal: string) => {
    console.log(`[onshell-agent] ${signal} — closing terminals and disconnecting`);
    void recordAudit("agent.stopped", { signal });
    tunnel.stop();
    // Give the close frames a moment to flush; the process exits on its own
    // once the socket and timers are gone, so this is only a backstop.
    setTimeout(() => process.exit(0), 1_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function status() {
  const config = await loadAgentConfig();
  const shells = await discoverShells();

  console.log(`version:  ${AGENT_VERSION}`);
  console.log(`config:   ${configPath()}`);
  console.log(`api:      ${config.apiBaseUrl}`);
  console.log(`gateway:  ${config.gatewayBaseUrl}`);
  console.log(`device:   ${config.deviceId ?? "not paired"}`);
  console.log(`owner:    ${config.ownerEmail ?? "unknown"}`);
  console.log(`access:   ${config.approval} — ${APPROVAL_SUMMARY[config.approval]}`);
  console.log(`log:      ${auditPath()}`);
  console.log(`shells:   ${shells.length > 0 ? shells.map((shell) => shell.token).join(", ") : "none found"}`);
}

/** Prints this machine's own record, readable without an account or a network. */
async function showLog(count: number) {
  const entries = await readAudit(count);
  if (entries.length === 0) {
    console.log(`Nothing recorded yet. The log lives at ${auditPath()}`);
    return;
  }

  for (const entry of entries) {
    const { at, event, ...rest } = entry;
    const detail = Object.entries(rest)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    console.log(`${String(at)}  ${String(event).padEnd(18)} ${detail}`);
  }
}

async function setApproval(mode: string) {
  if (!isApprovalMode(mode)) {
    console.error(`[onshell-agent] unknown mode: ${mode}. Use one of: ${APPROVAL_MODES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  await saveAgentConfig({ approval: mode });
  console.log(`[onshell-agent] access is now "${mode}" — ${APPROVAL_SUMMARY[mode]}`);
  console.log("[onshell-agent] restart the agent for this to take effect.");
}

async function main() {
  const [command = "run", ...rest] = process.argv.slice(2);

  switch (command) {
    case "run":
      await run();
      return;

    case "status":
      await status();
      return;

    case "service": {
      // argv[0] is the node binary and argv[1] the script, which together are
      // exactly what has to be re-run at login.
      const definition = serviceDefinition({ command: process.argv[0]!, args: [process.argv[1]!] });
      console.log(`# Save this as:\n#   ${definition.path}\n`);
      console.log(definition.contents);
      console.log("# Then run:");
      for (const step of definition.install) console.log(`#   ${step}`);
      if (definition.notes.length > 0) {
        console.log("#");
        for (const note of definition.notes) console.log(`# ${note}`);
      }
      return;
    }

    case "log": {
      const count = Number.parseInt(rest[0] ?? "50", 10);
      await showLog(Number.isFinite(count) && count > 0 ? count : 50);
      return;
    }

    case "approval": {
      if (!rest[0]) {
        const config = await loadAgentConfig();
        console.log(`${config.approval} — ${APPROVAL_SUMMARY[config.approval]}`);
        return;
      }
      await setApproval(rest[0]);
      return;
    }

    case "pair": {
      const [code, ...nameParts] = rest;
      if (!code) {
        console.error("[onshell-agent] usage: onshell-agent pair <code> [machine name]");
        process.exitCode = 1;
        return;
      }

      try {
        const paired = await pair(code, nameParts.join(" "));
        console.log(`[onshell-agent] paired as "${paired.name}" (${paired.deviceId})`);
        console.log(`[onshell-agent] identity stored in ${paired.storedAt}`);
        if (paired.ownerEmail) {
          console.log(`[onshell-agent] ${paired.ownerEmail} can connect without asking; anyone else will prompt here.`);
          console.log("[onshell-agent] change that with: onshell-agent approval <trusted|ask|always>");
        }
        console.log("[onshell-agent] start it with: onshell-agent run");
      } catch (error) {
        console.error(`[onshell-agent] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
      return;
    }

    case "--version":
    case "-v":
      console.log(AGENT_VERSION);
      return;

    case "--help":
    case "-h":
      console.log(USAGE);
      return;

    default:
      console.error(`[onshell-agent] unknown command: ${command}\n`);
      console.error(USAGE);
      process.exitCode = 1;
  }
}

// Not top-level `await`: the distributed build is bundled to CommonJS (Node's
// single-executable support takes a CJS entry point), which cannot carry one.
// It also gives the process a real last-resort error handler, which a bare
// top-level await did not have.
main().catch((error: unknown) => {
  console.error(`[onshell-agent] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
