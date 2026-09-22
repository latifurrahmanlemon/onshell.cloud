import { describe, expect, it } from "vitest";
import { organizationLogo } from "./organization-logo.js";
describe("organization logos", () => {
  it("accepts a raster logo and removal", () => {
    expect(organizationLogo.safeParse("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZuoAAAAASUVORK5CYII=").success).toBe(true);
    expect(organizationLogo.parse(null)).toBeNull();
  });
  it("rejects URLs, SVG, mislabeled content and oversized uploads", () => {
    for (const value of ["https://example.com/logo.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,aGVsbG8gdGhpcyBpcyB0ZXh0", `data:image/png;base64,${"A".repeat(400_001)}`]) expect(organizationLogo.safeParse(value).success).toBe(false);
  });
});
