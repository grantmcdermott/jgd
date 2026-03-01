import { assert, assertEquals } from "@std/assert";
import { writeDiscovery, removeDiscovery } from "../discovery.ts";
import { join } from "@std/path";

Deno.test("discovery file lifecycle", async (t) => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "jgd-disc-test-" });

  // Override temp dir env vars so discovery writes to our test directory.
  // POSIX uses TMPDIR; Windows uses TEMP/TMP.
  const origTmpDir = Deno.env.get("TMPDIR");
  const origTemp = Deno.env.get("TEMP");
  const origTmp = Deno.env.get("TMP");
  Deno.env.set("TMPDIR", tmpDir);
  Deno.env.set("TEMP", tmpDir);
  Deno.env.set("TMP", tmpDir);

  try {
    await t.step("removeDiscovery skips file owned by another PID", async () => {
      // Write a discovery file with the current process's PID
      const paths = await writeDiscovery("unix:///tmp/test.sock", 9999);
      assert(paths.length > 0, "should write at least one discovery file");

      const discPath = join(tmpDir, "jgd-discovery.json");
      const before = JSON.parse(await Deno.readTextFile(discPath));
      assertEquals(before.pid, Deno.pid);

      // Overwrite all paths with a different PID (simulating another instance).
      // writeDiscovery may write to both $TMPDIR and /tmp when they differ,
      // so overwrite all of them.
      const otherPid = Deno.pid + 99999;
      for (const p of paths) {
        await Deno.writeTextFile(
          p,
          JSON.stringify({ socketPath: "unix:///tmp/other.sock", httpPort: 8888, pid: otherPid }),
        );
      }

      // removeDiscovery should NOT delete any file because the PID doesn't match
      await removeDiscovery(paths);

      const after = JSON.parse(await Deno.readTextFile(discPath));
      assertEquals(after.pid, otherPid, "file should still exist with other PID");
      assertEquals(after.httpPort, 8888);

      // Clean up all paths
      for (const p of paths) {
        try { await Deno.remove(p); } catch { /* ignore */ }
      }
    });

    await t.step("removeDiscovery deletes file owned by current PID", async () => {
      const paths = await writeDiscovery("unix:///tmp/test.sock", 9999);
      assert(paths.length > 0);

      const discPath = join(tmpDir, "jgd-discovery.json");
      const content = JSON.parse(await Deno.readTextFile(discPath));
      assertEquals(content.pid, Deno.pid);

      // removeDiscovery should delete the file because the PID matches
      await removeDiscovery(paths);

      try {
        await Deno.readTextFile(discPath);
        assert(false, "file should have been removed");
      } catch (e) {
        assert(e instanceof Deno.errors.NotFound);
      }
    });
  } finally {
    // Restore temp dir env vars
    if (origTmpDir !== undefined) {
      Deno.env.set("TMPDIR", origTmpDir);
    } else {
      Deno.env.delete("TMPDIR");
    }
    if (origTemp !== undefined) {
      Deno.env.set("TEMP", origTemp);
    } else {
      Deno.env.delete("TEMP");
    }
    if (origTmp !== undefined) {
      Deno.env.set("TMP", origTmp);
    } else {
      Deno.env.delete("TMP");
    }
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore */ }
  }
});
