/** Serialize refreshes per key, with a trailing pass for events received in flight. */
export function coalescedRefresh() {
  const running = new Map<string, { again: boolean; promise: Promise<void> }>();
  return (key: string, refresh: () => Promise<void>): Promise<void> => {
    const current = running.get(key);
    if (current) {
      current.again = true;
      return current.promise;
    }
    const entry = { again: false, promise: Promise.resolve() };
    running.set(key, entry);
    entry.promise = Promise.resolve().then(async () => {
      try {
        do {
          entry.again = false;
          await refresh();
        } while (entry.again);
      } finally {
        running.delete(key);
      }
    });
    return entry.promise;
  };
}
