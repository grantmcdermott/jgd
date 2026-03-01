import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { PlotHistory } from './plot-history';
import { PlotWebviewProvider } from './webview-provider';

export type ConnectionChangeListener = (count: number) => void;

interface RSession {
    id: string;
    socket: net.Socket;
    buffer: string;
    welcomeSent: boolean;
    /**
     * Queue of pending resize entries.  Each browser resize message pushes one
     * entry; each R frame shifts one entry off.  Normal resize entries are
     * collapsed (only the latest is kept) while plotIndex entries are preserved.
     */
    pendingResizes: Array<{ plotIndex?: number }>;
    lastResizeW: number;
    lastResizeH: number;
}

/**
 * Maximum number of pending resize entries per session.  Under normal
 * operation the queue rarely exceeds 2-3 entries because each R frame
 * shifts one off.  This cap prevents unbounded growth if a browser
 * floods resize messages without R consuming them.
 */
const MAX_PENDING_RESIZES = 32;

const isWindows = process.platform === 'win32';

export class SocketServer {
    private server: net.Server | null = null;
    private socketPath: string = '';
    private tcpPort: number = 0;
    private sessions: Map<string, RSession> = new Map();
    private connectionListeners: ConnectionChangeListener[] = [];
    private sessionCounter = 0;

    constructor(
        private history: PlotHistory,
        private webviewProvider: PlotWebviewProvider
    ) {}

    getSocketPath(): string {
        return isWindows ? `tcp://127.0.0.1:${this.tcpPort}` : this.socketPath;
    }

    getEnvVars(): Record<string, string> {
        return { JGD_SOCKET: this.getSocketPath() };
    }

    private readyListeners: (() => void)[] = [];

    onReady(listener: () => void) {
        this.readyListeners.push(listener);
    }

    onConnectionChange(listener: ConnectionChangeListener) {
        this.connectionListeners.push(listener);
    }

    private notifyConnectionChange() {
        const count = this.sessions.size;
        for (const l of this.connectionListeners) l(count);
    }

    start() {
        this.webviewProvider.onResize((w, h) => {
            // When viewing a historical plot, include plotIndex and sessionId
            // so R re-renders the correct historical snapshot.
            const idx = this.history.currentIndex();
            const total = this.history.count();
            if (total > 0 && idx < total) {
                const plotIndex = idx - 1;
                const sessionId = this.history.getActiveSessionId();
                this.broadcastResize(w, h, plotIndex, sessionId);
            } else {
                this.broadcastResize(w, h);
            }
        });

        this.server = net.createServer((socket) => this.handleConnection(socket));

        if (isWindows) {
            /* TCP on Windows — let OS pick a free port */
            this.server.listen(0, '127.0.0.1', () => {
                const addr = this.server!.address() as net.AddressInfo;
                this.tcpPort = addr.port;
                console.log('jgd: TCP server listening on 127.0.0.1:' + this.tcpPort);
                this.writeDiscovery();
                this.notifyReady();
            });
        } else {
            /* Unix domain socket */
            const token = crypto.randomBytes(8).toString('hex');
            this.socketPath = path.join(os.tmpdir(), `jgd-${token}.sock`);
            try { fs.unlinkSync(this.socketPath); } catch {}

            this.server.listen(this.socketPath, () => {
                console.log('jgd: socket server listening at', this.socketPath);
                this.writeDiscovery();
                this.notifyReady();
            });
        }

        this.server.on('error', (err) => {
            console.error('jgd socket server error:', err);
        });
    }

    private writeDiscovery() {
        const socketPath = this.getSocketPath();
        const discoveryContent = JSON.stringify({ socketPath, pid: process.pid });

        const locations = [path.join(os.tmpdir(), 'jgd-discovery.json')];
        if (!isWindows) {
            locations.push('/tmp/jgd-discovery.json', '/private/tmp/jgd-discovery.json');
        }

        for (const loc of locations) {
            try {
                fs.writeFileSync(loc, discoveryContent);
                console.log('jgd: wrote discovery file to', loc);
            } catch (e) {
                console.warn('jgd: failed to write discovery to', loc, e);
            }
        }

        /* Set env vars for child processes */
        process.env['JGD_SOCKET'] = this.getSocketPath();
    }

    private notifyReady() {
        for (const l of this.readyListeners) l();
    }

    stop() {
        for (const session of this.sessions.values()) {
            session.socket.destroy();
        }
        this.sessions.clear();
        this.server?.close();
        if (!isWindows) {
            try { fs.unlinkSync(this.socketPath); } catch {}
        }
        try { fs.unlinkSync(path.join(os.tmpdir(), 'jgd-discovery.json')); } catch {}
        if (!isWindows) {
            try { fs.unlinkSync('/tmp/jgd-discovery.json'); } catch {}
        }
    }

    private handleConnection(socket: net.Socket) {
        const sessionId = `session-${++this.sessionCounter}`;
        const session: RSession = { id: sessionId, socket, buffer: '', welcomeSent: false, pendingResizes: [], lastResizeW: 0, lastResizeH: 0 };
        this.sessions.set(sessionId, session);
        this.notifyConnectionChange();

        socket.on('data', (data) => {
            session.buffer += data.toString();
            let newlineIdx: number;
            while ((newlineIdx = session.buffer.indexOf('\n')) !== -1) {
                const line = session.buffer.substring(0, newlineIdx);
                session.buffer = session.buffer.substring(newlineIdx + 1);
                if (line.length === 0) continue;

                // Defer welcome until the first message from R is received,
                // matching the Deno server handshake protocol.
                if (!session.welcomeSent) {
                    session.welcomeSent = true;
                    const welcome = {
                        type: 'server_info',
                        serverName: 'jgd-vscode',
                        protocolVersion: 1,
                        transport: isWindows ? 'tcp' : 'unix',
                    };
                    socket.write(JSON.stringify(welcome) + '\n');

                    const dims = this.webviewProvider.getPanelDimensions();
                    if (dims) {
                        session.pendingResizes.push({ plotIndex: undefined });
                        session.lastResizeW = dims.width;
                        session.lastResizeH = dims.height;
                        socket.write(JSON.stringify({ type: 'resize', width: dims.width, height: dims.height }) + '\n');
                    }
                }

                this.handleMessage(session, line);
            }
        });

        socket.on('close', () => {
            this.sessions.delete(sessionId);
            this.notifyConnectionChange();
        });

        socket.on('error', (err) => {
            console.error(`jgd session ${sessionId} error:`, err.message);
            this.sessions.delete(sessionId);
            this.notifyConnectionChange();
        });
    }

    private handleMessage(session: RSession, line: string) {
        try {
            const msg = JSON.parse(line);
            switch (msg.type) {
                case 'frame':
                    if (msg.plot) {
                        msg.plot.sessionId = session.id;
                        // Shift from the queue so each frame gets the correct entry
                        const entry = session.pendingResizes.length > 0
                            ? session.pendingResizes.shift()!
                            : undefined;
                        const isResize = entry !== undefined;
                        const plotIndex = entry?.plotIndex;
                        let accepted = true;
                        if (isResize && plotIndex !== undefined) {
                            accepted = this.history.replaceAtIndex(session.id, plotIndex, msg.plot);
                        } else if (isResize) {
                            accepted = this.history.replaceLatest(session.id, msg.plot);
                        } else if (msg.incremental) {
                            this.history.replaceCurrent(session.id, msg.plot);
                        } else {
                            this.history.addPlot(session.id, msg.plot);
                        }
                        if (accepted) this.webviewProvider.showPlot(msg.plot);
                    }
                    break;

                case 'metrics_request':
                    this.webviewProvider.measureText(msg).then((response) => {
                        const resp = JSON.stringify(response) + '\n';
                        session.socket.write(resp);
                    });
                    break;

                case 'close':
                    console.log(`jgd: session ${session.id} device closed`);
                    this.webviewProvider.onDeviceClosed(session.id);
                    break;

                default:
                    break;
            }
        } catch (e) {
            console.error('jgd: failed to parse message:', e);
        }
    }

    sendToSession(sessionId: string, msg: object) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.socket.write(JSON.stringify(msg) + '\n');
        }
    }

    private broadcastResize(w: number, h: number, plotIndex?: number, sessionId?: string) {
        // plotIndex resizes require sessionId for routing.
        // Route to the target session only; drop if the session is dead.
        if (plotIndex !== undefined) {
            if (!sessionId) return;
            const session = this.sessions.get(sessionId);
            if (!session) return;
            if (session.pendingResizes.length >= MAX_PENDING_RESIZES) return;
            session.pendingResizes.push({ plotIndex });
            // Do NOT update lastResizeW/H here — plotIndex resizes target a
            // specific historical plot, not the device viewport.
            const data = JSON.stringify({ type: 'resize', width: w, height: h, plotIndex }) + '\n';
            session.socket.write(data);
            return;
        }

        // Normal resize — broadcast to all sessions with dedup.
        const data = JSON.stringify({ type: 'resize', width: w, height: h }) + '\n';
        for (const session of this.sessions.values()) {
            if (session.lastResizeW === w && session.lastResizeH === h) continue;
            // Collapse previous normal entries; preserve plotIndex entries.
            session.pendingResizes = session.pendingResizes.filter(
                (e) => e.plotIndex !== undefined,
            );
            if (session.pendingResizes.length >= MAX_PENDING_RESIZES) continue;
            session.pendingResizes.push({ plotIndex: undefined });
            session.lastResizeW = w;
            session.lastResizeH = h;
            session.socket.write(data);
        }
    }
}
