import express from "express";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, userError } from "./store.js";
import { createMealie } from "./mealie.js";
import { createRounds } from "./rounds.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = path.resolve(process.env.DATA_DIR || "data");
mkdirSync(data, { recursive: true });
const store = createStore(path.join(data, "dinder-v2.sqlite"));
const mealie = createMealie();
const rounds = createRounds(store, mealie);
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, _res, next) => {
  req.body ??= {};
  next();
});
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
const profile = (req) => {
  const id = Number(req.query.profile || req.body.profile);
  if (![1, 2].includes(id)) throw userError("Choose your profile.");
  return id;
};
app.get("/api/health", (_req, res) => res.json({ ok: true, version: "2.0.0" }));
app.get("/api/config", (_req, res) =>
  res.json({ ...rounds.config(), profiles: store.profiles() }),
);
app.patch("/api/profiles/:id", (req, res) => {
  profile(req);
  store.rename(Number(req.params.id), req.body.name);
  res.json(store.profiles());
});
app.get("/api/state", async (req, res) => {
  const p = profile(req);
  const state = await rounds.serial(async () => {
    const recipes = await rounds.pool(req.query.fresh === "true");
    return { round: await rounds.current(p), recipes };
  });
  res.json({ ...rounds.config(), profiles: store.profiles(), ...state });
});
const action = (method, route, fn) =>
  app[method](route, async (req, res) => {
    const p = profile(req);
    res.json(await rounds.serial(() => fn(req, p)));
  });
action("post", "/api/rounds", (req, p) => rounds.start(req.body, p));
action("post", "/api/rounds/:id/votes", (req, p) =>
  rounds.vote(req.params.id, p, req.body.mealId, req.body.liked),
);
action("post", "/api/rounds/:id/retry", (req, p) =>
  rounds.retry(req.params.id, p),
);
action("post", "/api/rounds/:id/cancel", (req, p) =>
  rounds.cancel(req.params.id, p),
);
action("get", "/api/rounds/:id/choices", (req) =>
  rounds.choices(req.params.id),
);
action("post", "/api/rounds/:id/review", (req, p) =>
  rounds.review(req.params.id, req.body, p),
);
action("post", "/api/rounds/:id/publish", (req, p) =>
  rounds.publish(req.params.id, req.body.token, p),
);
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "API route not found." }),
);
app.use(express.static(path.join(root, "dist")));
app.get("/{*path}", (_req, res) =>
  res.sendFile(path.join(root, "dist/index.html")),
);
app.use((err, _req, res, _next) => {
  const status = err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500 && !err.expose) console.error(err);
  res.status(status).json({
    error: status >= 500 && !err.expose ? "Something went wrong." : err.message,
  });
});
const server = app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () =>
  console.log("Dinder is listening on port " + server.address().port),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
    store.db.close();
    process.exit(0);
  });
