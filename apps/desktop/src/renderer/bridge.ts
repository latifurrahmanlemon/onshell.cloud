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

export const bridge: OnshellBridge = window.onshell;

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
