/**
 * An expo-sqlite stand-in backed by Node's built-in SQLite engine, so
 * tests exercise the real SQL in lib/db.ts rather than mocked query
 * results. The statements are where the data-loss bugs lived; asserting
 * on fake return values would prove nothing about them.
 *
 * Plain JS and consumed via require() so it can be used from inside a
 * hoisted jest.mock() factory:
 *
 *   jest.mock("expo-sqlite", () => require("./sqlite-mock").createExpoSqliteMock());
 */
function createExpoSqliteMock() {
  const { DatabaseSync } = require("node:sqlite");

  function wrap(raw) {
    const api = {
      execAsync: async (sql) => {
        raw.exec(sql);
      },
      runAsync: async (sql, params = []) => {
        const result = raw.prepare(sql).run(...params);
        return {
          changes: Number(result.changes),
          lastInsertRowId: Number(result.lastInsertRowid),
        };
      },
      getAllAsync: async (sql, params = []) => raw.prepare(sql).all(...params),
      getFirstAsync: async (sql, params = []) => raw.prepare(sql).get(...params) ?? null,
      withExclusiveTransactionAsync: async (fn) => {
        raw.exec("BEGIN");
        try {
          await fn(api);
          raw.exec("COMMIT");
        } catch (err) {
          raw.exec("ROLLBACK");
          throw err;
        }
      },
    };
    return api;
  }

  return { openDatabaseAsync: async () => wrap(new DatabaseSync(":memory:")) };
}

module.exports = { createExpoSqliteMock };
