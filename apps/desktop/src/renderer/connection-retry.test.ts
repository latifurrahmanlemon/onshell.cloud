import { expect, it, vi } from "vitest";
import { retryConnection } from "./connection-retry.js";

const success = { ok: true as const, terminal: { terminalId: "terminal", mode: "direct" as const, title: "Host" } };
const failure = { ok: false as const, error: "Connection refused." };
const setup = () => ({ target: { kind: "relay" as const, hostId: "host" }, signal: new AbortController().signal, open: vi.fn().mockResolvedValue(failure), close: vi.fn().mockResolvedValue(undefined), onAttempt: vi.fn(), delayMs: 0 });

it("tries three times and keeps the actual failure reason", async () => {
  const options = setup();
  expect(await retryConnection(options)).toEqual(failure);
  expect(options.open).toHaveBeenCalledTimes(3);
  expect(options.open).toHaveBeenCalledWith({ kind: "direct", hostId: "host" });
  expect(options.onAttempt.mock.calls).toEqual([[1], [2], [3]]);
});
it("stops immediately after a successful retry", async () => {
  const options = setup();
  options.open.mockResolvedValueOnce(failure).mockResolvedValueOnce(success);
  expect(await retryConnection(options)).toEqual(success);
  expect(options.open).toHaveBeenCalledTimes(2);
});
it("cleans up a connection that opens after cancellation", async () => {
  const options = setup();
  const controller = new AbortController();
  options.signal = controller.signal;
  options.open.mockImplementation(async () => { controller.abort(); return success; });
  expect(await retryConnection(options)).toMatchObject({ ok: false, code: "cancelled" });
  expect(options.close).toHaveBeenCalledWith("terminal");
  expect(options.open).toHaveBeenCalledTimes(1);
});
it("does not connect after being cancelled", async () => {
  const options = setup();
  options.signal = AbortSignal.abort();
  await retryConnection(options);
  expect(options.open).not.toHaveBeenCalled();
});
it("handles IPC failures with the same bounded retry", async () => {
  const options = setup();
  options.open.mockRejectedValue(new Error("Service unavailable"));
  expect(await retryConnection(options)).toMatchObject({ ok: false, error: "Service unavailable" });
  expect(options.open).toHaveBeenCalledTimes(3);
});
