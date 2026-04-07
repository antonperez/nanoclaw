/**
 * Process-level watchdog for container agent runs.
 *
 * Tracks active container runs. If any run stays alive longer than
 * WATCHDOG_TIMEOUT_MS, we force process.exit(1) so Docker's restart
 * policy can recover. This is a safety net for cases where the
 * credential proxy timeout or container hard-kill mechanism fails.
 */
import { logger } from './logger.js';
import { CONTAINER_TIMEOUT, IDLE_TIMEOUT } from './config.js';

const CHECK_INTERVAL_MS = 30_000;

// Allow an extra 5-minute grace window beyond the container's own hard timeout
// (CONTAINER_TIMEOUT or IDLE_TIMEOUT, whichever is larger).
export const WATCHDOG_TIMEOUT_MS = parseInt(
  process.env.WATCHDOG_TIMEOUT_MS ||
    String(Math.max(CONTAINER_TIMEOUT, IDLE_TIMEOUT) + 5 * 60_000),
  10,
);

// containerName/runId -> last-activity timestamp (ms).
// Updated on any container output so long-running active tasks don't trip the watchdog.
const activeRuns = new Map<string, number>();

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/** Call when a container run starts. */
export function watchdogRegisterRun(id: string): void {
  activeRuns.set(id, Date.now());
}

/** Call on any activity (output) from a container run to reset its idle clock. */
export function watchdogHeartbeat(id: string): void {
  if (activeRuns.has(id)) {
    activeRuns.set(id, Date.now());
  }
}

/** Call when a container run ends (success, error, or timeout). */
export function watchdogUnregisterRun(id: string): void {
  activeRuns.delete(id);
}

export function startWatchdog(): void {
  if (WATCHDOG_TIMEOUT_MS <= 0) {
    logger.info('Watchdog disabled (WATCHDOG_TIMEOUT_MS=0)');
    return;
  }

  watchdogTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, startTime] of activeRuns) {
      const elapsed = now - startTime;
      if (elapsed > WATCHDOG_TIMEOUT_MS) {
        logger.fatal(
          { id, elapsedMs: elapsed, watchdogTimeoutMs: WATCHDOG_TIMEOUT_MS },
          'Watchdog: agent run stuck beyond timeout — forcing process exit for Docker restart',
        );
        process.exit(1);
      }
    }
  }, CHECK_INTERVAL_MS);

  // unref so the watchdog timer does not prevent a clean voluntary shutdown
  watchdogTimer.unref();
  logger.info({ timeoutMs: WATCHDOG_TIMEOUT_MS }, 'Watchdog started');
}

export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/** For tests only — clears all tracked runs without affecting the timer. */
export function _resetWatchdogState(): void {
  activeRuns.clear();
}
