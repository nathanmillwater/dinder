import express from "express";
import multer from "multer";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, userError } from "./store.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = path.resolve(process.env.DATA_DIR || "data");
mkdirSync(path.join(data, "uploads"), { recursive: true });
const store = createStore(path.join(data, "dinder.sqlite"));
const app = express();
app.use(express.json({ limit: "1mb" }));
// Express 5 leaves req.body undefined without a JSON body; validate it as empty instead.
app.use((req, _res, next) => {
  req.body ??= {};
  next();
});
app.use(
  "/uploads",
  express.static(path.join(data, "uploads"), { immutable: true, maxAge: "1y" }),
);
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(data, "uploads"),
    filename: (_req, file, cb) =>
      cb(
        null,
        `${crypto.randomUUID()}${{ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" }[file.mimetype] || ""}`,
      ),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(
      null,
      ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
        file.mimetype,
      ),
    ),
});
const profile = (req) => {
  const id = Number(req.query.profile || req.body?.profile);
  if (![1, 2].includes(id)) throw userError("Choose your profile.");
  return id;
};
const text = (value, max = 2000) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/profiles", (_req, res) => res.json(store.profiles()));
app.patch("/api/profiles/:id", (req, res) => {
  const id = Number(req.params.id),
    name = text(req.body.name, 40);
  if (![1, 2].includes(id) || !name)
    return res.status(400).json({ error: "Enter a name." });
  store.db.prepare("UPDATE profiles SET name=? WHERE id=?").run(name, id);
  res.json(store.profiles());
});
app.get("/api/meals", (_req, res) => res.json(store.meals()));
function mealValues(body) {
  const name = text(body.name, 100),
    recipe = text(body.recipe),
    photo = text(body.photo);
  if (!name) throw userError("Give your meal a name.");
  if (recipe && !/^https?:\/\//i.test(recipe))
    throw userError("Recipe links must start with http:// or https://.");
  if (photo && !/^\/uploads\/[a-zA-Z0-9.-]+$/.test(photo))
    throw userError("Upload a photo first.");
  return [name, photo, recipe, text(body.notes), text(body.emoji, 16) || "🍽️"];
}
app.post("/api/meals", (req, res) => {
  const result = store.db
    .prepare(
      "INSERT INTO meals(name,photo,recipe,notes,emoji) VALUES(?,?,?,?,?)",
    )
    .run(...mealValues(req.body));
  res
    .status(201)
    .json(store.meals().find((m) => m.id === Number(result.lastInsertRowid)));
});
app.put("/api/meals/:id", (req, res) => {
  const r = store.db
    .prepare(
      "UPDATE meals SET name=?,photo=?,recipe=?,notes=?,emoji=? WHERE id=?",
    )
    .run(...mealValues(req.body), Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: "Meal not found." });
  res.json({ ok: true });
});
app.delete("/api/meals/:id", (req, res) => {
  store.db.prepare("DELETE FROM meals WHERE id=?").run(Number(req.params.id));
  res.json({ ok: true });
});
app.post("/api/uploads", upload.single("photo"), (req, res) =>
  req.file
    ? res.status(201).json({ photo: `/uploads/${req.file.filename}` })
    : res
        .status(400)
        .json({ error: "Choose a JPG, PNG, WebP, or GIF image (up to 8 MB)." }),
);
app.post("/api/seed", (_req, res) => {
  if (store.meals().length)
    return res.status(409).json({
      error: "Starter meals are only available for an empty collection.",
    });
  const add = store.db.prepare(
    "INSERT INTO meals(name,notes,emoji) VALUES(?,?,?)",
  );
  for (const m of [
    [
      "Creamy tomato pasta",
      "A cosy bowl of pasta with a rich tomato sauce and a little parmesan.",
      "🍝",
    ],
    [
      "Taco night",
      "Load up warm tortillas with your favourite fillings.",
      "🌮",
    ],
    ["Homemade pizza", "Your kitchen, your toppings, your rules.", "🍕"],
    [
      "Coconut curry",
      "A fragrant coconut curry with rice and fresh herbs.",
      "🍛",
    ],
    [
      "Salmon & greens",
      "Roasted salmon, crisp greens, and a squeeze of lemon.",
      "🐟",
    ],
    [
      "Smash burgers",
      "Golden edges, melty cheese, and all the good toppings.",
      "🍔",
    ],
    [
      "Mushroom risotto",
      "Slow-stirred rice with mushrooms and parmesan.",
      "🍄",
    ],
    [
      "Stir-fry noodles",
      "Colourful vegetables and noodles in a sticky soy sauce.",
      "🍜",
    ],
    [
      "Sunday roast",
      "Crispy potatoes, seasonal veg, and plenty of gravy.",
      "🥔",
    ],
    [
      "Big colourful salad",
      "Crunchy greens, roasted vegetables, and a punchy dressing.",
      "🥗",
    ],
    [
      "Breakfast for dinner",
      "Eggs, toast, and permission to keep it easy.",
      "🍳",
    ],
    ["Jacket potatoes", "Fluffy potatoes with your favourite toppings.", "🥔"],
  ])
    add.run(...m);
  res.status(201).json(store.meals());
});
app.get("/api/history", (_req, res) => res.json(store.history()));
app.get("/api/rounds/current", (req, res) =>
  res.json(store.state(profile(req))),
);
app.post("/api/rounds", (req, res) => {
  const p = profile(req);
  const r = store.start(req.body.mealIds, req.body.plan === true);
  res.json(store.state(p, r.id));
});
app.post("/api/rounds/:id/votes", (req, res) => {
  const p = profile(req);
  if (typeof req.body.liked !== "boolean") throw userError("Choose yes or no.");
  res.json(
    store.vote(
      Number(req.params.id),
      p,
      Number(req.body.mealId),
      req.body.liked,
    ),
  );
});
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "API route not found." }),
);
app.use(express.static(path.join(root, "dist")));
app.get("/{*path}", (_req, res) =>
  res.sendFile(path.join(root, "dist/index.html")),
);
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError)
    return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      error:
        err.code === "LIMIT_FILE_SIZE"
          ? "Photos must be smaller than 8 MB."
          : err.message,
    });
  // userError and body-parser errors carry a 4xx status; anything else is a bug or a storage fault.
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  res
    .status(status)
    .json({ error: status === 500 ? "Something went wrong." : err.message });
});
const server = app.listen(Number(process.env.PORT) || 3000, "0.0.0.0", () =>
  console.log("Dinder is listening on port " + (process.env.PORT || 3000)),
);
// As PID 1 in Docker, Node has no default SIGTERM handling, so stop cleanly ourselves.
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
    store.db.close();
    process.exit(0);
  });
