import { EventEmitter } from 'events';

export interface PlotFrame {
    version: number;
    sessionId: string;
    device: {
        width: number;
        height: number;
        dpi: number;
        bg: string | null;
    };
    ops: any[];
}

interface SessionHistory {
    plots: PlotFrame[];
    currentIndex: number;
    latestDeleted: boolean;
}

export class PlotHistory {
    private sessions: Map<string, SessionHistory> = new Map();
    private activeSessionId: string = '';
    private maxPlots: number;
    private emitter = new EventEmitter();

    constructor(maxPlots: number = 50) {
        this.maxPlots = maxPlots;
    }

    onDidChange(listener: () => void) {
        this.emitter.on('change', listener);
    }

    addPlot(sessionId: string, plot: PlotFrame) {
        let session = this.sessions.get(sessionId);
        if (!session) {
            session = { plots: [], currentIndex: -1, latestDeleted: false };
            this.sessions.set(sessionId, session);
        }

        session.latestDeleted = false;
        session.plots.push(plot);
        // Evict oldest if over limit
        while (session.plots.length > this.maxPlots) {
            session.plots.shift();
        }
        session.currentIndex = session.plots.length - 1;
        this.activeSessionId = sessionId;
        this.emitter.emit('change');
    }

    replaceCurrent(sessionId: string, plot: PlotFrame) {
        let session = this.sessions.get(sessionId);
        if (!session || session.plots.length === 0) {
            return this.addPlot(sessionId, plot);
        }
        session.plots[session.currentIndex] = plot;
        this.activeSessionId = sessionId;
        this.emitter.emit('change');
    }

    replaceLatest(sessionId: string, plot: PlotFrame) {
        const session = this.sessions.get(sessionId);
        if (session && session.latestDeleted) return;
        if (!session || session.plots.length === 0) {
            return this.addPlot(sessionId, plot);
        }
        session.plots[session.plots.length - 1] = plot;
        // Don't change currentIndex — user stays on their historical view
        this.activeSessionId = sessionId;
        this.emitter.emit('change');
    }

    currentPlot(): PlotFrame | null {
        const session = this.sessions.get(this.activeSessionId);
        if (!session || session.currentIndex < 0) return null;
        return session.plots[session.currentIndex] ?? null;
    }

    navigatePrevious(): PlotFrame | null {
        const session = this.sessions.get(this.activeSessionId);
        if (!session || session.currentIndex <= 0) return null;
        session.currentIndex--;
        this.emitter.emit('change');
        return session.plots[session.currentIndex];
    }

    navigateNext(): PlotFrame | null {
        const session = this.sessions.get(this.activeSessionId);
        if (!session || session.currentIndex >= session.plots.length - 1) return null;
        session.currentIndex++;
        this.emitter.emit('change');
        return session.plots[session.currentIndex];
    }

    currentIndex(): number {
        const session = this.sessions.get(this.activeSessionId);
        return session ? session.currentIndex + 1 : 0;
    }

    count(): number {
        const session = this.sessions.get(this.activeSessionId);
        return session ? session.plots.length : 0;
    }

    clear() {
        const session = this.sessions.get(this.activeSessionId);
        if (session) {
            session.plots = [];
            session.currentIndex = -1;
        }
        this.emitter.emit('change');
    }

    removeCurrent(): PlotFrame | null {
        const session = this.sessions.get(this.activeSessionId);
        if (!session || session.plots.length === 0) return null;
        const wasLatest = (session.currentIndex === session.plots.length - 1);
        session.plots.splice(session.currentIndex, 1);
        if (wasLatest) session.latestDeleted = true;
        if (session.plots.length === 0) {
            session.currentIndex = -1;
            this.emitter.emit('change');
            return null;
        }
        if (session.currentIndex >= session.plots.length) {
            session.currentIndex = session.plots.length - 1;
        }
        this.emitter.emit('change');
        return session.plots[session.currentIndex];
    }
}
