/**
 * afterSign hook: notarize the macOS build, but only when Apple's credentials
 * are actually present.
 *
 * This is what makes the repository "signing-ready" without being "signing-
 * required": with no APPLE_ID in the environment the hook returns immediately,
 * so `yarn dist:mac` on a laptop produces a working unsigned .app, while the
 * same command in CI with the secrets set produces a notarized one. No code
 * changes between the two — only environment.
 *
 * @electron/notarize is an optional dependency: it is only needed on the macOS
 * signing path, so a Linux/Windows build (or an unsigned mac build) does not
 * require it to be installed.
 */
const path = require("node:path");

exports.default = async function notarize(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log("[notarize] Apple credentials not set — skipping notarization (unsigned build).");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const { notarize } = require("@electron/notarize");
  console.log(`[notarize] submitting ${appName}.app to Apple…`);
  await notarize({
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID
  });
  console.log("[notarize] done.");
};
