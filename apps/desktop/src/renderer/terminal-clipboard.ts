export type TerminalClipboardAction = "copy" | "paste";

interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Preserve terminal semantics while supporting platform-native clipboard keys.
 * Ctrl+C is still SIGINT on Windows/Linux unless text is selected; the explicit
 * Ctrl+Shift+C variant always means copy.
 */
export function terminalClipboardAction(
  event: ShortcutEvent,
  isMac: boolean,
  hasSelection: boolean
): TerminalClipboardAction | undefined {
  if (event.altKey) return undefined;
  const key = event.key.toLowerCase();
  if (isMac) {
    if (!event.metaKey) return undefined;
    if (key === "c") return "copy";
    if (key === "v") return "paste";
    return undefined;
  }
  if (!event.ctrlKey) return undefined;
  if (key === "c" && (event.shiftKey || hasSelection)) return "copy";
  if (key === "v") return "paste";
  return undefined;
}
