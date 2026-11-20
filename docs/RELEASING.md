# Releasing Surf

How to build a Surf download that opens on any Mac (Apple silicon and Intel)
without the "Apple could not verify" warning. That needs three things from
Apple: a Developer ID certificate (signing), a notarization credential, and
your Team ID. None of them ever goes into this repository.

## Build commands

| Command | What you get | Signed with |
| --- | --- | --- |
| `npm run package` | `dist/mac-arm64/Surf.app` (this Mac's architecture) | ad-hoc |
| `npm run package:universal` | `dist/mac-universal/Surf.app` (arm64 + x86_64) | ad-hoc |
| `npm run release` | `release/Surf-<version>-mac-universal.zip` | Developer ID + notarized, or ad-hoc if no certificate is found |

The release settings live in `build/release.config.js` (it extends the `build`
block in `package.json`) and the hardened-runtime entitlements in
`build/entitlements.mac.plist`.

An ad-hoc build runs on the Mac that built it. On other Macs, Gatekeeper
blocks it until the user right-clicks it and chooses Open, or allows it in
System Settings → Privacy & Security. A signed and notarized build opens
normally.

## One-time setup

### 1. Join the Apple Developer Program

Enroll at <https://developer.apple.com/programs/enroll/> with your Apple ID
($99 a year). Approval can take a day or two. You need a paid membership,
because a free account can't create Developer ID certificates.

### 2. Create a "Developer ID Application" certificate

The easiest way is with Xcode:

1. Install Xcode from the App Store and open it once.
2. Go to Xcode → Settings → Accounts and add your Apple ID with **+**.
3. Select your team and click **Manage Certificates…**
4. Click **+** and choose **Developer ID Application**.

Xcode stores the certificate and its private key in your login Keychain.
To check that it's there:

```sh
security find-identity -v -p codesigning
# 1) ABCDEF… "Developer ID Application: Your Name (AB12CD34EF)"
```

`npm run release` finds this identity in the Keychain by itself. Back up the
certificate: in Keychain Access, right-click it, choose Export, and save a
`.p12` file with a strong password. Keep that file somewhere safe outside
this repo, because a lost private key can't be downloaded again.

### 3. Find your Team ID

It's the 10-character code in brackets at the end of the certificate name
(`AB12CD34EF` above). You can also find it at
<https://developer.apple.com/account> → Membership details.

### 4. Create an app-specific password

Notarization uploads the app to Apple, and that upload needs a password. Your
real Apple ID password won't work here.

1. Sign in at <https://account.apple.com>.
2. Go to Sign-In and Security → App-Specific Passwords, and create one
   named "Surf notarization".
3. Copy it (it looks like `abcd-efgh-ijkl-mnop`). You need it only for the
   next step.

### 5. Store the notarization credentials in the Keychain

```sh
xcrun notarytool store-credentials surf-notary \
  --apple-id "you@example.com" \
  --team-id AB12CD34EF
```

The command prompts for the app-specific password, checks it with Apple, and
saves everything in your login Keychain under the profile name
`surf-notary`. From then on, nothing secret needs to be typed or set again.
Don't put the password in a file, a shell profile, `.env`, `package.json` or
a commit.

## Making a release

1. Bump `"version"` in `package.json` (for example `1.1.0`) and commit it.
2. Build:

   ```sh
   npm run release
   ```

   The first line of output says which mode it chose:

   ```
   [release] Developer ID signing + hardened runtime, notarizing via Keychain profile "surf-notary"
   ```

   electron-builder builds a universal app, signs it with the hardened runtime
   and `build/entitlements.mac.plist`, uploads it to Apple's notary service,
   waits for approval (usually a few minutes), staples the ticket to the app
   and zips it into `release/Surf-<version>-mac-universal.zip`.

   If the line says `no Developer ID found: ad-hoc signature`, the
   certificate isn't in the Keychain. Go back to step 2.

### Other credential sources (optional, for CI)

`build/release.config.js` follows electron-builder's environment variables.
Set them only in the shell or as CI secrets, never in a committed file.

- Signing: `CSC_NAME="Developer ID Application: Your Name (AB12CD34EF)"` picks
  a specific Keychain identity. `CSC_LINK` (path or base64 of a `.p12` file)
  with `CSC_KEY_PASSWORD` imports one, which is how CI machines sign.
- Notarizing, using one of these sets:
  - `APPLE_KEYCHAIN_PROFILE` (default `surf-notary`) and optionally `APPLE_KEYCHAIN`
  - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`
  - `APPLE_API_KEY` (path to the `.p8` file), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`
    (an App Store Connect API key)
- `SURF_SKIP_NOTARIZE=1` signs without notarizing, which is handy for checking
  that the signature works before you set up the notary profile.

## Verifying the build

Unzip the release on any Mac and check the app:

```sh
cd /tmp && ditto -x -k ~/path/to/release/Surf-1.1.0-mac-universal.zip surf-check && cd surf-check

# Gatekeeper's verdict. You want "accepted" and "source=Notarized Developer ID".
spctl -a -vv Surf.app

# Notarization ticket stapled to the app. You want "The validate action worked!"
xcrun stapler validate Surf.app

# Signature, hardened runtime ("flags=0x10000(runtime)") and entitlements.
codesign -dv --verbose=2 Surf.app
codesign -d --entitlements - Surf.app

# Both architectures. You want "x86_64 arm64".
lipo -archs Surf.app/Contents/MacOS/Surf
```

If notarization fails, electron-builder prints the submission ID. To see
Apple's reasons, run:

```sh
xcrun notarytool log <submission-id> --keychain-profile surf-notary
```

## Publishing on GitHub

With the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`):

```sh
git tag v1.1.0 && git push origin v1.1.0
gh release create v1.1.0 release/Surf-1.1.0-mac-universal.zip \
  --title "Surf 1.1.0" --notes "What's new: …"
```

Or, on github.com, open the repo → Releases → **Draft a new release**, pick or
create the tag, drag the zip into the assets box and publish.

Upload the zip electron-builder made. If you ever re-zip the app by hand,
use `ditto -c -k --keepParent Surf.app Surf.zip`, because plain `zip -r`
follows the framework symlinks and breaks the signature. The `.blockmap` file next to it is
only needed for auto-updates, so you can leave it out.
