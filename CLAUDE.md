# OpenWork

## Architecture

- **All management backends live in Pantheon** (`/mnt/c/workspace/pantheon`). Auth, worker management, admin UI, provider/seat management, conversations API — everything is in Pantheon.
- **No billing integration.** No Polar, no paywalls, no checkout flows.
- **`packages/web` is NOT used.** Pantheon serves all management UI directly (HTML + JS pages at `/app/*`). Do not build on or reference `packages/web`.
- **`packages/app`** is the SolidJS chat UI. It connects to OpenCode engines running on workers provisioned by Pantheon.
- **`packages/server`** is the HTTP API layer between the app and OpenCode. It runs inside worker containers.
