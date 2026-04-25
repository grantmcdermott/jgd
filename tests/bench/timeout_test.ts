import { assertEquals, assertRejects } from "@std/assert";
import { raceWithTimeout } from "./timeout.ts";

Deno.test("raceWithTimeout rejects immediately when timeout fires", async () => {
  let resolveOperation: ((value: string) => void) | undefined;
  const operation = new Promise<string>((resolve) => {
    resolveOperation = resolve;
  });

  let onTimeoutCalled = false;
  let onTimeoutFinished = false;
  let releaseOnTimeout: (() => void) | undefined;
  const onTimeoutBlocker = new Promise<void>((resolve) => {
    releaseOnTimeout = resolve;
  });
  let markOnTimeoutStarted: (() => void) | undefined;
  const onTimeoutStarted = new Promise<void>((resolve) => {
    markOnTimeoutStarted = resolve;
  });
  let markOnTimeoutFinished: (() => void) | undefined;
  const onTimeoutFinishedSignal = new Promise<void>((resolve) => {
    markOnTimeoutFinished = resolve;
  });

  const raced = raceWithTimeout(
    operation,
    20,
    async () => {
      onTimeoutCalled = true;
      markOnTimeoutStarted?.();
      await onTimeoutBlocker;
      onTimeoutFinished = true;
      markOnTimeoutFinished?.();
      resolveOperation?.("finished");
    },
    "timeout",
  );

  await onTimeoutStarted;
  await assertRejects(() => raced, Error, "timeout");
  assertEquals(onTimeoutCalled, true);
  assertEquals(onTimeoutFinished, false);

  releaseOnTimeout?.();
  await onTimeoutFinishedSignal;
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

Deno.test("raceWithTimeout sets timeout side effects before rejection is observed", async () => {
  const operation = new Promise<string>(() => {});
  let timeoutSideEffect = false;

  const raced = raceWithTimeout(
    operation,
    1,
    () => {
      timeoutSideEffect = true;
    },
    "timeout",
  );

  await assertRejects(async () => {
    try {
      await raced;
    } catch (error) {
      assertEquals(timeoutSideEffect, true);
      throw error;
    }
  }, Error, "timeout");
});
