import { test } from "node:test";
import assert from "node:assert/strict";
import { startMealie, startDinder, planEntry, recipes } from "./helpers.js";
import { addDays } from "../server/calendar.js";
test("HTTP: live recipe pools, concurrent votes, reviewed dinner writes, privacy and retired endpoints", async (t) => {
  const m = await startMealie();
  t.after(() => m.close());
  const app = await startDinder(m.url);
  t.after(() => app.close());
  const api = async (
    path,
    body,
    p = 1,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const res = await fetch(
      app.url +
        "/api" +
        path +
        (path.includes("?") ? "&" : "?") +
        "profile=" +
        p,
      {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await api("/health")).data.version, "2.0.0");
  const initial = (await api("/state")).data;
  assert.equal(initial.recipes.length, 12);
  assert.equal(initial.round, null);
  for (const path of ["/history", "/meals", "/seed", "/uploads"])
    assert.equal((await api(path)).status, 404);
  const starts = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      api("/rounds", { mode: "picker", source: "recipes" }, (i % 2) + 1),
    ),
  );
  assert.equal(new Set(starts.map((x) => x.data.id)).size, 1);
  const r = starts[0].data,
    id = recipes[0].id;
  m.state.entries = [planEntry(1, initial.today)];
  await api(`/rounds/${r.id}/votes`, { mealId: id, liked: true });
  assert.deepEqual((await api("/state", undefined, 2)).data.round.votes, {});
  const votes = await Promise.all(
    Array.from({ length: 5 }, () =>
      api(`/rounds/${r.id}/votes`, { mealId: id, liked: true }, 2),
    ),
  );
  assert.ok(votes.every((v) => v.data.matches.length === 1));
  const review = await api(`/rounds/${r.id}/review`, { targetEntryId: 1 });
  assert.equal(review.status, 200);
  assert.equal(m.state.writes.length, 0);
  const results = await Promise.all([
    api(`/rounds/${r.id}/publish`, { token: review.data.review.token }),
    api(`/rounds/${r.id}/publish`, { token: review.data.review.token }, 2),
  ]);
  assert.ok(results.every((x) => x.data.status === "complete"));
  assert.equal(m.state.entries.length, 1);
  assert.equal(m.state.writes.filter((w) => w.type === "create").length, 1);
  const planned = await api("/rounds", { mode: "picker", source: "mealplan" });
  assert.equal(planned.data.total, 1);
  m.state.recipes[0].name = "Updated recipe";
  m.state.recipes.push({
    ...recipes[0],
    id: "new-id",
    slug: "new",
    name: "New",
  });
  let state = await api("/state?fresh=true");
  assert.equal(state.data.recipes.length, 13);
  assert.equal(state.data.round.current.name, "Updated recipe");
  m.state.entries.push(planEntry(3, addDays(initial.today, 2), recipes[1].id));
  state = await api("/state");
  assert.equal(state.data.round.total, 2);
  m.state.status = 503;
  assert.equal((await api("/state?fresh=true")).status, 502);
  assert.equal(
    (await api(`/rounds/${planned.data.id}/votes`, { mealId: id, liked: true }))
      .status,
    502,
  );
  m.state.status = 200;
  await api(`/rounds/${planned.data.id}/cancel`, {});
  assert.equal(
    (await api("/rounds", { mode: "planner", startDate: "not-a-date" })).status,
    400,
  );
  assert.equal(
    (await api("/rounds", { mode: "planner" })).data.mode,
    "planner",
  );
  assert.ok(!JSON.stringify(state.data).includes("test-only-token"));
});
test("missing credentials leave configuration and process health available with safe errors", async (t) => {
  const m = await startMealie();
  t.after(() => m.close());
  const app = await startDinder(m.url, { token: "" });
  t.after(() => app.close());
  assert.equal((await fetch(app.url + "/api/health")).status, 200);
  assert.equal((await fetch(app.url + "/api/config")).status, 200);
  const res = await fetch(app.url + "/api/state?profile=1");
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /token/);
  assert.equal(m.state.calls.length, 0);
});
