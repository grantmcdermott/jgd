import { describe, it, expect, beforeEach } from 'vitest';
import { PlotHistory, PlotFrame } from './plot-history';

function makePlot(label: string, width = 400, height = 300): PlotFrame {
    return {
        version: 1,
        sessionId: '',
        device: { width, height, dpi: 96, bg: label },
        ops: [{ op: 'rect', label }],
    };
}

describe('PlotHistory', () => {
    let history: PlotHistory;

    beforeEach(() => {
        history = new PlotHistory(50);
    });

    // ---- Basic operations ----

    describe('addPlot', () => {
        it('adds a plot and sets it as current', () => {
            history.addPlot('s1', makePlot('A'));
            expect(history.count()).toBe(1);
            expect(history.currentIndex()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('A');
        });

        it('appends multiple plots', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            expect(history.count()).toBe(2);
            expect(history.currentIndex()).toBe(2);
            expect(history.currentPlot()?.device.bg).toBe('B');
        });
    });

    describe('navigation', () => {
        beforeEach(() => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.addPlot('s1', makePlot('C'));
        });

        it('navigatePrevious moves backward', () => {
            const plot = history.navigatePrevious();
            expect(plot?.device.bg).toBe('B');
            expect(history.currentIndex()).toBe(2);
        });

        it('navigateNext moves forward', () => {
            history.navigatePrevious();
            const plot = history.navigateNext();
            expect(plot?.device.bg).toBe('C');
            expect(history.currentIndex()).toBe(3);
        });

        it('navigatePrevious returns null at beginning', () => {
            history.navigatePrevious();
            history.navigatePrevious();
            expect(history.navigatePrevious()).toBeNull();
            expect(history.currentIndex()).toBe(1);
        });

        it('navigateNext returns null at end', () => {
            expect(history.navigateNext()).toBeNull();
            expect(history.currentIndex()).toBe(3);
        });
    });

    describe('removeCurrent', () => {
        it('removes the only plot', () => {
            history.addPlot('s1', makePlot('A'));
            const remaining = history.removeCurrent();
            expect(remaining).toBeNull();
            expect(history.count()).toBe(0);
        });

        it('removes middle plot and stays in bounds', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.addPlot('s1', makePlot('C'));
            history.navigatePrevious(); // now at B
            const remaining = history.removeCurrent();
            expect(remaining?.device.bg).toBe('C');
            expect(history.count()).toBe(2);
        });

        it('removes last plot and adjusts index', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            const remaining = history.removeCurrent(); // remove B (latest)
            expect(remaining?.device.bg).toBe('A');
            expect(history.count()).toBe(1);
            expect(history.currentIndex()).toBe(1);
        });

        it('returns null on empty history', () => {
            expect(history.removeCurrent()).toBeNull();
        });
    });

    describe('clear', () => {
        it('removes all plots', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.clear();
            expect(history.count()).toBe(0);
            expect(history.currentPlot()).toBeNull();
        });
    });

    // ---- replaceCurrent ----

    describe('replaceCurrent', () => {
        it('replaces the current plot in place', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.replaceCurrent('s1', makePlot('B2'));
            expect(history.count()).toBe(2);
            expect(history.currentPlot()?.device.bg).toBe('B2');
        });

        it('falls back to addPlot on empty session', () => {
            history.replaceCurrent('s1', makePlot('A'));
            expect(history.count()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('A');
        });

        it('replaces at navigated position, not latest', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.navigatePrevious(); // now at A
            history.replaceCurrent('s1', makePlot('A2'));
            expect(history.currentPlot()?.device.bg).toBe('A2');
            history.navigateNext();
            expect(history.currentPlot()?.device.bg).toBe('B');
        });
    });

    // ---- replaceLatest ----

    describe('replaceLatest', () => {
        it('replaces the latest plot regardless of navigation', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.navigatePrevious(); // viewing A
            const accepted = history.replaceLatest('s1', makePlot('B2'));
            expect(accepted).toBe(true);
            // Still viewing A
            expect(history.currentPlot()?.device.bg).toBe('A');
            // Navigate to latest — it's B2 now
            history.navigateNext();
            expect(history.currentPlot()?.device.bg).toBe('B2');
        });

        it('falls back to addPlot on empty session', () => {
            const accepted = history.replaceLatest('s1', makePlot('A'));
            expect(accepted).toBe(true);
            expect(history.count()).toBe(1);
        });
    });

    // ---- latestDeleted lifecycle ----

    describe('latestDeleted', () => {
        it('replaceLatest is rejected after deleting latest plot', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.removeCurrent(); // remove B (latest) → latestDeleted = true
            expect(history.count()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('A');

            const accepted = history.replaceLatest('s1', makePlot('stale'));
            expect(accepted).toBe(false);
            expect(history.count()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('A');
        });

        it('deleting non-latest plot does not arm latestDeleted', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.navigatePrevious(); // viewing A
            history.removeCurrent(); // remove A (not latest)
            expect(history.count()).toBe(1);

            const accepted = history.replaceLatest('s1', makePlot('B2'));
            expect(accepted).toBe(true);
            expect(history.currentPlot()?.device.bg).toBe('B2');
        });

        it('addPlot resets latestDeleted', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.removeCurrent(); // latestDeleted = true

            history.addPlot('s1', makePlot('C')); // resets latestDeleted
            const accepted = history.replaceLatest('s1', makePlot('C2'));
            expect(accepted).toBe(true);
            expect(history.currentPlot()?.device.bg).toBe('C2');
        });

        it('clear resets latestDeleted', () => {
            history.addPlot('s1', makePlot('A'));
            history.removeCurrent(); // latestDeleted = true
            history.clear();

            // After clear, addPlot should work and replaceLatest too
            history.addPlot('s1', makePlot('B'));
            const accepted = history.replaceLatest('s1', makePlot('B2'));
            expect(accepted).toBe(true);
        });

        it('replaceLatest is rejected on empty session after deleting last plot', () => {
            history.addPlot('s1', makePlot('A'));
            history.removeCurrent(); // latestDeleted = true, plots = []
            expect(history.count()).toBe(0);

            // latestDeleted check fires before the empty-session fallback
            const accepted = history.replaceLatest('s1', makePlot('stale'));
            expect(accepted).toBe(false);
            expect(history.count()).toBe(0);
        });
    });

    // ---- Resize-after-delete scenario (PR#13 / PR#18 bug) ----

    describe('resize after delete (jgd#11)', () => {
        it('must not replace remaining plot with stale resize frame', () => {
            // 1. Create RED then BLUE plot
            history.addPlot('s1', makePlot('RED'));
            history.addPlot('s1', makePlot('BLUE'));
            expect(history.count()).toBe(2);
            expect(history.currentPlot()?.device.bg).toBe('BLUE');

            // 2. Delete BLUE (latest)
            history.removeCurrent();
            expect(history.count()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('RED');

            // 3. Resize replay: R sends BLUE back (R doesn't know about deletion)
            const accepted = history.replaceLatest('s1', makePlot('BLUE', 800, 600));
            expect(accepted).toBe(false);

            // 4. RED must survive
            expect(history.count()).toBe(1);
            expect(history.currentPlot()?.device.bg).toBe('RED');
        });

        it('resize works normally when latest was not deleted', () => {
            history.addPlot('s1', makePlot('RED'));
            history.addPlot('s1', makePlot('BLUE'));

            // Resize replay replaces BLUE with resized BLUE
            const accepted = history.replaceLatest('s1', makePlot('BLUE', 800, 600));
            expect(accepted).toBe(true);
            expect(history.count()).toBe(2);
            expect(history.currentPlot()?.device.bg).toBe('BLUE');
            expect(history.currentPlot()?.device.width).toBe(800);
        });
    });

    // ---- Eviction ----

    describe('eviction', () => {
        it('evicts oldest plots when maxPlots exceeded', () => {
            const small = new PlotHistory(3);
            small.addPlot('s1', makePlot('A'));
            small.addPlot('s1', makePlot('B'));
            small.addPlot('s1', makePlot('C'));
            small.addPlot('s1', makePlot('D'));
            expect(small.count()).toBe(3);
            // A was evicted
            small.navigatePrevious();
            small.navigatePrevious();
            expect(small.currentPlot()?.device.bg).toBe('B');
        });
    });

    // ---- Multi-session ----

    describe('multi-session', () => {
        it('tracks plots independently per session', () => {
            history.addPlot('s1', makePlot('S1-A'));
            history.addPlot('s2', makePlot('S2-A'));
            // Active session is now s2
            expect(history.currentPlot()?.device.bg).toBe('S2-A');
            expect(history.count()).toBe(1);

            // Switch back to s1 by adding a plot
            history.addPlot('s1', makePlot('S1-B'));
            expect(history.currentPlot()?.device.bg).toBe('S1-B');
            expect(history.count()).toBe(2);
        });
    });

    // ---- Change events ----

    describe('events', () => {
        it('emits change on addPlot', () => {
            let fired = 0;
            history.onDidChange(() => fired++);
            history.addPlot('s1', makePlot('A'));
            expect(fired).toBe(1);
        });

        it('emits change on navigation', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            let fired = 0;
            history.onDidChange(() => fired++);
            history.navigatePrevious();
            history.navigateNext();
            expect(fired).toBe(2);
        });

        it('emits change on replaceLatest', () => {
            history.addPlot('s1', makePlot('A'));
            let fired = 0;
            history.onDidChange(() => fired++);
            history.replaceLatest('s1', makePlot('A2'));
            expect(fired).toBe(1);
        });

        it('emits change on replaceCurrent', () => {
            history.addPlot('s1', makePlot('A'));
            let fired = 0;
            history.onDidChange(() => fired++);
            history.replaceCurrent('s1', makePlot('A2'));
            expect(fired).toBe(1);
        });

        it('does not emit change when replaceLatest is rejected', () => {
            history.addPlot('s1', makePlot('A'));
            history.removeCurrent();
            let fired = 0;
            history.onDidChange(() => fired++);
            history.replaceLatest('s1', makePlot('stale'));
            expect(fired).toBe(0);
        });
    });
});
