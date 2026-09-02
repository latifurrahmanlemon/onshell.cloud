import { describe, expect, it } from "vitest";
import { terminalClipboardAction } from "./terminal-clipboard.js";

const key = (value: string, patch: Partial<KeyboardEvent> = {}) => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...patch
});

describe("terminalClipboardAction", () => {
  it("uses macOS Command shortcuts", () => {
    expect(terminalClipboardAction(key("c", { metaKey: true }), true, true)).toBe("copy");
    expect(terminalClipboardAction(key("v", { metaKey: true }), true, false)).toBe("paste");
  });

  it("preserves Ctrl+C as SIGINT when there is no selection", () => {
    expect(terminalClipboardAction(key("c", { ctrlKey: true }), false, false)).toBeUndefined();
  });

  it("copies a selection with Ctrl+C or the explicit Ctrl+Shift+C shortcut", () => {
    expect(terminalClipboardAction(key("c", { ctrlKey: true }), false, true)).toBe("copy");
    expect(terminalClipboardAction(key("c", { ctrlKey: true, shiftKey: true }), false, false)).toBe("copy");
  });

  it("pastes with Ctrl+V and ignores modified or ordinary keys", () => {
    expect(terminalClipboardAction(key("v", { ctrlKey: true }), false, false)).toBe("paste");
    expect(terminalClipboardAction(key("v", { ctrlKey: true, altKey: true }), false, false)).toBeUndefined();
    expect(terminalClipboardAction(key("v"), false, false)).toBeUndefined();
  });
});
