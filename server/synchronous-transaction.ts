export type SynchronousResult<T> = T &
  (Extract<T, PromiseLike<unknown>> extends never ? unknown : never);
