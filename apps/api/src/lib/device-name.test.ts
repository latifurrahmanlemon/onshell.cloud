import { describe, expect, it } from "vitest";
import { describeDevice } from "./device-name.js";

describe("describeDevice", () => {
  it("names the common desktop browsers", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      ).label
    ).toBe("Chrome on Windows");

    expect(
      describeDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
      ).label
    ).toBe("Safari on macOS");

    expect(describeDevice("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0").label).toBe(
      "Firefox on Ubuntu"
    );
  });

  it("does not let a Chromium fork be reported as Chrome", () => {
    // Every one of these carries "Chrome/" and "Safari/" in its own UA, so the
    // order of the table is the whole test: a naive match labels all three
    // Chrome, and the list stops distinguishing the devices it exists to name.
    const edge =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
    const opera =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0";
    const samsung =
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";

    expect(describeDevice(edge).label).toBe("Edge on Windows");
    expect(describeDevice(opera).label).toBe("Opera on Windows");
    expect(describeDevice(samsung).label).toBe("Samsung Internet on Android");
  });

  it("names iOS browsers by the device, not by the WebKit they are forced to use", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1"
      ).label
    ).toBe("Chrome on iPhone");
  });

  it("calls the desktop app what it is rather than the browser engine inside it", () => {
    expect(
      describeDevice("Onshell-Desktop/0.1.0 Electron/33.0.0 (Macintosh; Intel Mac OS X 10_15_7)").label
    ).toBe("Onshell Desktop on macOS");
  });

  it("says it does not know rather than guessing", () => {
    // A wrong name would be worse than none: it could talk someone out of
    // revoking a session that was not theirs.
    expect(describeDevice(undefined).label).toBe("Unknown device");
    expect(describeDevice("   ").label).toBe("Unknown device");
    expect(describeDevice("curl/8.4.0").label).toBe("Unknown device");
  });

  it("keeps whichever half it could read", () => {
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toEqual({
      label: "Windows",
      os: "Windows"
    });
  });
});
