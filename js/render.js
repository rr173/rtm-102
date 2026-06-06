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
        back: '#3498db',
        backDim: 'rgba(52, 152, 199, 0.3)',
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
        ghostPad: null,
        ghostVia: null,
        dragState: null
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

        const newScale = Geometry.clamp(viewState.scale * factor, 0.5, 20);
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

        drawGhostElements();

        drawDrawingTrack();

        drawSelection();

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
        setGhostPad,
        setGhostVia,
        setDragState,
        getBoardBounds,
        centerBoard,
        COLORS
    };
})();
