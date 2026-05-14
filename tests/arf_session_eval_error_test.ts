import { assert, assertRejects } from "@std/assert";
import { ArfSession, checkArfTestAvailable } from "./helpers/arf_session.ts";
import { testLog } from "./helpers/test_log.ts";

const arfTestAvailable = await checkArfTestAvailable();
const skip = !arfTestAvailable;

Deno.test({
  name: "ArfSession.eval: throws on R evaluation error by default",
  ignore: skip,
  async fn() {
    testLog("test start");
    const arf = new ArfSession();
    try {
      await arf.start();
      await assertRejects(
        () => arf.eval("stop('boom-from-test')"),
        Error,
        "R eval failed:",
      );
    } finally {
      await arf.shutdown();
    }
  },
});

Deno.test({
  name: "ArfSession.eval: throwOnRError=false returns error payload",
  ignore: skip,
  async fn() {
    testLog("test start");
    const arf = new ArfSession();
    try {
      await arf.start();
      const result = await arf.eval("stop('boom-from-test')", 30_000, {
        throwOnRError: false,
      });
      assert(
        result.error !== null &&
          result.error.includes("boom-from-test"),
        `Expected result.error to include boom-from-test, got: ${result.error}`,
      );
    } finally {
      await arf.shutdown();
    }
  },
});

Deno.test({
  name: "ArfSession.start: rejects accidental double start",
  ignore: skip,
  async fn() {
    testLog("test start");
    const arf = new ArfSession();
    try {
      await arf.start();
      await assertRejects(
        () => arf.start(),
        Error,
        "ArfSession already started",
      );
    } finally {
      await arf.shutdown();
    }
  },
});
