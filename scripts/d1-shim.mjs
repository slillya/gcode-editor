// A small stand-in for a Cloudflare D1 binding backed by node:sqlite, used by
// the tests and the local dev server so the Worker's real SQL runs unchanged.
import { DatabaseSync } from 'node:sqlite';

export function createD1(path = ':memory:') {
  const db = new DatabaseSync(path);
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
    },
    all: async () => ({ success: true, results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (list) => Promise.all(list.map((s) => s.run())),
  };
}
