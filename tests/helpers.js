import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

export const recipes = Array.from({ length: 12 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  name: `Dinner ${i + 1}`,
  slug: `dinner-${i + 1}`,
  description: `Description ${i + 1}`,
  image: i ? null : "image-version",
}));

export function memoryMealie() {
  const state = {
    recipes: structuredClone(recipes),
    entries: [],
    status: 200,
    fail: null,
    writes: [],
    nextId: 100,
  };
  const mapped = (r) => ({
    id: r.id,
    name: r.name,
    notes: r.description || "",
    photo: "",
    recipe: "https://mealie.example/g/home/r/" + r.slug,
  });
  const check = () => {
    if (state.status !== 200)
      throw Object.assign(Error("Mealie unavailable"), {
        status: 502,
        expose: true,
      });
  };
  const fail = (type, when) => {
    const f = state.fail;
    if (f?.type === type && f.when === when && f.remaining > 0) {
      f.remaining--;
      throw Object.assign(Error("Response interrupted"), {
        status: 502,
        expose: true,
      });
    }
  };
  const mealie = {
    state,
    publicUrl: "https://mealie.example",
    recipes: async () => {
      check();
      return state.recipes.map(mapped);
    },
    entries: async (start, end) => {
      check();
      return structuredClone(
        state.entries
          .filter((e) => e.date >= start && e.date <= end)
          .map((e) => ({
            ...e,
            recipe: state.recipes.find((r) => r.id === e.recipeId),
          })),
      );
    },
    create: async (body) => {
      check();
      fail("create", "before");
      const entry = {
        ...body,
        id: state.nextId++,
        groupId: "group",
        userId: "user",
        householdId: "household",
      };
      state.entries.push(entry);
      state.writes.push({ type: "create", id: entry.id });
      fail("create", "after");
      return structuredClone(entry);
    },
    update: async (id, body) => {
      check();
      fail("update", "before");
      const e = state.entries.find((e) => e.id === id);
      if (!e) throw Error("Missing entry");
      Object.assign(e, body);
      state.writes.push({ type: "update", id });
      fail("update", "after");
      return structuredClone(e);
    },
    remove: async (id) => {
      check();
      fail("delete", "before");
      state.entries = state.entries.filter((e) => e.id !== id);
      state.writes.push({ type: "delete", id });
      fail("delete", "after");
      return null;
    },
  };
  return mealie;
}
export function planEntry(
  id,
  date,
  recipeId = recipes[0].id,
  entryType = "dinner",
) {
  return {
    id,
    date,
    recipeId,
    entryType,
    title: "",
    text: "",
    recipeScale: 1,
    groupId: "group",
    userId: "user",
    householdId: "household",
  };
}
export async function startMealie() {
  const memory = memoryMealie(),
    state = memory.state;
  state.calls = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      state.calls.push({ path: url.pathname, method: req.method });
      res.setHeader("Content-Type", "application/json");
      if (state.status !== 200) {
        res
          .writeHead(state.status)
          .end(JSON.stringify({ detail: "Mealie error" }));
        return;
      }
      if (url.pathname.startsWith("/api/media/recipes/")) {
        res.setHeader("Content-Type", "image/png");
        res.end(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
            "base64",
          ),
        );
        return;
      }
      if (req.headers.authorization !== "Bearer test-only-token") {
        res.writeHead(401).end("{}");
        return;
      }
      if (url.pathname === "/api/groups/self") {
        res.end(JSON.stringify({ slug: "home" }));
        return;
      }
      let body = {};
      if (req.method !== "GET") {
        let input = "";
        for await (const chunk of req) input += chunk;
        body = input ? JSON.parse(input) : {};
      }
      if (
        url.pathname === "/api/households/mealplans" &&
        req.method === "GET" &&
        url.searchParams.get("orderBy") === "id"
      ) {
        res
          .writeHead(400)
          .end(JSON.stringify({ detail: "Cannot filter on GroupMealPlan.id" }));
        return;
      }
      const paginate = (items) => {
        const page = Number(url.searchParams.get("page") || 1);
        return {
          items: items.slice((page - 1) * 5, page * 5),
          total_pages: Math.ceil(items.length / 5),
        };
      };
      if (url.pathname === "/api/recipes") {
        res.end(JSON.stringify(paginate(state.recipes)));
        return;
      }
      if (
        url.pathname === "/api/households/mealplans" &&
        req.method === "GET"
      ) {
        res.end(
          JSON.stringify(
            paginate(
              await memory.entries(
                url.searchParams.get("start_date"),
                url.searchParams.get("end_date"),
              ),
            ),
          ),
        );
        return;
      }
      if (
        url.pathname === "/api/households/mealplans" &&
        req.method === "POST"
      ) {
        const e = await memory.create(body);
        res.writeHead(201).end(JSON.stringify(e));
        return;
      }
      const id = Number(url.pathname.split("/").at(-1));
      if (
        url.pathname.startsWith("/api/households/mealplans/") &&
        req.method === "PUT"
      ) {
        res.end(JSON.stringify(await memory.update(id, body)));
        return;
      }
      if (
        url.pathname.startsWith("/api/households/mealplans/") &&
        req.method === "DELETE"
      ) {
        await memory.remove(id);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end("{}");
    } catch (e) {
      res.writeHead(e.status || 500).end(JSON.stringify({ error: e.message }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

export async function startDinder(
  mealieUrl,
  { dataDir, token = "test-only-token" } = {},
) {
  const owned = !dataDir;
  dataDir ||= mkdtempSync(join(tmpdir(), "dinder-api-"));
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: "0",
      DATA_DIR: dataDir,
      MEALIE_URL: mealieUrl,
      MEALIE_PUBLIC_URL: mealieUrl,
      TZ: "Europe/London",
      MEALIE_API_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Dinder startup timed out: " + stderr));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/listening on port (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Dinder exited: " + stderr));
    });
  });
  return {
    url,
    dataDir,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, "exit");
        child.kill("SIGTERM");
        await ended;
      }
      if (owned) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
