# macOS code signing and notarization

Status: **not started.** Releases are currently unsigned (see `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` in
`.github/workflows/release.yml`), and the release notes tell users to clear the quarantine attribute with
`xattr`.

Decision: enroll with a **personal (individual)** Apple Developer account when ready.

## Why it's needed

Unsigned apps on Apple silicon are reported as "damaged". Since macOS 15 the Control-click bypass for
Gatekeeper is gone, so a build that is signed but not notarized is still blocked. Both signing and
notarization are required for a warning-free install.

## 1. Account and fees

- **Apple Developer Program: US$99 per year**, billed in local currency (about 99 € in the eurozone).
  Fee waivers exist only for nonprofits, education and government, not for individuals or open source.
- Needs an **Apple Account with two-factor authentication**, using your legal name and address.
- **Individual enrollment** (chosen): identity is verified in the Apple Developer app on an iPhone,
  iPad or Mac, which may involve scanning an ID document. Usually approved within a day or two. Your
  **legal name** appears as the developer in the signature and in Gatekeeper dialogs.
- (For reference, organization enrollment needs a registered legal entity, a free D-U-N-S number,
  which can take up to about two weeks, a website on the company's domain, and authority to sign for the
  company. Trade names aren't accepted, and a French micro-entreprise enrolls as an individual.)
- **Paperwork:** accepting the Apple Developer Program License Agreement. Free distribution outside the
  App Store needs no tax, banking or EU trader-status paperwork.

## 2. Certificates and credentials (one-time)

- **Developer ID Application** certificate: the one for apps distributed outside the App Store. Only the
  Account Holder can create it. No Mac is needed: generate the certificate signing request with
  `openssl`, then export the certificate and key as a password-protected `.p12`.
  - Valid 5 years. Builds signed and notarized before it expires keep working afterwards.
  - Apple limits how many can be created, so back up the `.p12`.
- No "Developer ID Installer" certificate is needed: it is only for `.pkg` installers, and we ship a
  `.dmg`.
- **App Store Connect API key** for notarization: a `.p8` file plus a Key ID and an Issuer ID. An Apple
  ID with an app-specific password also works, but the API key is better suited to CI.

## 3. Changes in this repo

- **`electron-builder.yml`, under `mac:`**
  - `hardenedRuntime: true` (required for notarization) and `notarize: true`.
  - An entitlements file. Electron needs at least `com.apple.security.cs.allow-jit`.
- **Bundled native code must be signed too:** sharp/libvips, better-sqlite3, @parcel/watcher, and any
  ffmpeg/ffprobe binaries in `resources/bin/mac`. electron-builder signs the Mach-O files it finds in
  the bundle. Third-party ffmpeg builds are the most likely cause of notarization failures, so check
  them first.
- **`.github/workflows/release.yml`**
  - Remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`.
  - Add these GitHub secrets to the macOS job:
    - `CSC_LINK`: the `.p12`, base64-encoded
    - `CSC_KEY_PASSWORD`
    - `APPLE_API_KEY`: the `.p8`
    - `APPLE_API_KEY_ID`
    - `APPLE_API_ISSUER`
  - Remove the `xattr` workaround from the release notes template.
- Notarization adds a few minutes to each macOS build while Apple scans it.

## Cost and time

- US$99 per year.
- Enrollment as an individual: about a day or two.
- Setup through the first successful notarized build: about half a day.
