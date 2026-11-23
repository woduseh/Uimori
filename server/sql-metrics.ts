import { AsyncLocalStorage } from 'node:async_hooks';
import { type DatabaseSync, StatementSync } from 'node:sqlite';

export type SqlUsage = { statements: number; elapsedMs: number };

const activeUsage = new AsyncLocalStorage<SqlUsage>();

export function measureSql<T>(usage: SqlUsage, run: () => T): T {
  return activeUsage.run(usage, run);
}

function measured<T>(usage: SqlUsage, statements: number, run: () => T): T {
  const startedAt = performance.now();
  try {
    return run();
  } finally {
    usage.statements += statements;
    usage.elapsedMs += performance.now() - startedAt;
  }
}

function countedCall<This, Args extends unknown[], Result>(
  original: (this: This, ...args: Args) => Result,
  statements: number
) {
  return function (this: This, ...args: Args): Result {
    const usage = activeUsage.getStore();
    if (!usage) return original.apply(this, args);
    return measured(usage, statements, () => original.apply(this, args));
  };
}

const statementMethods = StatementSync.prototype;
const measuredStatement: StatementSync = Object.create(statementMethods, {
  get: { value: countedCall(statementMethods.get, 1), writable: true, configurable: true },
  all: { value: countedCall(statementMethods.all, 1), writable: true, configurable: true },
  run: { value: countedCall(statementMethods.run, 1), writable: true, configurable: true },
  iterate: {
    value: function (this: StatementSync, ...args: Parameters<StatementSync['iterate']>) {
      const usage = activeUsage.getStore();
      if (!usage) return statementMethods.iterate.apply(this, args);
      const iterator = measured(usage, 1, () => statementMethods.iterate.apply(this, args));
      const next = iterator.next;
      iterator.next = (...nextArgs) => measured(usage, 0, () => next.apply(iterator, nextArgs));
      return iterator;
    },
    writable: true,
    configurable: true,
  },
});

export function instrumentDatabase(db: DatabaseSync): DatabaseSync {
  const prepare = countedCall(db.prepare, 0);
  db.prepare = function (this: DatabaseSync, ...args: Parameters<DatabaseSync['prepare']>) {
    return Object.setPrototypeOf(prepare.apply(this, args), measuredStatement) as StatementSync;
  };
  db.exec = countedCall(db.exec, 1);
  return db;
}
