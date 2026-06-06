const Render = (function() {
    const BOARD_WIDTH = 100;
    const BOARD_HEIGHT = 80;

    const COLORS = {
        board: '#1a5c2e',
        boardBorder: '#0d3d1c',
        grid: 'rgba(255, 255, 255, 0.08)',
        gridMajor: 'rgba(255, 255, 255, 0.15)',
        front: '#e74c3c',
        frontDim: 'rgba(231, 76, 60, 0.3)',
        frontPour: 'rgba(231, 76, 60, 0.35)',
        back: '#3498db',
        backDim: 'rgba(52, 152, 199, 0.3)',
        backPour: 'rgba(52, 152, 199, 0.35)',
        pad: '#f1c40f',
        padHole: '#2c3e50',
        via: '#ecf0f1',
        viaCenter: '#ffffff',
        viaFront: '#e74c3c',
        viaBack: '#3498db',
        drc: 'rgba(231, 76, 60, 0.5)',
        drcBorder: '#e74c3c',
        selection: '#f39c12',
        highlight: 'rgba(243, 156, 18, 0.3)',
        ghost: 'rgba(255, 255, 255, 0.4)',
        thermal: '#e67e22',
        ratsnest: '#f1c40f',
        pulse: '#e94560',
        netHighlight: '#f39c12',
        netColors: {
            'NET1': '#e74c3c',
            'NET2': '#3498db',
            'NET3': '#2ecc71',
            'NET4': '#9b59b6',
            'NET5': '#f39c12'
        }
    };

    let canvas, ctx;
    let viewState = {
        scale: 5,
        offsetX: 0,
        offsetY: 0,
        displayLayers: 'both',
        currentLayer: 'front',
        gridEnabled: true,
        gridSize: 0.5
    };

    let interactionState = {
        currentTool: 'pad',
        hoverPoint: null,
        selectedElement: null,
        drawingTrack: null,
        drawingCopperPour: null,
        ghostPad: null,
        ghostVia: null,
        dragState: null
    };

    let reportState = {
        panelOpen: false,
        pulseTarget: null,
        pulseStartTime: 0,
        pulseCount: 0,
        highlightedNet: null,
        showRatsnest: false
    };

    function init(canvasElement) {
        canvas = canvasElement;
        ctx = canvas.getContext('2d');
        resizeCanvas();
        centerBoard();
    }

    function resizeCanvas() {
        const container = canvas.parentElement;
        canvas.width = container.clientWidth;
        canvas.height = container.clientHeight;
    }

    function centerBoard() {
        const boardPixelW = BOARD_WIDTH * viewState.scale;
        const boardPixelH = BOARD_HEIGHT * viewState.scale;
        viewState.offsetX = (canvas.width - boardPixelW) / 2;
        viewState.offsetY = (canvas.height - boardPixelH) / 2;
    }

    function getViewState() {
        return viewState;
    }

    function getInteractionState() {
        return interactionState;
    }

    function setDisplayLayers(mode) {
        viewState.displayLayers = mode;
        if (mode === 'front') viewState.currentLayer = 'front';
        if (mode === 'back') viewState.currentLayer = 'back';
    }

    function setCurrentLayer(layer) {
        viewState.currentLayer = layer;
        if (viewState.displayLayers === 'both') {
        } else {
            viewState.displayLayers = layer;
        }
    }

    function setGridEnabled(enabled) {
        viewState.gridEnabled = enabled;
    }

    function setGridSize(size) {
        viewState.gridSize = size;
    }

    function setCurrentTool(tool) {
        interactionState.currentTool = tool;
    }

    function setHoverPoint(point) {
        interactionState.hoverPoint = point;
    }

    function setSelectedElement(element) {
        interactionState.selectedElement = element;
    }

    function setDrawingTrack(track) {
        interactionState.drawingTrack = track;
    }

    function setGhostPad(pad) {
        interactionState.ghostPad = pad;
    }

    function setGhostVia(via) {
        interactionState.ghostVia = via;
    }

    function setDragState(state) {
        interactionState.dragState = state;
    }

    function setDrawingCopperPour(pour) {
        interactionState.drawingCopperPour = pour;
    }

    function setPanelOpen(open) {
        reportState.panelOpen = open;
        if (!open) {
            reportState.showRatsnest = false;
        }
    }

    function setHighlightedNet(net) {
        reportState.highlightedNet = net;
    }

    function getHighlightedNet() {
        return reportState.highlightedNet;
    }

    function setShowRatsnest(show) {
        reportState.showRatsnest = show;
    }

    function startPulseAnimation(position) {
        reportState.pulseTarget = position;
        reportState.pulseStartTime = performance.now();
        reportState.pulseCount = 0;
        runPulseFrame();
    }

    function runPulseFrame() {
        if (!reportState.pulseTarget) return;

        const elapsed = performance.now() - reportState.pulseStartTime;
        const cycleDuration = 600;
        const totalCycles = 3;
        const totalDuration = cycleDuration * totalCycles;

        if (elapsed >= totalDuration) {
            reportState.pulseTarget = null;
            render();
            return;
        }

        reportState.pulseCount = Math.floor(elapsed / cycleDuration);
        render();
        requestAnimationFrame(runPulseFrame);
    }

    function centerOnPosition(point, targetScale) {
        const scale = targetScale || viewState.scale;
        const boardPixelW = BOARD_WIDTH * scale;
        const boardPixelH = BOARD_HEIGHT * scale;

        const container = canvas.parentElement;
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;

        const pointScreenX = point.x * scale;
        const pointScreenY = point.y * scale;

        viewState.scale = scale;
        viewState.offsetX = containerWidth / 2 - pointScreenX;
        viewState.offsetY = containerHeight / 2 - pointScreenY;
    }

    function worldToScreen(point) {
        return {
            x: point.x * viewState.scale + viewState.offsetX,
            y: point.y * viewState.scale + viewState.offsetY
        };
    }

    function screenToWorld(point) {
        return {
            x: (point.x - viewState.offsetX) / viewState.scale,
            y: (point.y - viewState.offsetY) / viewState.scale
        };
    }

    function zoom(factor, center) {
        const worldCenter = center ? screenToWorld(center) : {
            x: BOARD_WIDTH / 2,
            y: BOARD_HEIGHT / 2
        };

        const newScale = Geometry.clamp(viewState.scale * factor, 2.5, 100);
        const actualFactor = newScale / viewState.scale;

        const newScreenCenter = {
            x: worldCenter.x * newScale + viewState.offsetX,
            y: worldCenter.y * newScale + viewState.offsetY
        };

        viewState.scale = newScale;
        viewState.offsetX = center ? center.x - worldCenter.x * newScale : viewState.offsetX;
        viewState.offsetY = center ? center.y - worldCenter.y * newScale : viewState.offsetY;
    }

    function pan(dx, dy) {
        viewState.offsetX += dx;
        viewState.offsetY += dy;
    }

    function getBoardBounds() {
        return { width: BOARD_WIDTH, height: BOARD_HEIGHT };
    }

    function render() {
        resizeCanvas();

        ctx.fillStyle = '#0f0f1a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        drawBoard();

        if (viewState.gridEnabled) {
            drawGrid();
        }

        const showBack = viewState.displayLayers === 'both' || viewState.displayLayers === 'back';
        const showFront = viewState.displayLayers === 'both' || viewState.displayLayers === 'front';

        if (showBack) {
            drawLayer('back', viewState.displayLayers === 'both');
        }

        if (showFront) {
            drawLayer('front', viewState.displayLayers === 'both');
        }

        drawViases();

        if (DRC.isEnabled()) {
            drawDRCViolations();
        }

        if (reportState.panelOpen && reportState.showRatsnest) {
            drawRatsnestLines();
        }

        if (reportState.highlightedNet) {
            drawNetHighlight(reportState.highlightedNet);
        }

        drawGhostElements();

        drawDrawingTrack();

        drawDrawingCopperPour();

        drawSelection();

        if (reportState.pulseTarget) {
            drawPulseAnimation();
        }

        if (interactionState.hoverPoint) {
            drawCursor();
        }
    }

    function drawBoard() {
        const tl = worldToScreen({ x: 0, y: 0 });
        const br = worldToScreen({ x: BOARD_WIDTH, y: BOARD_HEIGHT });
        const w = br.x - tl.x;
        const h = br.y - tl.y;

        ctx.fillStyle = COLORS.board;
        ctx.fillRect(tl.x, tl.y, w, h);

        ctx.strokeStyle = COLORS.boardBorder;
        ctx.lineWidth = Math.max(2, viewState.scale * 0.2);
        ctx.strokeRect(tl.x, tl.y, w, h);
    }

    function drawGrid() {
        const tl = worldToScreen({ x: 0, y: 0 });
        const br = worldToScreen({ x: BOARD_WIDTH, y: BOARD_HEIGHT });

        const gridSize = viewState.gridSize;
        const majorStep = gridSize >= 1 ? 5 : (gridSize >= 0.5 ? 10 : 25);

        ctx.lineWidth = 1;

        for (let x = 0; x <= BOARD_WIDTH; x += gridSize) {
            const isMajor = Math.abs((x / gridSize) % majorStep) < 0.01;
            ctx.strokeStyle = isMajor ? COLORS.gridMajor : COLORS.grid;
            const p1 = worldToScreen({ x: x, y: 0 });
            const p2 = worldToScreen({ x: x, y: BOARD_HEIGHT });
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        }

        for (let y = 0; y <= BOARD_HEIGHT; y += gridSize) {
            const isMajor = Math.abs((y / gridSize) % majorStep) < 0.01;
            ctx.strokeStyle = isMajor ? COLORS.gridMajor : COLORS.grid;
            const p1 = worldToScreen({ x: 0, y: y });
            const p2 = worldToScreen({ x: BOARD_WIDTH, y: y });
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        }
    }

    function drawLayer(layer, dimmed) {
        const state = PCBState.getState();
        const isCurrent = layer === viewState.currentLayer;
        const opacity = dimmed && !isCurrent ? 0.3 : 1.0;

        for (const pour of state.copperPours) {
            if (pour.layer !== layer) continue;
            drawCopperPour(pour, opacity);
        }

        for (const track of state.tracks) {
            if (track.layer !== layer) continue;
            drawTrack(track, opacity);
        }

        for (const pad of state.pads) {
            drawPad(pad, layer, opacity);
        }
    }

    function drawTrack(track, opacity = 1.0) {
        if (track.points.length < 2) return;

        const layerColor = track.layer === 'front' ? COLORS.front : COLORS.back;
        const color = opacity < 1
            ? (track.layer === 'front' ? COLORS.frontDim : COLORS.backDim)
            : layerColor;

        const pixelWidth = Math.max(1, track.width * viewState.scale);

        ctx.save();
        ctx.globalAlpha = opacity;

        ctx.strokeStyle = color;
        ctx.lineWidth = pixelWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        const start = worldToScreen(track.points[0]);
        ctx.moveTo(start.x, start.y);
        for (let i = 1; i < track.points.length; i++) {
            const p = worldToScreen(track.points[i]);
            ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();

        ctx.restore();
    }

    function drawPad(pad, layer, opacity = 1.0) {
        const center = worldToScreen(pad);
        const radius = Math.max(1, pad.diameter / 2 * viewState.scale);
        const holeRadius = Math.max(0.5, pad.hole / 2 * viewState.scale);

        const layerColor = layer === 'front' ? COLORS.front : COLORS.back;
        const dimColor = layer === 'front' ? COLORS.frontDim : COLORS.backDim;

        ctx.save();
        ctx.globalAlpha = opacity;

        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = opacity < 1 ? dimColor : layerColor;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(center.x, center.y, holeRadius, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.padHole;
        ctx.fill();

        ctx.strokeStyle = opacity < 1 ? 'rgba(241, 196, 15, 0.3)' : COLORS.pad;
        ctx.lineWidth = Math.max(1, viewState.scale * 0.1);
        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.restore();
    }

    function drawViases() {
        const state = PCBState.getState();

        for (const via of state.vias) {
            drawVia(via);
        }
    }

    function drawVia(via) {
        const center = worldToScreen(via);
        const radius = Math.max(1, via.diameter / 2 * viewState.scale);
        const holeRadius = Math.max(0.5, via.hole / 2 * viewState.scale);

        ctx.save();

        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.viaFront;
        ctx.globalAlpha = viewState.displayLayers === 'back' ? 0.3 : 1;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.viaBack;
        ctx.globalAlpha = viewState.displayLayers === 'front' ? 0.3 : 1;
        ctx.fill();

        ctx.globalAlpha = 1;

        ctx.beginPath();
        ctx.arc(center.x, center.y, holeRadius, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.viaCenter;
        ctx.fill();

        ctx.strokeStyle = COLORS.via;
        ctx.lineWidth = Math.max(1, viewState.scale * 0.08);
        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.restore();
    }

    function drawDRCViolations() {
        const violations = DRC.getViolations();
        const clearance = DRC.getClearance();

        for (const v of violations) {
            if (viewState.displayLayers !== 'both' && viewState.displayLayers !== v.layer) continue;

            const pos = worldToScreen(v.position);
            const actualRadius = Math.max(0.05, Math.abs(clearance - v.clearance) + 0.1);
            const radiusPx = Math.max(6, actualRadius * viewState.scale);

            const layerDim = viewState.displayLayers === 'both' && v.layer !== viewState.currentLayer;

            ctx.save();
            ctx.globalAlpha = layerDim ? 0.25 : 0.5;
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, radiusPx, 0, Math.PI * 2);
            ctx.fillStyle = COLORS.drc;
            ctx.fill();

            ctx.globalAlpha = layerDim ? 0.5 : 1;
            ctx.strokeStyle = COLORS.drcBorder;
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }
    }

    function drawRatsnestLines() {
        const connectivity = DRC.getConnectivityReport();
        if (!connectivity || connectivity.length === 0) return;

        ctx.save();
        ctx.strokeStyle = COLORS.ratsnest;
        ctx.lineWidth = Math.max(1, viewState.scale * 0.12);
        ctx.setLineDash([4, 4]);
        ctx.lineCap = 'round';

        for (const netReport of connectivity) {
            for (const missing of netReport.missing) {
                const from = worldToScreen({ x: missing.from.x, y: missing.from.y });
                const to = worldToScreen({ x: missing.to.x, y: missing.to.y });

                ctx.beginPath();
                ctx.moveTo(from.x, from.y);
                ctx.lineTo(to.x, to.y);
                ctx.stroke();
            }
        }

        ctx.setLineDash([]);
        ctx.restore();
    }

    function drawNetHighlight(net) {
        const state = PCBState.getState();
        const netColor = COLORS.netColors[net] || COLORS.netHighlight;

        ctx.save();

        for (const pad of state.pads) {
            if (pad.net !== net) continue;
            const center = worldToScreen(pad);
            const radius = Math.max(1, (pad.diameter / 2 + 0.25) * viewState.scale);
            ctx.strokeStyle = netColor;
            ctx.lineWidth = Math.max(2, viewState.scale * 0.2);
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
            ctx.stroke();
        }

        for (const via of state.vias) {
            if (via.net !== net) continue;
            const center = worldToScreen(via);
            const radius = Math.max(1, (via.diameter / 2 + 0.25) * viewState.scale);
            ctx.strokeStyle = netColor;
            ctx.lineWidth = Math.max(2, viewState.scale * 0.2);
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
            ctx.stroke();
        }

        for (const track of state.tracks) {
            if (track.net !== net) continue;
            if (track.points.length < 2) continue;
            const pixelWidth = Math.max(3, (track.width + 0.5) * viewState.scale);
            ctx.strokeStyle = netColor;
            ctx.lineWidth = pixelWidth;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalAlpha = 0.35;
            ctx.beginPath();
            const start = worldToScreen(track.points[0]);
            ctx.moveTo(start.x, start.y);
            for (let i = 1; i < track.points.length; i++) {
                const p = worldToScreen(track.points[i]);
                ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
        }

        ctx.restore();
    }

    function drawPulseAnimation() {
        if (!reportState.pulseTarget) return;

        const elapsed = performance.now() - reportState.pulseStartTime;
        const cycleDuration = 600;
        const t = (elapsed % cycleDuration) / cycleDuration;

        const pos = worldToScreen(reportState.pulseTarget);
        const baseRadius = Math.max(8, viewState.scale * 1.0);
        const maxRadius = baseRadius * 2.5;
        const radius = baseRadius + (maxRadius - baseRadius) * t;
        const alpha = 1 - t;

        ctx.save();
        ctx.globalAlpha = alpha * 0.8;
        ctx.strokeStyle = COLORS.pulse;
        ctx.lineWidth = Math.max(2, viewState.scale * 0.25);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.globalAlpha = alpha * 0.3;
        ctx.fillStyle = COLORS.pulse;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius * 0.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    function drawGhostElements() {
        if (interactionState.ghostPad && interactionState.currentTool === 'pad') {
            const pad = interactionState.ghostPad;
            const center = worldToScreen(pad);
            const radius = Math.max(1, pad.diameter / 2 * viewState.scale);
            const holeRadius = Math.max(0.5, pad.hole / 2 * viewState.scale);
            const layerColor = viewState.currentLayer === 'front' ? COLORS.front : COLORS.back;

            ctx.save();
            ctx.globalAlpha = 0.5;

            ctx.beginPath();
            ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = layerColor;
            ctx.fill();

            ctx.beginPath();
            ctx.arc(center.x, center.y, holeRadius, 0, Math.PI * 2);
            ctx.fillStyle = COLORS.padHole;
            ctx.fill();

            ctx.strokeStyle = COLORS.ghost;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.restore();
        }

        if (interactionState.ghostVia && interactionState.currentTool === 'via') {
            drawVia(interactionState.ghostVia);
        }
    }

    function drawDrawingTrack() {
        if (!interactionState.drawingTrack) return;

        const track = interactionState.drawingTrack;
        if (track.points.length < 1) return;

        const layerColor = track.layer === 'front' ? COLORS.front : COLORS.back;
        const pixelWidth = Math.max(1, track.width * viewState.scale);

        ctx.save();

        if (track.points.length >= 2) {
            ctx.strokeStyle = layerColor;
            ctx.lineWidth = pixelWidth;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalAlpha = 0.8;

            ctx.beginPath();
            const start = worldToScreen(track.points[0]);
            ctx.moveTo(start.x, start.y);
            for (let i = 1; i < track.points.length; i++) {
                const p = worldToScreen(track.points[i]);
                ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
        }

        if (track.previewPoints && track.previewPoints.length >= 1) {
            const lastFixed = track.points[track.points.length - 1];
            ctx.strokeStyle = layerColor;
            ctx.lineWidth = pixelWidth;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalAlpha = 0.5;
            ctx.setLineDash([6, 4]);

            ctx.beginPath();
            const s = worldToScreen(lastFixed);
            ctx.moveTo(s.x, s.y);
            for (const p of track.previewPoints) {
                const sp = worldToScreen(p);
                ctx.lineTo(sp.x, sp.y);
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }

        const lastPoint = track.points[track.points.length - 1];
        const lpScreen = worldToScreen(lastPoint);
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(lpScreen.x, lpScreen.y, Math.max(3, pixelWidth * 0.7), 0, Math.PI * 2);
        ctx.fillStyle = COLORS.selection;
        ctx.fill();

        ctx.restore();
    }

    function drawSelection() {
        if (!interactionState.selectedElement) return;

        const sel = interactionState.selectedElement;

        ctx.save();

        if (sel.type === 'pad' || sel.type === 'via') {
            const el = sel.element;
            const center = worldToScreen(el);
            const radius = Math.max(3, (el.diameter / 2 + 0.3) * viewState.scale);

            ctx.strokeStyle = COLORS.selection;
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        } else if (sel.type === 'track') {
            const track = sel.element;
            if (track.points.length < 2) {
                ctx.restore();
                return;
            }

            const pixelWidth = Math.max(3, (track.width + 0.6) * viewState.scale);
            ctx.strokeStyle = COLORS.selection;
            ctx.lineWidth = pixelWidth;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalAlpha = 0.3;

            ctx.beginPath();
            const start = worldToScreen(track.points[0]);
            ctx.moveTo(start.x, start.y);
            for (let i = 1; i < track.points.length; i++) {
                const p = worldToScreen(track.points[i]);
                ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();

            ctx.globalAlpha = 1;
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.stroke();
            ctx.setLineDash([]);

            for (const p of track.points) {
                const sp = worldToScreen(p);
                ctx.beginPath();
                ctx.arc(sp.x, sp.y, 4, 0, Math.PI * 2);
                ctx.fillStyle = COLORS.selection;
                ctx.fill();
            }
        } else if (sel.type === 'copperPour') {
            const pour = sel.element;
            ctx.strokeStyle = COLORS.selection;
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            const pts = pour.points;
            if (pts && pts.length > 0) {
                const first = worldToScreen(pts[0]);
                ctx.moveTo(first.x, first.y);
                for (let i = 1; i < pts.length; i++) {
                    const sp = worldToScreen(pts[i]);
                    ctx.lineTo(sp.x, sp.y);
                }
                ctx.closePath();
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;

            for (const p of pts) {
                const sp = worldToScreen(p);
                const handleSize = Math.max(4, viewState.scale * 0.4);
                ctx.fillStyle = COLORS.selection;
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1;
                ctx.fillRect(sp.x - handleSize, sp.y - handleSize, handleSize * 2, handleSize * 2);
                ctx.strokeRect(sp.x - handleSize, sp.y - handleSize, handleSize * 2, handleSize * 2);
            }
        }

        ctx.restore();
    }

    function buildPolygonPath(points) {
        if (!points || points.length < 3) return;
        const first = worldToScreen(points[0]);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < points.length; i++) {
            const p = worldToScreen(points[i]);
            ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
    }

    function drawCopperPour(pour, opacity = 1.0) {
        if (pour.points.length < 3) return;
        const state = PCBState.getState();

        ctx.save();
        ctx.globalAlpha = opacity;

        const pourColor = pour.layer === 'front' ? COLORS.frontPour : COLORS.backPour;
        ctx.fillStyle = pourColor;
        ctx.beginPath();
        buildPolygonPath(pour.points);
        ctx.fill();

        ctx.globalCompositeOperation = 'destination-out';
        const clearance = pour.clearance;

        for (const track of state.tracks) {
            if (track.layer !== pour.layer) continue;
            if (track.net === pour.net) continue;
            if (track.points.length < 2) continue;
            for (let i = 0; i < track.points.length - 1; i++) {
                const start = track.points[i];
                const end = track.points[i + 1];
                drawTrackClearance(start, end, track.width, clearance);
            }
        }

        for (const pad of state.pads) {
            if (pad.net === pour.net) {
                if (Geometry.isPointInPolygon(pad, pour.points)) {
                    drawThermalClearance(pad, pad.diameter / 2, clearance);
                }
                continue;
            }
            drawCircleClearance(pad, pad.diameter / 2, clearance);
        }

        for (const via of state.vias) {
            if (via.net === pour.net) {
                if (Geometry.isPointInPolygon(via, pour.points)) {
                    drawThermalClearance(via, via.diameter / 2, clearance);
                }
                continue;
            }
            drawCircleClearance(via, via.diameter / 2, clearance);
        }

        ctx.globalCompositeOperation = 'source-over';

        for (const pad of state.pads) {
            if (pad.net === pour.net && Geometry.isPointInPolygon(pad, pour.points)) {
                drawThermalSpokes(pad, pour);
            }
        }

        for (const via of state.vias) {
            if (via.net === pour.net && Geometry.isPointInPolygon(via, pour.points)) {
                drawThermalSpokes(via, pour);
            }
        }

        ctx.restore();

        ctx.save();
        ctx.globalAlpha = opacity;
        const borderColor = pour.layer === 'front' ? COLORS.front : COLORS.back;
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = Math.max(1, viewState.scale * 0.08);
        ctx.globalAlpha = opacity * 0.6;
        ctx.beginPath();
        buildPolygonPath(pour.points);
        ctx.stroke();
        ctx.restore();
    }

    function drawTrackClearance(start, end, width, clearance) {
        const totalWidth = width + clearance * 2;
        const pixelWidth = Math.max(1, totalWidth * viewState.scale);
        ctx.lineWidth = pixelWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const s = worldToScreen(start);
        const e = worldToScreen(end);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
    }

    function drawCircleClearance(circle, radius, clearance) {
        const totalRadius = radius + clearance;
        const center = worldToScreen(circle);
        const pixelRadius = Math.max(0.5, totalRadius * viewState.scale);
        ctx.beginPath();
        ctx.arc(center.x, center.y, pixelRadius, 0, Math.PI * 2);
        ctx.fill();
    }

    function drawThermalClearance(circle, radius, clearance) {
        const innerR = radius * viewState.scale;
        const outerR = (radius + clearance) * viewState.scale;
        const center = worldToScreen(circle);
        if (outerR <= innerR + 1) return;

        ctx.beginPath();
        ctx.arc(center.x, center.y, Math.max(0.5, outerR), 0, Math.PI * 2);
        ctx.arc(center.x, center.y, Math.max(0.5, innerR), 0, Math.PI * 2, true);
        ctx.fill('evenodd');
    }

    function drawThermalSpokes(padOrVia, pour) {
        const center = worldToScreen(padOrVia);
        const padRadius = padOrVia.diameter / 2;
        const thermalWidth = 0.25;
        const spokeAngleStep = Math.PI / 2;

        ctx.save();
        const pourColor = pour.layer === 'front' ? COLORS.frontPour : COLORS.backPour;
        ctx.strokeStyle = pourColor;
        ctx.lineWidth = Math.max(1, thermalWidth * viewState.scale);
        ctx.lineCap = 'butt';

        const innerR = padRadius * viewState.scale;
        const outerR = (padRadius + pour.clearance) * viewState.scale;

        for (let i = 0; i < 4; i++) {
            const angle = i * spokeAngleStep;
            const ix = center.x + Math.cos(angle) * innerR;
            const iy = center.y + Math.sin(angle) * innerR;
            const ox = center.x + Math.cos(angle) * outerR;
            const oy = center.y + Math.sin(angle) * outerR;

            ctx.beginPath();
            ctx.moveTo(ix, iy);
            ctx.lineTo(ox, oy);
            ctx.stroke();
        }

        ctx.restore();
    }

    function drawDrawingCopperPour() {
        if (!interactionState.drawingCopperPour) return;
        const pour = interactionState.drawingCopperPour;
        if (pour.points.length < 1) return;

        ctx.save();

        const layerColor = pour.layer === 'front' ? COLORS.front : COLORS.back;

        if (pour.points.length >= 2) {
            ctx.strokeStyle = layerColor;
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalAlpha = 0.8;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            const first = worldToScreen(pour.points[0]);
            ctx.moveTo(first.x, first.y);
            for (let i = 1; i < pour.points.length; i++) {
                const p = worldToScreen(pour.points[i]);
                ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }

        if (pour.points.length >= 2 && interactionState.hoverPoint) {
            ctx.strokeStyle = layerColor;
            ctx.lineWidth = 2;
            ctx.globalAlpha = 0.4;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            const last = worldToScreen(pour.points[pour.points.length - 1]);
            const first = worldToScreen(pour.points[0]);
            const hover = worldToScreen(interactionState.hoverPoint);
            ctx.moveTo(last.x, last.y);
            ctx.lineTo(hover.x, hover.y);
            ctx.lineTo(first.x, first.y);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        for (let i = 0; i < pour.points.length; i++) {
            const sp = worldToScreen(pour.points[i]);
            const size = Math.max(3, viewState.scale * 0.4);
            ctx.fillStyle = COLORS.selection;
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            ctx.fillRect(sp.x - size, sp.y - size, size * 2, size * 2);
            ctx.strokeRect(sp.x - size, sp.y - size, size * 2, size * 2);
        }

        ctx.restore();
    }

    function drawCursor() {
        if (!interactionState.hoverPoint) return;

        const p = worldToScreen(interactionState.hoverPoint);
        const size = 8;

        ctx.save();
        ctx.strokeStyle = COLORS.ghost;
        ctx.lineWidth = 1;

        ctx.beginPath();
        ctx.moveTo(p.x - size, p.y);
        ctx.lineTo(p.x + size, p.y);
        ctx.moveTo(p.x, p.y - size);
        ctx.lineTo(p.x, p.y + size);
        ctx.stroke();

        if (viewState.gridEnabled) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
            ctx.fillStyle = COLORS.selection;
            ctx.fill();
        }

        ctx.restore();
    }

    return {
        init,
        render,
        worldToScreen,
        screenToWorld,
        zoom,
        pan,
        getViewState,
        getInteractionState,
        setDisplayLayers,
        setCurrentLayer,
        setGridEnabled,
        setGridSize,
        setCurrentTool,
        setHoverPoint,
        setSelectedElement,
        setDrawingTrack,
        setDrawingCopperPour,
        setGhostPad,
        setGhostVia,
        setDragState,
        getBoardBounds,
        centerBoard,
        setPanelOpen,
        setHighlightedNet,
        getHighlightedNet,
        setShowRatsnest,
        startPulseAnimation,
        centerOnPosition,
        COLORS
    };
})();
