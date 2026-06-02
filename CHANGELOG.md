# Changelog

## [0.1.0] — 2026-06-02

Initial release.

### Features

- **Compose tab** — reads `docker-compose.yml` instantly without a daemon; overlays live state from `docker compose ps` when Docker is running; bulk start / stop / restart for the whole stack; port conflict detection; V1 `version:` syntax warnings; missing `.env` detection
- **Containers** — start, stop, restart, shell, logs, remove; full state from `docker ps -a`
- **Images** — list, pull by name, remove; unreferenced images flagged as safe to remove
- **Volumes** — orphaned volume detection with safe-to-remove callout
- **Networks** — list and remove
- **Provider chips bar** — live Docker and Compose status; click for daemon controls and compose file options
- **Profiles** — named configurations with their own tabs, providers, refresh interval, and snippet scope
- **Snippets** — workspace (committed) and global (synced) command shortcuts; run in terminal or copy to clipboard
- **Pop-out view** — full editor tab with multi-column layout and live log panel with per-service tabs, search, and level filters
- **Proactive hints** — port conflicts, orphaned volumes, restarting services, deprecated syntax, missing env files
- **Commands cheat sheet** — project-aware Docker reference with one-click copy; service names populated from compose file
- **Daemon recovery** — auto-detects when Docker comes back online and refreshes immediately
- **Action feedback** — inline pending state on resource rows while an action is in progress
- **Onboarding** — guided first-run prompts for first install, profile setup, and unhealthy services
- **Settings** — per-profile provider and tab toggles, safety confirmations, display preferences, import/export

### Providers

- Docker (full) — works with Docker Desktop, Colima, Rancher Desktop, Podman in compatibility mode
- Kubernetes (coming soon) — namespace configuration available; data and actions in development
