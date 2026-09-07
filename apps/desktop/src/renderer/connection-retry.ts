import type { TerminalOpenResult, TerminalTarget } from "../shared/ipc.js";

export const cancelledConnection: TerminalOpenResult = { ok: false, error: "Connection cancelled.", code: "cancelled" };

export async function retryConnection(options: {
  target: TerminalTarget;
  signal: AbortSignal;
  open(target: TerminalTarget): Promise<TerminalOpenResult>;
  close(id: string): Promise<void>;
  onAttempt(attempt: number): void;
  delayMs?: number;
}): Promise<TerminalOpenResult> {
  const target: TerminalTarget = options.target.kind === "relay" ? { ...options.target, kind: "direct" } : options.target;
  let result: TerminalOpenResult = cancelledConnection;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (options.signal.aborted) return cancelledConnection;
    options.onAttempt(attempt);
    try { result = await options.open(target); }
    catch (cause) { result = { ok: false, error: cause instanceof Error ? cause.message : "The desktop connection service did not respond." }; }
    if (options.signal.aborted) {
      if (result.ok) await options.close(result.terminal.terminalId);
      return cancelledConnection;
    }
    if (result.ok) return result;
    if (attempt < 3) await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); options.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, (options.delayMs ?? 1000) * attempt);
      options.signal.addEventListener("abort", finish, { once: true });
    });
  }
  return result;
}
