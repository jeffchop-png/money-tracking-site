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

## Deploy as a public site

The included `render.yaml` deploys the built site and API together on Render, with a persistent data disk and an automatically generated editing key. This requires a paid Render web service and disk; the service URL is HTTPS and does not include a port.

1. Push this repository to GitHub.
2. In Render, choose **New** then **Blueprint**, and connect this repository.
3. Deploy the `morg-money` service from `render.yaml`.
4. Open the service's **Environment** page to view the generated `MORG_MONEY_KEY`; use it to unlock editing on the deployed site.

Render assigns the public `onrender.com` URL after deployment. A custom domain can be added in the service's **Settings** page. GitHub Pages cannot run the Node API needed for shared records; its browser-local mode is described below.

## GitHub Pages

The GitHub Actions workflow also publishes a static version at `https://jeffchop-png.github.io/money-tracking-site/`. In this mode, balances are saved in the current browser and are not shared with other visitors or devices. For shared records, deploy the Render service above instead.

## Offline use

After the page has been opened online once, the service worker caches the app shell and IndexedDB keeps a local copy of the ledger. An already-authorized device can keep editing while offline; edits are saved on that device and sync when the API is reachable again. Edit authorization expires after 12 hours, so unlock while online before relying on offline editing. If another person changed the ledger while a device was offline, its draft is kept locally and can be downloaded; it is not silently written over the shared version.

Offline drafts remain on that browser/device until synced or replaced. Offline mode cannot share changes with other people until the server is reachable.

## Linux process recovery

`GET /health` reports whether the API and its data directory are available. For a Linux host using systemd, `deploy/morg-money.service` is an example that starts the app at boot and restarts the process after it exits. Adjust the install path, service user, Node.js PATH, environment file, and writable data directory for the host before installing the unit.

Process restarts cannot prevent downtime caused by a host, network, or storage outage. True failover requires a hosting platform with health checks and redundant instances backed by a shared database; the current JSON-file store is intended for one server instance.
