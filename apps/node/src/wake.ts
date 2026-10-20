/**
 * Lets the Node's loops sleep until the backend has something for them (#169). The Node
 * used to ask Convex about three times a second while idle, which used up the free plan's
 * monthly function calls in about two days. Now a live subscription to this computer's
 * pending commands wakes every waiting loop at once; the timeout is only a safety net.
 */
export class Wake {
  readonly #waiters = new Set<() => void>();
  /** When the last wake came, 0 before the first. */
  lastWakeAt = 0;
  /** Resolves on the next wake() or after `ms`, whichever comes first. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#waiters.add(done);
    });
  }
  /** Wakes every loop that is waiting now. */
  wake(): void {
    this.lastWakeAt = Date.now();
    for (const done of [...this.#waiters]) done();
  }
}

/** While work is happening the loops stay quick; idle, they rest for this long. */
export const BUSY_PAUSE_MS = 1_000;
export const IDLE_PAUSE_MS = 120_000;
/** The loops stay quick for this long after the last sign of work. */
export const BUSY_FOR_MS = 60_000;
/** How often the Node reports that it is online (convex/lib/devices.ts allows 150 s). */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Waits before the next start attempt when the backend refuses the Node: 15 s, doubling,
 * at most 10 minutes. Exiting instead made launchd restart it every few seconds, about
 * 35,000 times while the backend was disabled (2026-10).
 */
export function retryDelay(attempt: number): number {
  return Math.min(15_000 * 2 ** Math.max(0, attempt), 600_000);
}
