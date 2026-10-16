/**
 * Helpers for the few tests that assert on speed (render speed, kernel cost, analysis time).
 *
 * The suite runs on busy machines (several workers, Chrome, other agents), where the wall clock mostly measures
 * how long the process waited for a core. Two defences, used together:
 *
 *  - `cpuNow()`: the CPU time this process has spent, in ms, where the runtime can tell (Node: a worker process is
 *    single-threaded for our code, so this is the cost of the code under test and ignores time spent waiting for a
 *    core). The browser has no such clock and falls back to `performance.now()`.
 *  - `settle()`: take the best of several attempts and stop at the first that passes. Interference only ever
 *    adds time, so the best attempt is the honest one, and a quiet machine pays for one attempt only.
 *
 * They live in `@agstudio/sdk/testing` (plugin tests may import nothing from outside the SDK); this re-exports them.
 */
export { cpuNow, settle, type Better } from '@agstudio/sdk/testing';
