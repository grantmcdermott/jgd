import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { PlotHistory, PlotFrame } from './plot-history';
import { SocketServer, discoveryPath } from './socket-server';

// Minimal mock that satisfies the SocketServer's usage of PlotWebviewProvider.
// We only need the methods SocketServer actually calls.
class MockWebviewProvider {
    resizeListener: ((w: number, h: number) => void) | null = null;
    dims = { width: 800, height: 600 };
    shownPlots: PlotFrame[] = [];
    measuredRequests: any[] = [];
    closedSessions: string[] = [];

    onResize(listener: (w: number, h: number) => void) {
        this.resizeListener = listener;
    }

    getPanelDimensions() {
        return this.dims;
    }

    showPlot(plot: PlotFrame) {
        this.shownPlots.push(plot);
    }

    measureText(request: any): Promise<any> {
        this.measuredRequests.push(request);
        return Promise.resolve({
            type: 'metrics_response',
            id: request.id,
            width: 42,
            ascent: 10,
            descent: 3,
        });
    }

    onDeviceClosed(sessionId: string) {
        this.closedSessions.push(sessionId);
    }

    // Simulate a webview resize event
    triggerResize(w: number, h: number) {
        this.resizeListener?.(w, h);
    }
}

let plotCounter = 0;
function makePlotMsg(label: string, width = 400, height = 300, extra: Record<string, unknown> = {}) {
    const msg: Record<string, unknown> = {
        type: 'frame',
        plot: {
            version: 1,
            sessionId: '',
            device: { width, height, dpi: 96, bg: label },
            ops: [{ op: 'rect', label }],
        },
        ...extra,
    };
    // Auto-assign plotNumber for new plots (not resize replays)
    if (!extra.resizeReplay && msg.plotNumber === undefined) {
        msg.plotNumber = plotCounter++;
    }
    return msg;
}

interface ClientHelper {
    socket: net.Socket;
    send: (msg: object) => void;
    readLine: () => Promise<string>;
    close: () => void;
}

/** Connect a TCP client to the server and return helpers. */
function connectClient(socketPath: string): Promise<ClientHelper> {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let buffer = '';
        const lineQueue: string[] = [];
        let lineResolve: ((line: string) => void) | null = null;

        socket.on('data', (data) => {
            buffer += data.toString();
            let idx: number;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.substring(0, idx);
                buffer = buffer.substring(idx + 1);
                if (lineResolve) {
                    const r = lineResolve;
                    lineResolve = null;
                    r(line);
                } else {
                    lineQueue.push(line);
                }
            }
        });

        socket.on('error', (err) => {
            if (lineResolve) {
                const r = lineResolve;
                lineResolve = null;
                r(''); // unblock pending readLine
            }
            reject(err);
        });

        socket.connect(socketPath, () => {
            resolve({
                socket,
                send: (msg: object) => socket.write(JSON.stringify(msg) + '\n'),
                readLine: () => {
                    if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift()!);
                    return new Promise((res) => { lineResolve = res; });
                },
                close: () => socket.destroy(),
            });
        });
    });
}

function waitMs(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SocketServer', () => {
    let history: PlotHistory;
    let provider: MockWebviewProvider;
    let server: SocketServer;
    let clients: ClientHelper[];

    beforeEach(async () => {
        plotCounter = 0;
        history = new PlotHistory(50);
        provider = new MockWebviewProvider();
        server = new SocketServer(history, provider as any);
        clients = [];
        server.start();
        // Wait for the server to be listening
        await new Promise<void>((resolve) => server.onReady(resolve));
    });

    afterEach(() => {
        for (const c of clients) c.close();
        server.stop();
    });

    async function connect(): Promise<ClientHelper> {
        const client = await connectClient(server.getSocketPath());
        clients.push(client);
        // Send an initial message to trigger the deferred welcome handshake,
        // then consume the server_info and initial resize responses.
        client.send({ type: 'hello' });
        await client.readLine(); // server_info
        await client.readLine(); // initial resize
        return client;
    }

    // ---- Frame routing ----

    describe('frame routing', () => {
        it('routes normal frame to addPlot', async () => {
            const client = await connect();

            client.send(makePlotMsg('A'));
            await waitMs(50);

            expect(history.count()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('A');
            expect(provider.shownPlots).toHaveLength(1);
        });

        it('routes incremental frame via appendOps (ops accumulate)', async () => {
            const client = await connect();

            client.send(makePlotMsg('A'));
            await waitMs(50);

            // Send incremental frame with additional ops
            const incrMsg = {
                type: 'frame',
                plot: {
                    version: 1,
                    sessionId: '',
                    device: { width: 400, height: 300, dpi: 96, bg: 'A' },
                    ops: [{ op: 'line', label: 'extra' }],
                },
                incremental: true,
            };
            client.send(incrMsg);
            await waitMs(50);

            expect(history.count()).toBe(1);
            // The original rect op + the incremental line op
            const ops = history.currentPlot()?.ops;
            expect(ops).toHaveLength(2);
            expect((ops![0] as any).op).toBe('rect');
            expect((ops![1] as any).op).toBe('line');
            expect(provider.shownPlots).toHaveLength(2);
        });

        it('routes resizeReplay frame to replaceLatest', async () => {
            const client = await connect();

            // Add a plot first
            client.send(makePlotMsg('A'));
            await waitMs(50);

            // R responds with a resizeReplay frame
            client.send(makePlotMsg('A-resized', 1000, 700, { resizeReplay: true }));
            await waitMs(50);

            // Should replace, not add
            expect(history.count()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('A-resized');
        });

        it('routes resizeReplay frame with plotIndex to replaceAtIndex', async () => {
            const client = await connect();

            // Add two plots
            client.send(makePlotMsg('A'));
            await waitMs(50);
            client.send(makePlotMsg('B'));
            await waitMs(50);
            expect(history.count()).toBe(2);

            // R sends a plotIndex resize replay for plot 0
            client.send(makePlotMsg('A-resized', 500, 400, { resizeReplay: true, plotIndex: 0 }));
            await waitMs(50);

            // Should replace at index, not add
            expect(history.count()).toBe(2);
        });
    });

    // ---- Resize-after-delete (the jgd#11 bug) ----

    describe('resize after delete (jgd#11)', () => {
        it('resize after delete-latest uses plotIndex and updates correct plot', async () => {
            const client = await connect();

            // Two plots: RED then BLUE
            client.send(makePlotMsg('RED'));
            await waitMs(50);
            client.send(makePlotMsg('BLUE'));
            await waitMs(50);
            expect(history.count()).toBe(2);

            // Delete BLUE (latest) → latestDeleted=true
            history.removeCurrent();
            expect(history.count()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('RED');

            // Trigger resize — should include plotIndex=0
            provider.triggerResize(1000, 700);
            const resizeMsg = JSON.parse(await client.readLine());
            expect(resizeMsg.type).toBe('resize');
            expect(resizeMsg.plotIndex).toBe(0);

            // R replays snapshot[0] (RED) at new dimensions with plotIndex
            client.send(makePlotMsg('RED-resized', 1000, 700, { resizeReplay: true, plotIndex: 0 }));
            await waitMs(50);

            // Plot updated via replaceAtIndex, not added
            expect(history.count()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('RED-resized');
        });
    });

    // ---- broadcastResize dedup ----

    describe('broadcastResize', () => {
        it('deduplicates resize with same dimensions', async () => {
            const client = await connect();
            // Initial dims are 800x600 (already consumed by connect())

            // Trigger resize with same dimensions
            provider.triggerResize(800, 600);
            // Should NOT receive a resize message — use a race with timeout
            const got = await Promise.race([
                client.readLine().then(() => true),
                waitMs(100).then(() => false),
            ]);
            expect(got).toBe(false);
        });

        it('forwards resize with different dimensions', async () => {
            const client = await connect();

            provider.triggerResize(1024, 768);
            const msg = JSON.parse(await client.readLine());
            expect(msg.type).toBe('resize');
            expect(msg.width).toBe(1024);
            expect(msg.height).toBe(768);
        });
    });

    // ---- Initial connection ----

    describe('initial connection', () => {
        it('sends current panel dimensions on connect', async () => {
            provider.dims = { width: 500, height: 400 };
            const client = await connectClient(server.getSocketPath());
            clients.push(client);
            // Trigger the deferred welcome
            client.send({ type: 'hello' });
            const info = JSON.parse(await client.readLine());
            expect(info.type).toBe('server_info');
            const msg = JSON.parse(await client.readLine());
            expect(msg.type).toBe('resize');
            expect(msg.width).toBe(500);
            expect(msg.height).toBe(400);
        });
    });

    // ---- Discovery file ----

    describe('discovery file', () => {
        it('writes discovery file with correct schema', () => {
            const discPath = discoveryPath();
            const content = JSON.parse(fs.readFileSync(discPath, 'utf-8'));
            expect(content.serverName).toBe('jgd-vscode');
            expect(content.socketPath).toBe(server.getSocketPath());
            expect(content.pid).toBe(process.pid);
            expect(content).not.toHaveProperty('serverInfo');
        });
    });

    // ---- Close message ----

    describe('close message', () => {
        it('forwards close to webview provider with session id', async () => {
            const client = await connect();

            client.send({ type: 'close' });
            await waitMs(50);

            expect(provider.closedSessions).toHaveLength(1);
            expect(provider.closedSessions[0]).toMatch(/^session-/);
        });
    });

    // ---- Metrics round-trip ----

    describe('metrics', () => {
        it('forwards metrics_request to provider and returns response', async () => {
            const client = await connect();

            client.send({
                type: 'metrics_request',
                id: 7,
                kind: 'strWidth',
                str: 'hello',
                gc: { font: { size: 12, family: 'sans' } },
            });

            const resp = JSON.parse(await client.readLine());
            expect(resp.type).toBe('metrics_response');
            expect(resp.id).toBe(7);
            expect(resp.width).toBe(42);
            expect(provider.measuredRequests).toHaveLength(1);
        });
    });

    // ---- newPage frames are not tagged as resize ----

    describe('newPage handling', () => {
        it('newPage frame is added as new plot, not tagged as resize', async () => {
            const client = await connect();

            // First frame
            client.send(makePlotMsg('A'));
            await waitMs(50);
            expect(history.count()).toBe(1);

            // Trigger a resize
            provider.triggerResize(1000, 700);
            await client.readLine(); // consume resize message

            // R sends a newPage frame at the new dimensions
            // (cb_newPage consumed the resize, so this is a new plot)
            client.send(makePlotMsg('B', 1000, 700, { newPage: true }));
            await waitMs(50);

            // Should be added as a new plot (addPlot), not replace
            expect(history.count()).toBe(2);
            expect(history.currentPlot()?.device.bg).toBe('B');
        });

        it('resizeReplay frame after newPage correctly replaces', async () => {
            const client = await connect();

            // First frame
            client.send(makePlotMsg('A'));
            await waitMs(50);

            // Trigger a resize to 1000x700
            provider.triggerResize(1000, 700);
            await client.readLine();

            // R sends a newPage frame at original dimensions
            client.send(makePlotMsg('B', 800, 600, { newPage: true }));
            await waitMs(50);

            // New plot added
            expect(history.count()).toBe(2);

            // Now R replays the resize with resizeReplay flag
            client.send(makePlotMsg('B-resized', 1000, 700, { resizeReplay: true }));
            await waitMs(50);

            expect(history.count()).toBe(2);
            expect(history.currentPlot()?.device.bg).toBe('B-resized');
        });
    });
});
