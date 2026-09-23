/** Keep the current view plus four recent conversations, without truncating the open manuscript. */
export function evictHelperViews<T>(views: Map<string, T>, currentId: string): string[] {
  const removed: string[] = [];
  for (const key of views.keys()) {
    if (views.size <= 5) break;
    if (key === currentId) continue;
    views.delete(key);
    removed.push(key);
  }
  return removed;
}
