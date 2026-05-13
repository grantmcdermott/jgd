/**
 * Timestamped logger for tests.
 *
 * Always emits UTC ISO timestamps so CI logs can be compared across runners.
 */
export function testLog(message: string): void {
  console.log(`[test-step] ${new Date().toISOString()} | ${message}`);
}
