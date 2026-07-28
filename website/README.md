# EasyField website

Standalone bilingual product site for EasyField. It is intentionally isolated from the DaVinci Resolve plugin app in the repository root.

## Development

```sh
pnpm install
pnpm dev
```

## Production build

```sh
pnpm build
pnpm preview
```

## Single-file artifact

```sh
pnpm bundle
```

This creates `bundle.html`, including the application, styles, brand artwork and local font files. It can be opened directly without a development server. When it is served over HTTP, the live release check is enabled; when opened from disk, download actions safely link to the GitHub Releases page.

The site checks the official GitHub Releases endpoint in the browser. If the expected `EasyField-VERSION-macOS-universal.pkg` asset exists, download buttons point to it. If no verified public installer exists, they link to the release status without claiming that a download is available.

To bypass the runtime check for a deployment, copy `.env.example` to `.env.production` and set `VITE_EASYFIELD_DOWNLOAD_URL` to the verified installer URL.

## Product facts used by the site

- 20 tools across Footage, Image, Video, Motion and Audio
- macOS 15+
- DaVinci Resolve Studio 21.0.2+
- Apple silicon and Intel universal installer target
- version line 1.2.x

Pricing is clearly labeled as a launch preview while checkout and the public release remain unavailable.
