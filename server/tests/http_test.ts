import { assert, assertEquals } from "@std/assert";
import { TestServer } from "./helpers/server.ts";

Deno.test("HTTP static file serving", async (t) => {
  const server = new TestServer();
  try {
    await server.start();

    await t.step("GET / returns HTML", async () => {
      const res = await fetch(`${server.httpBaseUrl}/`);
      assertEquals(res.status, 200);
      const ct = res.headers.get("content-type") ?? "";
      assert(ct.includes("text/html"), `Expected text/html, got ${ct}`);
      await res.body?.cancel();
    });

    await t.step("GET /app.js returns JavaScript", async () => {
      const res = await fetch(`${server.httpBaseUrl}/app.js`);
      assertEquals(res.status, 200);
      const ct = res.headers.get("content-type") ?? "";
      assert(
        ct.includes("javascript") || ct.includes("text/javascript"),
        `Expected javascript content-type, got ${ct}`,
      );
      await res.body?.cancel();
    });

    await t.step("GET /renderer.js returns JavaScript", async () => {
      const res = await fetch(`${server.httpBaseUrl}/renderer.js`);
      assertEquals(res.status, 200);
      const ct = res.headers.get("content-type") ?? "";
      assert(
        ct.includes("javascript") || ct.includes("text/javascript"),
        `Expected javascript content-type, got ${ct}`,
      );
      await res.body?.cancel();
    });

    await t.step("GET /style.css returns CSS", async () => {
      const res = await fetch(`${server.httpBaseUrl}/style.css`);
      assertEquals(res.status, 200);
      const ct = res.headers.get("content-type") ?? "";
      assert(ct.includes("text/css"), `Expected text/css, got ${ct}`);
      await res.body?.cancel();
    });

    await t.step("GET /nonexistent returns 404", async () => {
      const res = await fetch(`${server.httpBaseUrl}/nonexistent`);
      assertEquals(res.status, 404);
      await res.body?.cancel();
    });
  } finally {
    await server.shutdown();
    server.cleanup();
  }
});
