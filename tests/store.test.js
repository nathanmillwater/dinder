import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.js";
function setup(count = 12) {
  const s = createStore(":memory:");
  for (let i = 1; i <= count; i++)
    s.db.prepare("INSERT INTO meals(name) VALUES(?)").run("Meal " + i);
  return s;
}
test("empty collection refuses a round", () => {
  const s = setup(0);
  assert.throws(() => s.start(), /Add a meal/);
  assert.equal(s.state(1), null);
  s.db.close();
});
test("random shortlist is unique, limited to ten, shared by profiles, and repeated starts join", () => {
  const s = setup();
  const r = s.start();
  const a = s.state(1),
    b = s.state(2);
  assert.equal(a.meals.length, 10);
  assert.equal(new Set(a.meals.map((m) => m.id)).size, 10);
  assert.deepEqual(
    a.meals.map((m) => m.id).sort(),
    b.meals.map((m) => m.id).sort(),
  );
  assert.equal(s.start().id, r.id);
  s.db.close();
});
test("different swipe order yields one immutable shared winner and hides partner votes", () => {
  const s = setup(3),
    r = s.start(),
    [a, b] = s.state(1).meals;
  s.vote(r.id, 1, a.id, true);
  s.vote(r.id, 2, b.id, true);
  assert.equal(s.state(2).votes.length, 1);
  assert.equal(s.state(2).votes[0].meal_id, b.id);
  const match = s.vote(r.id, 2, a.id, true);
  assert.equal(match.status, "matched");
  assert.equal(match.winner.id, a.id);
  s.vote(r.id, 1, b.id, true);
  assert.equal(s.state(1).winner.id, a.id);
  assert.equal(s.state(2).winner.id, a.id);
  s.db.close();
});
test("duplicate submissions do not change votes or progress", () => {
  const s = setup(1),
    r = s.start(),
    id = s.state(1).meals[0].id;
  s.vote(r.id, 1, id, true);
  s.vote(r.id, 1, id, false);
  assert.equal(s.state(1).votes.length, 1);
  assert.equal(s.state(1).votes[0].liked, 1);
  assert.equal(s.vote(r.id, 2, id, true).status, "matched");
  s.db.close();
});
test("first finisher waits; both finishing with no match allows fresh round", () => {
  const s = setup(3),
    r = s.start();
  for (const m of s.state(1).meals) s.vote(r.id, 1, m.id, false);
  assert.equal(s.state(1).status, "active");
  for (const m of s.state(2).meals) s.vote(r.id, 2, m.id, true);
  assert.equal(s.state(1).status, "exhausted");
  assert.notEqual(s.start().id, r.id);
  s.db.close();
});
test("meal snapshots survive edits and deletion and custom selection is validated", () => {
  const s = setup(2);
  assert.throws(() => s.start([999]), /Choose meals/);
  const r = s.start([1]);
  s.db.exec(
    "UPDATE meals SET name='Changed' WHERE id=1;DELETE FROM meals WHERE id=1",
  );
  assert.equal(s.state(1).meals[0].name, "Meal 1");
  assert.throws(() => s.vote(r.id, 1, 2, true), /not in this round/);
  s.vote(r.id, 1, 1, true);
  assert.equal(s.vote(r.id, 2, 1, true).winner.name, "Meal 1");
  s.db.close();
});

test("database survives closing and reopening with round progress intact", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = mkdtempSync(join(tmpdir(), "dinder-"));
  try {
    let s = createStore(join(folder, "db.sqlite"));
    s.db.prepare("INSERT INTO meals(name) VALUES(?)").run("Dinner");
    const round = s.start();
    s.vote(round.id, 1, 1, true);
    s.db.close();
    s = createStore(join(folder, "db.sqlite"));
    assert.equal(s.meals()[0].name, "Dinner");
    assert.equal(s.state(1).votes.length, 1);
    assert.equal(s.vote(round.id, 2, 1, true).winner.name, "Dinner");
    s.db.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("history contains only successful matches, preserves snapshots, and never duplicates retries", () => {
  const s = setup(2);
  assert.deepEqual(s.history(), []);
  const first = s.start([1]);
  s.vote(first.id, 1, 1, true);
  assert.deepEqual(s.history(), []);
  s.vote(first.id, 2, 1, true);
  s.vote(first.id, 2, 1, true);
  assert.equal(s.history().length, 1);
  assert.ok(s.history()[0].matchedAt.endsWith("Z"));
  assert.ok(s.history()[0].matchedAt.includes("T"));
  s.db.exec(
    "UPDATE meals SET name='Edited' WHERE id=1;DELETE FROM meals WHERE id=1",
  );
  assert.equal(s.history()[0].meal.name, "Meal 1");
  const noMatch = s.start([2]);
  s.vote(noMatch.id, 1, 2, false);
  s.vote(noMatch.id, 2, 2, true);
  assert.equal(s.history().length, 1);
  const last = s.start([2]);
  s.vote(last.id, 1, 2, true);
  s.vote(last.id, 2, 2, true);
  assert.deepEqual(
    s.history().map((m) => m.id),
    [last.id, first.id],
  );
  s.db.close();
});

test("history migration retains legacy matches and remains safe on repeated startup", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "dinder-history-"));
  const file = join(dir, "db.sqlite");
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec(
      "CREATE TABLE rounds(id INTEGER PRIMARY KEY AUTOINCREMENT,meals TEXT NOT NULL,winner INTEGER,status TEXT NOT NULL DEFAULT 'active',created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    legacy
      .prepare("INSERT INTO rounds(meals,winner,status) VALUES(?,1,'matched')")
      .run(
        JSON.stringify([
          {
            id: 1,
            name: "Old favourite",
            photo: "",
            recipe: "https://example.com",
            notes: "",
            emoji: "🍝",
          },
        ]),
      );
    legacy.close();
    let s = createStore(file);
    assert.equal(s.history()[0].meal.name, "Old favourite");
    assert.equal(s.history()[0].matchedAt, null);
    assert.ok(s.history()[0].startedAt.endsWith("Z"));
    s.db.close();
    s = createStore(file);
    assert.equal(s.history().length, 1);
    s.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("meal plans need a week of meals and swipe the whole collection", () => {
  let s = setup(6);
  assert.throws(() => s.start(undefined, true), /at least 7 meals/);
  s.db.close();
  s = setup(12);
  const r = s.start(undefined, true);
  assert.equal(r.goal, 7);
  assert.equal(s.state(1).meals.length, 12);
  assert.equal(s.start().id, r.id);
  s.db.close();
});

test("meal plans collect shared yeses in order until a week is planned", () => {
  const s = setup(10),
    r = s.start(undefined, true),
    deck = s.state(1).meals;
  s.vote(r.id, 1, deck[0].id, true);
  s.vote(r.id, 2, deck[0].id, false);
  const yeses = deck.slice(1, 8).reverse();
  for (const m of yeses) s.vote(r.id, 1, m.id, true);
  for (const [i, m] of yeses.entries()) {
    const after = s.vote(r.id, 2, m.id, true);
    assert.equal(after.matches.length, i + 1);
    assert.equal(after.status, i < 6 ? "active" : "matched");
  }
  const done = s.state(2);
  assert.equal(done.winner, null);
  assert.deepEqual(
    done.matches.map((m) => m.id),
    yeses.map((m) => m.id),
  );
  s.vote(r.id, 1, deck[8].id, true);
  s.vote(r.id, 2, deck[8].id, true);
  assert.equal(s.state(1).matches.length, 7);
  const [entry] = s.history();
  assert.equal(entry.kind, "plan");
  assert.equal(entry.complete, true);
  assert.ok(entry.matchedAt.endsWith("Z"));
  assert.deepEqual(
    entry.meals.map((m) => m.id),
    yeses.map((m) => m.id),
  );
  s.db.close();
});

test("an unfinished plan keeps its partial week in history; an empty one does not", () => {
  const s = setup(7);
  const empty = s.start(undefined, true);
  for (const p of [1, 2])
    for (const m of s.state(p).meals) s.vote(empty.id, p, m.id, false);
  assert.equal(s.state(1).status, "exhausted");
  assert.deepEqual(s.history(), []);
  const partial = s.start(undefined, true);
  for (const p of [1, 2])
    for (const m of s.state(p).meals)
      s.vote(partial.id, p, m.id, m.id <= 3);
  assert.equal(s.state(1).status, "exhausted");
  const [entry] = s.history();
  assert.equal(entry.id, partial.id);
  assert.equal(entry.complete, false);
  assert.equal(entry.meals.length, 3);
  const quick = s.start([1]);
  s.vote(quick.id, 1, 1, true);
  s.vote(quick.id, 2, 1, true);
  assert.equal(s.history()[0].kind, "match");
  assert.equal(s.state(1).matches.length, 1);
  s.db.close();
});
