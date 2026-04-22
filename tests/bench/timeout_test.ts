import { assertEquals, assertRejects } from "@std/assert";
import { raceWithTimeout } from "./timeout.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test("raceWithTimeout rejects immediately when timeout fires", async () => {
  let resolveOperation: ((value: string) => void) | undefined;
  const operation = new Promise<string>((resolve) => {
    resolveOperation = resolve;
  });

  let onTimeoutCalled = false;
  let onTimeoutFinished = false;

  const raced = raceWithTimeout(
    operation,
    20,
    async () => {
      onTimeoutCalled = true;
      await sleep(80);
      onTimeoutFinished = true;
      resolveOperation?.("finished");
    },
    "timeout",
  );

  await assertRejects(() => raced, Error, "timeout");
  assertEquals(onTimeoutCalled, true);
  assertEquals(onTimeoutFinished, false);

  await sleep(120);
  assertEquals(onTimeoutFinished, true);
});

Deno.test("raceWithTimeout returns operation result before timeout", async () => {
  let onTimeoutCalled = false;

  const result = await raceWithTimeout(
    Promise.resolve("ok"),
    100,
    () => {
      onTimeoutCalled = true;
    },
    "timeout",
  );

  assertEquals(result, "ok");
  assertEquals(onTimeoutCalled, false);
});
