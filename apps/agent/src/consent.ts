/**
 * Asking the person at the keyboard.
 *
 * The hard question this file answers is *when* to ask. Prompting on every
 * session would break the product outright — the whole point is reaching your
 * desktop from your phone, and there is nobody at the desktop to click Allow.
 * Never prompting is worse: it means a workspace admin can quietly open a shell
 * on an employee's personal laptop.
 *
 * So the default splits on identity. The person who paired the machine is
 * trusted on it; anybody else has to be let in by whoever is sitting there. That
 * keeps unattended access working for its owner while making "someone else took
 * a shell on my computer" impossible to do silently.
 */
import { execFile } from "node:child_process";
import { platform } from "node:os";
import type { Requester } from "@onshell/agent-protocol";

/**
 * How long a prompt waits before it gives up and denies.
 *
 * Configurable because a minute is right for a laptop on a desk and wrong for a
 * machine somebody has to walk to. Clamped so a hostile or fat-fingered value
 * cannot turn the prompt into either a hang or a formality.
 */
const PROMPT_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.ONSHELL_CONSENT_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(raw)) return 60_000;
  return Math.min(300_000, Math.max(1_000, raw));
})();

export type ApprovalMode = "trusted" | "ask" | "always";

export const APPROVAL_MODES: ApprovalMode[] = ["trusted", "ask", "always"];

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as string[]).includes(value);
}

export interface ConsentRequest {
  kind: "shell" | "files";
  requestedBy?: Requester;
  /** The account that paired this machine. */
  ownerUserId?: string;
  mode: ApprovalMode;
}

export interface ConsentDecision {
  granted: boolean;
  /** How it was decided, for the local log. */
  reason: string;
}

/**
 * Strips anything that is not plainly printable before it reaches a dialog.
 *
 * Names and emails are chosen by whoever signed up, so they are attacker
 * controlled as far as this machine is concerned. Every prompt below is invoked
 * without a shell, so this is not about command injection — it is that a display
 * name containing quotes or newlines could otherwise rewrite what the dialog
 * appears to say, which is its own kind of attack when the entire point is an
 * informed decision.
 */
function safeText(value: string | undefined, fallback: string, max = 80) {
  const cleaned = (value ?? "")
    // Control characters first: a newline in a name could add a line to the
    // dialog that looks like it came from us.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/["'`$\\]/g, "")
    .trim()
    .slice(0, max);
  return cleaned.length > 0 ? cleaned : fallback;
}

function describe(request: ConsentRequest) {
  const who = request.requestedBy
    ? `${safeText(request.requestedBy.name, "Someone")} (${safeText(request.requestedBy.email, "unknown", 120)})`
    : "Someone in your workspace";
  const what = request.kind === "shell" ? "open a terminal on this computer" : "browse the files on this computer";
  return { who, what };
}

/** Runs a command, resolving to its stdout, or undefined on failure or timeout. */
function tryExec(file: string, args: string[], timeoutMs: number) {
  return new Promise<string | undefined>((resolveExec) => {
    // `execFile`, never `exec`: no shell means no amount of punctuation in a
    // display name can turn into a command.
    const child = execFile(file, args, { timeout: timeoutMs }, (error, stdout) => {
      resolveExec(error ? undefined : stdout);
    });
    child.on("error", () => resolveExec(undefined));
  });
}

/**
 * Windows: a modal message box.
 *
 * The script is passed base64 as `-EncodedCommand` rather than assembled into a
 * command line, so nothing in the message can be read as PowerShell. It also
 * defaults to the *No* button, so a stray Enter denies.
 */
async function promptWindows(title: string, message: string) {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    `$result = [System.Windows.Forms.MessageBox]::Show('${message}', '${title}',`,
    "  [System.Windows.Forms.MessageBoxButtons]::YesNo,",
    "  [System.Windows.Forms.MessageBoxIcon]::Warning,",
    "  [System.Windows.Forms.MessageBoxDefaultButton]::Button2)",
    "if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { Write-Output 'ALLOW' } else { Write-Output 'DENY' }"
  ].join("\n");

  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const stdout = await tryExec("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], PROMPT_TIMEOUT_MS);
  return stdout?.includes("ALLOW") ?? false;
}

async function promptDarwin(title: string, message: string) {
  const seconds = Math.floor(PROMPT_TIMEOUT_MS / 1000);
  const stdout = await tryExec(
    "osascript",
    [
      "-e",
      `display dialog "${message}" with title "${title}" buttons {"Deny", "Allow"} default button "Deny" with icon caution giving up after ${seconds}`
    ],
    PROMPT_TIMEOUT_MS
  );

  // "gave up:true" comes back when nobody answered, and must not read as Allow.
  if (stdout === undefined || stdout.includes("gave up:true")) return false;
  return stdout.includes("button returned:Allow");
}

async function promptLinux(title: string, message: string) {
  // Exit status carries the answer for both of these, and `tryExec` reports a
  // non-zero exit as undefined — which is exactly Deny.
  const zenity = await tryExec(
    "zenity",
    ["--question", "--title", title, "--text", message, "--ok-label=Allow", "--cancel-label=Deny"],
    PROMPT_TIMEOUT_MS
  );
  if (zenity !== undefined) return true;

  const kdialog = await tryExec("kdialog", ["--title", title, "--yesno", message], PROMPT_TIMEOUT_MS);
  return kdialog !== undefined;
}

async function prompt(request: ConsentRequest) {
  const { who, what } = describe(request);
  const title = "Onshell access request";
  const message = `${who} wants to ${what}.\n\nAllow this?`;

  switch (platform()) {
    case "win32":
      return promptWindows(title, message);
    case "darwin":
      return promptDarwin(title, message);
    default:
      return promptLinux(title, message);
  }
}

/**
 * Decides whether a session may start.
 *
 * Anything that goes wrong — no dialog program installed, a headless machine,
 * nobody there to answer — denies. A prompt that fails open is not a prompt.
 */
export async function requestConsent(request: ConsentRequest): Promise<ConsentDecision> {
  if (request.mode === "trusted") return { granted: true, reason: "policy_trusted" };

  const isOwner =
    request.mode === "ask" && request.ownerUserId !== undefined && request.requestedBy?.id === request.ownerUserId;
  if (isOwner) return { granted: true, reason: "owner" };

  const granted = await prompt(request);
  return { granted, reason: granted ? "approved_locally" : "denied_locally" };
}

/**
 * A non-blocking "this is happening" notice.
 *
 * Remote access nobody can see is what separates a support tool from spyware. A
 * tray icon is the better answer and arrives with the packaged app; until then,
 * every session that starts *without* asking still announces itself on the
 * machine it is starting on.
 */
export function notifySessionStarted(request: ConsentRequest) {
  const { who, what } = describe(request);
  const title = "Onshell session started";
  const message = `${who} can ${what}.`;

  void (async () => {
    switch (platform()) {
      case "win32": {
        const script = [
          "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
          "Add-Type -AssemblyName System.Drawing | Out-Null",
          "$icon = New-Object System.Windows.Forms.NotifyIcon",
          "$icon.Icon = [System.Drawing.SystemIcons]::Information",
          "$icon.Visible = $true",
          `$icon.ShowBalloonTip(8000, '${title}', '${message}', [System.Windows.Forms.ToolTipIcon]::Info)`,
          "Start-Sleep -Seconds 8",
          "$icon.Dispose()"
        ].join("\n");

        await tryExec(
          "powershell.exe",
          ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
          20_000
        );
        return;
      }
      case "darwin":
        await tryExec("osascript", ["-e", `display notification "${message}" with title "${title}"`], 10_000);
        return;
      default:
        await tryExec("notify-send", [title, message], 10_000);
    }
  })();
}
