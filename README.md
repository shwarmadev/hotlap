# Hotlap

Hotlap is a friends-and-family fork of [T3 Code](https://github.com/pingdotgg/t3code), the open-source control surface for coding agents. It adds thread tools and runs without hosted Hotlap services: you run the server on your own machine and pair your phone and laptop to it over your LAN or Tailscale. Hotlap telemetry is off.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, Hotlap can control them.

## Install

Install and sign in to at least one provider first:

- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
- Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
- Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
- Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

| Surface              | How                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Terminal, no install | `npx hotlap@latest` (Node.js 22.16+, 23.11+, or 24.10+). Starts the server and the local web app.                          |
| macOS                | Download the DMG from [Releases](https://github.com/shwarmadev/hotlap/releases). Signed and notarized.                     |
| Windows and Linux    | Installers on the same [Releases](https://github.com/shwarmadev/hotlap/releases) page.                                     |
| iPhone               | TestFlight, link on the [Releases](https://github.com/shwarmadev/hotlap/releases) page once the first build clears review. |
| Android              | Sideload the APK from [Releases](https://github.com/shwarmadev/hotlap/releases).                                           |

Hotlap keeps its data in `~/.hotlap`, so it runs side by side with a T3 Code install.

For a persistent command-line install without npm, download and review
`scripts/install.sh` or `scripts/install.ps1` from this repository and run it with
`sh` or PowerShell. Do not use the installers at `t3.codes`; those install T3 Code.
The scripts put a `hotlap` launcher in `~/.local/bin`, and from there
`hotlap service install` keeps the server running in the background, `hotlap update`
moves to a newer release, `hotlap uninstall` removes it, and `hotlap --help` has the
full reference. Details in [Install and first run](./docs/user/install.md).

## Pair your phone or another machine

On the machine that runs your agents, open **Settings → Connections** in the desktop app, enable **Network access**, and create a pairing link (or run `npx hotlap serve --host <tailnet-or-lan-ip>` and then `npx hotlap pair`). Scan the QR code with the phone app or paste the link into **Add environment** on another device. Over Tailscale this works from anywhere; over a LAN it works at home. Details in [Remote access](./docs/user/remote-access.md). There is no hosted relay, so the "T3 Connect" tunnel described there is unavailable.

## How this fork stays current

An hourly job on Anish's box checks `pingdotgg/t3code` for updates. Clean merges need no agent; conflicts go to a time-limited agent that preserves Hotlap's features, identity, data paths, and release setup. The job checks for unresolved conflicts and runs the required verification before pushing. Unsafe merges or failed checks are preserved on a `sync-failed/*` review branch instead of reaching `main`.

Hotlap also includes thread drafts, conversation forks, transcript copying, and saved prompts. Upstream sync must preserve these functional changes, not just branding.

## Fork Hotlap

Want your own build? Fork this repository, then:

1. Search for `Hotlap`, `hotlap`, `ai.usefastlane.code`, and `shwarmadev/hotlap` and replace them with your own name, bundle id, and repository.
2. Drop your mark into `assets/hotlap/mark.svg` and run `node scripts/export-hotlap-icons.ts`.
3. Add the signing and publishing secrets listed in [`.github/workflows/release.yml`](./.github/workflows/release.yml) and run the **Release** workflow.

The rest of this file is T3 Code's README, kept so the fork stays easy to merge. Where it says `t3`, read `hotlap`.

---

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
