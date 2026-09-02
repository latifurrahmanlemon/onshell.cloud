import { describe, expect, it } from "vitest";
import { donationSchema } from "./donations.js";

describe("donation checkout validation", () => {
  it("accepts guest donations from one dollar", () => {
    expect(donationSchema.parse({ amountCents: 100 })).toMatchObject({
      amountCents: 100,
      source: "website",
    });
  });

  it("accepts the Stripe eight-digit ceiling", () => {
    expect(
      donationSchema.parse({ amountCents: 99_999_999, source: "desktop" })
        .amountCents,
    ).toBe(99_999_999);
  });

  it("rejects zero, sub-dollar, and over-limit amounts", () => {
    for (const amountCents of [0, 99, 100_000_000]) {
      expect(donationSchema.safeParse({ amountCents }).success).toBe(false);
    }
  });

  it("normalizes optional donor details without requiring a login identity", () => {
    const parsed = donationSchema.parse({
      amountCents: 500,
      donorName: "  Ada  ",
      donorEmail: "ada@example.com",
    });
    expect(parsed.donorName).toBe("Ada");
    expect(parsed.donorEmail).toBe("ada@example.com");
  });
});
