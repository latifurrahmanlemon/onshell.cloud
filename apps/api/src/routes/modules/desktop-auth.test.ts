import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approveDesktopAuthRequest,
  createDesktopAuthRequest,
  denyDesktopAuthRequest,
  DESKTOP_AUTH_TTL_SECONDS,
  normalizeUserCode,
  pollDesktopAuthRequest,
  previewDesktopAuthRequest
} from "../../lib/desktop-auth.js";

/**
 * The state machine behind `POST /desktop/auth/requests`.
 *
 * These are the security properties of the flow rather than a formality: this
 * is the one path in the product where a session for an account is handed to a
 * process that never presented a credential for it. Each case below is a way
 * that could go wrong.
 *
 * The routes in desktop.ts are a thin wrapper — validate, call one of these,
 * translate the result into a status code — so the interesting behaviour is all
 * here, and it can be exercised without a database.
 */

const machine = {
  machineName: "WIN-DEV-01",
  platform: "win32",
  appVersion: "0.1.0",
  ipAddress: "203.0.113.10"
};

afterEach(() => {
  vi.useRealTimers();
});

describe("browser sign-in, happy path", () => {
  it("hands the session to the app once the person approves, and only once", () => {
    const created = createDesktopAuthRequest(machine);

    // Nothing is collectable before somebody agrees.
    expect(pollDesktopAuthRequest(created.requestId, created.deviceSecret)).toEqual({ status: "pending" });

    const approval = approveDesktopAuthRequest(created.requestId, created.userCode, "user_1");
    expect(approval.status).toBe("approved");

    expect(pollDesktopAuthRequest(created.requestId, created.deviceSecret)).toEqual({
      status: "approved",
      userId: "user_1"
    });

    // One-shot: the request is consumed by the poll that collected it, so a
    // replay of the same poll cannot mint a second session.
    expect(pollDesktopAuthRequest(created.requestId, created.deviceSecret)).toEqual({ status: "expired" });
  });

  it("accepts the code as the person is likely to type it", () => {
    for (const transform of [
      (code: string) => code.toLowerCase(),
      (code: string) => code.replace("-", ""),
      (code: string) => ` ${code} `
    ]) {
      const created = createDesktopAuthRequest(machine);
      expect(approveDesktopAuthRequest(created.requestId, transform(created.userCode), "user_1").status).toBe(
        "approved"
      );
    }
  });

  it("generates codes from an alphabet with no I, O, 0 or 1 to transcribe wrongly", () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const created = createDesktopAuthRequest(machine);
      expect(created.userCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{4}$/);
    }
  });

  it("does not repeat a code or a secret across requests", () => {
    const first = createDesktopAuthRequest(machine);
    const second = createDesktopAuthRequest(machine);
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.deviceSecret).not.toBe(second.deviceSecret);
  });
});

describe("the device secret is what entitles a caller to the session", () => {
  it("refuses a poll that presents the wrong secret", () => {
    const created = createDesktopAuthRequest(machine);
    approveDesktopAuthRequest(created.requestId, created.userCode, "user_1");

    expect(pollDesktopAuthRequest(created.requestId, "not-the-secret")).toEqual({
      status: "invalid_device_secret"
    });
    // And knowing the id is not enough to guess it either.
    expect(pollDesktopAuthRequest(created.requestId, created.requestId)).toEqual({
      status: "invalid_device_secret"
    });
  });

  it("does not let a wrong secret cancel the request it failed to collect", () => {
    const created = createDesktopAuthRequest(machine);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      pollDesktopAuthRequest(created.requestId, `guess-${attempt}`);
    }

    // The real app is still able to finish. A failed poll that destroyed the
    // request would make this endpoint a denial-of-service tool against any
    // sign-in whose id had leaked.
    approveDesktopAuthRequest(created.requestId, created.userCode, "user_1");
    expect(pollDesktopAuthRequest(created.requestId, created.deviceSecret)).toEqual({
      status: "approved",
      userId: "user_1"
    });
  });
});

describe("the user code is what stops a remote attacker being approved", () => {
  it("refuses approval with the wrong code and never reveals the right one", () => {
    const created = createDesktopAuthRequest(machine);

    expect(approveDesktopAuthRequest(created.requestId, "AAAA-AAAA", "user_1")).toEqual({
      status: "invalid_user_code"
    });

    const preview = previewDesktopAuthRequest(created.requestId);
    expect(preview).toMatchObject({ status: "pending", machineName: "WIN-DEV-01", platform: "win32" });
    expect(JSON.stringify(preview)).not.toContain(normalizeUserCode(created.userCode));

    // Still collectable by nobody, because nothing was approved.
    expect(pollDesktopAuthRequest(created.requestId, created.deviceSecret)).toEqual({ status: "pending" });
  });

  it("destroys the request after a handful of wrong codes rather than allowing a guess", () => {
    const created = createDesktopAuthRequest(machine);

    let lastStatus = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      lastStatus = approveDesktopAuthRequest(created.requestId, `WRONG-${attempt}`, "user_1").status;
    }
    expect(lastStatus).toBe("expired");

    // Gone entirely: the correct code no longer works either, and the app is
    // told the request is over rather than left waiting.
    expect(approveDesktopAuthRequest(created.requestId, created.userCode, "user_1").status).toBe("expired");
    expect(pollDesktopAuthRequest(created.requestId, created.deviceSecret)).toEqual({ status: "expired" });
  });

  it("refuses to approve a request that was already resolved", () => {
    const created = createDesktopAuthRequest(machine);
    expect(approveDesktopAuthRequest(created.requestId, created.userCode, "user_1").status).toBe("approved");
    expect(approveDesktopAuthRequest(created.requestId, created.userCode, "user_2")).toEqual({
      status: "already_resolved",
      resolution: "approved"
    });
  });
});

describe("denial", () => {
  it("tells the app it was refused, once", () => {
    const created = createDesktopAuthRequest(machine);
    expect(denyDesktopAuthRequest(created.requestId).status).toBe("denied");

    expect(pollDesktopAuthRequest(created.requestId, created.deviceSecret)).toEqual({ status: "denied" });
    expect(pollDesktopAuthRequest(created.requestId, created.deviceSecret)).toEqual({ status: "expired" });
  });

  it("cannot be turned back into an approval", () => {
    const created = createDesktopAuthRequest(machine);
    denyDesktopAuthRequest(created.requestId);
    expect(approveDesktopAuthRequest(created.requestId, created.userCode, "user_1")).toEqual({
      status: "already_resolved",
      resolution: "denied"
    });
  });
});

describe("expiry", () => {
  it("stops being collectable after its own deadline, however often it was polled", () => {
    vi.useFakeTimers();
    const created = createDesktopAuthRequest(machine);

    // Polling must not extend the life of the request. The record carries its
    // own expiry precisely because re-storing it restarts the map's TTL, and a
    // client that keeps asking would otherwise hold the window open all day.
    for (let elapsed = 0; elapsed < DESKTOP_AUTH_TTL_SECONDS; elapsed += 30) {
      expect(pollDesktopAuthRequest(created.requestId, created.deviceSecret)).toEqual({ status: "pending" });
      vi.advanceTimersByTime(30_000);
    }

    vi.advanceTimersByTime(1_000);
    expect(pollDesktopAuthRequest(created.requestId, created.deviceSecret)).toEqual({ status: "expired" });
  });

  it("cannot be approved or previewed once expired", () => {
    vi.useFakeTimers();
    const created = createDesktopAuthRequest(machine);

    vi.advanceTimersByTime((DESKTOP_AUTH_TTL_SECONDS + 1) * 1000);
    expect(previewDesktopAuthRequest(created.requestId)).toBeUndefined();
    expect(approveDesktopAuthRequest(created.requestId, created.userCode, "user_1").status).toBe("expired");
    expect(denyDesktopAuthRequest(created.requestId).status).toBe("expired");
  });
});

describe("unknown requests", () => {
  it("look exactly like expired ones", () => {
    expect(pollDesktopAuthRequest("dar_nonexistent", "whatever")).toEqual({ status: "expired" });
    expect(approveDesktopAuthRequest("dar_nonexistent", "AAAA-AAAA", "user_1").status).toBe("expired");
    expect(previewDesktopAuthRequest("dar_nonexistent")).toBeUndefined();
  });
});
