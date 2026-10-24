import { test } from "node:test";
import assert from "node:assert/strict";
import { createMealie } from "../server/mealie.js";

const recipe = {
  id: "20ba78c4-f2d9-40d7-8747-551bbe476aa4",
  name: "Omelette",
  slug: "omelette",
  image: "v1",
  description: "Eggs for two",
};
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), { status });

test("Mealie paginates, maps UUIDs and group links, and caches/coalesces requests", async () => {
  const calls = [];
  const mealie = createMealie({
    url: "https://mealie.example/",
    token: "private-token",
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.Authorization, "Bearer private-token");
      assert.equal(options.redirect, "error");
      if (url.endsWith("/api/groups/self"))
        return response({ slug: "our kitchen" });
      const page = Number(new URL(url).searchParams.get("page"));
      return response({
        total_pages: 2,
        items:
          page === 1
            ? [recipe]
            : [
                {
                  ...recipe,
                  id: "second-id",
                  slug: "toast",
                  image: null,
                  description: null,
                },
              ],
      });
    },
  });
  const [meals, simultaneous] = await Promise.all([
    mealie.recipes(),
    mealie.recipes(),
  ]);
  assert.deepEqual(meals, simultaneous);
  assert.equal(calls.length, 3);
  assert.deepEqual(meals[0], {
    id: recipe.id,
    name: "Omelette",
    notes: "Eggs for two",
    photo: `https://mealie.example/api/media/recipes/${recipe.id}/images/original.webp?version=v1`,
    recipe: "https://mealie.example/g/our%20kitchen/r/omelette",
  });
  assert.equal(meals[1].photo, "");
  assert.equal(meals[1].notes, "");
  await mealie.recipes();
  assert.equal(calls.length, 3);
  await mealie.recipes({ fresh: true });
  assert.equal(calls.length, 6);
  assert.ok(!JSON.stringify(meals).includes("private-token"));
});

test("missing/invalid credentials and upstream failures have safe actionable errors", async () => {
  const missing = createMealie({
    token: "",
    fetchImpl: () => assert.fail("No request without token"),
  });
  await assert.rejects(missing.recipes(), {
    status: 503,
    message: /token/,
  });
  for (const status of [401, 403, 500]) {
    const mealie = createMealie({
      token: "secret",
      fetchImpl: async () => response({ detail: "secret" }, status),
    });
    await assert.rejects(
      mealie.recipes(),
      (err) =>
        err.status === (status === 500 ? 502 : 503) &&
        !err.message.includes("secret"),
    );
  }
  const timeout = createMealie({
    token: "secret",
    fetchImpl: async () => {
      throw Error("secret upstream error");
    },
  });
  await assert.rejects(timeout.recipes(), {
    status: 502,
    message: /Cannot reach Mealie/,
  });
});

test("malformed responses fail without replacing the last successful cache", async () => {
  let broken = false;
  const mealie = createMealie({
    token: "secret",
    fetchImpl: async (url) => {
      if (url.endsWith("/api/groups/self")) return response({ slug: "home" });
      return broken
        ? response({ items: "bad" })
        : response({ items: [recipe], total_pages: 1 });
    },
  });
  await mealie.recipes();
  broken = true;
  await assert.rejects(mealie.recipes({ fresh: true }), { status: 502 });
  await assert.rejects(mealie.recipes(), { status: 502 });
  broken = false;
  assert.equal((await mealie.recipes())[0].id, recipe.id);
});

test("empty collections are valid; invalid JSON, groups and recipes are rejected", async () => {
  for (const [group, list, valid] of [
    [{ slug: "home" }, { items: [], total_pages: 0 }, true],
    [{}, { items: [], total_pages: 0 }, false],
    [
      { slug: "home" },
      { items: [{ name: "Missing UUID" }], total_pages: 1 },
      false,
    ],
  ]) {
    const mealie = createMealie({
      token: "secret",
      fetchImpl: async (url) =>
        response(url.endsWith("/api/groups/self") ? group : list),
    });
    if (valid) assert.deepEqual(await mealie.recipes(), []);
    else await assert.rejects(mealie.recipes(), { status: 502 });
  }
  const invalid = createMealie({
    token: "secret",
    fetchImpl: async () => new Response("<html>Proxy error</html>"),
  });
  await assert.rejects(invalid.recipes(), {
    status: 502,
    message: /invalid response/,
  });
});

test("meal-plan reads use Mealie-supported date ordering and browser URLs stay public", async () => {
  const calls = [];
  const m = createMealie({
    url: "http://mealie:9000",
    publicUrl: "https://recipes.example",
    token: "secret",
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("/mealplans?")) {
        assert.equal(new URL(url).searchParams.get("orderBy"), "date");
        return response({ items: [], total_pages: 0 });
      }
      return url.endsWith("/groups/self")
        ? response({ slug: "home" })
        : response({ items: [recipe], total_pages: 1 });
    },
  });
  await m.entries("2026-10-24", "2026-10-30");
  const [meal] = await m.recipes();
  assert.ok(meal.recipe.startsWith("https://recipes.example/"));
  assert.ok(meal.photo.startsWith("https://recipes.example/"));
  assert.ok(calls.every((url) => url.startsWith("http://mealie:9000/")));
});
