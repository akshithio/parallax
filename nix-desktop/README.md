
# Nix Desktop

Nix Desktop is an Electron-based coding-agent interface that connects a local project workspace to ChatGPT through the Nix browser extension.

The desktop app manages projects, conversations, tool execution, permissions, file attachments, model selection, and the agent loop. The extension handles communication with ChatGPT in the browser.

## Architecture

Nix consists of two applications:

- `nix-desktop` — Electron and Next.js desktop interface
- `nix-extension` — Chrome extension that bridges ChatGPT to the desktop app

The communication flow is:

1. The user sends a message from the desktop app.
2. The Electron process sends it to the extension over a local WebSocket.
3. The extension submits the message through ChatGPT.
4. The extension captures the streamed response and returns it to the desktop app.
5. The desktop app parses any `‹nix:...›` tool actions.
6. Allowed actions run inside the selected project folder.
7. Tool results are sent back to ChatGPT until it produces a final prose response.

The local WebSocket server listens on port `8765`.

## Features

- Project folders with project-specific conversations
- Persistent conversation history
- Streaming assistant responses
- Read, list, search, run, and write agent tools
- Configurable tool permission levels
- File attachments and drag-and-drop uploads
- Dynamic ChatGPT model discovery
- Model and intelligence selection
- Built-in terminal drawer
- File and workspace side panel
- Open projects in VS Code, Cursor, Zed, IntelliJ IDEA, or Finder
- Conversation search, rename, and deletion
- Stop-generation support
- Automatic agent-loop execution with a safety limit

## Requirements

- macOS
- Node.js 18 or later
- pnpm 10
- Google Chrome
- The Nix Chrome extension installed and enabled
- An open, signed-in ChatGPT tab

Some editor integration is currently macOS-specific.

## Installation

Install the desktop dependencies:

```bash
cd nix-desktop
pnpm install
```

Install the browser extension:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the `nix-extension` directory.
5. Open ChatGPT in Chrome.
6. Confirm that the Nix extension is connected.

## Development

Start the desktop app:

```bash
pnpm run dev
```

This launches Electron, starts the Next.js development server on port `3000`, and opens the desktop interface.

The Electron main process starts the local WebSocket server on port `8765`. The browser extension connects to that server automatically.

## Scripts

```bash
pnpm run dev
```

Starts Electron and the Next.js development server.

```bash
pnpm start
```

Starts Electron.

```bash
pnpm run build
```

Builds the Next.js application.

```bash
pnpm test
```

Runs the complete test stack:

- Node protocol and transport tests
- React component tests
- Renderer and extension integration tests
- Playwright workflow tests in Chromium

The workflow test uses a deterministic local bridge. It does not require Chrome,
a ChatGPT account, or a live extension connection.

Run one layer directly with:

```bash
pnpm run test:node
pnpm run test:component
pnpm run test:integration
pnpm run test:workflow
```

```bash
pnpm run verify
```

Runs the complete test stack, TypeScript checking, and the production build. This
is the command enforced by the repository test workflow.

```bash
pnpm run export
```

Builds and exports the Next.js application.

```bash
pnpm run package:mac
```

Builds an unpublished macOS installer and update archive in `dist/`.

## Releases and automatic updates

Electron update feeds use GitHub **Releases**, not the GitHub Packages registry.
Each tagged release publishes the application archive, installer, and
`latest-mac.yml` metadata that installed copies of Nix use to discover updates.

The updater:

- checks shortly after an installed build starts and every four hours afterward;
- downloads a newer release in the background;
- installs the downloaded release when Nix quits; and
- exposes check, download, and restart controls in Settings without system dialogs.

The release repository must be public. A private GitHub update feed would require
shipping a GitHub credential inside every installed application, which is not a
safe distribution model.

Configure these GitHub Actions repository secrets before publishing:

- `CSC_LINK` — base64-encoded Developer ID Application certificate or a secure URL
  containing it;
- `CSC_KEY_PASSWORD` — password for that certificate;
- `APPLE_ID` — Apple account used for notarization;
- `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password for that account; and
- `APPLE_TEAM_ID` — Apple Developer team identifier.

To publish a release:

1. Update the `version` in `package.json`.
2. Create and push the matching tag, such as `v0.2.0`.
3. The Release workflow verifies that the tag and package version match and that
   every signing secret is present. It then runs the complete test suite, builds a
   signed universal macOS application, notarizes it, and publishes the GitHub
   Release assets. Missing signing credentials fail the release instead of
   publishing an unsigned build.

Do not publish a draft release: GitHub does not expose draft assets to installed
applications checking for updates.

## Project Structure

```text
nix-desktop/
├── components/          React UI components
├── hooks/
│   └── useNix.ts       Main conversation and agent-loop state
├── lib/
│   ├── agentExecutor.js Local tool executor
│   ├── agentProtocol.ts Tool-tag parser and formatter
│   ├── systemPrompt.ts  Agent protocol prompt
│   └── utils.ts         Shared utilities
├── pages/               Next.js pages
├── styles/              Global styles
├── main.js              Electron main process
├── preload.js           Secure renderer IPC bridge
└── package.json
```

## Agent Protocol

On the first message of a conversation, Nix prepends an agent-system prompt to the message sent to ChatGPT.

The model may respond with tool actions such as:

```text
‹nix:list path="src" /›
```

```text
‹nix:read path="src/index.ts" /›
```

```text
‹nix:search query="TODO|FIXME" path="src" /›
```

```text
‹nix:run›pnpm test‹/nix:run›
```

```text
‹nix:write path="src/example.ts"›
export const example = true
