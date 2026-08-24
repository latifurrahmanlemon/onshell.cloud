import { describe, expect, it } from "vitest";
import { fallbackMembership, resolveActiveMembership } from "./active-organization.js";

/**
 * The rule that decides what a whole session sees, tested without a database.
 *
 * Ordering is the interesting part. The memberships arrive `createdAt`-ordered
 * from every load in the API, and the fallback takes the first — so these cases
 * pin down "the workspace held longest", not "whatever the index yielded".
 */
const own = { organizationId: "org_own" };
const invited = { organizationId: "org_invited" };
const memberships = [own, invited];

describe("resolveActiveMembership", () => {
  it("honours a workspace the person is a member of", () => {
    expect(resolveActiveMembership(memberships, "org_invited")).toEqual({ membership: invited, fellBack: false });
  });

  it("falls back to the oldest membership when no workspace is named", () => {
    // A session minted before the column existed, or a first sign-in. Taking the
    // default is not a substitution, so there is nothing to report.
    expect(resolveActiveMembership(memberships, null)).toEqual({ membership: own, fellBack: false });
    expect(resolveActiveMembership(memberships, undefined)).toEqual({ membership: own, fellBack: false });
    expect(resolveActiveMembership(memberships, "")).toEqual({ membership: own, fellBack: false });
  });

  it("reports the fall-back when a named workspace is not one of theirs", () => {
    // The revoked-membership case: cross-tenant access is impossible because the
    // answer is a workspace they are really in, but the caller has to be told, or
    // their host list becomes somebody else's for no visible reason.
    expect(resolveActiveMembership(memberships, "org_stranger")).toEqual({ membership: own, fellBack: true });
  });

  it("resolves nothing, and claims no fall-back, for an account with no memberships", () => {
    expect(resolveActiveMembership([], "org_own")).toEqual({ membership: undefined, fellBack: false });
    expect(fallbackMembership([])).toBeUndefined();
  });

  it("does not depend on the order the caller happens to pass", () => {
    // The whole bug in one assertion: with the list reversed, `memberships[0]`
    // silently changes answer. Naming the workspace does not.
    expect(resolveActiveMembership([invited, own], "org_own").membership).toBe(own);
    expect(resolveActiveMembership(memberships, "org_own").membership).toBe(own);
  });
});
