import { assert, assertEquals, assertRejects } from "@std/assert";
import { writeDiscovery, removeDiscovery } from "../discovery.ts";
import { join } from "@std/path";

Deno.test("discovery file lifecycle", async (t) => {
  const cacheDir = Deno.makeTempDirSync({ prefix: "jgd-disc-test-" });

  // Override cache dir env vars so discovery writes to our test directory.
  // XDG_CACHE_HOME for Linux, LOCALAPPDATA for Windows.
  const origXdg = Deno.env.get("XDG_CACHE_HOME");
  const origLocalAppData = Deno.env.get("LOCALAPPDATA");
  Deno.env.set("XDG_CACHE_HOME", cacheDir);
  Deno.env.set("LOCALAPPDATA", cacheDir);

  try {
    const discPath = join(cacheDir, "jgd", "discovery.json");

    await t.step("removeDiscovery skips file owned by another PID", async () => {
      const path = await writeDiscovery("unix:///tmp/test.sock", "jgd-test");
      assert(path.length > 0, "should return a path");

      const before = JSON.parse(await Deno.readTextFile(discPath));
      assertEquals(before.pid, Deno.pid);

      // Overwrite with a different PID (simulating another instance).
      const otherPid = Deno.pid + 99999;
      await Deno.writeTextFile(
        path,
        JSON.stringify({ serverName: "jgd-other", socketPath: "unix:///tmp/other.sock", pid: otherPid }),
      );

      // removeDiscovery should NOT delete the file because the PID doesn't match
      await removeDiscovery(path);

      const after = JSON.parse(await Deno.readTextFile(discPath));
      assertEquals(after.pid, otherPid, "file should still exist with other PID");
      assertEquals(after.serverName, "jgd-other");

      try { await Deno.remove(path); } catch { /* ignore */ }
    });

    await t.step("discovery file contains serverName and serverInfo", async () => {
      const path = await writeDiscovery(
        "unix:///tmp/test.sock",
        "jgd-test",
        { httpUrl: "http://127.0.0.1:8080/" },
      );

      const content = JSON.parse(await Deno.readTextFile(discPath));
      assertEquals(content.serverName, "jgd-test");
      assertEquals(content.socketPath, "unix:///tmp/test.sock");
      assertEquals(content.pid, Deno.pid);
      assertEquals(content.serverInfo.httpUrl, "http://127.0.0.1:8080/");

      try { await Deno.remove(path); } catch { /* ignore */ }
    });

    await t.step("serverInfo is omitted when not provided", async () => {
      const path = await writeDiscovery("unix:///tmp/test.sock", "jgd-test");

      const content = JSON.parse(await Deno.readTextFile(discPath));
      assertEquals(content.serverName, "jgd-test");
      assertEquals(content.serverInfo, undefined);

      try { await Deno.remove(path); } catch { /* ignore */ }
    });

    await t.step("writeDiscovery rejects invalid serverInfo", async () => {
      await assertRejects(
        () => writeDiscovery("unix:///tmp/test.sock", "jgd-test", null as unknown as Record<string, string>),
        Error,
        "serverInfo must be a plain object",
      );
      await assertRejects(
        () => writeDiscovery("unix:///tmp/test.sock", "jgd-test", [1, 2] as unknown as Record<string, string>),
        Error,
        "serverInfo must be a plain object",
      );
      await assertRejects(
        () => writeDiscovery("unix:///tmp/test.sock", "jgd-test", "string" as unknown as Record<string, string>),
        Error,
        "serverInfo must be a plain object",
      );
    });

    await t.step("writeDiscovery rejects non-string serverInfo values", async () => {
      await assertRejects(
        () => writeDiscovery("unix:///tmp/test.sock", "jgd-test", { key: 123 } as unknown as Record<string, string>),
        Error,
        'serverInfo value for "key" must be a string',
      );
    });

    await t.step("writeDiscovery rejects empty serverName", async () => {
      await assertRejects(
        () => writeDiscovery("unix:///tmp/test.sock", ""),
        Error,
        "serverName must be a non-empty string",
      );
      await assertRejects(
        () => writeDiscovery("unix:///tmp/test.sock", "   "),
        Error,
        "serverName must be a non-empty string",
      );
    });

    await t.step("removeDiscovery deletes file owned by current PID", async () => {
      const path = await writeDiscovery("unix:///tmp/test.sock", "jgd-test");

      const content = JSON.parse(await Deno.readTextFile(discPath));
      assertEquals(content.pid, Deno.pid);

      // removeDiscovery should delete the file because the PID matches
      await removeDiscovery(path);

      try {
        await Deno.readTextFile(discPath);
        assert(false, "file should have been removed");
      } catch (e) {
        assert(e instanceof Deno.errors.NotFound);
      }
    });
  } finally {
    if (origXdg !== undefined) {
      Deno.env.set("XDG_CACHE_HOME", origXdg);
    } else {
      Deno.env.delete("XDG_CACHE_HOME");
    }
    if (origLocalAppData !== undefined) {
      Deno.env.set("LOCALAPPDATA", origLocalAppData);
    } else {
      Deno.env.delete("LOCALAPPDATA");
    }
    try {
      await Deno.remove(cacheDir, { recursive: true });
    } catch { /* ignore */ }
  }
});
