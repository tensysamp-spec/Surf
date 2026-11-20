// electron-builder config for `npm run release` (see docs/RELEASING.md).
// Extends the "build" block in package.json. Credentials are never read from
// files: with a Developer ID certificate (CSC_NAME / CSC_LINK, or one in the
// login Keychain) the app is signed with the hardened runtime and notarized;
// without one it falls back to the same ad-hoc signature as `npm run package`.
const { execFileSync } = require('child_process');
const path = require('path');
const { Arch } = require('builder-util');
const base = require('../package.json').build;

const NOTARY_PROFILE = 'surf-notary';

// A "Developer ID Application" identity in the Keychain counts as credentials,
// so the owner never has to export the certificate or put its name in env.
function keychainHasDeveloperId() {
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
    return /"Developer ID Application: /.test(out);
  } catch { return false; }
}

const signed = !!(process.env.CSC_LINK || process.env.CSC_NAME || keychainHasDeveloperId());
const notaryEnv = process.env.APPLE_ID || process.env.APPLE_API_KEY || process.env.APPLE_KEYCHAIN_PROFILE;
const notarize = signed && process.env.SURF_SKIP_NOTARIZE !== '1';

// electron-builder reads these env vars itself when notarizing; default to the
// Keychain profile created by `xcrun notarytool store-credentials surf-notary`.
if (notarize && !notaryEnv) process.env.APPLE_KEYCHAIN_PROFILE = NOTARY_PROFILE;

console.log(`[release] ${signed ? 'Developer ID signing + hardened runtime' : 'no Developer ID found: ad-hoc signature'}`
  + `${signed ? (notarize ? `, notarizing via ${notaryEnv ? 'env credentials' : `Keychain profile "${NOTARY_PROFILE}"`}` : ', notarization skipped') : ''}`);

// Unsigned builds still need an ad-hoc signature to launch on Apple silicon.
// Universal builds call afterPack per arch too; only the merged app is final.
async function adHocSign(context) {
  if (signed || context.electronPlatformName !== 'darwin' || context.arch !== Arch.universal) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
}

module.exports = {
  ...base,
  directories: { ...base.directories, output: 'release' },
  afterPack: adHocSign,
  mac: {
    ...base.mac,
    target: [{ target: 'zip', arch: ['universal'] }],
    artifactName: '${productName}-${version}-mac-${arch}.${ext}',
    // null skips electron-builder's signing; undefined lets it find the identity.
    identity: signed ? undefined : null,
    hardenedRuntime: signed,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize,
    extendInfo: {
      ...base.mac.extendInfo,
      NSCameraUsageDescription: 'Websites you allow can use your camera.',
      NSMicrophoneUsageDescription: 'Websites you allow can use your microphone.',
      NSLocationUsageDescription: 'Websites you allow can see your location.',
      NSLocationWhenInUseUsageDescription: 'Websites you allow can see your location.',
    },
  },
};
