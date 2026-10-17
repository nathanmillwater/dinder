# Dinder

Dinner, together. A shared meal collection and a swipe-to-match dinner picker for two people on your LAN.

## Run with Docker

```sh
docker compose up -d --build
```

Open **http://SERVER_LAN_IP:3000** on both phones connected to the same network. To find the server address, run `hostname -I` on the server. Each person chooses a different profile; names can be changed using the profile button. No login or external service is needed.

To use another port: `DINDER_PORT=3080 docker compose up -d --build`.

Use “Add starter meals” for 12 editable dinner ideas, or build your own collection. Photos are uploaded to this server (8 MB maximum). Recipe links open in a new tab.

## Match Mode

Either person starts a round with up to ten randomly selected meals. The other opens Dinder and selects “Join Match Mode”. Each profile sees the same meals in a different order. Swipe right/left, tap the heart/cross, or use keyboard arrow keys. The first shared yes wins. Choices and progress survive refreshing and restarting the app. If one person finishes first, they wait for the other. After no match, retry with a random shortlist or choose meals yourselves. Meal edits never alter an ongoing round.

Only one round can be active. Both people must finish it or match before starting another. Private votes stay hidden; each partner can see the other's progress count. This is designed for a trusted LAN, without authentication.

## Meal planner

“Plan our week” starts a round that keeps going until you have seven shared yeses — a dinner for each night. It swipes through your whole collection (at least seven meals), each match pops up as it happens, and the finished plan lists the nights from the day you started. It shares the one-active-round rule with Match Mode. If you both run out of meals first, the nights you did match are kept in History.

## Match history

The History tab saves every successful match and week plan (including partly filled ones), newest first, with its meal details and recipe link. It is shared between both profiles and survives meal edits, deletion, and restarts. Existing matches are included automatically; older matches show their round start time because an exact match timestamp was not recorded before this feature.

## Data and backup

SQLite, its journal files, and uploaded photos live in the Docker volume `dinder-data` (usually named `dinder_dinder-data`). `docker compose down` preserves them. **`docker compose down -v` deletes them.**

For a consistent backup, stop the service and archive the whole volume:

```sh
docker compose stop
docker run --rm -v dinder_dinder-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/dinder-backup.tar.gz -C /data .
docker compose start
```

If you changed the Compose project name, find the volume using `docker volume ls` and replace `dinder_dinder-data`. To restore, stop the service, extract that archive into the same volume as root, ensure `/data` is owned by UID 1000, then start the service again. Backups contain your photos and meal data; keep them outside the source repository.

## Local development

Requires Node.js 24 or newer and npm.

```sh
npm ci
npm run build
npm start
```

For live frontend editing run `npm run dev` in a second terminal while the backend is running on port 3000; open port 5173. `PORT` changes the backend port; `DATA_DIR` changes the data directory (defaults to `./data`). The development proxy expects backend port 3000.

```sh
npm test
npm run build
docker compose logs -f
```

Health endpoint: `/api/health`. Docker checks it every 30 seconds and restarts the service if its process exits. SQLite and image storage require local disk; do not put the database on a network share. Google Fonts improve typography when available; system font fallbacks keep the app usable offline. No external image or recipe services are needed.

## Optional browser tests

`tests/browser.cjs` exercises two isolated phone sessions, meal uploads and edits, matching, reconnection, refresh, and desktop layout. Run it only against a disposable instance: it replaces the test instance’s meal collection. Install `playwright-core` separately, provide Chromium through `CHROMIUM_PATH`, set `DINDER_TEST_URL` (default `http://127.0.0.1:3099`), then run `node tests/browser.cjs`. Screenshots are written to `DINDER_TEST_ARTIFACTS` (default `/tmp/dinder-artifacts`).
