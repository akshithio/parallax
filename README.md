# <img src="./web/public/logo-light.svg#gh-dark-mode-only" alt="parallax logo" width="30" height="30" align="center" /><img src="./web/public/logo-dark.svg#gh-light-mode-only" alt="parallax logo" width="30" height="30" align="center" /> parallax

Parallax is a macOS workspace for working through repositories with the ChatGPT
account you are already signed in to. A Chrome extension you load yourself drives
your signed-in tab, so there is no API key to paste and no second account to
create.

<p>
  <a href="https://parallax.akshith.io">Download for macOS</a>
</p>

This repository is a pnpm monorepo with three packages:

- `app` — Electron and Next.js desktop application
- `ext` — Chrome extension that connects ChatGPT to the desktop app
- `web` — download website deployed at `https://parallax.akshith.io`

The first three hops stay on your Mac. Only the last one is a network session,
and it is the ChatGPT tab you already have open. Parallax stores no model
credentials of its own.

```mermaid
flowchart LR
  repo["your repository"] --> app["Parallax desktop"]
  app -->|"local WebSocket"| bridge["Chrome bridge"]
  bridge -->|"your signed-in tab"| chatgpt["chatgpt.com"]
```

## Licence

Parallax is MIT licensed. See [LICENSE](LICENSE).

## Credits

Parallax's desktop app is an adaptation of the [T3 Code](https://github.com/pingdotgg/t3code)
UI layer, which is MIT licensed and copyright T3 Tools Inc. The workspace layout,
message log, composer, and surrounding chrome started there; the agent protocol,
browser bridge, and release pipeline are Parallax's own.

The upstream licence is reproduced in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Icons

The app, extension, and site marks are generated from the SVG sources in
`app/build`. After editing one, regenerate every raster:

```bash
pnpm icons
```

That writes the macOS `.icns`, the light and dark dock tiles, and the four
extension PNGs.

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

After the first Chrome Web Store release is published manually, the same tag can
also upload the new extension package, submit it for review, and publish it after
approval. Enable that step with the `CWS_AUTO_PUBLISH` repository variable and set
the publisher and item IDs in `CWS_PUBLISHER_ID` and `CWS_EXTENSION_ID`. The OAuth
client ID, client secret, and refresh token belong in repository secrets named
`CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, and `CWS_REFRESH_TOKEN`.

Chrome Web Store copy, privacy declarations, test instructions, and distribution
choices live in `ext/store/listing.md`. The public privacy policy lives at
`https://parallax.akshith.io/privacy`.

The website resolves its download buttons against the newest published GitHub
Release, so releases do not require hardcoded website changes.
