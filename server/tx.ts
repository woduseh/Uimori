import type { DatabaseSync } from 'node:sqlite';
import type { SynchronousResult } from './synchronous-transaction.js';

declare const txBrand: unique symbol;

export type Tx = { readonly [txBrand]: 'uimori-tx' };

export type TxPort = {
  readonly transaction: <T>(fn: (tx: Tx) => SynchronousResult<T>) => SynchronousResult<T>;
};

const activeTxs = new WeakSet<Tx>();

export function assertTx(tx: Tx, db?: DatabaseSync): void {
  if (!activeTxs.has(tx) || (db !== undefined && !db.isTransaction))
    throw new Error('TRANSACTION_REQUIRED');
}

export function createTxPort(
  db: DatabaseSync,
  runTransaction: <T>(fn: () => SynchronousResult<T>) => SynchronousResult<T>
): TxPort {
  return {
    transaction<T>(fn: (tx: Tx) => SynchronousResult<T>): SynchronousResult<T> {
      return runTransaction(() => {
        if (!db.isTransaction) throw new Error('TRANSACTION_REQUIRED');
        const tx = Object.freeze({}) as Tx;
        activeTxs.add(tx);
        try {
          return fn(tx);
        } finally {
          activeTxs.delete(tx);
        }
      });
    },
  };
}
