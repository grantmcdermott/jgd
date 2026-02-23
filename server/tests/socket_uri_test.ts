import { assertEquals, assertThrows } from "@std/assert";
import { parseSocketUri, socketUri } from "../socket_uri.ts";

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

  await t.step("tcp with empty hostname throws", () => {
    // new URL("tcp://:1234") throws "Invalid URL" before our check runs,
    // so just verify it throws an Error.
    assertThrows(
      () => parseSocketUri("tcp://:1234"),
      Error,
    );
  });

  await t.step("tcp with query string throws", () => {
    assertThrows(
      () => parseSocketUri("tcp://127.0.0.1:8888?key=val"),
      Error,
      "unexpected query or fragment",
    );
  });

  await t.step("tcp with fragment throws", () => {
    assertThrows(
      () => parseSocketUri("tcp://127.0.0.1:8888#frag"),
      Error,
      "unexpected query or fragment",
    );
  });

  await t.step("unix:///absolute/path", () => {
    const addr = parseSocketUri("unix:///tmp/jgd-abc.sock");
    assertEquals(addr, { transport: "unix", path: "/tmp/jgd-abc.sock" });
  });

  await t.step("unix URI decodes percent-encoded characters", () => {
    const addr = parseSocketUri("unix:///tmp/path%20with%20spaces.sock");
    assertEquals(addr, { transport: "unix", path: "/tmp/path with spaces.sock" });
  });

  await t.step("unix:// without absolute path throws", () => {
    assertThrows(
      () => parseSocketUri("unix://relative.sock"),
      Error,
      "Unsupported socket URI:",
    );
  });

  await t.step("unix URI with unencoded # throws", () => {
    assertThrows(
      () => parseSocketUri("unix:///tmp/file#1.sock"),
      Error,
      "unencoded query or fragment",
    );
  });

  await t.step("unix URI with unencoded ? throws", () => {
    assertThrows(
      () => parseSocketUri("unix:///tmp/file?v=2.sock"),
      Error,
      "unencoded query or fragment",
    );
  });

  await t.step("npipe:///name", () => {
    const addr = parseSocketUri("npipe:///jgd-abc123");
    assertEquals(addr, {
      transport: "npipe",
      name: "jgd-abc123",
      pipePath: "\\\\.\\pipe\\jgd-abc123",
    });
  });

  await t.step("npipe with empty name throws", () => {
    assertThrows(
      () => parseSocketUri("npipe:///"),
      Error,
      "Empty pipe name",
    );
  });

  await t.step("raw path throws", () => {
    assertThrows(
      () => parseSocketUri("/tmp/jgd-test.sock"),
      Error,
      "Unsupported socket URI:",
    );
  });

  await t.step("socketUri.tcp round-trips", () => {
    const uri = socketUri.tcp("127.0.0.1", 9999);
    assertEquals(uri, "tcp://127.0.0.1:9999");
    const addr = parseSocketUri(uri);
    assertEquals(addr, { transport: "tcp", hostname: "127.0.0.1", port: 9999 });
  });

  await t.step("socketUri.unix round-trips", () => {
    const uri = socketUri.unix("/tmp/jgd-test.sock");
    assertEquals(uri, "unix:///tmp/jgd-test.sock");
    const addr = parseSocketUri(uri);
    assertEquals(addr, { transport: "unix", path: "/tmp/jgd-test.sock" });
  });

  await t.step("socketUri.unix encodes special characters", () => {
    const uri = socketUri.unix("/tmp/path with spaces.sock");
    assertEquals(uri, "unix:///tmp/path%20with%20spaces.sock");
    const addr = parseSocketUri(uri);
    assertEquals(addr, { transport: "unix", path: "/tmp/path with spaces.sock" });
  });

  await t.step("socketUri.unix encodes # and ? in path", () => {
    const uri = socketUri.unix("/tmp/file#1.sock");
    assertEquals(uri, "unix:///tmp/file%231.sock");
    const addr = parseSocketUri(uri);
    assertEquals(addr, { transport: "unix", path: "/tmp/file#1.sock" });

    const uri2 = socketUri.unix("/tmp/file?v=2.sock");
    assertEquals(uri2, "unix:///tmp/file%3Fv=2.sock");
    const addr2 = parseSocketUri(uri2);
    assertEquals(addr2, { transport: "unix", path: "/tmp/file?v=2.sock" });
  });

  await t.step("socketUri.unix rejects relative path", () => {
    assertThrows(
      () => socketUri.unix("relative.sock"),
      Error,
      "must be absolute",
    );
  });

  await t.step("socketUri.npipe round-trips", () => {
    const uri = socketUri.npipe("jgd-test123");
    assertEquals(uri, "npipe:///jgd-test123");
    const addr = parseSocketUri(uri);
    assertEquals(addr, { transport: "npipe", name: "jgd-test123", pipePath: "\\\\.\\pipe\\jgd-test123" });
  });

  await t.step("unrecognized URI scheme throws", () => {
    assertThrows(
      () => parseSocketUri("http://example.com"),
      Error,
      "Unsupported socket URI:",
    );
    assertThrows(
      () => parseSocketUri("foo://bar"),
      Error,
      "Unsupported socket URI:",
    );
  });
});
