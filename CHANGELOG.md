# Changelog

## [0.1.0] — 2026-06-09 (patch)

### Fixed

- **Compose tab always showed "No compose file found" when Docker was offline** — the containers tab was setting provider `status = error`, which caused `sendFullState` to skip the compose tab on every subsequent poll. The gate now only skips providers that are fully disconnected; compose (file-based) runs regardless of daemon state.
- **Compose tab no longer poisons provider status** — `getComposeData` no longer sets `status = error` when the daemon is offline. Only daemon-dependent tabs own that field.
- **Docker Desktop start command failed on Windows** — `Start-Process "Docker Desktop"` was passing a window title, not an executable path. Now uses `$env:ProgramFiles\Docker\Docker\Docker Desktop.exe`.
- **Duplicate copy button IDs in commands cheat sheet** — "docker system prune" and "docker system prune --volumes" hashed to the same ID, making the second copy button a no-op. IDs are now sequential integers.
- **Log stream callbacks fired after disposal** — a `disposed` flag now prevents `onLine` / `onEnd` from being called after the stream is killed.
- **Container name unquoted in shell command** — `docker exec -it` now quotes the container name, consistent with how other CLI operations handle names containing dots or hyphens.

### Improved

- **Compose action output streams live** — `compose up`, `down`, `restart`, and `stop` now stream Docker output to an output channel in real time rather than capturing it silently. The channel header shows the exact command run; the footer on failure reads "Docker exited with code N — the error above is from Docker, not Wheelhouse."
- **Platform-aware Docker start instructions** — the "Docker not running" helper cards now show OS-specific instructions (Windows: Start Menu / exe path; macOS: Applications / menu bar; Linux: `systemctl` command). The "Start Docker →" button on Windows and macOS triggers the start directly; Linux shows an install guide link.
- **OS detection in webview** — `process.platform` is now included in every state message so all current and future provider UI can make platform-specific decisions without reaching back to the extension host.
- **JSDoc file headers** — all source files now have a standard block header (filename, one-liner, responsibilities) matching the project's code style.

### Tests

- Added `DockerProvider.compose.test.ts` — 21 new tests covering compose file discovery (`findComposeDir`, `findWorkspaceWithCompose`), `getComposeData` behaviour with daemon offline, status isolation between tabs, and the end-to-end scenario where the containers tab poisons status but compose still returns services.

---

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
