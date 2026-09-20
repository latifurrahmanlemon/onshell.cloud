/** Serial revision polling: no overlap, reconnect on focus, and periodic reconciliation. */
export function startLiveSync(read: () => Promise<{ revision: string }>, changed: () => void, interval = 5000) {
  let stopped = false, busy = false, last: string | undefined, checks = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped || busy) return;
    clearTimeout(timer);
    busy = true;
    try {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        const next = await read();
        if (!stopped && (next.revision !== last || ++checks >= 12)) {
          last = next.revision; checks = 0; changed();
        }
      }
    } catch { /* Retry transient failures; periodic reconciliation also supports older servers. */
      if (!stopped && ++checks >= 3) { checks = 0; changed(); }
    } finally {
      busy = false;
      if (!stopped) timer = setTimeout(() => void tick(), interval);
    }
  };
  const wake = () => { void tick(); };
  globalThis.addEventListener?.("focus", wake);
  globalThis.addEventListener?.("online", wake);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", wake);
  void tick();
  return () => {
    stopped = true; clearTimeout(timer);
    globalThis.removeEventListener?.("focus", wake);
    globalThis.removeEventListener?.("online", wake);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", wake);
  };
}
