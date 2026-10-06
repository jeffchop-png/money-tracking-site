# Morg Money

Morg Money uses a shared Node.js API and a server-side JSON file, so people visiting the same deployment see the same ledger. It is not a static-only site.

## Local development

Requires Node.js 22.9 or newer.

```sh
npm install
cp .env.example .env
npm run dev
```

Set `MORG_MONEY_KEY` in `.env` to the editing key. The Vite page runs at `http://localhost:5173`; the API runs on port `3001`.

## Production

```sh
npm run build
npm start
```

Configure `MORG_MONEY_KEY` in the server environment and set `MORG_MONEY_DATA_DIR` to persistent storage. All visitors must reach the same running API and data directory; static hosting alone or multiple uncoordinated server instances will not share changes. Use HTTPS when exposing the site publicly.

## Offline use

After the page has been opened online once, the service worker caches the app shell and IndexedDB keeps a local copy of the ledger. An already-authorized device can keep editing while offline; edits are saved on that device and sync when the API is reachable again. Edit authorization expires after 12 hours, so unlock while online before relying on offline editing. If another person changed the ledger while a device was offline, its draft is kept locally and can be downloaded; it is not silently written over the shared version.

Offline drafts remain on that browser/device until synced or replaced. Offline mode cannot share changes with other people until the server is reachable.

## Linux process recovery

`GET /health` reports whether the API and its data directory are available. For a Linux host using systemd, `deploy/morg-money.service` is an example that starts the app at boot and restarts the process after it exits. Adjust the install path, service user, Node.js PATH, environment file, and writable data directory for the host before installing the unit.

Process restarts cannot prevent downtime caused by a host, network, or storage outage. True failover requires a hosting platform with health checks and redundant instances backed by a shared database; the current JSON-file store is intended for one server instance.
