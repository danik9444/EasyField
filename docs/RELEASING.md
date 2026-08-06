# Releasing EasyField

EasyField uses a notarized macOS PKG for first installation and a signed GitHub Release feed for later in-app updates. The installed plugin is root-owned and contains only a fixed GitHub feed URL plus an Ed25519 public key. The private update key never ships with the product.

## Supported release target

- macOS 15.0.0 or newer, Intel and Apple silicon.
- DaVinci Resolve 21.0.2 or newer, installed from Blackmagic Design. The Mac App Store build is rejected because it does not support Workflow Integration plugins.
- Resolve must be closed during initial PKG installation and during an in-app update.
- The first installer and every update are system-wide. The target is `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/com.easyfield.panel`.

The checked-in runtime catalog is deliberately marked unavailable. Production
update and PKG builders fail closed until FFmpeg/ffprobe, the librosa/Python
environment and whisper.cpp are supplied for both architectures as exact,
checksum-pinned, non-symlink payload trees. Every Mach-O file must match its
declared architecture and carry a valid non-ad-hoc signature. The development
`.venv`, Homebrew tools and global `PATH` are never accepted as release proof.
The runtime payloads must not be advertised as bundled/offline until this gate
and the real-device matrix pass.

CI audits the full dependency graph, including the development-only Electron
harness; the Release workflow separately blocks on the shipped dependency
audit. Resolve supplies the production Electron host and owns its native
`WorkflowIntegration.node`. EasyField redistributes neither the Electron
runtime nor Blackmagic's native module. Installation verifies the official
SamplePlugin copy in place.

## One-time repository setup

1. Keep [`danik9444/EasyField`](https://github.com/danik9444/EasyField) public and protect `main`. Require strict `verify` plus CodeQL analysis for Actions, JavaScript/TypeScript and Python before merge.
   The installed updater intentionally has no GitHub credential and accepts only unauthenticated HTTPS downloads from this pinned owner/repository. The protected Release workflow refuses to sign or publish from any other repository.
   Release tags must use the GitHub-verified signer identity
   `166756911+danik9444@users.noreply.github.com`; changing the approved signer
   requires a reviewed workflow change on protected `main`.
2. Enable GitHub immutable releases in repository settings. Never replace assets for a released version.
3. Create a protected GitHub Actions environment named `release` with required
   reviewers. Add an environment variable named `EASYFIELD_RELEASE_ENABLED`
   and leave it `false` by default. Set it to exactly `true` only after the
   readiness checklist, legal review and release approval are complete. The
   publishing job fails before its checkout or signing when the gate is not
   enabled.
4. Add these environment secrets:

   - `EASYFIELD_ACCOUNT_CONFIG_BASE64`: base64 of the complete production
     `plugin/account-config.json`. This file contains only the public Supabase
     URL/publishable key, enabled OAuth providers and checkout-host allowlist;
     never place a service-role key, merchant token or webhook secret in it.
   - `EASYFIELD_UPDATE_PRIVATE_KEY_BASE64`: base64 of the complete Ed25519 PKCS#8 private PEM.
   - `APPLE_INSTALLER_CERTIFICATE_BASE64`: base64 of the Developer ID Installer `.p12`.
   - `APPLE_INSTALLER_CERTIFICATE_PASSWORD`: password for that `.p12`.
   - `APPLE_INSTALLER_IDENTITY`: exact Keychain identity, normally `Developer ID Installer: Company Name (TEAMID)`.
   - `APPLE_NOTARY_KEY_BASE64`: base64 of the App Store Connect API `.p8` key.
   - `APPLE_NOTARY_KEY_ID` and `APPLE_NOTARY_ISSUER_ID`.

Generate the update publisher key once on an offline/trusted Mac:

```sh
npm run release:keygen -- --out-dir release/keys
base64 < release/keys/easyfield-update-private.pem | tr -d '\n'
```

Store the resulting private-key value only in the protected secret and an offline backup. Commit neither the key nor `release/`. Record the printed public-key fingerprint in the project password manager or release runbook.

Create `EASYFIELD_ACCOUNT_CONFIG_BASE64` only from a config that already
passes the local validator:

```sh
npm run release:validate-account
base64 < plugin/account-config.json | tr -d '\n'
```

Store the one-line result directly in the protected environment secret. The
Release workflow decodes it with restrictive permissions before the plugin
manifest is assembled, validates it without printing the key, and removes each
temporary copy in the job cleanup steps. Pull-request CI never receives or
reconstructs this production config.

5. Review [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) and record
   release approval. In particular, confirm EasyField's eligibility under the
   Remotion license or purchase the required company license. Verify GSAP terms,
   font notices and provenance/redistribution rights for every visual and media
   asset. A generated SBOM inventories packages but does not replace legal
   approval.

## Mandatory account deployment order

For a paid-account release, the server is deployed and proven before any
desktop artifact is signed. The order is mandatory:

1. Apply every migration through
   `20260715154941_creator_monthly_price_24.sql` to a disposable/staging
   Supabase environment and run executable database tests against the real
   PostgreSQL functions, triggers, RLS and grants. Reconcile any historical
   duplicate ambiguous checkout before applying the production migration.
2. Deploy Supabase Auth, the account and billing-webhook Edge Functions, the
   metered generation gateway, merchant adapter, no-payment reconciliation,
   scheduled grant/expiry workers and refund/dispute/chargeback handling.
3. Verify email/password recovery, Google and Apple OAuth, every advertised
   subscription/top-up SKU, Partner reversal, idempotent webhook retries,
   cancellation and crash recovery in the merchant sandbox. A successful
   checkout must be followed through credit reservation, generation,
   settlement and local artifact persistence.
4. Confirm the deployed service reports the required schema and operational
   readiness, then create and validate the public `plugin/account-config.json`.
   Upload only its base64 form to the protected
   `EASYFIELD_ACCOUNT_CONFIG_BASE64` secret.
5. Only after the server evidence and operational approvals are recorded may a
   reviewed change remove the fail-closed generation/Partner blockers. Enable
   the protected `EASYFIELD_RELEASE_ENABLED` gate for that release window,
   produce the desktop artifacts, run packaged Resolve smoke tests, and return
   the gate to `false` afterward.

The repository is deliberately at an earlier stage today: customer generation
and Partner checkout remain explicitly blocked. Pull-request CI therefore runs
`npm run release:validate-account -- --ci-structure-test`. That mode only
proves that no live config is present, both paid paths remain disabled, and the
two production builders still invoke the real release gate. CI then exercises
the update/reproducibility/PKG path with
`EASYFIELD_ACCOUNT_STRUCTURE_TEST=1`. The builders accept that value only in
the non-tag GitHub workflow named `CI`, while the live account config is absent
and both paid readiness flags remain explicitly false. The resulting update
archive is clearly named `ci-structure`, uses a throwaway test signing key, and
the PKG is clearly named `ci-structure-unsigned`; artifact inspection proves
that neither contains `account-config.json`. These artifacts cannot reach an
account service under their packaged defaults, never exercise Checkout, and
must not be distributed. `release.yml` never sets this mode and always uses the
real production gate. When the readiness blockers are intentionally removed,
the CI-only mode fails and the workflow must be replaced with staging-backed
database and Edge integration while retaining the same artifact checks.

## Prepare a version

Use a stable `MAJOR.MINOR.PATCH` SemVer for public releases. The updater is pinned to the stable GitHub `latest` feed; prereleases require a future, separate signed channel and must not be published by this workflow. All five version sources must agree: root package, lockfile root entries, plugin package, and Resolve XML manifest.

```sh
npm run release:version -- set 1.2.0
npm run release:version -- check 1.2.0
npm ci
npm run verify:source
npm run verify
npm run release:validate-account
npm run release:validate-runtimes
npm run release:sbom -- --out release/output/easyfield-1.2.0.spdx.json
SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)" npm run plugin:assemble
```

`release:validate-account` is expected to fail while either paid-path blocker
remains. Do not weaken or bypass it to obtain a package; finish the server-side
prerequisites instead.

`release:validate-runtimes` is also expected to fail while
`plugin/runtime-packs.json` is marked unavailable. Complete it only with
approved binaries and a written approval record under
`docs/release-approvals/`; do not invent download locations, versions or
checksums. Materialize the payload before `plugin:assemble` so the signed plugin
manifest inventories every runtime byte. Each approved component must also
carry reviewed SPDX metadata; the release SBOM then records every component and
architecture as an explicit EasyField dependency. The exact preparation and
validation contract is documented in
[`RUNTIME_PACKAGING.md`](RUNTIME_PACKAGING.md).

Review the generated `plugin/update-manifest.json`. It must declare macOS 15.0.0, Resolve 21.0.2, both architectures, a canonical file list, and the expected build ID. Do not edit this file by hand.

Commit the version and product changes, merge through CI, then create one annotated, signed tag:

```sh
git tag -s v1.2.0 -m "EasyField 1.2.0"
git push origin v1.2.0
```

The tag starts the protected Release workflow. Before any dependency install or
signing, the workflow requires an annotated tag whose GitHub-verified signer is
allowlisted and whose commit is an ancestor of protected `main`. A read-only
job rebuilds and tests the panel, then uploads one immutable handoff whose
SHA-256 is checked against both the build output and GitHub's artifact digest.
A separate credentialed job reverifies the tag and handoff before it imports
signing material, signs `easyfield-update.json` with Ed25519, builds and signs
the PKG, submits it to Apple notarization, staples the ticket, verifies
Gatekeeper, creates checksums and provenance attestations, and finally publishes
a GitHub Release.

The signing and publishing job does nothing unless the protected `release`
environment variable `EASYFIELD_RELEASE_ENABLED` is exactly `true`. Return it
to `false` after the authorized release window. This operational gate
supplements—rather than replaces—required reviewers and immutable release
assets.

The feed is always:

```text
https://github.com/danik9444/EasyField/releases/latest/download/easyfield-update.json
```

The release must contain `easyfield-update.json`, `EasyField-VERSION-plugin.tar.gz`, `EasyField-VERSION-macOS-universal.pkg`, `SHA256SUMS`, the SPDX SBOM, the public-key material, and the notarization result. GitHub attests both the release artifacts and the installer/SBOM association.

## Local dry run

A local dry run does not install or publish anything:

```sh
npm run plugin:assemble
npm run release:keygen -- --out-dir release/test-keys
npm run release:update -- \
  --repo danik9444/EasyField \
  --private-key release/test-keys/easyfield-update-private.pem \
  --out-dir release/test-output \
  --notes "Local release verification"
npm run release:pkg -- --unsigned --out-dir release/test-output
```

The unsigned PKG is for structure/testing only and must never be distributed. The scripts do not invoke `installer`, copy into Resolve, create a tag, or contact GitHub.

## Installation and updates

Users download the notarized PKG for the first installation. Its preinstall checks the operating system, Resolve source/version, and that Resolve is closed. Its postinstall verifies every staged checksum, rejects links and special files, creates a root-owned next directory, verifies it again, moves the prior plugin to a temporary recovery location, and atomically swaps the new plugin into place. If verification or the swap fails, it restores the previous plugin. After final verification succeeds, the obsolete recovery copy is removed so old code and account configuration are not retained as a second unmanaged installation.

The PKG and update archive never contain `WorkflowIntegration.node`. At launch,
EasyField loads the regular file installed by Blackmagic at
`/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node`.
The installer rejects a missing module, symlink, invalid code signature,
unexpected Blackmagic identifier/team, or anything other than a universal
`arm64` + `x86_64` binary.

Subsequent updates are discovered inside EasyField. The updater accepts only the fixed GitHub owner/repository feed, verifies the Ed25519 signature over the canonical payload, verifies archive size/hash and every manifest file, and uses the same atomic/recovery approach. Restart Resolve after an update.

## Rollback and incident response

- Never mutate an existing release or rebuild the same version with different bytes. Fix forward with a higher SemVer.
- For a product regression, publish a new version containing the last known-good code. The updater intentionally does not offer downgrades.
- Installer/update rollback is transactional: a failure before final verification restores the prior tree automatically. After a verified success, rollback is a fix-forward release with a higher SemVer; no dormant prior plugin is retained on disk.
- If the Ed25519 private key may be exposed, immediately stop/pause releases and remove compromised release assets. The current updater pins the entire source descriptor and does not permit an in-app key or repository change. Rotate the key by producing a new notarized PKG with the new descriptor and require users to reinstall it. Never silently change the key in an existing GitHub asset.
- If an Apple certificate or notarization key is exposed, revoke it in Apple Developer/App Store Connect, replace the protected GitHub secret, and produce a new version.

Keep GitHub Actions logs, `notarization.json`, `SHA256SUMS`, the provenance attestation, release approvals, and the public-key fingerprint as the release audit record.
