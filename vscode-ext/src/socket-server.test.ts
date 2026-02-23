import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import { PlotHistory, PlotFrame } from './plot-history';
import { SocketServer } from './socket-server';

// Minimal mock that satisfies the SocketServer's usage of PlotWebviewProvider.
// We only need the methods SocketServer actually calls.
class MockWebviewProvider {
    resizeListener: ((w: number, h: number) => void) | null = null;
    dims = { width: 800, height: 600 };
    shownPlots: PlotFrame[] = [];
    measuredRequests: any[] = [];

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

    onDeviceClosed(_sessionId: string) {}

    // Simulate a webview resize event
    triggerResize(w: number, h: number) {
        this.resizeListener?.(w, h);
    }
}

function makePlotMsg(label: string, width = 400, height = 300, extra: Record<string, unknown> = {}) {
    return {
        type: 'frame',
        plot: {
            version: 1,
            sessionId: '',
            device: { width, height, dpi: 96, bg: label },
            ops: [{ op: 'rect', label }],
        },
        ...extra,
    };
}

/** Connect a TCP client to the server and return helpers. */
function connectClient(socketPath: string): Promise<{
    socket: net.Socket;
    send: (msg: object) => void;
    readLine: () => Promise<string>;
    close: () => void;
}> {
    return new Promise((resolve) => {
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

    beforeEach(async () => {
        history = new PlotHistory(50);
        provider = new MockWebviewProvider();
        server = new SocketServer(history, provider as any);
        server.start();
        // Wait for the server to be listening
        await new Promise<void>((resolve) => server.onReady(resolve));
    });

    afterEach(() => {
        server.stop();
    });

    // ---- Frame routing ----

    describe('frame routing', () => {
        it('routes normal frame to addPlot', async () => {
            const client = await connectClient(server.getSocketPath());
            await client.readLine(); // consume initial resize

            client.send(makePlotMsg('A'));
            await waitMs(50);

            expect(history.count()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('A');
            expect(provider.shownPlots).toHaveLength(1);
            client.close();
        });

        it('routes incremental frame to replaceCurrent', async () => {
            const client = await connectClient(server.getSocketPath());
            await client.readLine();

            client.send(makePlotMsg('A'));
            await waitMs(50);
            client.send(makePlotMsg('A-updated', 400, 300, { incremental: true }));
            await waitMs(50);

            expect(history.count()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('A-updated');
            expect(provider.shownPlots).toHaveLength(2);
            client.close();
        });

        it('routes resize-response frame to replaceLatest', async () => {
            const client = await connectClient(server.getSocketPath());
            await client.readLine(); // initial resize (800x600)

            // Add a plot first
            client.send(makePlotMsg('A'));
            await waitMs(50);

            // Trigger a resize from the webview
            provider.triggerResize(1000, 700);
            const resizeMsg = JSON.parse(await client.readLine());
            expect(resizeMsg.type).toBe('resize');
            expect(resizeMsg.width).toBe(1000);

            // R responds with a resized frame
            client.send(makePlotMsg('A-resized', 1000, 700));
            await waitMs(50);

            // Should replace, not add
            expect(history.count()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('A-resized');
            client.close();
        });
    });

    // ---- Resize-after-delete (the jgd#11 bug) ----

    describe('resize after delete (jgd#11)', () => {
        it('discards stale resize frame after latest plot was deleted', async () => {
            const client = await connectClient(server.getSocketPath());
            await client.readLine();

            // Two plots: RED then BLUE
            client.send(makePlotMsg('RED'));
            await waitMs(50);
            client.send(makePlotMsg('BLUE'));
            await waitMs(50);
            expect(history.count()).toBe(2);

            // Delete BLUE (latest)
            history.removeCurrent();
            expect(history.count()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('RED');

            // Trigger resize
            provider.triggerResize(1000, 700);
            await client.readLine(); // consume resize message

            // R replays BLUE (stale) as resize response
            const plotsBefore = provider.shownPlots.length;
            client.send(makePlotMsg('BLUE', 1000, 700));
            await waitMs(50);

            // RED must survive, BLUE must not reappear
            expect(history.count()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('RED');
            // showPlot should NOT have been called for the rejected frame
            expect(provider.shownPlots.length).toBe(plotsBefore);
            client.close();
        });
    });

    // ---- broadcastResize dedup ----

    describe('broadcastResize', () => {
        it('deduplicates resize with same dimensions', async () => {
            const client = await connectClient(server.getSocketPath());
            const initialResize = JSON.parse(await client.readLine());
            // Initial dims are 800x600
            expect(initialResize.width).toBe(800);

            // Trigger resize with same dimensions
            provider.triggerResize(800, 600);
            // Should NOT receive a resize message — use a race with timeout
            const got = await Promise.race([
                client.readLine().then(() => true),
                waitMs(100).then(() => false),
            ]);
            expect(got).toBe(false);
            client.close();
        });

        it('forwards resize with different dimensions', async () => {
            const client = await connectClient(server.getSocketPath());
            await client.readLine(); // initial 800x600

            provider.triggerResize(1024, 768);
            const msg = JSON.parse(await client.readLine());
            expect(msg.type).toBe('resize');
            expect(msg.width).toBe(1024);
            expect(msg.height).toBe(768);
            client.close();
        });
    });

    // ---- Initial connection ----

    describe('initial connection', () => {
        it('sends current panel dimensions on connect', async () => {
            provider.dims = { width: 500, height: 400 };
            const client = await connectClient(server.getSocketPath());
            const msg = JSON.parse(await client.readLine());
            expect(msg.type).toBe('resize');
            expect(msg.width).toBe(500);
            expect(msg.height).toBe(400);
            client.close();
        });

        it('arms resizePending on initial connect', async () => {
            const client = await connectClient(server.getSocketPath());
            await client.readLine(); // consume initial resize

            // First frame after connect should be treated as resize response
            client.send(makePlotMsg('initial'));
            await waitMs(50);

            // Add another frame — if resizePending was properly consumed,
            // this should be a new plot (addPlot), not a replace
            client.send(makePlotMsg('second'));
            await waitMs(50);

            expect(history.count()).toBe(2);
            client.close();
        });
    });

    // ---- Metrics round-trip ----

    describe('metrics', () => {
        it('forwards metrics_request to provider and returns response', async () => {
            const client = await connectClient(server.getSocketPath());
            await client.readLine();

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
            client.close();
        });
    });
});
