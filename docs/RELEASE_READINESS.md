# EasyField 1.2.0 release readiness

**Assessment date:** 2026-07-14
**Target:** macOS 15+, Intel and Apple silicon, DaVinci Resolve Studio 21.0.2+
**Decision:** **NO-GO for a public final release; GO as a signed bootstrap beta after the external release prerequisites below are supplied.**

## Verified in this candidate

- [x] Version `1.2.0` is synchronized across the root package, lockfile, plugin package and Resolve manifest.
- [x] Full automated suite passes: 404 tests, 0 failures.
- [x] Production TypeScript and both Vite builds pass.
- [x] Plugin manifest verifies its exact EasyField file tree and explicitly excludes Blackmagic's native Resolve module. The installer validates Resolve's official signed, universal SamplePlugin copy in place.
- [x] Production dependency audit reports 0 known vulnerabilities.
- [x] SPDX 2.3 SBOM includes every direct production dependency and excludes development-only Electron/Vite.
- [x] Signed update feed is accepted by the production updater and rejects tampering.
- [x] Two update builds from the same source are byte-for-byte reproducible.
- [x] Unsigned QA PKG expands successfully and verifies 50/50 authenticated payload files with no symlinks.
- [x] Installer and updater both preserve the previous plugin for rollback and fail closed on checksum, signature, compatibility or tree mismatch.
- [x] All 20 tool screens pass responsive UI smoke at compact and expanded widths without horizontal overflow.
- [x] The installed 1.1.0 panel opens inside the real Resolve Workflow Integrations host and connects to the active project/timeline.
- [x] Live Kie generation exercised accepted-task persistence, timeout recovery without resubmission, and an honest terminal upstream failure.
- [x] A real provider rejection exposed and fixed OmniHuman's 300-character prompt boundary before release.

## Public bootstrap release prerequisites

- [ ] Confirm [`danik9444/EasyField`](https://github.com/danik9444/EasyField) is **public**, configure it as `origin`, and protect `main`. The updater intentionally stores no GitHub credential and can only read public release assets.
- [ ] Add a protected `release` environment and the secrets listed in `docs/RELEASING.md`.
- [ ] Supply a valid Apple **Developer ID Installer** identity and App Store Connect notarization credentials.
- [ ] Produce the PKG in GitHub Actions, notarize it, staple the ticket, and pass `pkgutil`, `spctl`, checksum and provenance checks.
- [x] Add an explicit proprietary project license, third-party notice index and security-reporting policy.
- [ ] Obtain written release approval for Remotion eligibility/company licensing, GSAP terms, bundled fonts and every shipped visual/media asset. The notice index is not a substitute for this review.
- [ ] Run the on-device Resolve matrix on at least one Intel Mac and one Apple-silicon Mac before promoting the beta.

## Final-product blockers

- [ ] Bundle or publish checksum-pinned universal runtime packs for FFmpeg/ffprobe, librosa/Python and whisper.cpp. The local development runtimes are not portable release payloads.
- [ ] Complete and test the execution adapters for the tools that currently stop at an honest preflight; do not advertise them as completed actions until Source → Result → Library → Resolve Apply succeeds.
- [ ] Enable SuperBrain execution only after every planned action exposes validated cost, privacy, placement and rollback contracts.
- [ ] Complete the Resolve device matrix for exact trims, mixed timeline/source FPS, linked A/V, locked/disabled tracks, alpha, HDR/Rec.709, restart and rollback behavior.
- [x] Keep the standalone Electron harness current and covered by the full CI dependency audit. It is development-only: Resolve supplies the production host and no Electron runtime is copied into an EasyField release.

## Release and rollback gates

Do not publish if any of the following occurs:

- the protected `release` environment variable `EASYFIELD_RELEASE_ENABLED` is not exactly `true`;
- any automated test, production build, artifact-tree verification, signature, notarization or Gatekeeper check fails;
- the tag version differs from any version source or a release already exists for that version;
- the update archive/feed is not reproducible from the tagged commit;
- an accepted paid provider task can be lost after restart;
- a Resolve operation changes media outside the confirmed interval or cannot prove rollback;
- the signing key, Apple credential or release environment may have been exposed.

Rollback is a fix-forward release with a higher SemVer. The most recent installed plugin is retained under `/Library/Application Support/EasyField/Recovery`; released assets are immutable and are never replaced in place.
