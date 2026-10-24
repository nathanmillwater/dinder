import { DatabaseSync } from "node:sqlite";
export const userError = (message, status = 400) =>
  Object.assign(new Error(message), { status, expose: true });
export function createStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS profiles(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT OR IGNORE INTO profiles VALUES(1,'Me'),(2,'Partner');
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, closed INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_session ON sessions(closed) WHERE closed=0;
    CREATE TABLE IF NOT EXISTS operations(round_id TEXT PRIMARY KEY REFERENCES sessions(id), state TEXT NOT NULL);`);
  const parse = (row) => (row ? JSON.parse(row.state) : null);
  return {
    db,
    profiles: () => db.prepare("SELECT * FROM profiles ORDER BY id").all(),
    rename(id, name) {
      if (![1, 2].includes(id) || typeof name !== "string" || !name.trim())
        throw userError("Enter a profile name.");
      db.prepare("UPDATE profiles SET name=? WHERE id=?").run(
        name.trim().slice(0, 40),
        id,
      );
    },
    current: () =>
      parse(
        db
          .prepare("SELECT state FROM sessions ORDER BY rowid DESC LIMIT 1")
          .get(),
      ),
    get: (id) =>
      parse(db.prepare("SELECT state FROM sessions WHERE id=?").get(id)),
    save(round) {
      db.prepare(
        "INSERT INTO sessions(id,closed,state) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET closed=excluded.closed,state=excluded.state",
      ).run(
        round.id,
        ["complete", "cancelled", "expired"].includes(round.status) ? 1 : 0,
        JSON.stringify(round),
      );
      return round;
    },
    operation: (id) =>
      parse(
        db.prepare("SELECT state FROM operations WHERE round_id=?").get(id),
      ),
    saveOperation(id, operation) {
      db.prepare(
        "INSERT INTO operations VALUES(?,?) ON CONFLICT(round_id) DO UPDATE SET state=excluded.state",
      ).run(id, JSON.stringify(operation));
    },
  };
}
