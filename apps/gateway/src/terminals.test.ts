import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  attachSocket,
  detachSocket,
  endTerminal,
  hasLiveTerminal,
  registerTerminal,
  resetTerminals,
  setDetachGraceMs,
  type TerminalStream
} from "./terminals.js";

/** The two bits of `ws` this module touches, and a record of what was sent. */
function fakeSocket() {
  const sent: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(payload),
    close: () => {
      socket.readyState = 3;
    }
  };
  return { socket: socket as unknown as WebSocket, sent, raw: socket };
}

/** A shell whose output we drive by hand. */
function fakeStream() {
  const listeners: Array<(chunk: string) => void> = [];
  const exits: Array<() => void> = [];
  const written: string[] = [];
  let ended = false;

  const stream: TerminalStream = {
    onData: (listener) => listeners.push(listener),
    onExit: (listener) => exits.push(listener),
    write: (data) => written.push(data),
    resize: () => undefined,
    end: () => {
      ended = true;
    }
  };

  return {
    stream,
    written,
    emit: (chunk: string) => listeners.forEach((listener) => listener(chunk)),
    exit: () => exits.forEach((listener) => listener()),
    get ended() {
      return ended;
    }
  };
}

afterEach(() => {
  resetTerminals();
  setDetachGraceMs(15 * 60_000);
  vi.useRealTimers();
});

describe("terminals", () => {
  it("keeps the shell running when its socket goes, and hands it back on reconnect", () => {
    const shell = fakeStream();
    const first = fakeSocket();
    const dispose = vi.fn();

    registerTerminal("s1", shell.stream, dispose, first.socket);
    shell.emit("hello");
    expect(first.sent).toEqual(["hello"]);

    detachSocket("s1", first.socket);
    // The whole point: a dropped socket is not a reason to end anything.
    expect(shell.ended).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    expect(hasLiveTerminal("s1")).toBe(true);

    // Output produced with nobody watching is kept, not thrown away.
    shell.emit("while you were out");

    const second = fakeSocket();
    const resumed = attachSocket("s1", second.socket);
    expect(resumed?.backlog).toEqual(["while you were out"]);
    expect(resumed?.exited).toBe(false);
    expect(resumed?.stream).toBe(shell.stream);

    shell.emit("live again");
    expect(second.sent).toEqual(["live again"]);
  });

  it("ends the shell once the grace period passes with nobody attached", () => {
    vi.useFakeTimers();
    setDetachGraceMs(1000);

    const shell = fakeStream();
    const socket = fakeSocket();
    const dispose = vi.fn();
    registerTerminal("s2", shell.stream, dispose, socket.socket);

    detachSocket("s2", socket.socket);
    vi.advanceTimersByTime(999);
    expect(shell.ended).toBe(false);

    vi.advanceTimersByTime(2);
    expect(shell.ended).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(hasLiveTerminal("s2")).toBe(false);
  });

  it("cancels the countdown when a browser comes back in time", () => {
    vi.useFakeTimers();
    setDetachGraceMs(1000);

    const shell = fakeStream();
    const first = fakeSocket();
    registerTerminal("s3", shell.stream, () => undefined, first.socket);

    detachSocket("s3", first.socket);
    vi.advanceTimersByTime(500);
    attachSocket("s3", fakeSocket().socket);
    vi.advanceTimersByTime(5000);

    expect(shell.ended).toBe(false);
    expect(hasLiveTerminal("s3")).toBe(true);
  });

  it("holds a shell's last output for a browser that reconnects after it exited", () => {
    const shell = fakeStream();
    const first = fakeSocket();
    registerTerminal("s4", shell.stream, () => undefined, first.socket);

    detachSocket("s4", first.socket);
    shell.emit("build failed");
    shell.exit();

    const second = fakeSocket();
    const resumed = attachSocket("s4", second.socket);
    expect(resumed?.backlog).toEqual(["build failed"]);
    expect(resumed?.exited).toBe(true);
    // Delivered once; the entry is gone rather than waiting out a grace period
    // for a shell that has already ended.
    expect(hasLiveTerminal("s4")).toBe(false);
  });

  it("tells the attached socket the shell exited, so the console does not reconnect", () => {
    const shell = fakeStream();
    const socket = fakeSocket();
    registerTerminal("s5", shell.stream, () => undefined, socket.socket);

    shell.exit();

    expect(socket.sent.some((frame) => frame.includes('"type":"exit"'))).toBe(true);
    expect(hasLiveTerminal("s5")).toBe(false);
  });

  it("does not forgive a deliberate close", () => {
    const shell = fakeStream();
    const socket = fakeSocket();
    const dispose = vi.fn();
    registerTerminal("s6", shell.stream, dispose, socket.socket);

    endTerminal("s6");

    expect(shell.ended).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(attachSocket("s6", fakeSocket().socket)).toBeUndefined();
  });

  it("tells a superseded socket to stop rather than letting two windows fight over one shell", () => {
    const shell = fakeStream();
    const first = fakeSocket();
    registerTerminal("s8", shell.stream, () => undefined, first.socket);

    attachSocket("s8", fakeSocket().socket);

    // "exit", not a bare close: a console reading this as a dropped connection
    // would reconnect and take the terminal back, forever.
    expect(first.sent.some((frame) => frame.includes('"type":"exit"'))).toBe(true);
    expect(first.raw.readyState).toBe(3);
  });

  it("lets a late close event from a replaced socket alone", () => {
    vi.useFakeTimers();
    setDetachGraceMs(1000);

    const shell = fakeStream();
    const first = fakeSocket();
    registerTerminal("s7", shell.stream, () => undefined, first.socket);

    const second = fakeSocket();
    attachSocket("s7", second.socket);
    // The old socket's close arrives after it was superseded. Acting on it would
    // start a countdown under the socket that is actually attached.
    detachSocket("s7", first.socket);
    vi.advanceTimersByTime(5000);

    expect(shell.ended).toBe(false);
    expect(hasLiveTerminal("s7")).toBe(true);
  });
});
