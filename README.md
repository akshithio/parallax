# Nix

Nix is a macOS workspace for working through repositories with ChatGPT. This
repository is a pnpm monorepo containing the desktop application, browser bridge,
and product website.

## Packages

- `nix-desktop` — Electron and Next.js desktop application
- `nix-extension` — Chrome extension that connects ChatGPT to the desktop app
- `nix-website` — download website deployed on Vercel

## Development

Install every workspace package:

```bash
pnpm install
```

Start the desktop application:

```bash
pnpm dev
```

Start the website:

```bash
pnpm dev:website
```

Run every package's tests and production checks:

```bash
pnpm verify
```

## Releases

Pushing a version tag such as `v0.2.0` runs the release workflow. It verifies the
workspace, builds the signed and notarized universal macOS application, packages
the Chrome extension, and publishes the update metadata and downloads to a GitHub
Release.

The website resolves its download buttons against the newest published GitHub
Release, so releases do not require hardcoded website changes.
