import { useEffect, useRef } from "react";

/** Refresh data on workspace changes while leaving editor state mounted. */
export function useLiveRefresh(refresh: () => Promise<unknown>, enabled = true) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    let busy = false, disposed = false, again = false;
    const run = async () => {
      if (busy) { again = true; return; }
      busy = true;
      try { await latest.current(); } catch { /* Existing data remains visible during network outages. */ }
      finally { busy = false; if (again && !disposed) { again = false; void run(); } }
    };
    const changed = () => { void run(); };
    window.addEventListener("onshell:sync", changed);
    return () => { disposed = true; window.removeEventListener("onshell:sync", changed); };
  }, [enabled]);
}
