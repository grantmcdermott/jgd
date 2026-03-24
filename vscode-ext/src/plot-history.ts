import { EventEmitter } from 'events';

export interface PlotFrame {
    version: number;
    sessionId: string;
    /** Frame-level extension fields (e.g. postEffects). */
    frameExt?: Record<string, unknown> | null;
    device: {
        width: number;
        height: number;
        dpi: number;
        bg: string | null;
    };
    ops: any[];
    /** R-side snapshot index, assigned by PlotHistory on addPlot. */
    rIndex?: number;
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

    onDidChange(listener: () => void): { dispose(): void } {
        this.emitter.on('change', listener);
        return {
            dispose: () => {
                this.emitter.removeListener('change', listener);
            },
        };
    }

    addPlot(sessionId: string, plot: PlotFrame) {
        let session = this.sessions.get(sessionId);
        if (!session) {
            session = { plots: [], currentIndex: -1, latestDeleted: false };
            this.sessions.set(sessionId, session);
        }

        session.latestDeleted = false;
        // rIndex is set by the caller from R's plotNumber before calling addPlot
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
        const old = session.plots[session.currentIndex];
        if (old?.rIndex !== undefined) plot.rIndex = old.rIndex;
        session.plots[session.currentIndex] = plot;
        this.activeSessionId = sessionId;
        this.emitter.emit('change');
    }

    appendOps(sessionId: string, plot: PlotFrame): boolean {
        const session = this.sessions.get(sessionId);
        if (session && session.latestDeleted) return false;
        if (!session || session.plots.length === 0) {
            this.addPlot(sessionId, plot);
            return true;
        }
        // Always append to the latest plot, not the currently viewed one.
        // Incremental frames are always for the most recent drawing/replay,
        // even if the user has navigated to a historical plot.
        const latest = session.plots[session.plots.length - 1];
        const newOps = plot.ops || [];
        for (const op of newOps) {
            latest.ops.push(op);
        }
        latest.device = plot.device;
        this.activeSessionId = sessionId;
        this.emitter.emit('change');
        return true;
    }

    replaceAtIndex(sessionId: string, rIndex: number, plot: PlotFrame): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        const idx = session.plots.findIndex(p => p.rIndex === rIndex);
        if (idx < 0) return false;
        plot.rIndex = rIndex;
        session.plots[idx] = plot;
        this.activeSessionId = sessionId;
        this.emitter.emit('change');
        return true;
    }

    replaceLatest(sessionId: string, plot: PlotFrame, expectedRIndex?: number): boolean {
        const session = this.sessions.get(sessionId);
        if (session && session.latestDeleted) return false;
        if (!session || session.plots.length === 0) {
            this.addPlot(sessionId, plot);
            return true;
        }
        const old = session.plots[session.plots.length - 1];
        // If expectedRIndex is provided, verify we're replacing the right plot.
        // A new plot may have been added after the resize was sent, so the
        // latest plot's rIndex won't match — skip the stale replacement.
        if (expectedRIndex !== undefined && old?.rIndex !== undefined && old.rIndex !== expectedRIndex) {
            return false;
        }
        if (old?.rIndex !== undefined) {
            plot.rIndex = old.rIndex;
        } else if (expectedRIndex !== undefined) {
            plot.rIndex = expectedRIndex;
        }
        session.plots[session.plots.length - 1] = plot;
        // Don't change currentIndex — user stays on their historical view
        this.activeSessionId = sessionId;
        this.emitter.emit('change');
        return true;
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

    getActiveSessionId(): string {
        return this.activeSessionId;
    }

    currentIndex(): number {
        const session = this.sessions.get(this.activeSessionId);
        return session ? session.currentIndex + 1 : 0;
    }

    /** Return the R-side snapshot index of the current plot. */
    currentRIndex(): number | undefined {
        const plot = this.currentPlot();
        return plot?.rIndex;
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
            session.latestDeleted = false;
        }
        this.emitter.emit('change');
    }

    isLatestDeleted(): boolean {
        const session = this.sessions.get(this.activeSessionId);
        return session ? session.latestDeleted : false;
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
