import * as vscode from 'vscode';
import { PlotHistory, PlotFrame } from './plot-history';

export class PlotWebviewProvider {
    private panel: vscode.WebviewPanel | null = null;
    private pendingMetrics: Map<number, (response: any) => void> = new Map();
    private metricsIdCounter = 0;
    private panelWidth = 800;
    private panelHeight = 600;
    private resizeListeners: ((w: number, h: number) => void)[] = [];

    constructor(
        private extensionUri: vscode.Uri,
        private history: PlotHistory
    ) {}

    onResize(listener: (w: number, h: number) => void) {
        this.resizeListeners.push(listener);
    }

    getPanelDimensions(): { width: number; height: number } {
        return { width: this.panelWidth, height: this.panelHeight };
    }

    reveal(preserveFocus = false) {
        if (this.panel) {
            this.panel.reveal(undefined, preserveFocus);
        } else {
            this.createPanel(preserveFocus);
        }
        const plot = this.history.currentPlot();
        if (plot) this.sendPlotToWebview(plot);
    }

    refresh() {
        const plot = this.history.currentPlot();
        if (plot) {
            this.sendPlotToWebview(plot);
        } else {
            this.panel?.webview.postMessage({ type: 'clear' });
        }
        this.updateToolbar();
    }

    showPlot(plot: PlotFrame) {
        if (!this.panel) this.createPanel(true);
        this.sendPlotToWebview(plot);
        this.updateToolbar();
    }

    onDeviceClosed(_sessionId: string) {
        // Keep plots in history for navigation/export, just update toolbar
        this.updateToolbar();
    }

    navigatePrevious() {
        const plot = this.history.navigatePrevious();
        if (plot) {
            this.sendPlotToWebview(plot);
            this.updateToolbar();
        }
    }

    navigateNext() {
        const plot = this.history.navigateNext();
        if (plot) {
            this.sendPlotToWebview(plot);
            this.updateToolbar();
        }
    }

    async exportPlot(format: 'png' | 'svg' | 'pdf') {
        if (!this.panel) return;
        this.panel.webview.postMessage({ type: 'export', format });
    }

    async measureText(request: any): Promise<any> {
        if (!this.panel) {
            return { type: 'metrics_response', id: request.id, width: 0, ascent: 0, descent: 0 };
        }

        return new Promise((resolve) => {
            const id = ++this.metricsIdCounter;
            this.pendingMetrics.set(id, resolve);
            this.panel!.webview.postMessage({
                type: 'metrics_request',
                id,
                originalId: request.id,
                kind: request.kind,
                str: request.str,
                c: request.c,
                gc: request.gc
            });

            setTimeout(() => {
                if (this.pendingMetrics.has(id)) {
                    this.pendingMetrics.delete(id);
                    resolve({ type: 'metrics_response', id: request.id, width: 0, ascent: 0, descent: 0 });
                }
            }, 500);
        });
    }

    private createPanel(preserveFocus = false) {
        this.panel = vscode.window.createWebviewPanel(
            'jgd.plotPane',
            'R Plot',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.extensionUri, 'webview')
                ]
            }
        );

        this.panel.webview.html = this.getWebviewHtml();

        this.panel.webview.onDidReceiveMessage((msg) => {
            switch (msg.type) {
                case 'metrics_response': {
                    const resolver = this.pendingMetrics.get(msg.id);
                    if (resolver) {
                        this.pendingMetrics.delete(msg.id);
                        resolver({
                            type: 'metrics_response',
                            id: msg.originalId,
                            width: msg.width,
                            ascent: msg.ascent,
                            descent: msg.descent
                        });
                    }
                    break;
                }
                case 'export_data': {
                    this.handleExportData(msg);
                    break;
                }
                case 'resize': {
                    this.panelWidth = msg.width;
                    this.panelHeight = msg.height;
                    for (const l of this.resizeListeners) l(msg.width, msg.height);
                    break;
                }
                case 'navigate': {
                    if (msg.direction === 'previous') this.navigatePrevious();
                    else if (msg.direction === 'next') this.navigateNext();
                    break;
                }
                case 'requestExport': {
                    this.exportPlot(msg.format);
                    break;
                }
            }
        });

        this.panel.onDidDispose(() => {
            this.panel = null;
        });
    }

    private sendPlotToWebview(plot: PlotFrame) {
        this.panel?.webview.postMessage({ type: 'render', plot });
    }

    private updateToolbar() {
        this.panel?.webview.postMessage({
            type: 'toolbar',
            current: this.history.currentIndex(),
            total: this.history.count()
        });
    }

    private async handleExportData(msg: any) {
        const filters: Record<string, string[]> = {
            png: ['PNG Image'],
            svg: ['SVG Image'],
            pdf: ['PDF Document']
        };
        const ext = msg.format as string;
        const uri = await vscode.window.showSaveDialog({
            filters: { [filters[ext]?.[0] ?? ext]: [ext] },
            defaultUri: vscode.Uri.file(`plot.${ext}`)
        });
        if (!uri) return;

        if (msg.data) {
            const buf = Buffer.from(msg.data, 'base64');
            await vscode.workspace.fs.writeFile(uri, buf);
            vscode.window.showInformationMessage(`Plot exported to ${uri.fsPath}`);
        }
    }

    private getWebviewHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--vscode-editor-background); overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
#toolbar {
    display: flex; align-items: center; gap: 8px; padding: 4px 8px;
    background: var(--vscode-editorWidget-background);
    border-bottom: 1px solid var(--vscode-editorWidget-border);
    font-size: 12px; color: var(--vscode-foreground);
}
#toolbar button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; padding: 2px 8px; cursor: pointer; border-radius: 2px;
}
#toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
#toolbar button:disabled { opacity: 0.4; cursor: default; }
#plot-info { flex: 1; text-align: center; }
#canvas-container { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; }
canvas { display: block; }
</style>
</head>
<body>
<div id="toolbar">
    <button id="btn-prev" title="Previous plot">◀</button>
    <button id="btn-next" title="Next plot">▶</button>
    <span id="plot-info">No plots</span>
    <select id="export-select">
        <option value="">Export…</option>
        <option value="png">PNG</option>
        <option value="svg">SVG</option>
    </select>
</div>
<div id="canvas-container">
    <canvas id="plot-canvas"></canvas>
</div>
<canvas id="metrics-canvas" style="display:none;"></canvas>
<script>
${getRendererScript()}
</script>
</body>
</html>`;
    }
}

function getRendererScript(): string {
    return `
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('plot-canvas');
const ctx = canvas.getContext('2d');
const metricsCanvas = document.getElementById('metrics-canvas');
const metricsCtx = metricsCanvas.getContext('2d');

let currentPlot = null;

// Toolbar
document.getElementById('btn-prev').addEventListener('click', () => {
    vscode.postMessage({ type: 'navigate', direction: 'previous' });
});
document.getElementById('btn-next').addEventListener('click', () => {
    vscode.postMessage({ type: 'navigate', direction: 'next' });
});
document.getElementById('export-select').addEventListener('change', (e) => {
    const fmt = e.target.value;
    if (fmt) {
        vscode.postMessage({ type: 'requestExport', format: fmt });
        e.target.value = '';
    }
});

// Resize observer
const container = document.getElementById('canvas-container');
let resizeTimer = null;
const resizeObserver = new ResizeObserver(() => {
    if (currentPlot) replay(currentPlot);
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        vscode.postMessage({ type: 'resize', width: container.clientWidth, height: container.clientHeight });
    }, 300);
});
resizeObserver.observe(container);

// Message handler
window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
        case 'render':
            currentPlot = msg.plot;
            replay(msg.plot);
            break;
        case 'clear':
            currentPlot = null;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            break;
        case 'toolbar':
            document.getElementById('plot-info').textContent =
                msg.total > 0 ? msg.current + ' / ' + msg.total : 'No plots';
            document.getElementById('btn-prev').disabled = msg.current <= 1;
            document.getElementById('btn-next').disabled = msg.current >= msg.total;
            break;
        case 'metrics_request':
            handleMetricsRequest(msg);
            break;
        case 'export':
            handleExport(msg.format);
            break;
    }
});

function applyGc(ctx, gc) {
    if (!gc) return;
    if (gc.col != null) ctx.strokeStyle = gc.col;
    if (gc.fill != null) ctx.fillStyle = gc.fill;
    ctx.lineWidth = gc.lwd || 1;
    ctx.lineCap = gc.lend || 'round';
    ctx.lineJoin = gc.ljoin || 'round';
    ctx.miterLimit = gc.lmitre || 10;
    if (gc.lty && gc.lty.length > 0) {
        ctx.setLineDash(gc.lty);
    } else {
        ctx.setLineDash([]);
    }
    if (gc.font) {
        const size = gc.font.size || 12;
        const family = mapFontFamily(gc.font.family);
        const face = gc.font.face || 1;
        let style = '';
        if (face === 2 || face === 4) style += 'bold ';
        if (face === 3 || face === 4) style += 'italic ';
        ctx.font = style + size + 'px ' + family;
    }
}

function mapFontFamily(family) {
    if (!family || family === '' || family === 'sans') return 'sans-serif';
    if (family === 'serif' || family === 'Times') return 'serif';
    if (family === 'mono' || family === 'Courier') return 'monospace';
    return family + ', sans-serif';
}

async function replay(plot) {
    const dpr = window.devicePixelRatio || 1;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    const plotW = plot.device.width;
    const plotH = plot.device.height;
    const scaleX = containerW / plotW;
    const scaleY = containerH / plotH;
    const scale = Math.min(scaleX, scaleY);

    const drawW = plotW * scale;
    const drawH = plotH * scale;

    canvas.width = drawW * dpr;
    canvas.height = drawH * dpr;
    canvas.style.width = drawW + 'px';
    canvas.style.height = drawH + 'px';

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr * scale, dpr * scale);

    ctx.save();

    if (plot.device.bg) {
        ctx.fillStyle = plot.device.bg;
        ctx.fillRect(0, 0, plotW, plotH);
    } else {
        ctx.clearRect(0, 0, plotW, plotH);
    }

    const ops = plot.ops;
    for (let i = 0; i < ops.length; i++) {
        await renderOp(ctx, ops[i], plotH);
    }
}

async function renderOp(ctx, op, plotH) {
    switch (op.op) {
        case 'line': {
            applyGc(ctx, op.gc);
            if (op.gc && op.gc.col != null) {
                ctx.beginPath();
                ctx.moveTo(op.x1, op.y1);
                ctx.lineTo(op.x2, op.y2);
                ctx.stroke();
            }
            break;
        }
        case 'polyline': {
            applyGc(ctx, op.gc);
            if (op.x.length < 2) break;
            ctx.beginPath();
            ctx.moveTo(op.x[0], op.y[0]);
            for (let i = 1; i < op.x.length; i++) {
                ctx.lineTo(op.x[i], op.y[i]);
            }
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'polygon': {
            applyGc(ctx, op.gc);
            ctx.beginPath();
            ctx.moveTo(op.x[0], op.y[0]);
            for (let i = 1; i < op.x.length; i++) {
                ctx.lineTo(op.x[i], op.y[i]);
            }
            ctx.closePath();
            if (op.gc && op.gc.fill != null) ctx.fill();
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'rect': {
            applyGc(ctx, op.gc);
            const rx = Math.min(op.x0, op.x1);
            const ry = Math.min(op.y0, op.y1);
            const rw = Math.abs(op.x1 - op.x0);
            const rh = Math.abs(op.y1 - op.y0);
            if (op.gc && op.gc.fill != null) {
                ctx.fillStyle = op.gc.fill;
                ctx.fillRect(rx, ry, rw, rh);
            }
            if (op.gc && op.gc.col != null) {
                ctx.strokeStyle = op.gc.col;
                ctx.strokeRect(rx, ry, rw, rh);
            }
            break;
        }
        case 'circle': {
            applyGc(ctx, op.gc);
            ctx.beginPath();
            ctx.arc(op.x, op.y, op.r, 0, 2 * Math.PI);
            if (op.gc && op.gc.fill != null) ctx.fill();
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'text': {
            applyGc(ctx, op.gc);
            ctx.save();
            ctx.translate(op.x, op.y);
            if (op.rot) ctx.rotate(-op.rot * Math.PI / 180);
            ctx.textBaseline = 'alphabetic';
            let align = 'left';
            if (op.hadj === 0.5) align = 'center';
            else if (op.hadj === 1) align = 'right';
            ctx.textAlign = align;
            if (op.gc && op.gc.col != null) {
                ctx.fillStyle = op.gc.col;
                ctx.fillText(op.str, 0, 0);
            }
            ctx.restore();
            break;
        }
        case 'clip': {
            ctx.restore();
            ctx.save();
            ctx.beginPath();
            ctx.rect(op.x0, op.y0, op.x1 - op.x0, op.y1 - op.y0);
            ctx.clip();
            break;
        }
        case 'path': {
            applyGc(ctx, op.gc);
            ctx.beginPath();
            for (const subpath of op.subpaths) {
                if (subpath.length === 0) continue;
                ctx.moveTo(subpath[0][0], subpath[0][1]);
                for (let i = 1; i < subpath.length; i++) {
                    ctx.lineTo(subpath[i][0], subpath[i][1]);
                }
                ctx.closePath();
            }
            const rule = op.winding === 'evenodd' ? 'evenodd' : 'nonzero';
            if (op.gc && op.gc.fill != null) ctx.fill(rule);
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'raster': {
            const img = new Image();
            img.src = op.data;
            await img.decode();
            ctx.save();
            const dw = op.w;
            const dh = op.h;
            // R raster callback: (x,y) is bottom-left of destination in device coords.
            // Our device is top-down (y=0 at top). So:
            //   positive h: raster goes upward from y, top-left = (x, y - h)
            //   negative h: raster goes upward from y, top-left = (x, y + h) since h<0 means y+h < y
            // In both cases: top-left y = y - abs(h)
            const aw = Math.abs(dw);
            const ah = Math.abs(dh);
            const dx = dw >= 0 ? op.x : op.x + dw;
            const dy = op.y - ah;
            if (op.rot) {
                const cx = dx + aw / 2;
                const cy = dy + ah / 2;
                ctx.translate(cx, cy);
                ctx.rotate(-op.rot * Math.PI / 180);
                ctx.translate(-cx, -cy);
            }
            ctx.imageSmoothingEnabled = !!op.interpolate;
            ctx.drawImage(img, dx, dy, aw, ah);
            ctx.restore();
            break;
        }
    }
}

function handleMetricsRequest(msg) {
    const gc = msg.gc || {};
    const size = gc.font ? gc.font.size || 12 : 12;
    const family = gc.font ? mapFontFamily(gc.font.family) : 'sans-serif';
    const face = gc.font ? gc.font.face || 1 : 1;
    let style = '';
    if (face === 2 || face === 4) style += 'bold ';
    if (face === 3 || face === 4) style += 'italic ';
    metricsCtx.font = style + size + 'px ' + family;

    let width = 0, ascent = 0, descent = 0;
    if (msg.kind === 'strWidth' && msg.str) {
        const m = metricsCtx.measureText(msg.str);
        width = m.width;
    } else if (msg.kind === 'metricInfo') {
        const ch = msg.c > 0 ? String.fromCodePoint(msg.c) : 'M';
        const m = metricsCtx.measureText(ch);
        width = m.width;
        ascent = m.actualBoundingBoxAscent || size * 0.75;
        descent = m.actualBoundingBoxDescent || size * 0.25;
    }

    vscode.postMessage({
        type: 'metrics_response',
        id: msg.id,
        originalId: msg.originalId,
        width, ascent, descent
    });
}

function handleExport(format) {
    if (!currentPlot) return;
    if (format === 'png') {
        canvas.toBlob((blob) => {
            if (!blob) return;
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = btoa(String.fromCharCode(...new Uint8Array(reader.result)));
                vscode.postMessage({ type: 'export_data', format: 'png', data: base64 });
            };
            reader.readAsArrayBuffer(blob);
        }, 'image/png');
    } else if (format === 'svg') {
        const svg = plotToSvg(currentPlot);
        const base64 = btoa(unescape(encodeURIComponent(svg)));
        vscode.postMessage({ type: 'export_data', format: 'svg', data: base64 });
    }
}

function svgEsc(s) { return s.replace(/&/g,'&amp;').replace(/[<]/g,'&lt;').replace(/[>]/g,'&gt;').replace(/"/g,'&quot;'); }

function svgTag(name, attrs, selfClose) {
    return String.fromCharCode(60) + name + (attrs || '') + (selfClose ? '/>' : '>');
}
function svgClose(name) { return String.fromCharCode(60) + '/' + name + '>'; }

function svgGcStroke(gc) {
    if (!gc || gc.col == null) return ' stroke="none"';
    let s = ' stroke="' + gc.col + '"';
    s += ' stroke-width="' + (gc.lwd || 1) + '"';
    s += ' stroke-linecap="' + (gc.lend || 'round') + '"';
    s += ' stroke-linejoin="' + (gc.ljoin || 'round') + '"';
    if (gc.lty && gc.lty.length > 0) s += ' stroke-dasharray="' + gc.lty.join(',') + '"';
    return s;
}

function svgGcFill(gc) {
    if (!gc || gc.fill == null) return ' fill="none"';
    return ' fill="' + gc.fill + '"';
}

function svgFont(gc) {
    if (!gc || !gc.font) return { size: 12, family: 'sans-serif', style: '', weight: '' };
    const size = gc.font.size || 12;
    const family = mapFontFamily(gc.font.family);
    const face = gc.font.face || 1;
    return {
        size,
        family,
        weight: (face === 2 || face === 4) ? 'bold' : 'normal',
        style: (face === 3 || face === 4) ? 'italic' : 'normal'
    };
}

function plotToSvg(plot) {
    const w = plot.device.width;
    const h = plot.device.height;
    let s = svgTag('svg', ' xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"') + '\\n';

    if (plot.device.bg) {
        s += svgTag('rect', ' width="' + w + '" height="' + h + '" fill="' + plot.device.bg + '"', true) + '\\n';
    }

    let clipId = 0;
    let inClip = false;

    for (const op of plot.ops) {
        switch (op.op) {
            case 'clip': {
                if (inClip) s += svgClose('g') + '\\n';
                clipId++;
                const cw = op.x1 - op.x0, ch = op.y1 - op.y0;
                const cx = Math.min(op.x0, op.x1), cy = Math.min(op.y0, op.y1);
                const aw = Math.abs(cw), ah = Math.abs(ch);
                s += svgTag('defs') + svgTag('clipPath', ' id="c' + clipId + '"') + svgTag('rect', ' x="' + cx + '" y="' + cy + '" width="' + aw + '" height="' + ah + '"', true) + svgClose('clipPath') + svgClose('defs') + '\\n';
                s += svgTag('g', ' clip-path="url(#c' + clipId + ')"') + '\\n';
                inClip = true;
                break;
            }
            case 'line':
                s += svgTag('line', ' x1="' + op.x1 + '" y1="' + op.y1 + '" x2="' + op.x2 + '" y2="' + op.y2 + '"' + svgGcStroke(op.gc) + ' fill="none"', true) + '\\n';
                break;
            case 'rect': {
                const rx = Math.min(op.x0, op.x1), ry = Math.min(op.y0, op.y1);
                const rw = Math.abs(op.x1 - op.x0), rh = Math.abs(op.y1 - op.y0);
                s += svgTag('rect', ' x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\\n';
                break;
            }
            case 'circle':
                s += svgTag('circle', ' cx="' + op.x + '" cy="' + op.y + '" r="' + op.r + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\\n';
                break;
            case 'polyline': {
                if (op.x.length < 2) break;
                let pts = '';
                for (let i = 0; i < op.x.length; i++) pts += op.x[i] + ',' + op.y[i] + ' ';
                s += svgTag('polyline', ' points="' + pts.trim() + '"' + svgGcStroke(op.gc) + ' fill="none"', true) + '\\n';
                break;
            }
            case 'polygon': {
                let pts = '';
                for (let i = 0; i < op.x.length; i++) pts += op.x[i] + ',' + op.y[i] + ' ';
                s += svgTag('polygon', ' points="' + pts.trim() + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\\n';
                break;
            }
            case 'path': {
                let d = '';
                for (const sub of op.subpaths) {
                    if (sub.length === 0) continue;
                    d += 'M' + sub[0][0] + ' ' + sub[0][1];
                    for (let i = 1; i < sub.length; i++) d += 'L' + sub[i][0] + ' ' + sub[i][1];
                    d += 'Z';
                }
                const rule = op.winding === 'evenodd' ? 'evenodd' : 'nonzero';
                s += svgTag('path', ' d="' + d + '" fill-rule="' + rule + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\\n';
                break;
            }
            case 'text': {
                const f = svgFont(op.gc);
                let anchor = 'start';
                if (op.hadj === 0.5) anchor = 'middle';
                else if (op.hadj === 1) anchor = 'end';
                const col = (op.gc && op.gc.col != null) ? op.gc.col : 'black';
                let transform = 'translate(' + op.x + ',' + op.y + ')';
                if (op.rot) transform += ' rotate(' + (-op.rot) + ')';
                s += svgTag('text', ' transform="' + transform + '" font-family="' + f.family + '" font-size="' + f.size + '" font-weight="' + f.weight + '" font-style="' + f.style + '" text-anchor="' + anchor + '" fill="' + col + '"') + svgEsc(op.str) + svgClose('text') + '\\n';
                break;
            }
            case 'raster': {
                const aw = Math.abs(op.w), ah = Math.abs(op.h);
                const dx = op.w >= 0 ? op.x : op.x + op.w;
                const dy = op.y - ah;
                let transform = '';
                if (op.rot) {
                    const cx = dx + aw / 2, cy = dy + ah / 2;
                    transform = ' transform="rotate(' + (-op.rot) + ',' + cx + ',' + cy + ')"';
                }
                s += svgTag('image', ' x="' + dx + '" y="' + dy + '" width="' + aw + '" height="' + ah + '" href="' + op.data + '"' + transform, true) + '\\n';
                break;
            }
        }
    }

    if (inClip) s += svgClose('g') + '\\n';
    s += svgClose('svg');
    return s;
}
`;
}
