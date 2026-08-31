/**
 * electron-builder v25 skips macOS signing entirely when no certificate is
 * present. That leaves Electron frameworks and native modules without one
 * coherent code-signature tree, which modern Gatekeeper can reject as a
 * malformed app instead of offering the normal one-time user exception.
 *
 * A dash is Apple's ad-hoc identity. It does not establish publisher trust or
 * notarize the app, but it seals every executable in the bundle so macOS can
 * validate that the installed app is internally consistent. When
 * electron-builder finds a real Developer ID identity, keep that identity and
 * this same hook performs the normal distribution signature instead.
 */
const { signAsync } = require("@electron/osx-sign");

module.exports = async function signMac(options) {
  const identity = options.identity || "-";
  const mode = identity === "-" ? "ad-hoc" : "Developer ID";

  console.log(`[sign-mac] applying ${mode} signature to ${options.app}`);
  await signAsync({
    ...options,
    identity,
    // The ad-hoc identity is intentionally not stored in the keychain.
    identityValidation: false,
    // There is no provisioning profile or team identifier for ad-hoc signing.
    preEmbedProvisioningProfile:
      identity === "-" ? false : options.preEmbedProvisioningProfile,
    preAutoEntitlements: identity === "-" ? false : options.preAutoEntitlements,
  });
};
