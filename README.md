# EasyField

[![CI](https://github.com/danik9444/EasyField/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/danik9444/EasyField/actions/workflows/ci.yml)
[Releases](https://github.com/danik9444/EasyField/releases) · [Release process](docs/RELEASING.md)

EasyField is a compact AI creation panel for DaVinci Resolve. It combines live
Kie.ai generation with a local Resolve bridge that can grab timeline media and
place generated image, video, and audio results back on the current timeline.

## Current status

The catalog contains **20 tools across 5 categories**. Every card now opens a
complete, auto-saved workspace with recipes, source selection, validated-model
browsing, privacy/cost preflight and a review state. The established execution
flows remain live: **Create Image, Edit Image, Create Video, Edit Video,
Animations, Create Music, Voice Over, and local librosa Beat Detection**.

The remaining newer workflows currently stop at an honest preflight when their
provider or Resolve execution adapter is not installed; they never simulate a
successful paid run. **SuperBrain now calls a real Kie chat model and validates
its typed plan**, but applying a multi-tool plan remains blocked until every
step exposes cost, privacy, provider, placement and rollback contracts.

The Resolve-hosted main process uses SQLite for settings, drafts, job ledgers
and artifact metadata. Accepted provider task IDs recover after restart, and
remote generation results are materialized into the local artifact store as
soon as the host can download them.

## Requirements

- macOS 15+ and DaVinci Resolve Studio 21.0.2+ installed directly from
  Blackmagic Design. EasyField loads `WorkflowIntegration.node` from Resolve's
  official SDK SamplePlugin installation; the Blackmagic binary is neither
  tracked by this repository nor redistributed in EasyField releases.
- Node.js 22.18+ and npm.
- `ffmpeg` and `ffprobe` on `PATH` for timeline grabs, media conversion, and
  animation export. With Homebrew: `brew install ffmpeg`.
- Python 3 with the project-managed librosa environment for Beat Detection. See
  [`plugin/python/README.md`](plugin/python/README.md); packages are not installed
  globally.
- A funded Kie.ai API key for live AI generation.

## Development

```sh
npm ci
npm run dev
```

Open <http://localhost:5173>. This is enough for UI and Kie.ai development; the
Resolve badge remains offline unless the plugin bridge is also running.

Browser development exercises the UI and local development proxies. To exercise
the main/preload boundary without Resolve, leave Vite running and start the
development-only Electron harness in a second terminal:

```sh
npm run plugin:dev
```

Resolve supplies the production Electron host. The npm Electron dependency is
used only by this local harness and is not copied into the plugin, update
archive, or installer.

Useful checks:

```sh
npm test              # all contract and bridge tests
npm run build         # typecheck + standalone UI build
npm run plugin:build  # typecheck + plugin UI build
npm run verify:source # plugin UI first, then all source/contract tests
npm run verify        # clean-checkout tests + both builds + release-tree checks
```

The standalone `dist/` build contains only the UI. Live Kie.ai and Resolve calls
must be served through the Vite development proxies or the plugin's embedded
server.

## Developer install in DaVinci Resolve

```sh
npm ci
npm run plugin:install
```

Do not copy `WorkflowIntegration.node` into this repository. The install
preflight verifies the regular, signed, universal module installed by
Blackmagic at its official SamplePlugin path before staging EasyField.

The install script builds a checksummed local release, publishes it under
`~/Library/Application Support/EasyField/Updates`, and atomically swaps the
manifest-listed integration files into:

```text
/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/com.easyfield.panel
```

macOS will request administrator permission. Restart Resolve, open a project and
timeline, then choose **Workspace → Workflow Integrations → EasyField**.

The managed librosa runtime is versioned separately under
`~/Library/Application Support/EasyField/runtime/python`; the 300+ MB virtual
environment is not duplicated inside Resolve's root-owned plugin directory.

End users install a signed and notarized macOS PKG produced by the protected
GitHub Release workflow. The PKG validates macOS and Resolve compatibility,
requires Resolve to be closed, verifies the complete payload, and preserves the
previous installation for recovery. See [`docs/RELEASING.md`](docs/RELEASING.md)
for repository setup, signing, notarization and the no-publish local dry run.
Published installers are available only from the
[official EasyField releases](https://github.com/danik9444/EasyField/releases/latest).

## In-app updates

`npm run plugin:build` also publishes the newest local build to Application
Support. The installed panel checks that channel after launch and every five
minutes. A newer version or newer build ID opens an Update dialog; the same
action is always available in **Settings → Resolve → EasyField updates**.

Update installation accepts no renderer-supplied path or URL. Main stages only
manifest-listed files, and the administrator side rechecks the exact file set
and every SHA-256 before swapping directories. The previous installation stays
in `/Library/Application Support/EasyField/Recovery` for recovery. Restart
Resolve after an update so its Electron host loads the new integration.

Local developer installs use the local channel described above. Production PKG
installs contain a fixed public GitHub Release feed and an Ed25519 public key.
The production updater accepts only that pinned repository, verifies the signed
release envelope, archive size and SHA-256, then verifies the exact manifest
tree before requesting the same administrator-approved atomic swap. A published
version is immutable and an update always requires a higher SemVer.

## API key and local security

Enter the Kie.ai key from Settings or the credits badge on Home. In the Electron
plugin it is encrypted with Electron `safeStorage` (macOS Keychain-backed). The
renderer receives only an internal proxy token; the Kie proxy adds the real key
inside the main process. Browser development keeps the key in `sessionStorage`
only and must not be treated as a production credential store.

The Resolve bridge listens only on `127.0.0.1` and protects privileged endpoints
with a per-process secret plus origin checks. Keep port `18832` local and do not
remove those checks: the bridge can read timeline media and mutate a project.

## Troubleshooting

- **Resolve stays offline:** launch EasyField from Resolve rather than a normal
  browser, confirm a project and timeline are open, and restart Resolve after an
  install. A native-module error means Resolve's official SamplePlugin module is
  missing, has an unexpected signature/architecture, or does not match the
  installed Resolve version; reinstall Resolve from Blackmagic Design.
- **Plugin is missing from the menu:** rerun `npm run plugin:install`, confirm the
  destination above exists, and restart Resolve Studio.
- **Frame grab, conversion, or render fails:** run `ffmpeg -version` and
  `ffprobe -version`. Install or expose both binaries to Resolve's environment.
- **Beat Detection reports that librosa is missing:** follow
  `plugin/python/README.md` to create `plugin/python/.venv`. The panel reports the
  missing pack safely and never modifies the timeline while it is unavailable.
- **A recovered job says it needs attention:** reconnect Kie.ai, then reopen the
  Activity panel. Accepted provider task IDs are retained in SQLite.
- **Kie.ai returns an auth or credit error:** reconnect the key from Home and
  check its balance. Run the app through Vite or the embedded plugin server;
  opening `dist/index.html` directly bypasses the required proxies.
- **Port 18832 is already in use:** close stale EasyField/Electron processes and
  relaunch the panel.

## License and third-party software

EasyField is source-visible but **not open source**. The project is published
under an all-rights-reserved proprietary notice; see [`LICENSE`](LICENSE).
Runtime dependency and vendor boundaries are recorded in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), and every release also
produces an SPDX SBOM. Report vulnerabilities privately as described in
[`SECURITY.md`](SECURITY.md).
