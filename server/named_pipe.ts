/**
 * Named pipe adapter for Windows.
 *
 * Bridges node:net (event-based) to the Deno.Conn / Deno.Listener interfaces
 * used by RSession and the accept loop in main.ts.
 *
 * On non-Windows platforms node:net falls back to Unix domain sockets,
 * so the adapter unit tests can run on Linux/macOS too.
 */

import { createServer, Socket } from "node:net";
import type { Server } from "node:net";

// ---------------------------------------------------------------------------
// PipeConn — wraps a node:net Socket as a Deno.Conn-compatible object
// ---------------------------------------------------------------------------

/** Minimal Deno.Conn-compatible wrapper around a node:net Socket. */
export class PipeConn {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  #socket: Socket;
  #closed = false;

  constructor(socket: Socket) {
    this.#socket = socket;

    // Build a ReadableStream from Socket events.
    this.readable = new ReadableStream<Uint8Array>({
      start(controller) {
        socket.on("data", (chunk: Uint8Array) => {
          try {
            controller.enqueue(new Uint8Array(chunk));
          } catch {
            // Stream already closed
          }
        });
        socket.on("end", () => {
          try { controller.close(); } catch { /* already closed */ }
        });
        socket.on("error", (err) => {
          try { controller.error(err); } catch { /* already closed */ }
        });
      },
      cancel() {
        socket.destroy();
      },
    });

    // Build a WritableStream that delegates to socket.write().
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          socket.write(chunk, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      close() {
        socket.end();
      },
      abort() {
        socket.destroy();
      },
    });
  }

  /**
   * Write bytes to the socket. Returns the number of bytes accepted.
   * Node sockets always accept the full buffer into their internal queue,
   * so this always returns data.byteLength (matching Deno.Conn.write semantics).
   */
  write(data: Uint8Array): Promise<number> {
    if (this.#closed) {
      return Promise.reject(new Deno.errors.BadResource("connection closed"));
    }
    return new Promise((resolve, reject) => {
      this.#socket.write(data, (err) => {
        if (err) reject(new Deno.errors.BadResource(err.message));
        else resolve(data.byteLength);
      });
    });
  }

  /** Close the underlying socket. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
  }
}

// ---------------------------------------------------------------------------
// PipeListener — wraps a node:net Server as an async-iterable listener
// ---------------------------------------------------------------------------

/**
 * Async-iterable listener for named pipes (or Unix sockets via node:net).
 *
 * The internal design uses a simple promise-based queue:
 *  - Each `connection` event pushes a PipeConn into the queue.
 *  - The async iterator consumes from the queue.
 *  - close() rejects any pending waiter so the iterator terminates.
 */
export class PipeListener {
  #server: Server;
  #closed = false;

  // Queue for accepted connections (unbounded).
  #queue: PipeConn[] = [];
  // Waiter: resolve/reject for the next accept() call.
  #waiter: {
    resolve: (conn: PipeConn) => void;
    reject: (err: Error) => void;
  } | null = null;

  constructor() {
    this.#server = createServer();

    this.#server.on("connection", (socket: Socket) => {
      if (this.#closed) {
        socket.destroy();
        return;
      }
      const conn = new PipeConn(socket);
      if (this.#waiter) {
        const w = this.#waiter;
        this.#waiter = null;
        w.resolve(conn);
      } else {
        this.#queue.push(conn);
      }
    });
  }

  /** Start listening on the given pipe path (e.g. `\\.\pipe\jgd-xxx`). */
  listen(pipePath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(pipePath, () => {
        this.#server.removeListener("error", reject);
        resolve();
      });
    });
  }

  /** Wait for the next accepted connection. */
  #accept(): Promise<PipeConn> {
    if (this.#queue.length > 0) {
      return Promise.resolve(this.#queue.shift()!);
    }
    if (this.#closed) {
      return Promise.reject(
        new Deno.errors.BadResource("listener closed"),
      );
    }
    return new Promise<PipeConn>((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  /** Async iterator — enables `for await (const conn of listener)`. */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<PipeConn> {
    while (!this.#closed) {
      try {
        yield await this.#accept();
      } catch {
        // BadResource from close() — terminate the iterator.
        return;
      }
    }
  }

  /** Stop listening and reject any pending accept. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#server.close();
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w.reject(new Deno.errors.BadResource("listener closed"));
    }
    // Destroy any queued connections that were never consumed.
    for (const conn of this.#queue) {
      conn.close();
    }
    this.#queue.length = 0;
  }
}
