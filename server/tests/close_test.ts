import { assertEquals } from "@std/assert";
import { withTestHarness } from "./helpers/harness.ts";
import type { CloseMessage, ResizeMessage } from "./helpers/types.ts";

Deno.test("close message relay", withTestHarness(async (t, { rClient, browser }) => {
  // Wait for registration
  browser.sendResize(1, 1);
  await rClient.readMessage<ResizeMessage>();

  await t.step("R close message reaches browser", async () => {
    await rClient.sendClose();

    const msg = await browser.waitForType<CloseMessage>("close");
    assertEquals(msg.type, "close");
  });
}));
