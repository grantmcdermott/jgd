import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { TestServer } from "../../server/tests/helpers/server.ts";
import { E2EBrowser } from "../../server/tests/helpers/e2e_browser.ts";
import type { FrameMessage } from "../../server/tests/helpers/types.ts";
import { AutoMetricsBrowserClient } from "./auto_metrics_client.ts";
import { pollResize } from "./arf_poll.ts";
import { ArfSession } from "./arf_session.ts";
import { waitForWsConnected } from "./page_ready.ts";
import { toRSocketAddress } from "./r_process.ts";

export interface ArfBrowserTestContext {
  server: TestServer;
  browser: AutoMetricsBrowserClient;
  arf: ArfSession;
  socketAddr: string;
  close(): Promise<void>;
}

export interface ArfPageTestContext {
  server: TestServer;
  e2e: E2EBrowser;
  arf: ArfSession;
  page: Awaited<ReturnType<E2EBrowser["newPage"]>>;
  socketAddr: string;
  close(): Promise<void>;
}

async function runCleanupSteps(
  steps: Array<() => Promise<void> | void>,
): Promise<void> {
  const errors: unknown[] = [];

  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Multiple cleanup steps failed");
  }
}

async function cleanupAfterSetupFailure(
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch {
    // Preserve the original setup error while still attempting cleanup.
  }
}

async function closeArfBrowserResources(
  server: TestServer,
  browser: AutoMetricsBrowserClient,
  arf: ArfSession,
): Promise<void> {
  await runCleanupSteps([
    () => browser.close(),
    () => delay(100),
    () => server.shutdown(),
    () => server.cleanup(),
    () => arf.shutdown(),
  ]);
}

async function closeArfPageResources(
  server: TestServer,
  e2e: E2EBrowser,
  arf: ArfSession,
): Promise<void> {
  await runCleanupSteps([
    () => arf.shutdown(),
    () => e2e.close(),
    () => delay(100),
    () => server.shutdown(),
    () => server.cleanup(),
  ]);
}

export async function startArfBrowserTest(): Promise<ArfBrowserTestContext> {
  const server = new TestServer({ tcp: true });
  const browser = new AutoMetricsBrowserClient();
  const arf = new ArfSession();

  try {
    await server.start();
    // Connect the browser before the R session registers, so the hub has a
    // client to forward initial frames to. We deliberately do NOT send an
    // initial resize here: the hub only forwards resize messages to currently
    // registered R sessions, and `arf.start()` does not register one — that
    // happens later when `jgd(...)` opens the socket — so any resize sent
    // before then is silently dropped. `jgd(width=8, height=6, dpi=96)` below
    // sets the device size authoritatively from R's side.
    await browser.connect(server.wsUrl);

    await arf.start();
    const socketAddr = toRSocketAddress(server.socketPath);
    await arf.eval(
      `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
    );

    return {
      server,
      browser,
      arf,
      socketAddr,
      async close() {
        await closeArfBrowserResources(server, browser, arf);
      },
    };
  } catch (error) {
    await cleanupAfterSetupFailure(() =>
      closeArfBrowserResources(server, browser, arf)
    );
    throw error;
  }
}

export async function startArfPageTest(
  opts: { browserFirst: boolean },
): Promise<ArfPageTestContext> {
  const server = new TestServer({ tcp: true });
  const e2e = new E2EBrowser();
  const arf = new ArfSession();

  try {
    await server.start();
    const socketAddr = toRSocketAddress(server.socketPath);
    let page: Awaited<ReturnType<E2EBrowser["newPage"]>>;

    if (opts.browserFirst) {
      await e2e.launch();
      page = await e2e.newPage(server.httpBaseUrl);
      // Block until the page's WebSocket is open so the hub has a client
      // when R starts drawing (the web client only sets `#ws-status.connected`
      // inside its `onopen` handler — fixed sleeps can resolve before that).
      await waitForWsConnected(page);

      await arf.start();
      await arf.eval(
        `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
      );
    } else {
      await arf.start();
      await arf.eval(
        `options(jgd.socket = "${socketAddr}"); library(jgd); jgd(width=8, height=6, dpi=96)`,
      );

      await e2e.launch();
      page = await e2e.newPage(server.httpBaseUrl);
      await waitForWsConnected(page);
    }

    return {
      server,
      e2e,
      arf,
      page,
      socketAddr,
      async close() {
        await closeArfPageResources(server, e2e, arf);
      },
    };
  } catch (error) {
    await cleanupAfterSetupFailure(() =>
      closeArfPageResources(server, e2e, arf)
    );
    throw error;
  }
}

export async function waitForFrameWithOps(
  browser: AutoMetricsBrowserClient,
  label: string,
  timeoutMs = 8000,
): Promise<FrameMessage> {
  const frame = await browser.waitForType<FrameMessage>("frame", timeoutMs);
  assert(frame.plot.ops.length > 0, `${label} should have ops`);
  return frame;
}

export async function createTwoBasePlots(
  ctx: ArfBrowserTestContext,
): Promise<[FrameMessage, FrameMessage]> {
  await ctx.arf.eval("plot(1:3); plot(4:6)");
  const frame1 = await waitForFrameWithOps(ctx.browser, "First frame");
  const frame2 = await waitForFrameWithOps(ctx.browser, "Second frame");
  return [frame1, frame2];
}

export async function waitForResizeFrame(
  browser: AutoMetricsBrowserClient,
  timeoutMs = 6000,
): Promise<FrameMessage> {
  return await browser.waitForMessage<FrameMessage>(
    (msg) => msg.type === "frame" && (msg as FrameMessage).resize === true,
    timeoutMs,
  );
}

export async function sendResizeAndPoll(
  ctx: ArfBrowserTestContext,
  width: number,
  height: number,
): Promise<void> {
  ctx.browser.sendResize(width, height);
  await ctx.browser.sendPing(3000);
  await pollResize(ctx.arf, 40);
}

export async function sendPlotIndexResizeAndPoll(
  ctx: ArfBrowserTestContext,
  width: number,
  height: number,
  plotIndex: number,
  sessionId?: string,
): Promise<void> {
  ctx.browser.sendResizeWithPlotIndex(width, height, plotIndex, sessionId);
  await ctx.browser.sendPing(3000);
  await pollResize(ctx.arf, 40);
}

export async function assertNoExtraFrameBeforePong(
  browser: AutoMetricsBrowserClient,
  message: string,
): Promise<void> {
  const ac = new AbortController();
  const sentinel = Symbol("pong");
  const extraFrame = await Promise.race([
    browser.waitForType<FrameMessage>("frame", 6000, ac.signal).catch(() =>
      null
    ),
    browser.sendPing(3000).then(() => {
      ac.abort();
      return sentinel;
    }),
  ]);

  assertEquals(extraFrame, sentinel, message);
}
