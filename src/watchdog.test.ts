import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// Config mock: CONTAINER_TIMEOUT=60_000, IDLE_TIMEOUT=60_000
// → WATCHDOG_TIMEOUT_MS = max(60_000, 60_000) + 5*60_000 = 360_000
vi.mock('./config.js', () => ({
  CONTAINER_TIMEOUT: 60_000,
  IDLE_TIMEOUT: 60_000,
}));
const MOCK_CONTAINER_TIMEOUT = 60_000;

import {
  WATCHDOG_TIMEOUT_MS,
  startWatchdog,
  stopWatchdog,
  watchdogHeartbeat,
  watchdogRegisterRun,
  watchdogUnregisterRun,
  _resetWatchdogState,
} from './watchdog.js';

describe('watchdog', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    _resetWatchdogState();
  });

  afterEach(() => {
    stopWatchdog();
    vi.useRealTimers();
    exitSpy.mockRestore();
    _resetWatchdogState();
  });

  it('WATCHDOG_TIMEOUT_MS is computed from config', () => {
    // max(60_000, 60_000) + 5 * 60_000 = 360_000
    expect(WATCHDOG_TIMEOUT_MS).toBe(MOCK_CONTAINER_TIMEOUT + 5 * 60_000);
  });

  it('does not exit when no runs are registered', () => {
    startWatchdog();
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS + 60_000);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does not exit when run is registered but within timeout', () => {
    startWatchdog();
    watchdogRegisterRun('c1');
    // advance less than the timeout
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS - 1000);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) when a run exceeds the timeout', () => {
    startWatchdog();
    watchdogRegisterRun('c1');

    // Advance past the timeout: interval fires at 30k, 60k, ..., until elapsed > WATCHDOG_TIMEOUT_MS
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS + 30_001);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not exit after run is unregistered', () => {
    startWatchdog();
    watchdogRegisterRun('c1');
    watchdogUnregisterRun('c1');

    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS + 30_001);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('heartbeat resets the activity clock, preventing premature exit', () => {
    startWatchdog();
    watchdogRegisterRun('c1');

    // Advance to just under the timeout (intervals fire at 30k, 60k, ..., 330k;
    // each sees elapsed < WATCHDOG_TIMEOUT_MS → no exit)
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS - 1);
    expect(exitSpy).not.toHaveBeenCalled();

    // Heartbeat resets the activity clock to current fake time
    watchdogHeartbeat('c1');

    // Another full timeout - 1ms elapses from the heartbeat; still safe
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS - 1);
    expect(exitSpy).not.toHaveBeenCalled();

    // Push past the timeout since the heartbeat — next interval fires and exits
    vi.advanceTimersByTime(30_001);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('heartbeat on unknown id is a no-op', () => {
    startWatchdog();
    // Should not throw
    watchdogHeartbeat('nonexistent');
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS + 60_000);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('stopWatchdog prevents exit after being called', () => {
    startWatchdog();
    watchdogRegisterRun('c1');
    stopWatchdog();

    vi.setSystemTime(new Date(Date.now() + WATCHDOG_TIMEOUT_MS + 1));
    vi.advanceTimersByTime(30_001);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('multiple concurrent runs — exits if any exceeds timeout', () => {
    startWatchdog();
    watchdogRegisterRun('c1');
    watchdogRegisterRun('c2');
    watchdogUnregisterRun('c1'); // c1 finishes normally, c2 remains stuck

    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS + 30_001);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
