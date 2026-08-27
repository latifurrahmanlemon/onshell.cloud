import { describe, expect, it } from "vitest";
import { liveGatewaySessionIds } from "./gateway.js";

/**
 * The stakes here are lopsided, which is what these tests are about: the caller
 * closes every session row whose id is *not* in this list. Returning [] for a
 * response that could not be read would end every terminal in the workspace, so
 * "I could not read this" has to be a different answer from "nothing is running".
 */
describe("liveGatewaySessionIds", () => {
  it("keeps the sessions that are still running", () => {
    expect(
      liveGatewaySessionIds([
        { id: "gw_1", status: "active" },
        { id: "gw_2", status: "pending" }
      ])
    ).toEqual(["gw_1", "gw_2"]);
  });

  it("drops the ones the gateway is only still remembering", () => {
    // The gateway never prunes its map, so a closed session stays in the listing
    // forever. Treating those as live would keep the rows open for good — which
    // is the leak this whole path exists to stop.
    expect(
      liveGatewaySessionIds([
        { id: "gw_open", status: "active" },
        { id: "gw_done", status: "closed" },
        { id: "gw_bad", status: "failed" }
      ])
    ).toEqual(["gw_open"]);
  });

  it("reads an empty listing as an empty listing", () => {
    // A restarted gateway. Everything it was serving really has ended, so the
    // answer is [] and every row gets closed — not undefined.
    expect(liveGatewaySessionIds([])).toEqual([]);
  });

  it("refuses to read a response it does not understand", () => {
    for (const payload of [null, undefined, {}, "sessions", 42, { sessions: [] }]) {
      expect(liveGatewaySessionIds(payload)).toBeUndefined();
    }
  });

  it("ignores entries with nothing usable in them", () => {
    // Not an error worth abandoning the whole reconcile over — an entry with no
    // id simply cannot match a row, so it can only be skipped.
    expect(
      liveGatewaySessionIds([{ id: "gw_1", status: "active" }, { status: "active" }, { id: 7 }, { id: "" }, null])
    ).toEqual(["gw_1"]);
  });
});
