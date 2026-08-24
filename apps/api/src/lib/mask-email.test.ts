import { describe, expect, it } from "vitest";
import { maskEmail } from "./mask-email.js";

describe("maskEmail", () => {
  it("keeps the first character and the domain so the recipient recognises the mailbox", () => {
    expect(maskEmail("latifur@bdren.net.bd")).toBe("l•••@bdren.net.bd");
    expect(maskEmail("ada@example.com")).toBe("a•••@example.com");
  });

  it("hides the length of the local part", () => {
    // Both masks are identical, so the response cannot be used to narrow a
    // guess at the address behind it.
    expect(maskEmail("ab@example.com")).toBe(maskEmail("abcdefghijkl@example.com"));
  });

  it("splits on the final @, so a quoted local part is not mistaken for the domain", () => {
    expect(maskEmail('"weird@local"@example.com')).toBe('"•••@example.com');
  });

  it("tolerates surrounding whitespace", () => {
    expect(maskEmail("  ada@example.com  ")).toBe("a•••@example.com");
  });

  it("reveals nothing when the value is not an address", () => {
    expect(maskEmail("not-an-email")).toBe("•••");
    expect(maskEmail("@example.com")).toBe("•••");
    expect(maskEmail("ada@")).toBe("•••");
    expect(maskEmail("")).toBe("•••");
  });
});
