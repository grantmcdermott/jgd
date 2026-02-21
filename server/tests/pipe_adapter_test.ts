/**
 * Unit tests for PipeConn / PipeListener adapters.
 *
 * On POSIX these use Unix sockets via node:net; on Windows they use
 * real named pipes.  Both are supported by node:net transparently.
 */

import { assertEquals } from "@std/assert";
import { PipeListener, PipeConn } from "../named_pipe.ts";
import { connect as nodeConnect } from "node:net";
import { join } from "@std/path";

const isWindows = Deno.build.os === "windows";

/**
 * Create a pipe/socket path for testing. Returns [path, cleanup].
 * On Windows: \\.\pipe\jgd-test-<random> (named pipe, no file cleanup needed).
 * On POSIX:  <tmpdir>/test.sock (Unix socket, directory removed on cleanup).
 */
function tmpPipePath(): [string, () => void] {
  if (isWindows) {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    return [`\\\\.\\pipe\\jgd-test-${id}`, () => {}];
  }
  const dir = Deno.makeTempDirSync({ prefix: "jgd-pipe-test-" });
  const cleanup = () => {
    try { Deno.removeSync(dir, { recursive: true }); } catch { /* best effort */ }
  };
  return [join(dir, "test.sock"), cleanup];
}

Deno.test("PipeListener: accept and round-trip data", async () => {
  const [pipePath, cleanup] = tmpPipePath();
  try {
    const listener = new PipeListener();
    await listener.listen(pipePath);

    // Connect a client via node:net
    const clientSocket = await new Promise<import("node:net").Socket>(
      (resolve, reject) => {
        const s = nodeConnect(pipePath, () => resolve(s));
        s.once("error", reject);
      },
    );
    const clientConn = new PipeConn(clientSocket);

    // Accept the connection on the server side
    const iter = listener[Symbol.asyncIterator]();
    const { value: serverConn, done } = await iter.next();
    assertEquals(done, false);

    // Server writes, client reads
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const message = "hello from server\n";
    await serverConn!.write(encoder.encode(message));

    const reader = clientConn.readable.getReader();
    const { value: chunk } = await reader.read();
    assertEquals(decoder.decode(chunk), message);
    reader.releaseLock();

    // Client writes, server reads
    const reply = "hello from client\n";
    await clientConn.write(encoder.encode(reply));

    const serverReader = serverConn!.readable.getReader();
    const { value: serverChunk } = await serverReader.read();
    assertEquals(decoder.decode(serverChunk), reply);
    serverReader.releaseLock();

    // Cleanup
    clientConn.close();
    serverConn!.close();
    listener.close();
  } finally {
    cleanup();
  }
});

Deno.test("PipeListener: close terminates async iterator", async () => {
  const [pipePath, cleanup] = tmpPipePath();
  try {
    const listener = new PipeListener();
    await listener.listen(pipePath);

    // Start iterating in the background
    const connections: unknown[] = [];
    const loopDone = (async () => {
      for await (const conn of listener) {
        connections.push(conn);
      }
    })();

    // Close the listener — the loop should terminate
    listener.close();
    await loopDone;

    assertEquals(connections.length, 0);
  } finally {
    cleanup();
  }
});

Deno.test("PipeListener: multiple connections", async () => {
  const [pipePath, cleanup] = tmpPipePath();
  try {
    const listener = new PipeListener();
    await listener.listen(pipePath);

    // Connect two clients
    const connect = () =>
      new Promise<PipeConn>((resolve, reject) => {
        const s = nodeConnect(pipePath, () => resolve(new PipeConn(s)));
        s.once("error", reject);
      });

    const client1 = await connect();
    const client2 = await connect();

    // Accept both
    const iter = listener[Symbol.asyncIterator]();
    const { value: server1 } = await iter.next();
    const { value: server2 } = await iter.next();

    // Verify both connections work independently
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    await server1!.write(encoder.encode("conn1\n"));
    await server2!.write(encoder.encode("conn2\n"));

    const r1 = client1.readable.getReader();
    const { value: c1 } = await r1.read();
    assertEquals(decoder.decode(c1), "conn1\n");
    r1.releaseLock();

    const r2 = client2.readable.getReader();
    const { value: c2 } = await r2.read();
    assertEquals(decoder.decode(c2), "conn2\n");
    r2.releaseLock();

    // Cleanup
    client1.close();
    client2.close();
    server1!.close();
    server2!.close();
    listener.close();
  } finally {
    cleanup();
  }
});
