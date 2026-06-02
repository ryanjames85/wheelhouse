# Wheelhouse

![Wheelhouse](media/wheelhouse-logo-readme.png)

**Everything you'd open a terminal for. Without opening a terminal.**

Docker · Kubernetes · Compose — managed from a single VS Code sidebar panel.

![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-blue?logo=visualstudiocode) ![Docker](https://img.shields.io/badge/Docker-supported-2496ED?logo=docker&logoColor=white) ![Kubernetes](https://img.shields.io/badge/Kubernetes-coming%20soon-326CE5?logo=kubernetes&logoColor=white) ![Licence](https://img.shields.io/badge/licence-PolyForm%20NC-lightgrey)

---

## What is Wheelhouse?

Every developer working with Docker has the same six terminals open. Wheelhouse replaces all of them.

It reads your `docker-compose.yml` directly — no daemon required — and overlays live state when Docker is running. Start services, tail logs, open a shell, manage volumes and images. All from the sidebar, all with one click.

---

## Features

### Infrastructure at a glance

The **provider chips bar** tells you immediately whether Docker is running, whether a compose file is found, and whether your Kubernetes cluster is reachable. Green = connected. Red = needs attention. Click any chip for details and options.

### Compose tab

- Services load from your compose file instantly — even when the daemon is offline
- Live state overlaid from `docker compose ps` when Docker is available
- Bulk ▶ / ■ / ↺ actions for the whole stack in the section header
- Expanded rows show image, ports, volumes, and env file per service
- Port conflicts detected and shown inline before you start
- V1 `version:` syntax and missing `.env` variables flagged as hints

### Containers, Images, Volumes, Networks

Full lifecycle management — start, stop, restart, shell, logs, remove. Pull images by name directly from the Images tab. Unreferenced images flagged as safe to remove. Orphaned volumes highlighted.

### Kubernetes *(coming soon)*

Kubernetes support is in development. Enable it in Settings → Providers to configure your namespace ready for when it lands.

### Profiles

Named configurations per project. Each profile has its own visible tabs, active providers, refresh interval, and snippets. Switch in one click from the profile pill.

### Snippets

Save commands you always retype as one-click buttons. Workspace snippets live in `.wheelhouse/snippets.json` — commit them so your team shares the same shortcuts. Global snippets sync across machines. Run in terminal or copy to clipboard.

### Pop-out view

Click ↗ to open Wheelhouse as a full editor tab in its own OS window. Stats bar, multi-column layout, pinned live log panel with tabs per service, search, and level filters.

### Commands cheat sheet

A project-aware Docker reference in Settings → Commands. Grouped by intent. Service names populated from your compose file. One-click copy.

### Proactive hints

A rule-based banner surfaces issues before they become problems: port conflicts, orphaned volumes, repeated restarts, deprecated syntax, missing `.env`. Dismissable. Resettable.

---

## Getting started

1. Install the extension
2. Open a folder containing a `docker-compose.yml`
3. Click the Wheelhouse icon in the activity bar

Services appear immediately. Live state and actions activate when the Docker daemon is reachable.

---

## Compatibility

Wheelhouse shells out to the `docker` and `kubectl` binaries directly — no SDK, no Docker Desktop dependency, no cloud account required.

| Runtime | Supported |
| --- | --- |
| Docker Desktop | ✓ |
| Colima | ✓ |
| Rancher Desktop | ✓ |
| Podman (docker compat mode) | ✓ |
| Any `kubectl`-compatible cluster | coming soon |

Override the binary path per-profile in Settings → Providers.

---

## Extension commands

| Command | Description |
| --- | --- |
| `Wheelhouse: Refresh` | Force a full data refresh |
| `Wheelhouse: Switch Profile` | Pick a profile from the quick-pick menu |
| `Wheelhouse: Open Full View` | Pop out to a full editor tab |
| `Wheelhouse: Export Settings` | Save profiles and snippets to JSON |
| `Wheelhouse: Import Settings` | Restore profiles and snippets from JSON |

---

## Architecture

Provider-based plugin system — Docker and Kubernetes ship first-party. The `IProvider` interface is open: anyone can build a provider for Podman, Nomad, Fly.io, or any other runtime without touching core.

```text
src/
├── core/ProviderRegistry.ts      provider lifecycle
├── providers/
│   ├── docker/                   Docker CLI wrapper · 5 tabs
│   └── kubernetes/               kubectl wrapper · 4 tabs
├── storage/StorageManager.ts     profiles, snippets, settings
└── ui/
    ├── WheelhousePanel.ts        sidebar webview
    └── PopoutPanel.ts            full editor tab + live log panel
```

---

## Licence

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/) — free to use, modify, and share for non-commercial purposes.

---

*Built in Ireland. Shipped with care.*
