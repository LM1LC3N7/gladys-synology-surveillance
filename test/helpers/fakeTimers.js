// -----------------------------------------------------------------------------
// Fake timers: nothing fires by itself, the test runs what it wants.
// -----------------------------------------------------------------------------

export function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    pending,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { id, fn, ms });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    /** The delays waiting, in creation order. */
    delays: () => [...pending.values()].map((t) => t.ms),
    /** Run (and remove) every pending timeout once; `filter` picks some by delay. */
    async run(filter = () => true) {
      for (const t of [...pending.values()].filter((t) => filter(t.ms))) {
        pending.delete(t.id);
        await t.fn();
      }
    },
  };
}
