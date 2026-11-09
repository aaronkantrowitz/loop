import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Ordered, append-only migrations. `PRAGMA user_version` records how many have run.
 * Timestamps are stored as ISO-8601 UTC strings with millisecond precision, which sort lexically.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE repositories (
    id             INTEGER PRIMARY KEY,
    slug           TEXT NOT NULL UNIQUE,      -- lower-cased "owner/name"
    owner          TEXT NOT NULL,
    name           TEXT NOT NULL,
    default_branch TEXT,
    coverage_from  TEXT,                      -- every PR updated at or after this instant is stored
    synced_at      TEXT                       -- start time of the last successful sync
  );

  CREATE TABLE pull_requests (
    repo_id        INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    number         INTEGER NOT NULL,
    author         TEXT,                      -- null when the GitHub account was deleted
    author_is_bot  INTEGER NOT NULL,
    state          TEXT NOT NULL,
    is_draft       INTEGER NOT NULL,
    base_ref       TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    merged_at      TEXT,
    closed_at      TEXT,
    merged_by      TEXT,
    additions      INTEGER NOT NULL,
    deletions      INTEGER NOT NULL,
    changed_files  INTEGER NOT NULL,
    reviews_total  INTEGER NOT NULL,          -- GitHub's count, to detect truncated review lists
    PRIMARY KEY (repo_id, number)
  );
  CREATE INDEX pull_requests_updated ON pull_requests (repo_id, updated_at);

  CREATE TABLE reviews (
    id             TEXT PRIMARY KEY,          -- GitHub node id
    repo_id        INTEGER NOT NULL,
    pr_number      INTEGER NOT NULL,
    author         TEXT,
    author_is_bot  INTEGER NOT NULL,
    state          TEXT NOT NULL,
    submitted_at   TEXT NOT NULL,
    comment_count  INTEGER NOT NULL,
    FOREIGN KEY (repo_id, pr_number) REFERENCES pull_requests(repo_id, number) ON DELETE CASCADE
  );
  CREATE INDEX reviews_pr ON reviews (repo_id, pr_number);

  CREATE TABLE narratives (
    cache_key      TEXT PRIMARY KEY,          -- sha256 of model + prompt version + facts
    created_at     TEXT NOT NULL,
    payload        TEXT NOT NULL
  );
  `,
];

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
