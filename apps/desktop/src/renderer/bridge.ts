/**
 * The renderer's view of `window.onshell`.
 *
 * Typed against the same contract the preload implements, so the compiler
 * catches a channel the main process does not actually serve.
 */
import type { OnshellBridge } from "../shared/ipc.js";
import { copyBridgeWithActivity } from "./activity-bridge.js";

declare global {
  interface Window {
    onshell: OnshellBridge;
  }
}

type ActivityListener = (pending: number) => void;

let pendingActivity = 0;
const activityListeners = new Set<ActivityListener>();

function publishActivity(change: number) {
  pendingActivity = Math.max(0, pendingActivity + change);
  for (const listener of activityListeners) listener(pendingActivity);
}

function track<T>(promise: Promise<T>) {
  publishActivity(1);
  return promise.finally(() => publishActivity(-1));
}

const untracked = new Set([
  "getState",
  "onState",
  "console.load",
  "console.hosts",
  "console.snippets",
  "terminals.localShells",
  "terminals.write",
  "terminals.resize",
  "terminals.onEvent",
  "workspace.load",
  "workspace.save",
  "updates.check",
  "clipboard.readText",
  "clipboard.writeText"
]);

export function subscribeActivity(listener: ActivityListener) {
  activityListeners.add(listener);
  listener(pendingActivity);
  return () => {
    activityListeners.delete(listener);
  };
}

export const bridge: OnshellBridge = copyBridgeWithActivity(window.onshell, (path) => !untracked.has(path), track);

export type {
  AppState,
  ConsoleData,
  LocalShell,
  SignInResult,
  TerminalEvent,
  TerminalOpened,
  TerminalTarget,
  TwoFactorChallenge
} from "../shared/ipc.js";
