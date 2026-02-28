// Embedded web assets for self-contained execution (no filesystem needed).
// Source: servers/go/web/
//
// To update: copy file contents from servers/go/web/ into the template literals below.

export const assets: Record<string, { body: string; type: string }> = {
  "/index.html": {
    type: "text/html; charset=utf-8",
    body: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>jgd</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<div id="toolbar">
    <div id="ws-status" title="Disconnected"></div>
    <button id="btn-prev" title="Previous plot" disabled>&#9664;</button>
    <button id="btn-next" title="Next plot" disabled>&#9654;</button>
    <button id="btn-delete" title="Remove current plot" disabled>&#10005;</button>
    <span id="plot-info">No plots</span>
    <select id="export-select" disabled>
        <option value="">Export\u2026</option>
        <option value="png">PNG</option>
        <option value="svg">SVG</option>
    </select>
</div>
<div id="canvas-container">
    <canvas id="plot-canvas"></canvas>
</div>
<canvas id="metrics-canvas" style="display:none;"></canvas>
<script src="renderer.js"></script>
<script src="app.js"></script>
</body>
</html>
`,
  },

  "/app.js": {
    type: "text/javascript; charset=utf-8",
    body: `// app.js — WebSocket client, PlotHistory, message routing, toolbar, resize, metrics, export.
// Plot history, message routing, toolbar, resize, metrics, and export for the browser frontend.

(function() {
    'use strict';

    // ---- PlotHistory (ported from plot-history.ts) ----

    function PlotHistory(maxPlots) {
        this._sessions = new Map();
        this._activeSessionId = '';
        this._maxPlots = maxPlots || 50;
    }

    PlotHistory.prototype.addPlot = function(sessionId, plot) {
        var session = this._sessions.get(sessionId);
        if (!session) {
            session = { plots: [], currentIndex: -1, latestDeleted: false };
            this._sessions.set(sessionId, session);
        }
        session.latestDeleted = false;
        session.plots.push(plot);
        while (session.plots.length > this._maxPlots) {
            session.plots.shift();
        }
        session.currentIndex = session.plots.length - 1;
        this._activeSessionId = sessionId;
    };

    PlotHistory.prototype.replaceCurrent = function(sessionId, plot) {
        var session = this._sessions.get(sessionId);
        if (!session || session.plots.length === 0) {
            return this.addPlot(sessionId, plot);
        }
        session.plots[session.currentIndex] = plot;
        this._activeSessionId = sessionId;
    };

    PlotHistory.prototype.appendOps = function(sessionId, plot) {
        var session = this._sessions.get(sessionId);
        if (session && session.latestDeleted) return;
        if (!session || session.plots.length === 0) {
            return this.addPlot(sessionId, plot);
        }
        // Always append to the latest plot, not the currently viewed one.
        // Incremental frames are always for the most recent drawing/replay,
        // even if the user has navigated to a historical plot.
        var latest = session.plots[session.plots.length - 1];
        var newOps = plot.ops || [];
        for (var i = 0; i < newOps.length; i++) {
            latest.ops.push(newOps[i]);
        }
        latest.device = plot.device;
        this._activeSessionId = sessionId;
    };

    PlotHistory.prototype.currentPlot = function() {
        var session = this._sessions.get(this._activeSessionId);
        if (!session || session.currentIndex < 0) return null;
        return session.plots[session.currentIndex] || null;
    };

    PlotHistory.prototype.navigatePrevious = function() {
        var session = this._sessions.get(this._activeSessionId);
        if (!session || session.currentIndex <= 0) return null;
        session.currentIndex--;
        return session.plots[session.currentIndex];
    };

    PlotHistory.prototype.navigateNext = function() {
        var session = this._sessions.get(this._activeSessionId);
        if (!session || session.currentIndex >= session.plots.length - 1) return null;
        session.currentIndex++;
        return session.plots[session.currentIndex];
    };

    PlotHistory.prototype.removeCurrent = function() {
        var session = this._sessions.get(this._activeSessionId);
        if (!session || session.plots.length === 0) return null;
        var wasLatest = (session.currentIndex === session.plots.length - 1);
        session.plots.splice(session.currentIndex, 1);
        if (wasLatest) session.latestDeleted = true;
        if (session.plots.length === 0) {
            session.currentIndex = -1;
            return null;
        }
        if (session.currentIndex >= session.plots.length) {
            session.currentIndex = session.plots.length - 1;
        }
        return session.plots[session.currentIndex];
    };

    PlotHistory.prototype.replaceLatest = function(sessionId, plot) {
        var session = this._sessions.get(sessionId);
        if (session && session.latestDeleted) return;
        if (!session || session.plots.length === 0) {
            return this.addPlot(sessionId, plot);
        }
        session.plots[session.plots.length - 1] = plot;
        // Don't change currentIndex — user stays on their historical view
    };

    PlotHistory.prototype.replaceAtIndex = function(sessionId, plotIndex, plot) {
        var session = this._sessions.get(sessionId);
        if (!session || plotIndex < 0 || plotIndex >= session.plots.length) return;
        session.plots[plotIndex] = plot;
        this._activeSessionId = sessionId;
    };

    PlotHistory.prototype.currentIndex = function() {
        var session = this._sessions.get(this._activeSessionId);
        return session ? session.currentIndex + 1 : 0;
    };

    PlotHistory.prototype.count = function() {
        var session = this._sessions.get(this._activeSessionId);
        return session ? session.plots.length : 0;
    };

    // ---- DOM references ----

    var canvas = document.getElementById('plot-canvas');
    var container = document.getElementById('canvas-container');
    var metricsCanvas = document.getElementById('metrics-canvas');
    var metricsCtx = metricsCanvas.getContext('2d');
    var btnPrev = document.getElementById('btn-prev');
    var btnNext = document.getElementById('btn-next');
    var btnDelete = document.getElementById('btn-delete');
    var exportSelect = document.getElementById('export-select');
    var plotInfo = document.getElementById('plot-info');
    var wsStatus = document.getElementById('ws-status');

    // ---- State ----

    var history = new PlotHistory(50);
    var ws = null;

    // ---- Toolbar updates ----

    function updateToolbar() {
        var idx = history.currentIndex();
        var total = history.count();
        plotInfo.textContent = total > 0 ? idx + ' / ' + total : 'No plots';
        btnPrev.disabled = idx <= 1;
        btnNext.disabled = idx >= total;
        btnDelete.disabled = total === 0;
        exportSelect.disabled = total === 0;
    }

    function replayCurrentPlot() {
        var plot = history.currentPlot();
        if (plot) {
            replay(canvas, container, plot);
        } else {
            var ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    // ---- Toolbar event handlers ----

    btnPrev.addEventListener('click', function() {
        if (history.navigatePrevious()) {
            replayCurrentPlot();
            updateToolbar();
        }
    });

    btnNext.addEventListener('click', function() {
        if (history.navigateNext()) {
            replayCurrentPlot();
            updateToolbar();
        }
    });

    btnDelete.addEventListener('click', function() {
        history.removeCurrent();
        replayCurrentPlot();
        updateToolbar();
    });

    exportSelect.addEventListener('change', function(e) {
        var fmt = e.target.value;
        if (!fmt) return;
        e.target.value = '';
        handleExport(fmt);
    });

    // ---- Export ----

    function handleExport(format) {
        var plot = history.currentPlot();
        if (!plot) return;

        var dpr = window.devicePixelRatio || 1;
        var exportW = canvas.width;
        var exportH = canvas.height;

        if (format === 'png') {
            renderToOffscreen(plot, exportW, exportH).then(function(blob) {
                if (!blob) return;
                downloadBlob(blob, 'plot.png');
            });
        } else if (format === 'svg') {
            var svg = plotToSvg(plot, exportW / dpr, exportH / dpr);
            var blob = new Blob([svg], { type: 'image/svg+xml' });
            downloadBlob(blob, 'plot.svg');
        }
    }

    function downloadBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function() { URL.revokeObjectURL(url); }, 1500);
    }

    // ---- Message handlers ----

    var renderScheduled = false;

    function scheduleRender() {
        if (!renderScheduled) {
            renderScheduled = true;
            requestAnimationFrame(function() {
                renderScheduled = false;
                replayCurrentPlot();
                updateToolbar();
            });
        }
    }

    function handleFrame(msg) {
        var plot = msg.plot;
        var sessionId = plot.sessionId || 'default';
        if (msg.resize) {
            if (msg.plotIndex !== undefined) {
                history.replaceAtIndex(sessionId, msg.plotIndex, plot);
            } else {
                history.replaceLatest(sessionId, plot);
            }
        } else if (msg.incremental) {
            history.appendOps(sessionId, plot);
        } else {
            history.addPlot(sessionId, plot);
        }
        scheduleRender();
    }

    function handleMetricsRequest(msg) {
        var gc = msg.gc || {};
        var size = gc.font ? gc.font.size || 12 : 12;
        var family = gc.font ? mapFontFamily(gc.font.family) : 'sans-serif';
        var face = gc.font ? gc.font.face || 1 : 1;
        var style = '';
        if (face === 2 || face === 4) style += 'bold ';
        if (face === 3 || face === 4) style += 'italic ';
        metricsCtx.font = style + size + 'px ' + family;

        var width = 0, ascent = 0, descent = 0;
        var m;
        if (msg.kind === 'strWidth' && msg.str) {
            m = metricsCtx.measureText(msg.str);
            width = m.width;
        } else if (msg.kind === 'metricInfo') {
            var ch = msg.c > 0 ? String.fromCodePoint(msg.c) : 'M';
            m = metricsCtx.measureText(ch);
            width = m.width;
            ascent = m.actualBoundingBoxAscent || size * 0.75;
            descent = m.actualBoundingBoxDescent || size * 0.25;
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'metrics_response',
                id: msg.id,
                width: width,
                ascent: ascent,
                descent: descent
            }));
        }
    }

    // ---- Resize ----

    var resizeTimer = null;
    var resizeObserver = new ResizeObserver(function() {
        replayCurrentPlot();
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                var msg = {
                    type: 'resize',
                    width: container.clientWidth,
                    height: container.clientHeight
                };
                // Include plotIndex when viewing a historical plot (not the latest)
                var idx = history.currentIndex();
                var total = history.count();
                if (total > 0 && idx < total) {
                    msg.plotIndex = idx - 1;
                }
                ws.send(JSON.stringify(msg));
            }
        }, 300);
    });
    resizeObserver.observe(container);

    // ---- WebSocket ----

    var reconnectDelay = 2000;
    var maxReconnectDelay = 30000;

    function connect() {
        var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(proto + '//' + location.host + '/ws');

        ws.onopen = function() {
            reconnectDelay = 2000;
            wsStatus.className = 'connected';
            wsStatus.title = 'Connected';
            // Send initial resize so R knows the viewport size
            ws.send(JSON.stringify({
                type: 'resize',
                width: container.clientWidth,
                height: container.clientHeight
            }));
        };

        ws.onclose = function() {
            wsStatus.className = '';
            wsStatus.title = 'Disconnected';
            setTimeout(connect, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
        };

        ws.onerror = function() {
            // onclose will fire after this
        };

        ws.onmessage = function(e) {
            var msg;
            try {
                msg = JSON.parse(e.data);
            } catch (err) {
                return;
            }

            switch (msg.type) {
                case 'frame':
                    handleFrame(msg);
                    break;
                case 'metrics_request':
                    handleMetricsRequest(msg);
                    break;
                case 'close':
                    updateToolbar();
                    break;
            }
        };
    }

    connect();

})();
`,
  },

  "/renderer.js": {
    type: "text/javascript; charset=utf-8",
    body: `// renderer.js — Canvas2D rendering functions for jgd plot display.
// All functions are global so app.js can call them.

function mapFontFamily(family) {
    if (!family || family === '' || family === 'sans') return 'sans-serif';
    if (family === 'serif' || family === 'Times') return 'serif';
    if (family === 'mono' || family === 'Courier') return 'monospace';
    return family + ', sans-serif';
}

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
        var size = gc.font.size || 12;
        var family = mapFontFamily(gc.font.family);
        var face = gc.font.face || 1;
        var style = '';
        if (face === 2 || face === 4) style += 'bold ';
        if (face === 3 || face === 4) style += 'italic ';
        ctx.font = style + size + 'px ' + family;
    }
}

// Generation counter to detect superseded renders — incremented each
// time replay() starts.  If a newer render begins while an async op
// (raster image decode) is pending, the older render aborts.
var _renderGen = 0;

async function replay(canvas, container, plot) {
    var gen = ++_renderGen;
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var containerW = container.clientWidth;
    var containerH = container.clientHeight;

    var plotW = plot.device.width;
    var plotH = plot.device.height;
    var scaleX = containerW / plotW;
    var scaleY = containerH / plotH;
    var scale = Math.min(scaleX, scaleY);

    var drawW = plotW * scale;
    var drawH = plotH * scale;

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

    var ops = plot.ops;
    for (var i = 0; i < ops.length; i++) {
        await renderOp(ctx, ops[i], plotH);
        // Abort if a newer render has started (prevents overlap from
        // async raster image decoding interleaving with a new render).
        if (_renderGen !== gen) { ctx.restore(); return; }
    }

    ctx.restore();
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
            for (var i = 1; i < op.x.length; i++) {
                ctx.lineTo(op.x[i], op.y[i]);
            }
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'polygon': {
            applyGc(ctx, op.gc);
            ctx.beginPath();
            ctx.moveTo(op.x[0], op.y[0]);
            for (var i = 1; i < op.x.length; i++) {
                ctx.lineTo(op.x[i], op.y[i]);
            }
            ctx.closePath();
            if (op.gc && op.gc.fill != null) ctx.fill();
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'rect': {
            applyGc(ctx, op.gc);
            var rx = Math.min(op.x0, op.x1);
            var ry = Math.min(op.y0, op.y1);
            var rw = Math.abs(op.x1 - op.x0);
            var rh = Math.abs(op.y1 - op.y0);
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
            var align = 'left';
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
            for (var si = 0; si < op.subpaths.length; si++) {
                var subpath = op.subpaths[si];
                if (subpath.length === 0) continue;
                ctx.moveTo(subpath[0][0], subpath[0][1]);
                for (var i = 1; i < subpath.length; i++) {
                    ctx.lineTo(subpath[i][0], subpath[i][1]);
                }
                ctx.closePath();
            }
            var rule = op.winding === 'evenodd' ? 'evenodd' : 'nonzero';
            if (op.gc && op.gc.fill != null) ctx.fill(rule);
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'raster': {
            var img = new Image();
            img.src = op.data;
            await img.decode();
            ctx.save();
            var dw = op.w;
            var dh = op.h;
            var aw = Math.abs(dw);
            var ah = Math.abs(dh);
            var dx = dw >= 0 ? op.x : op.x + dw;
            var dy = op.y - ah;
            if (op.rot) {
                var cx = dx + aw / 2;
                var cy = dy + ah / 2;
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

// Render a plot to an offscreen canvas and return a PNG Blob.
function renderToOffscreen(plot, width, height) {
    var offscreen = document.createElement('canvas');
    var plotW = plot.device.width;
    var plotH = plot.device.height;
    var scale = Math.min(width / plotW, height / plotH);
    offscreen.width = plotW * scale;
    offscreen.height = plotH * scale;
    var offCtx = offscreen.getContext('2d');
    offCtx.scale(scale, scale);
    if (plot.device.bg) {
        offCtx.fillStyle = plot.device.bg;
        offCtx.fillRect(0, 0, plotW, plotH);
    }
    return (async function() {
        for (var i = 0; i < plot.ops.length; i++) {
            await renderOp(offCtx, plot.ops[i], plotH);
        }
        return new Promise(function(resolve) {
            offscreen.toBlob(function(blob) { resolve(blob); }, 'image/png');
        });
    })();
}

// SVG export helpers

function svgEsc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function svgTag(name, attrs, selfClose) {
    return '<' + name + (attrs || '') + (selfClose ? '/>' : '>');
}

function svgClose(name) {
    return '</' + name + '>';
}

function svgGcStroke(gc) {
    if (!gc || gc.col == null) return ' stroke="none"';
    var s = ' stroke="' + svgEsc(gc.col) + '"';
    s += ' stroke-width="' + (+gc.lwd || 1) + '"';
    s += ' stroke-linecap="' + svgEsc(gc.lend || 'round') + '"';
    s += ' stroke-linejoin="' + svgEsc(gc.ljoin || 'round') + '"';
    if (gc.lty && gc.lty.length > 0) s += ' stroke-dasharray="' + gc.lty.map(function(v) { return +v || 0; }).join(',') + '"';
    return s;
}

function svgGcFill(gc) {
    if (!gc || gc.fill == null) return ' fill="none"';
    return ' fill="' + svgEsc(gc.fill) + '"';
}

function svgFont(gc) {
    if (!gc || !gc.font) return { size: 12, family: 'sans-serif', style: '', weight: '' };
    var size = +gc.font.size || 12;
    var family = mapFontFamily(gc.font.family);
    var face = gc.font.face || 1;
    return {
        size: size,
        family: family,
        weight: (face === 2 || face === 4) ? 'bold' : 'normal',
        style: (face === 3 || face === 4) ? 'italic' : 'normal'
    };
}

function plotToSvg(plot, exportW, exportH) {
    var w = plot.device.width;
    var h = plot.device.height;
    var outW = exportW || w;
    var outH = exportH || h;
    var s = svgTag('svg', ' xmlns="http://www.w3.org/2000/svg" width="' + outW + '" height="' + outH + '" viewBox="0 0 ' + w + ' ' + h + '"') + '\\n';

    if (plot.device.bg) {
        s += svgTag('rect', ' width="' + w + '" height="' + h + '" fill="' + svgEsc(plot.device.bg) + '"', true) + '\\n';
    }

    var clipId = 0;
    var inClip = false;

    for (var oi = 0; oi < plot.ops.length; oi++) {
        var op = plot.ops[oi];
        switch (op.op) {
            case 'clip': {
                if (inClip) s += svgClose('g') + '\\n';
                clipId++;
                var cw = op.x1 - op.x0, ch = op.y1 - op.y0;
                var cx = Math.min(op.x0, op.x1), cy = Math.min(op.y0, op.y1);
                var aw = Math.abs(cw), ah = Math.abs(ch);
                s += svgTag('defs') + svgTag('clipPath', ' id="c' + clipId + '"') + svgTag('rect', ' x="' + cx + '" y="' + cy + '" width="' + aw + '" height="' + ah + '"', true) + svgClose('clipPath') + svgClose('defs') + '\\n';
                s += svgTag('g', ' clip-path="url(#c' + clipId + ')"') + '\\n';
                inClip = true;
                break;
            }
            case 'line':
                s += svgTag('line', ' x1="' + op.x1 + '" y1="' + op.y1 + '" x2="' + op.x2 + '" y2="' + op.y2 + '"' + svgGcStroke(op.gc) + ' fill="none"', true) + '\\n';
                break;
            case 'rect': {
                var rx = Math.min(op.x0, op.x1), ry = Math.min(op.y0, op.y1);
                var rw = Math.abs(op.x1 - op.x0), rh = Math.abs(op.y1 - op.y0);
                s += svgTag('rect', ' x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\\n';
                break;
            }
            case 'circle':
                s += svgTag('circle', ' cx="' + op.x + '" cy="' + op.y + '" r="' + op.r + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\\n';
                break;
            case 'polyline': {
                if (op.x.length < 2) break;
                var pts = '';
                for (var i = 0; i < op.x.length; i++) pts += op.x[i] + ',' + op.y[i] + ' ';
                s += svgTag('polyline', ' points="' + pts.trim() + '"' + svgGcStroke(op.gc) + ' fill="none"', true) + '\\n';
                break;
            }
            case 'polygon': {
                var pts = '';
                for (var i = 0; i < op.x.length; i++) pts += op.x[i] + ',' + op.y[i] + ' ';
                s += svgTag('polygon', ' points="' + pts.trim() + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\\n';
                break;
            }
            case 'path': {
                var d = '';
                for (var si = 0; si < op.subpaths.length; si++) {
                    var sub = op.subpaths[si];
                    if (sub.length === 0) continue;
                    d += 'M' + sub[0][0] + ' ' + sub[0][1];
                    for (var i = 1; i < sub.length; i++) d += 'L' + sub[i][0] + ' ' + sub[i][1];
                    d += 'Z';
                }
                var rule = op.winding === 'evenodd' ? 'evenodd' : 'nonzero';
                s += svgTag('path', ' d="' + d + '" fill-rule="' + rule + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\\n';
                break;
            }
            case 'text': {
                var f = svgFont(op.gc);
                var anchor = 'start';
                if (op.hadj === 0.5) anchor = 'middle';
                else if (op.hadj === 1) anchor = 'end';
                var col = (op.gc && op.gc.col != null) ? svgEsc(op.gc.col) : 'black';
                var transform = 'translate(' + op.x + ',' + op.y + ')';
                if (op.rot) transform += ' rotate(' + (-op.rot) + ')';
                s += svgTag('text', ' transform="' + transform + '" font-family="' + svgEsc(f.family) + '" font-size="' + f.size + '" font-weight="' + svgEsc(f.weight) + '" font-style="' + svgEsc(f.style) + '" text-anchor="' + anchor + '" fill="' + col + '"') + svgEsc(op.str) + svgClose('text') + '\\n';
                break;
            }
            case 'raster': {
                var aw = Math.abs(op.w), ah = Math.abs(op.h);
                var dx = op.w >= 0 ? op.x : op.x + op.w;
                var dy = op.y - ah;
                var transform = '';
                if (op.rot) {
                    var cx = dx + aw / 2, cy = dy + ah / 2;
                    transform = ' transform="rotate(' + (-op.rot) + ',' + cx + ',' + cy + ')"';
                }
                var safeHref = /^data:image\\//.test(op.data) ? op.data : svgEsc(op.data);
                s += svgTag('image', ' x="' + dx + '" y="' + dy + '" width="' + aw + '" height="' + ah + '" href="' + safeHref + '"' + transform, true) + '\\n';
                break;
            }
        }
    }

    if (inClip) s += svgClose('g') + '\\n';
    s += svgClose('svg');
    return s;
}
`,
  },

  "/style.css": {
    type: "text/css; charset=utf-8",
    body: `* { margin: 0; padding: 0; box-sizing: border-box; }

body {
    background: #1e1e1e;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    height: 100vh;
}

#toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    background: #252526;
    border-bottom: 1px solid #454545;
    font-size: 12px;
    color: #cccccc;
    font-family: system-ui, -apple-system, sans-serif;
}

#toolbar button, #toolbar select {
    background: #3a3d41;
    color: #cccccc;
    border: none;
    padding: 2px 8px;
    cursor: pointer;
    border-radius: 2px;
    font-size: 12px;
}

#toolbar button:hover, #toolbar select:hover {
    background: #45494e;
}

#toolbar button:disabled, #toolbar select:disabled {
    opacity: 0.4;
    cursor: default;
}

#plot-info {
    flex: 1;
    text-align: center;
}

#ws-status {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #f44747;
    flex-shrink: 0;
}

#ws-status.connected {
    background: #4ec9b0;
}

#canvas-container {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
}

canvas {
    display: block;
}
`,
  },
};
