# Dinder v2

Dinner, together. Two people swipe through a live Mealie collection to plan the week or choose tonight’s dinner. Mealie owns the recipes and meal plan; Dinder keeps only profiles, round progress, and reliable-save journals.

## Two modes

**Meal Planner** defaults to next Monday–Sunday, with an editable start date. Every shared yes adds a distinct dinner; seven shared yeses complete the draft. Review and reorder the meals before publishing. Publishing replaces all dinner entries on the selected dates, preserving other meal types. If you run out of shared likes, publish a partial plan on selected nights or retry unmatched recipes while keeping your matches.

**Meal Picker** uses either all Mealie recipes or dinner recipes in the upcoming seven days, including today. The first shared yes wins. From the recipe pool, review and confirm setting tonight’s dinner. From the meal plan, review a swap between the selected planned dinner and tonight’s dinner; if tonight is empty, the winning dinner moves to tonight. Multiple planned entries require selecting the exact entries. A winner already scheduled tonight needs no change.

There are exactly two named profiles and one shared round at a time. Votes are private, partner progress is shared, and refreshing or restarting preserves the round. Swipe, tap heart/cross, or use keyboard arrows. Either player can cancel before saving begins. Picker rounds expire at local midnight; an already-started save continues reconciling its original reviewed dates.

## Live Mealie data

Recipes are loaded from Mealie with at most 15 seconds of in-memory caching. Active rounds incorporate additions, edits, and deletions while retaining surviving votes. Deleted shared matches reopen planner slots. Refresh fetches immediately, and new rounds and confirmation checks fetch fresh data. Planned pools exclude notes without recipes and deduplicate recipes while retaining their entry dates.

Mealie outages pause swiping and saving without losing progress. Recipe photos and links use the public Mealie address and may require a Mealie browser login. No local recipe management or match-history screen remains.

## Run with Docker Compose

Create a long-lived Mealie API token in **User profile → API Tokens**, with permission to read recipes and edit the household’s meal plan. Copy `.env.example` to `.env`:

```dotenv
MEALIE_URL=https://recipes.muthur.network
MEALIE_PUBLIC_URL=https://recipes.muthur.network
MEALIE_API_TOKEN=your-token-here
TZ=Europe/London
```

```sh
docker compose up -d --build
```

Open `http://SERVER_LAN_IP:3000` on both phones and choose different profiles. `DINDER_PORT=3080` changes the standalone host port. The local image is tagged `dinder:2.0.0`; no registry is required.

`MEALIE_URL` is the backend API base. `MEALIE_PUBLIC_URL` supplies browser recipe/photo links; use different values when reaching Mealie internally over Docker. The token stays on the server, and `.env` is ignored by Git and excluded from build contexts. This is a trusted-LAN application without Dinder authentication; everyone who can reach it can act on the configured household’s meal plan.

## Homelab deployment

The sibling `../homelab` repository includes Dinder in its apps stack, built from this checkout. It uses `http://mealie:9000` internally, routes HTTPS through Traefik at `https://dinder.${DOMAIN}`, and appears in Homepage. Copy homelab’s `apps/dinder.env.example` to its ignored `apps/dinder.env` and set `MEALIE_API_TOKEN` there. See `../homelab/docs/dinder.md` for operations and rollback.

From the homelab root:

```sh
./scripts/compose-validate.sh
docker compose --env-file .env -f apps/docker-compose.yml build dinder
docker compose --env-file .env -f apps/docker-compose.yml up -d --no-deps dinder
```

The existing proxy network and Mealie service must be running. Prepare `${SERVICES_PATH}/dinder/data` owned by UID/GID 1000. There is no host port in homelab mode.

## Reliable writes and storage

Every change requires reviewing its effect and then confirming. Dinder checks for concurrent Mealie edits, journals each write before sending it, and verifies the result before continuing. Weekly replacement stages new dinners before removing old ones. Save retries reconcile existing entries using stable operation markers instead of creating duplicates; these markers appear in the created Mealie dinner’s notes.

Mealie does not offer an atomic multi-entry write, so an interruption can leave a partially updated plan. Dinder shows a save error and retains its journal. Retry to finish. If another client has edited an affected entry, Dinder stops rather than overwriting it; inspect Mealie and restore the reviewed entry before retrying. Do not delete the state directory while saving is incomplete. No automatic rollback overwrites external edits.

SQLite lives at `/data/dinder-v2.sqlite` in Docker, or `$DATA_DIR/dinder-v2.sqlite` locally (default `./data`). The standalone volume remains `dinder-data`; homelab uses its separate bind mount. Old v1 files are not migrated or used. Keep the old standalone container/image/volume for rollback during cutover. A Dinder rollback does not undo changes already confirmed in Mealie.

Back up Dinder’s entire data directory while stopped, and back up Mealie separately for recipes and plans. `docker compose down` preserves named volumes; **`docker compose down -v` deletes them**.

## Development and checks

Requires Node.js 24 or newer. `npm start` loads the ignored `.env` file; shell environment variables take precedence.

```sh
npm ci
npm run build
npm start
```

For frontend development, run `npm run dev` alongside the backend on port 3000 and open port 5173. `PORT` and `DATA_DIR` configure the backend. The development proxy expects port 3000.

```sh
npm test
npm run build
```

Tests use disposable data and a mock Mealie service. They cover live pool updates, private voting, complete and partial planning, swaps, date boundaries, concurrent submissions, failures after writes, conflict detection, and restart recovery. They require permission to listen on localhost. Optional browser tests require `playwright-core` and Chromium (`CHROMIUM_PATH`, default `/usr/bin/chromium`): run `node tests/browser.cjs` after building. Screenshots go to `DINDER_TEST_ARTIFACTS` (default `/tmp/dinder-v2-artifacts`). No tests change the real Mealie service.

`/api/health` checks Dinder independently of Mealie. Docker checks it every 30 seconds. Optional Google Fonts fall back to system fonts offline.
