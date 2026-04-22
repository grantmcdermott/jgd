import { assertEquals } from "@std/assert";
import { settleTimeoutPath } from "./run.ts";

Deno.test("settleTimeoutPath returns after collectors settle", async () => {
  const start = Date.now();
  await settleTimeoutPath(
    Promise.resolve(),
    [Promise.resolve(), Promise.resolve()],
    20,
  );
  const elapsed = Date.now() - start;
  assertEquals(elapsed < 200, true);
});

Deno.test("settleTimeoutPath bounds collector wait when collectors never close", async () => {
  const never = new Promise<void>(() => {});
  const start = Date.now();
  await settleTimeoutPath(Promise.resolve(), [never, never], 50);
  const elapsed = Date.now() - start;
  assertEquals(elapsed >= 50, true);
  assertEquals(elapsed < 400, true);
});
