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
}

export class SocketServer {
    private server: net.Server | null = null;
    private socketPath: string = '';
    private sessions: Map<string, RSession> = new Map();
    private connectionListeners: ConnectionChangeListener[] = [];
    private sessionCounter = 0;

    constructor(
        private history: PlotHistory,
        private webviewProvider: PlotWebviewProvider
    ) {}

    getSocketPath(): string {
        return this.socketPath;
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
        const token = crypto.randomBytes(8).toString('hex');
        this.socketPath = path.join(os.tmpdir(), `jgd-${token}.sock`);

        try { fs.unlinkSync(this.socketPath); } catch {}

        this.webviewProvider.onResize((w, h) => {
            this.broadcast({ type: 'resize', width: w, height: h });
        });

        this.server = net.createServer((socket) => this.handleConnection(socket));
        this.server.listen(this.socketPath, () => {
            console.log('jgd: socket server listening at', this.socketPath);
            const discoveryContent = JSON.stringify({
                socketPath: this.socketPath,
                pid: process.pid
            });
            const locations = [
                path.join(os.tmpdir(), 'jgd-discovery.json'),
                '/tmp/jgd-discovery.json',
                '/private/tmp/jgd-discovery.json'
            ];
            for (const loc of locations) {
                try {
                    fs.writeFileSync(loc, discoveryContent);
                    console.log('jgd: wrote discovery file to', loc);
                } catch (e) {
                    console.warn('jgd: failed to write discovery to', loc, e);
                }
            }

            process.env['JGD_SOCKET'] = this.socketPath;

            for (const l of this.readyListeners) l();
        });

        this.server.on('error', (err) => {
            console.error('jgd socket server error:', err);
        });
    }

    stop() {
        for (const session of this.sessions.values()) {
            session.socket.destroy();
        }
        this.sessions.clear();
        this.server?.close();
        try { fs.unlinkSync(this.socketPath); } catch {}
        try { fs.unlinkSync(path.join(os.tmpdir(), 'jgd-discovery.json')); } catch {}
        try { fs.unlinkSync('/tmp/jgd-discovery.json'); } catch {}
    }

    private handleConnection(socket: net.Socket) {
        const sessionId = `session-${++this.sessionCounter}`;
        const session: RSession = { id: sessionId, socket, buffer: '' };
        this.sessions.set(sessionId, session);
        this.notifyConnectionChange();

        const dims = this.webviewProvider.getPanelDimensions();
        if (dims) {
            socket.write(JSON.stringify({ type: 'resize', width: dims.width, height: dims.height }) + '\n');
        }

        socket.on('data', (data) => {
            session.buffer += data.toString();
            let newlineIdx: number;
            while ((newlineIdx = session.buffer.indexOf('\n')) !== -1) {
                const line = session.buffer.substring(0, newlineIdx);
                session.buffer = session.buffer.substring(newlineIdx + 1);
                if (line.length > 0) {
                    this.handleMessage(session, line);
                }
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
                        if (msg.incremental) {
                            this.history.replaceCurrent(session.id, msg.plot);
                        } else {
                            this.history.addPlot(session.id, msg.plot);
                        }
                        this.webviewProvider.showPlot(msg.plot);
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

    broadcast(msg: object) {
        const data = JSON.stringify(msg) + '\n';
        for (const session of this.sessions.values()) {
            session.socket.write(data);
        }
    }
}
