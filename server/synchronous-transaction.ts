/** Every possible callback result must complete before a SQLite transaction returns. */
export type SynchronousResult<T> = T &
  (Extract<T, PromiseLike<unknown>> extends never ? unknown : never);
