import { DatabaseSync } from "node:sqlite";
// Dinners in a meal plan.
export const WEEK = 7;
// Errors meant for the person using the app; anything else is reported as a server fault.
export const userError = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export function createStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS profiles(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
 INSERT OR IGNORE INTO profiles VALUES(1,'Me'),(2,'Partner');
 CREATE TABLE IF NOT EXISTS meals(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,photo TEXT NOT NULL DEFAULT '',recipe TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',emoji TEXT NOT NULL DEFAULT '🍽️');
 CREATE TABLE IF NOT EXISTS rounds(id INTEGER PRIMARY KEY AUTOINCREMENT,meals TEXT NOT NULL,winner INTEGER,status TEXT NOT NULL DEFAULT 'active',created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE UNIQUE INDEX IF NOT EXISTS one_active ON rounds(status) WHERE status='active';
 CREATE TABLE IF NOT EXISTS votes(round_id INTEGER REFERENCES rounds(id),profile_id INTEGER REFERENCES profiles(id),meal_id INTEGER,liked INTEGER NOT NULL,PRIMARY KEY(round_id,profile_id,meal_id));`);
  // Existing rounds already retain meal snapshots; add the exact match time for new matches.
  if (
    !db
      .prepare("PRAGMA table_info(rounds)")
      .all()
      .some((column) => column.name === "matched_at")
  ) {
    db.exec("ALTER TABLE rounds ADD COLUMN matched_at TEXT");
  }
  // A round ends once it has `goal` shared yeses: 1 for a quick match, WEEK for a meal plan.
  if (
    !db
      .prepare("PRAGMA table_info(rounds)")
      .all()
      .some((column) => column.name === "goal")
  ) {
    db.exec("ALTER TABLE rounds ADD COLUMN goal INTEGER NOT NULL DEFAULT 1");
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS round_matches(round_id INTEGER NOT NULL REFERENCES rounds(id),meal_id INTEGER NOT NULL,matched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(round_id,meal_id))",
  );
  const timestamp = (value) => (value ? value.replace(" ", "T") + "Z" : null);
  // Shared yeses in the order they happened, as snapshots from the round's deck.
  function matchesOf(round, deck = JSON.parse(round.meals)) {
    return db
      .prepare(
        "SELECT meal_id FROM round_matches WHERE round_id=? ORDER BY rowid",
      )
      .all(round.id)
      .map((row) => deck.find((meal) => meal.id === row.meal_id));
  }
  function history() {
    return db
      .prepare(
        "SELECT id,meals,winner,goal,status,created,matched_at FROM rounds WHERE status='matched' OR (goal>1 AND status='exhausted' AND EXISTS(SELECT 1 FROM round_matches WHERE round_id=rounds.id)) ORDER BY COALESCE(matched_at,created) DESC,id DESC",
      )
      .all()
      .map((round) => {
        const entry = {
          id: round.id,
          startedAt: timestamp(round.created),
          matchedAt: timestamp(round.matched_at),
        };
        if (round.goal === 1)
          return {
            ...entry,
            kind: "match",
            meal: JSON.parse(round.meals).find(
              (meal) => meal.id === round.winner,
            ),
          };
        return {
          ...entry,
          kind: "plan",
          goal: round.goal,
          complete: round.status === "matched",
          meals: matchesOf(round),
        };
      });
  }
  const profiles = () => db.prepare("SELECT * FROM profiles ORDER BY id").all();
  const meals = () => db.prepare("SELECT * FROM meals ORDER BY id DESC").all();
  // A meal plan swipes the whole collection (or the chosen meals) until WEEK shared yeses.
  function start(ids, plan = false) {
    const goal = plan ? WEEK : 1;
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db
        .prepare("SELECT * FROM rounds WHERE status='active'")
        .get();
      if (existing) {
        db.exec("COMMIT");
        return existing;
      }
      let chosen = meals();
      if (ids) {
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.some((id) => !chosen.some((m) => m.id === id))
        )
          throw userError("Choose meals from your collection.");
        chosen = chosen.filter((m) => ids.includes(m.id));
      } else {
        for (let i = chosen.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
        }
        if (!plan) chosen = chosen.slice(0, 10);
      }
      if (!chosen.length) throw userError("Add a meal before starting a round.");
      if (chosen.length < goal)
        throw userError(`Add at least ${goal} meals to plan a week.`);
      const result = db
        .prepare("INSERT INTO rounds(meals,goal) VALUES(?,?)")
        .run(JSON.stringify(chosen), goal);
      const round = db
        .prepare("SELECT * FROM rounds WHERE id=?")
        .get(Number(result.lastInsertRowid));
      db.exec("COMMIT");
      return round;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  function state(profile, id) {
    const round = id
      ? db.prepare("SELECT * FROM rounds WHERE id=?").get(id)
      : db.prepare("SELECT * FROM rounds ORDER BY id DESC LIMIT 1").get();
    if (!round) return null;
    const deck = JSON.parse(round.meals);
    // A seeded shuffle gives each profile a stable, independent deck after refresh.
    const ordered = [...deck];
    let seed = (round.id * 2654435761 + profile * 1013904223) >>> 0;
    for (let i = ordered.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const j = seed % (i + 1);
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }
    const own = db
      .prepare(
        "SELECT meal_id,liked FROM votes WHERE round_id=? AND profile_id=?",
      )
      .all(round.id, profile);
    const counts = db
      .prepare(
        "SELECT profile_id,COUNT(*) AS count FROM votes WHERE round_id=? GROUP BY profile_id",
      )
      .all(round.id);
    return {
      ...round,
      meals: ordered,
      votes: own,
      progress: profiles().map((p) => ({
        id: p.id,
        count: counts.find((c) => c.profile_id === p.id)?.count || 0,
      })),
      winner: deck.find((m) => m.id === round.winner) || null,
      matches: matchesOf(round, deck),
    };
  }
  function vote(roundId, profile, mealId, liked) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = db.prepare("SELECT * FROM rounds WHERE id=?").get(roundId);
      if (!r) throw userError("Round not found.", 404);
      if (!JSON.parse(r.meals).some((m) => m.id === mealId))
        throw userError("Meal is not in this round.");
      if (r.status === "active") {
        const cast = db
          .prepare("INSERT OR IGNORE INTO votes VALUES(?,?,?,?)")
          .run(roundId, profile, mealId, liked ? 1 : 0);
        // Only the vote just cast can create a new shared yes, and only for its own meal.
        const mutual =
          cast.changes &&
          liked &&
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM votes WHERE round_id=? AND meal_id=? AND liked=1",
            )
            .get(roundId, mealId).n === 2;
        if (mutual)
          db.prepare(
            "INSERT OR IGNORE INTO round_matches(round_id,meal_id) VALUES(?,?)",
          ).run(roundId, mealId);
        const found = db
          .prepare("SELECT COUNT(*) AS n FROM round_matches WHERE round_id=?")
          .get(roundId).n;
        if (mutual && found >= r.goal)
          db.prepare(
            "UPDATE rounds SET winner=?,status='matched',matched_at=CURRENT_TIMESTAMP WHERE id=?",
          ).run(r.goal === 1 ? mealId : null, roundId);
        else if (
          db
            .prepare("SELECT COUNT(*) AS n FROM votes WHERE round_id=?")
            .get(roundId).n ===
          JSON.parse(r.meals).length * 2
        )
          db.prepare("UPDATE rounds SET status='exhausted' WHERE id=?").run(
            roundId,
          );
      }
      db.exec("COMMIT");
      return state(profile, roundId);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return { db, profiles, meals, start, state, vote, history };
}
