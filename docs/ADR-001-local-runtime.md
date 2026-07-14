# ADR-001: Local-first Electron runtime

**Status:** Accepted
**Date:** 2026-07-10

## Context

EasyField controls a privileged DaVinci Resolve bridge, holds paid-provider
credentials, tracks asynchronous jobs and must preserve expiring media results.
The renderer cannot be the source of truth for any of those responsibilities.

## Decision

- Electron Main owns credentials, durable state, artifact downloads and window
  control behind a narrow preload/IPC surface.
- SQLite (`node:sqlite`, WAL mode) stores namespaced settings, drafts, jobs,
  artifacts, recipes, transcripts and project manifests. Media bytes live in a
  managed filesystem store.
- Kie credentials use `safeStorage`. Renderer requests carry a non-secret proxy
  token and Main injects the decrypted credential upstream.
- Main injects the per-process Resolve bridge token through Electron's session
  request boundary; renderer JavaScript never receives the token.
- The renderer may use localStorage/IndexedDB only as a browser-development
  fallback and migration source, never as the production authority.
- Model and tool behavior is capability-driven through typed registries.
- HyperFrames source is constrained and deterministic. GSAP is bundled locally,
  generated frames run with `sandbox="allow-scripts"`, and seek control uses a
  small postMessage protocol.

## Consequences

- Paid jobs and result metadata survive application restarts.
- Provider URLs can be downloaded and checksummed without browser CORS limits.
- The production renderer no longer receives the real Kie key.
- Browser-only development cannot exercise Keychain, SQLite, artifact ingestion
  or Electron window resizing; those require `npm run plugin:dev`.
- The loopback HTTP bridge remains a compatibility surface until all Resolve
  calls move behind typed IPC, but its bearer token is Main-only.

## Follow-up

- Add versioned relational tables when project manifests and transcript editing
  require indexed queries beyond the current namespaced JSON records.
- Move every Resolve operation behind a typed snapshot/apply/undo IPC contract.
- Add signed update, notarization and packaged FFmpeg verification before beta.
