/**
 * The renderer's view of `window.onshell`.
 *
 * Typed against the same contract the preload implements, so the compiler
 * catches a channel the main process does not actually serve.
 */
import type { OnshellBridge } from "../shared/ipc.js";

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

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && typeof (value as PromiseLike<unknown>).then === "function");
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

function trackedBridge<T extends object>(target: T, parent = ""): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;
      const path = parent ? `${parent}.${String(property)}` : String(property);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, object, args) as unknown;
          return isPromiseLike(result) && !untracked.has(path) ? track(Promise.resolve(result)) : result;
        };
      }
      return value && typeof value === "object" ? trackedBridge(value as object, path) : value;
    }
  }) as T;
}

export function subscribeActivity(listener: ActivityListener) {
  activityListeners.add(listener);
  listener(pendingActivity);
  return () => {
    activityListeners.delete(listener);
  };
}

export const bridge: OnshellBridge = trackedBridge(window.onshell);

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
