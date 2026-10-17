import { DatabaseSync } from "node:sqlite";
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
  function history() {
    return db
      .prepare(
        "SELECT id,meals,winner,created,matched_at FROM rounds WHERE status='matched' ORDER BY COALESCE(matched_at,created) DESC,id DESC",
      )
      .all()
      .map((round) => ({
        id: round.id,
        startedAt: round.created.replace(" ", "T") + "Z",
        matchedAt: round.matched_at ? round.matched_at.replace(" ", "T") + "Z" : null,
        meal: JSON.parse(round.meals).find((meal) => meal.id === round.winner),
      }));
  }
  const profiles = () => db.prepare("SELECT * FROM profiles ORDER BY id").all();
  const meals = () => db.prepare("SELECT * FROM meals ORDER BY id DESC").all();
  function start(ids) {
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
        chosen = chosen.slice(0, 10);
      }
      if (!chosen.length) throw userError("Add a meal before starting a round.");
      const result = db
        .prepare("INSERT INTO rounds(meals) VALUES(?)")
        .run(JSON.stringify(chosen));
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
        db.prepare("INSERT OR IGNORE INTO votes VALUES(?,?,?,?)").run(
          roundId,
          profile,
          mealId,
          liked ? 1 : 0,
        );
        const mutual = db
          .prepare(
            "SELECT meal_id FROM votes WHERE round_id=? AND liked=1 GROUP BY meal_id HAVING COUNT(*)=2 LIMIT 1",
          )
          .get(roundId);
        if (mutual)
          db.prepare(
            "UPDATE rounds SET winner=?,status='matched',matched_at=CURRENT_TIMESTAMP WHERE id=?",
          ).run(mutual.meal_id, roundId);
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
