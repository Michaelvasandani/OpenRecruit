# OpenTrade fork licensing and desktop-distribution constraints

_Resolves [OpenRecruit #7](https://github.com/Michaelvasandani/OpenRecruit/issues/7). Researched 2026-08-22 against fork/upstream commit [`9bbbcdf`](https://github.com/OpenTradeOSS/OpenTrade/commit/9bbbcdf51983f4a349fbc70158389e64650dd7c0) (OpenTrade v0.2.5). This is a technical reading of the cited materials, not legal advice._

## Decision

OpenRecruit can proceed as a **modified, locally installed macOS desktop distribution** of OpenTrade under the repository's Elastic License 2.0 (ELv2), subject to the release gates below. The license expressly grants rights to use, copy, distribute, make available, and prepare derivative works; it does not state a corresponding source-code disclosure requirement. It does require recipients of any part of the software to receive ELv2, requires prominent modification notices in modified copies, and prohibits removing or obscuring the licensor's license/copyright/other notices. It also prohibits offering the software as a hosted or managed service when users can access a substantial set of its functionality. ([fork LICENSE](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/LICENSE), [official ELv2 FAQ](https://www.elastic.co/licensing/elastic-license/faq))

Therefore the POC may remain a local desktop product, but a public build should not ship until it has its own OpenRecruit identity, signing credentials, release/update channel, and complete license/notice payload. A future hosted product needs a separate ELv2 review before implementation or release.

## Factual obligations and constraints

### 1. Inherited OpenTrade code

The fork and upstream are currently at the same commit and both declare `Elastic-2.0` in their root and app package metadata. The repository `LICENSE` is the official ELv2 text, while `NOTICE` identifies “OpenTrade,” attributes copyright to the OpenTrade contributors, points recipients to ELv2, names shadcn/ui and Radix UI, and records third-party trademark disclaimers. ([root package metadata](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/package.json), [app package metadata](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/app/package.json), [NOTICE](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/NOTICE), [upstream repository](https://github.com/OpenTradeOSS/OpenTrade))

ELv2's text establishes these conditions:

- Every recipient of any part of the software must also receive ELv2's terms.
- Modified copies must carry prominent notices that the software was modified.
- Licensor licensing, copyright, and other notices may not be altered, removed, or obscured.
- License-key functionality may not be moved, changed, disabled, or circumvented, and protected functionality may not be removed or obscured. No license-key mechanism was found in this checkout, but this condition remains applicable if one is introduced upstream.
- A third party may not be given the software as a hosted or managed service when that service exposes any substantial set of the software's features or functionality.
- Trademark rights are not granted by ELv2; trademark use remains subject to applicable law.
- Noncompliant use is unlicensed and triggers ELv2's termination/cure terms.

These are direct requirements of the [fork's ELv2 text](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/LICENSE). Elastic's [official FAQ](https://www.elastic.co/licensing/elastic-license/faq) confirms that modification and redistribution are intended to be allowed subject to the three principal limitations, and says the notice restriction is intended to cover license/copyright/trademark notice, including in-product names and logos.

### 2. Third-party software

The exact dependency graph is pinned in [`bun.lock`](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/bun.lock). The direct runtime dependency manifests published to the npm registry report permissive licenses: MIT for most direct dependencies, Apache-2.0 for `class-variance-authority` and `drizzle-orm`, and ISC for `lucide-react`. Electron 40.8.5 and electron-updater 6.6.2 report MIT. These metadata facts can be checked in the registry's authoritative package records (for example [Electron 40.8.5](https://registry.npmjs.org/electron/40.8.5), [electron-updater 6.6.2](https://registry.npmjs.org/electron-updater/6.6.2), [drizzle-orm 0.45.2](https://registry.npmjs.org/drizzle-orm/0.45.2), and [lucide-react 0.469.0](https://registry.npmjs.org/lucide-react/0.469.0)).

The lockfile-wide metadata audit also found Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, BlueOak-1.0.0, 0BSD, Python-2.0, CC-BY-4.0, MPL-2.0, and WTFPL/WTFPL-or-ISC entries in addition to MIT. That graph includes build/dev and platform-optional packages, so it does **not** by itself prove which components reach a DMG. Notably, the MPL-2.0 entries are Lightning CSS packages in the build graph. The existing `NOTICE` is not a complete, artifact-derived inventory; it explicitly defers unnamed dependencies to their npm licenses. ([NOTICE](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/NOTICE), [lockfile](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/bun.lock))

Electron itself is MIT-licensed and requires its copyright and permission notice to accompany copies or substantial portions. Electron embeds Chromium and Node.js into the distributed binary, so its bundled third-party license materials must remain in the packaged application. ([Electron LICENSE](https://github.com/electron/electron/blob/main/LICENSE), [Electron architecture/distribution description](https://www.electronjs.org/docs/latest/tutorial/distribution-overview))

**Release requirement:** generate the dependency/license inventory from the actual unpacked signed application, preserve Electron's `LICENSE` and `LICENSES.chromium.html`, and include all required copyright/license/notice texts in an accessible third-party-notices artifact. Re-run that check for every dependency or Electron upgrade. This is more reliable than treating npm's SPDX field alone as satisfaction of each license's notice terms.

### 3. Product identity and trademarks

The current build still identifies itself as OpenTrade: `productName: OpenTrade`, app ID `ai.exla.opentrade`, upstream homepage/author metadata, OpenTrade DMG title, and many visible strings/assets. The updater is explicitly configured to publish to and read from `OpenTradeOSS/OpenTrade`. ([package metadata](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/app/package.json), [electron-builder configuration](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/app/electron-builder.yml), [updater implementation](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/app/src/main/updater.ts))

ELv2 supplies no trademark license. The existing `NOTICE` says third-party marks belong to their owners, while the upstream README identifies OpenTrade as built by Exla Corp. ([LICENSE](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/LICENSE), [NOTICE](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/NOTICE), [README](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/README.md))

**Release requirement:** adopt OpenRecruit product naming, iconography, descriptions, URLs, bundle ID, process/menu labels, and release filenames. Preserve upstream attribution and ELv2 notices in `LICENSE`, `NOTICE`, and an About/Legal surface, and add a prominent statement such as “OpenRecruit is a modified distribution of OpenTrade; it is not affiliated with or endorsed by OpenTrade/Exla Corp.” Do not imply upstream sponsorship. Counsel should approve the precise treatment of inherited OpenTrade names/logos because ELv2's notice restriction and trademark law are distinct constraints.

### 4. macOS signing and notarization

The repository produces an arm64 DMG and ZIP, enables hardened runtime and notarization, and expects an Apple Developer ID certificate plus Apple credentials in CI. Its workflow also has an ad-hoc fallback. ([builder configuration](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/app/electron-builder.yml), [release workflow](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/.github/workflows/release-desktop.yml))

For direct distribution outside the Mac App Store, Apple says a Developer ID certificate is issued to Apple Developer Program members and is used so Gatekeeper can verify developer identity and tamper resistance. Apple requires Developer ID-distributed software built after June 1, 2019 to be notarized and specifies a Developer ID certificate, hardened runtime, secure timestamp, and valid signatures for shipped executables. ([Apple Developer ID](https://developer.apple.com/support/developer-id/), [Apple notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution))

The existing app ID belongs to the upstream identity. Apple defines `CFBundleIdentifier` as the unique system identity of an app and notes that it participates in signature validation. ([Apple bundle identifier reference](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleidentifier))

**Release requirement:** register and use a new reverse-DNS OpenRecruit bundle ID under the distributor's control; use the distributor's own Apple Developer membership, Developer ID Application certificate, and notarization credentials; verify all helpers/native modules are signed with only the entitlements actually required; and make signed/notarized artifacts the normal public channel. An ad-hoc artifact may be useful for internal testing, but Electron documents that unsigned distribution produces operating-system security friction, and electron-builder says macOS auto-update requires code signing. ([Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing), [electron-builder auto-update](https://www.electron.build/docs/features/auto-update/))

### 5. Releases and auto-update

The current builder configuration bakes `OpenTradeOSS/OpenTrade` into the packaged `app-update.yml`; the app checks that feed on boot and every four hours, and the release workflow publishes the ZIP, DMG, blockmaps, and `latest-mac.yml` with GitHub credentials. ([builder configuration](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/app/electron-builder.yml), [updater implementation](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/app/src/main/updater.ts), [release workflow](https://github.com/Michaelvasandani/OpenRecruit/blob/9bbbcdf51983f4a349fbc70158389e64650dd7c0/.github/workflows/release-desktop.yml))

electron-builder documents that the first publish provider becomes the default update server, macOS updates require signing, and the ZIP plus update metadata are required for the macOS updater. ([publish configuration](https://www.electron.build/publish/), [auto-update](https://www.electron.build/docs/features/auto-update/))

**Release requirement:** point `publish.owner`/`repo`, homepage/repository metadata, workflow permissions, and updater branding to an OpenRecruit-controlled repository/channel before packaging. Publish an OpenRecruit-signed ZIP, blockmap, and `latest-mac.yml` together with the DMG. Never ship a fork build that continues to consume upstream OpenTrade updates: at best it will fail signature/product expectations; at worst it abandons control of what the fork asks its users to install.

## Interpretation for the POC

The following are project interpretations, not statements from the licensors:

1. A downloadable, user-operated OpenRecruit app is within the ordinary modification/redistribution permission described by ELv2, provided the obligations above are met.
2. The safest branding posture is a distinct OpenRecruit identity with clear historical attribution, rather than presenting the fork as OpenTrade or erasing upstream provenance.
3. ELv2 does not make the POC's source publication a release condition in its text. Keeping source and corresponding release tags public is nevertheless useful for provenance and auditability.
4. Local-only operation should remain an explicit POC boundary. A hosted control plane that merely supports unrelated features may be distinguishable from hosting OpenTrade-derived functionality, but exposing a substantial set of the fork's agent-control/recruiting functionality as a managed service could trigger the ELv2 prohibition.
5. Passing an npm-license scan is not enough. Compliance must be verified against what the final `.app` and DMG actually contain.

## Public-release checklist

- [ ] Keep the upstream ELv2 text with source and binaries; do not replace or obscure it.
- [ ] Retain upstream copyright/license attribution and add a prominent modified-distribution notice in the repository, shipped legal materials, and About/Legal UI.
- [ ] Rebrand all product-facing identity to OpenRecruit while retaining non-confusing provenance.
- [ ] Replace `ai.exla.opentrade` with a distributor-controlled bundle ID.
- [ ] Replace upstream homepage, repository, release publisher, and update-feed coordinates.
- [ ] Establish an OpenRecruit version/tag lineage and publish DMG + signed ZIP + blockmap + `latest-mac.yml` atomically.
- [ ] Sign with the distributor's Developer ID, enable hardened runtime, notarize, staple/verify where applicable, and test Gatekeeper on a clean Mac.
- [ ] Produce a shipped-artifact software bill of materials and third-party-notices bundle; verify Electron/Chromium notices survive packaging.
- [ ] Review icons, screenshots, templates, and other inherited assets for trademark/attribution issues.
- [ ] Keep hosted/managed delivery outside the POC until counsel reviews the concrete architecture against ELv2.

## Questions requiring counsel

1. Does the proposed rebranding treatment—removing OpenTrade from the product identity while retaining it in prominent provenance/legal notices—satisfy ELv2's ban on altering/removing/obscuring notices, particularly in light of Elastic's FAQ discussion of in-product names and logos?
2. Should original OpenRecruit contributions carry an additional license notice, and if so how should it be expressed without purporting to sublicense or relicense the inherited ELv2 work?
3. Do the inherited OpenTrade name, logos, screenshots, icons, or other brand assets require permission beyond ELv2, or should any be replaced before even a public POC release?
4. For any later hosted sync, remote Scout execution, team workspace, or recruiter service, does the concrete feature/API boundary provide third parties access to a “substantial set” of the ELv2 software's functionality?
5. After producing a signed release candidate, are the assembled third-party notices and any source/attribution steps sufficient for every component actually shipped—especially Electron/Chromium materials and any MPL-2.0 code found in the final artifact?

## Newly surfaced engineering questions

- Who owns the OpenRecruit reverse-DNS namespace, Apple Developer team, signing certificate lifecycle, and GitHub release repository?
- Should the POC disable updater checks until an independently signed OpenRecruit update channel exists?
- What build-time process will generate and verify the artifact-derived SBOM/license bundle on every release?
- Which current hardened-runtime exceptions (`allow-unsigned-executable-memory`, disabled library validation, inherited entitlements) remain necessary after trading integrations are removed?
- The workflow comments refer to `docs/PACKAGING.md`, but that file is absent at the researched commit. Where will the new signing, notarization, credential-rotation, and recovery runbook live?
