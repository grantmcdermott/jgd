import { assertEquals, assertThrows } from "@std/assert";
import { parseSocketUri } from "../socket_uri.ts";

Deno.test("parseSocketUri", async (t) => {
  await t.step("tcp://host:port", () => {
    const addr = parseSocketUri("tcp://127.0.0.1:8888");
    assertEquals(addr, { transport: "tcp", hostname: "127.0.0.1", port: 8888 });
  });

  await t.step("tcp with port 0", () => {
    const addr = parseSocketUri("tcp://127.0.0.1:0");
    assertEquals(addr, { transport: "tcp", hostname: "127.0.0.1", port: 0 });
  });

  await t.step("tcp with missing port throws", () => {
    assertThrows(
      () => parseSocketUri("tcp://127.0.0.1"),
      Error,
      "Invalid TCP port",
    );
  });

  await t.step("tcp with empty port throws", () => {
    assertThrows(
      () => parseSocketUri("tcp://127.0.0.1:"),
      Error,
      "Invalid TCP port",
    );
  });

  await t.step("unix:///absolute/path", () => {
    const addr = parseSocketUri("unix:///tmp/jgd-abc.sock");
    assertEquals(addr, { transport: "unix", path: "/tmp/jgd-abc.sock" });
  });

  await t.step("unix URI preserves percent-encoded characters", () => {
    const addr = parseSocketUri("unix:///tmp/path%20with%20spaces.sock");
    // WHATWG URL spec: non-special schemes (unix://) treat paths as opaque,
    // so .pathname preserves percent-encoding unlike http/https.
    assertEquals(addr, { transport: "unix", path: "/tmp/path%20with%20spaces.sock" });
  });

  await t.step("npipe:///name", () => {
    const addr = parseSocketUri("npipe:///jgd-abc123");
    assertEquals(addr, {
      transport: "npipe",
      name: "jgd-abc123",
      pipePath: "\\\\.\\pipe\\jgd-abc123",
    });
  });

  await t.step("raw absolute path treated as unix", () => {
    const addr = parseSocketUri("/tmp/jgd-test.sock");
    assertEquals(addr, { transport: "unix", path: "/tmp/jgd-test.sock" });
  });

  await t.step("unrecognized URI scheme throws", () => {
    assertThrows(
      () => parseSocketUri("http://example.com"),
      Error,
      "Unsupported socket URI scheme",
    );
    assertThrows(
      () => parseSocketUri("foo://bar"),
      Error,
      "Unsupported socket URI scheme",
    );
  });
});
