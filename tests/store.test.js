import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../server/store.js";
import { createRounds } from "../server/rounds.js";
import { memoryMealie, planEntry, recipes } from "./helpers.js";
import { today, nextMonday, addDays } from "../server/calendar.js";
function setup(t) {
  const store = createStore(":memory:"),
    mealie = memoryMealie();
  let date = "2026-10-24";
  const service = createRounds(store, mealie, { day: () => date });
  t.after(() => store.db.close());
  return {
    store,
    mealie,
    service,
    setDay: (v) => {
      date = v;
    },
  };
}
async function match(service, r, ids) {
  for (const id of ids) {
    await service.vote(r.id, 1, id, true);
    await service.vote(r.id, 2, id, true);
  }
  return service.current(1);
}
async function planner(s, count = 7) {
  const r = await s.service.start(
    { mode: "planner", startDate: "2026-10-26" },
    1,
  );
  if (count < 7) {
    for (const p of [1, 2])
      for (const meal of s.mealie.state.recipes)
        await s.service.vote(
          r.id,
          p,
          meal.id,
          s.mealie.state.recipes.indexOf(meal) < count,
        );
  } else
    await match(
      s.service,
      r,
      recipes.slice(0, count).map((m) => m.id),
    );
  return s.service.current(1);
}
const assignments = (r) =>
  r.matches.map((m, i) => ({ recipeId: m.id, date: r.dates[i] }));

test("calendar uses London dates and calendar arithmetic across DST and next Mondays", () => {
  assert.equal(
    today(new Date("2026-07-01T23:30:00Z"), "Europe/London"),
    "2026-07-02",
  );
  assert.equal(
    today(new Date("2026-10-25T23:30:00Z"), "Europe/London"),
    "2026-10-25",
  );
  assert.equal(addDays("2026-10-24", 2), "2026-10-26");
  assert.equal(nextMonday("2026-10-26"), "2026-11-02");
});
test("two profiles, a single shared round, private votes and immutable duplicate votes", async (t) => {
  const s = setup(t),
    r = await s.service.start({ mode: "picker", source: "recipes" }, 1);
  assert.equal((await s.service.start({ mode: "planner" }, 2)).id, r.id);
  await s.service.vote(r.id, 1, r.current.id, true);
  await s.service.vote(r.id, 1, r.current.id, false);
  const other = await s.service.current(2);
  assert.deepEqual(other.votes, {});
  assert.equal(other.progress[0].count, 1);
  assert.equal((await s.service.current(1)).votes[r.current.id], true);
});
test("live additions, edits and deletions preserve surviving votes and remove deleted shared yeses", async (t) => {
  const s = setup(t),
    r = await s.service.start({ mode: "planner" }, 1),
    id = recipes[0].id;
  await match(s.service, r, [id]);
  s.mealie.state.recipes[0].name = "New name";
  assert.equal((await s.service.current(1)).matches[0].name, "New name");
  const extra = { ...recipes[0], id: "added-recipe", name: "Added" };
  s.mealie.state.recipes.push(extra);
  assert.equal((await s.service.current(1)).total, 13);
  s.mealie.state.recipes.shift();
  const current = await s.service.current(1);
  assert.equal(current.matches.length, 0);
  assert.equal(current.votes[id], undefined);
  assert.equal(current.total, 12);
});
test("planner replaces only selected nights, preserves other meal types and publishes idempotently", async (t) => {
  const s = setup(t);
  s.mealie.state.entries = [
    planEntry(1, "2026-10-26"),
    planEntry(2, "2026-10-26", recipes[0].id, "lunch"),
    planEntry(3, "2026-11-02"),
  ];
  const r = await planner(s);
  assert.equal(r.status, "review");
  const review = await s.service.review(
    r.id,
    { assignments: assignments(r) },
    1,
  );
  assert.equal(s.mealie.state.writes.length, 0);
  const done = await s.service.publish(r.id, review.review.token, 1);
  assert.equal(done.status, "complete");
  const dinners = s.mealie.state.entries.filter(
    (e) => e.entryType === "dinner" && e.date < "2026-11-02",
  );
  assert.equal(dinners.length, 7);
  assert.ok(s.mealie.state.entries.some((e) => e.id === 2));
  assert.ok(s.mealie.state.entries.some((e) => e.id === 3));
  const n = s.mealie.state.writes.length;
  await s.service.publish(r.id, review.review.token, 2);
  assert.equal(s.mealie.state.writes.length, n);
});
test("exhausted partial plans replace assigned nights only; retry keeps shared yeses", async (t) => {
  const s = setup(t);
  s.mealie.state.entries = [
    planEntry(1, "2026-10-26"),
    planEntry(2, "2026-10-27"),
  ];
  const r = await planner(s, 1);
  assert.equal(r.status, "exhausted");
  const retry = await s.service.retry(r.id, 1);
  assert.equal(retry.status, "swiping");
  assert.equal(retry.matches.length, 1);
  assert.equal(retry.progress[0].count, 1);
  const reviewed = await s.service.review(
    r.id,
    { assignments: [{ recipeId: r.matches[0].id, date: "2026-10-28" }] },
    1,
  );
  await s.service.publish(r.id, reviewed.review.token, 1);
  assert.ok(s.mealie.state.entries.some((e) => e.id === 1));
  assert.ok(s.mealie.state.entries.some((e) => e.id === 2));
  assert.equal(s.mealie.state.entries.length, 3);
});
test("review rejects duplicate nights, stale recipes and changed Mealie dinners", async (t) => {
  const s = setup(t),
    r = await planner(s);
  await assert.rejects(
    s.service.review(
      r.id,
      {
        assignments: r.matches.map((m) => ({
          recipeId: m.id,
          date: r.dates[0],
        })),
      },
      1,
    ),
    { status: 400 },
  );
  const reviewed = await s.service.review(
    r.id,
    { assignments: assignments(r) },
    1,
  );
  s.mealie.state.entries.push(planEntry(99, r.dates[0]));
  await assert.rejects(s.service.publish(r.id, reviewed.review.token, 1), {
    status: 409,
  });
  assert.equal(s.mealie.state.writes.length, 0);
  assert.equal(s.store.operation(r.id), null);
});
test("picker planned pool deduplicates dinner recipes and ignores notes, lunches, past and distant dates", async (t) => {
  const s = setup(t);
  s.mealie.state.entries = [
    planEntry(1, "2026-10-24"),
    planEntry(2, "2026-10-25"),
    planEntry(3, "2026-10-26", null),
    planEntry(4, "2026-10-25", recipes[1].id, "lunch"),
    planEntry(5, "2026-10-23", recipes[2].id),
    planEntry(6, "2026-10-31", recipes[3].id),
  ];
  const r = await s.service.start({ mode: "picker", source: "mealplan" }, 1);
  assert.equal(r.total, 1);
  assert.equal(r.current.planned.length, 2);
});
test("planned winner swaps dates while preserving entry details and unrelated dinners", async (t) => {
  const s = setup(t);
  const a = planEntry(1, "2026-10-24"),
    b = {
      ...planEntry(2, "2026-10-27", recipes[1].id),
      recipeScale: 2,
      text: "Keep my notes",
    };
  s.mealie.state.entries = [a, b, planEntry(3, "2026-10-24", recipes[2].id)];
  const r = await s.service.start({ mode: "picker", source: "mealplan" }, 1);
  await match(s.service, r, [recipes[1].id]);
  await assert.rejects(s.service.review(r.id, { sourceEntryId: 2 }, 1), {
    status: 400,
  });
  const reviewed = await s.service.review(
    r.id,
    { sourceEntryId: 2, targetEntryId: 1 },
    1,
  );
  await s.service.publish(r.id, reviewed.review.token, 1);
  assert.equal(
    s.mealie.state.entries.find((e) => e.id === 1).date,
    "2026-10-27",
  );
  assert.equal(
    s.mealie.state.entries.find((e) => e.id === 2).date,
    "2026-10-24",
  );
  assert.equal(
    s.mealie.state.entries.find((e) => e.id === 2).text,
    "Keep my notes",
  );
  assert.equal(s.mealie.state.entries.find((e) => e.id === 2).recipeScale, 2);
  assert.equal(
    s.mealie.state.entries.find((e) => e.id === 3).date,
    "2026-10-24",
  );
});
test("planned winner moves to an empty night, and an already-tonight winner needs no write", async (t) => {
  const s = setup(t);
  s.mealie.state.entries = [planEntry(2, "2026-10-27", recipes[1].id)];
  let r = await s.service.start({ mode: "picker", source: "mealplan" }, 1);
  await match(s.service, r, [recipes[1].id]);
  let reviewed = await s.service.review(r.id, { sourceEntryId: 2 }, 1);
  await s.service.publish(r.id, reviewed.review.token, 1);
  assert.equal(s.mealie.state.entries[0].date, "2026-10-24");
  r = await s.service.start({ mode: "picker", source: "mealplan" }, 1);
  await match(s.service, r, [recipes[1].id]);
  reviewed = await s.service.review(r.id, { sourceEntryId: 2 }, 1);
  const n = s.mealie.state.writes.length;
  await s.service.publish(r.id, reviewed.review.token, 1);
  assert.equal(s.mealie.state.writes.length, n);
});
test("recipe winner replaces chosen dinner only and expires at local midnight", async (t) => {
  const s = setup(t);
  s.mealie.state.entries = [
    planEntry(1, "2026-10-24"),
    planEntry(2, "2026-10-24"),
  ];
  let r = await s.service.start({ mode: "picker", source: "recipes" }, 1);
  await match(s.service, r, [recipes[2].id]);
  const reviewed = await s.service.review(r.id, { targetEntryId: 1 }, 1);
  await s.service.publish(r.id, reviewed.review.token, 1);
  assert.ok(s.mealie.state.entries.some((e) => e.id === 2));
  assert.ok(!s.mealie.state.entries.some((e) => e.id === 1));
  assert.ok(s.mealie.state.entries.some((e) => e.recipeId === recipes[2].id));
  r = await s.service.start({ mode: "picker", source: "recipes" }, 1);
  s.setDay("2026-10-25");
  assert.equal((await s.service.current(1)).status, "expired");
});
test("Mealie outage pauses voting without losing saved progress; cancellation frees the round", async (t) => {
  const s = setup(t),
    r = await s.service.start({ mode: "planner" }, 1);
  await s.service.vote(r.id, 1, recipes[0].id, true);
  s.mealie.state.status = 503;
  await assert.rejects(s.service.vote(r.id, 2, recipes[0].id, true), {
    status: 502,
  });
  assert.deepEqual(s.store.get(r.id).votes[2], {});
  s.mealie.state.status = 200;
  await s.service.cancel(r.id, 1);
  assert.notEqual(
    (await s.service.start({ mode: "picker", source: "recipes" }, 1)).id,
    r.id,
  );
});
for (const type of ["create", "delete"])
  test(`interrupted ${type} response is reconciled on retry without duplicate writes`, async (t) => {
    const s = setup(t);
    s.mealie.state.entries = [planEntry(1, "2026-10-26")];
    const r = await planner(s),
      reviewed = await s.service.review(
        r.id,
        { assignments: assignments(r) },
        1,
      );
    s.mealie.state.fail = { type, when: "after", remaining: 1 };
    await assert.rejects(s.service.publish(r.id, reviewed.review.token, 1), {
      status: 502,
    });
    assert.equal(s.store.get(r.id).status, "sync_error");
    await assert.rejects(s.service.cancel(r.id, 1), { status: 409 });
    const done = await s.service.publish(r.id, reviewed.review.token, 1);
    assert.equal(done.status, "complete");
    assert.equal(s.mealie.state.entries.length, 7);
    assert.equal(
      s.mealie.state.writes.filter((w) => w.type === "create").length,
      7,
    );
  });
test("interrupted swap survives database reopen and completes the other date update", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dinder-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = createStore(join(dir, "v2.sqlite"));
  const mealie = memoryMealie();
  mealie.state.entries = [
    planEntry(1, "2026-10-24"),
    planEntry(2, "2026-10-26", recipes[1].id),
  ];
  let service = createRounds(store, mealie, { day: () => "2026-10-24" });
  const r = await service.start({ mode: "picker", source: "mealplan" }, 1);
  await match(service, r, [recipes[1].id]);
  const reviewed = await service.review(
    r.id,
    { sourceEntryId: 2, targetEntryId: 1 },
    1,
  );
  mealie.state.fail = { type: "update", when: "after", remaining: 1 };
  await assert.rejects(service.publish(r.id, reviewed.review.token, 1));
  store.db.close();
  store = createStore(join(dir, "v2.sqlite"));
  t.after(() => store.db.close());
  service = createRounds(store, mealie, { day: () => "2026-10-24" });
  assert.equal(
    (await service.publish(r.id, reviewed.review.token, 2)).status,
    "complete",
  );
  assert.equal(
    mealie.state.writes.filter((w) => w.type === "update").length,
    2,
  );
});
test("external edits during a partial save are preserved and reported as conflicts", async (t) => {
  const s = setup(t),
    r = await planner(s),
    reviewed = await s.service.review(r.id, { assignments: assignments(r) }, 1);
  s.mealie.state.fail = { type: "create", when: "after", remaining: 1 };
  await assert.rejects(s.service.publish(r.id, reviewed.review.token, 1));
  s.mealie.state.entries[0].text = "Edited by someone else";
  await assert.rejects(s.service.publish(r.id, reviewed.review.token, 1), {
    status: 409,
  });
  assert.equal(s.mealie.state.entries.length, 1);
  assert.equal(s.mealie.state.entries[0].text, "Edited by someone else");
});

test("recipe deletion after review reopens the draft before a save operation starts", async (t) => {
  const s = setup(t),
    r = await planner(s),
    reviewed = await s.service.review(r.id, { assignments: assignments(r) }, 1);
  s.mealie.state.recipes = s.mealie.state.recipes.filter(
    (m) => m.id !== r.matches[0].id,
  );
  await assert.rejects(s.service.publish(r.id, reviewed.review.token, 1), {
    status: 409,
  });
  assert.equal(s.store.operation(r.id), null);
  assert.equal(s.store.get(r.id).matches.length, 6);
  assert.equal(s.store.get(r.id).status, "swiping");
});
test("completed operation recovers a crash before the final session state is stored", async (t) => {
  const s = setup(t),
    r = await planner(s),
    reviewed = await s.service.review(r.id, { assignments: assignments(r) }, 1);
  await s.service.publish(r.id, reviewed.review.token, 1);
  const persisted = s.store.get(r.id);
  persisted.status = "publishing";
  persisted.result = null;
  s.store.save(persisted);
  assert.equal(
    (await s.service.publish(r.id, reviewed.review.token, 1)).status,
    "complete",
  );
  assert.ok(s.store.get(r.id).result.length);
});
