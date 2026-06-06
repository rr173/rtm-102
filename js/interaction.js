const Interaction = (function() {
    let canvas;
    let isMouseDown = false;
    let isPanning = false;
    let panStart = { x: 0, y: 0 };
    let spacePressed = false;
    let lastClickTime = 0;
    let lastClickPos = null;
    let contextMenuTarget = null;
    let selectedViolationId = null;
    let selectedConnectivityNet = null;
    let isResizingPanel = false;
    let resizeStartX = 0;
    let resizeStartWidth = 0;

    const DOUBLE_CLICK_TIME = 300;
    const DOUBLE_CLICK_DIST = 5;

    function init(canvasElement) {
        canvas = canvasElement;
        bindEvents();
    }

    function bindEvents() {
        canvas.addEventListener('mousedown', onMouseDown);
        canvas.addEventListener('mousemove', onMouseMove);
        canvas.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('contextmenu', onContextMenu);
        canvas.addEventListener('dblclick', onDoubleClick);
        canvas.addEventListener('mouseleave', onMouseLeave);

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);

        document.addEventListener('click', onDocumentClick);
    }

    function getMousePos(e) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    }

    function getWorldMousePos(e) {
        const screen = getMousePos(e);
        return Render.screenToWorld(screen);
    }

    function isInsideBoard(point) {
        const bounds = Render.getBoardBounds();
        return point.x >= 0 && point.x <= bounds.width &&
               point.y >= 0 && point.y <= bounds.height;
    }

    function snapIfNeeded(point) {
        const view = Render.getViewState();
        if (view.gridEnabled) {
            return Geometry.snapToGrid(point, view.gridSize);
        }
        return point;
    }

    function onMouseDown(e) {
        if (e.button === 1 || (e.button === 0 && spacePressed)) {
            isPanning = true;
            panStart = getMousePos(e);
            canvas.style.cursor = 'grabbing';
            e.preventDefault();
            return;
        }

        if (e.button !== 0) return;

        const worldPos = getWorldMousePos(e);
        const snapped = snapIfNeeded(worldPos);
        const view = Render.getViewState();
        const tool = Render.getInteractionState().currentTool;

        isMouseDown = true;

        if (tool === 'select') {
            handleSelectMouseDown(snapped, e);
        } else if (tool === 'pad') {
            handlePadMouseDown(snapped);
        } else if (tool === 'track') {
            handleTrackMouseDown(snapped);
        } else if (tool === 'via') {
            handleViaMouseDown(snapped);
        } else if (tool === 'copper') {
            handleCopperPourMouseDown(snapped);
        }

        refreshUI();
    }

    function onMouseMove(e) {
        const screenPos = getMousePos(e);
        const worldPos = getWorldMousePos(e);
        const snapped = snapIfNeeded(worldPos);
        const view = Render.getViewState();
        const tool = Render.getInteractionState().currentTool;
        const drawingTrack = Render.getInteractionState().drawingTrack;

        if (isPanning) {
            const dx = screenPos.x - panStart.x;
            const dy = screenPos.y - panStart.y;
            Render.pan(dx, dy);
            panStart = screenPos;
            Render.render();
            return;
        }

        Render.setHoverPoint(isInsideBoard(snapped) ? snapped : (isInsideBoard(worldPos) ? worldPos : null));

        const dragState = Render.getInteractionState().dragState;
        if (isMouseDown && dragState) {
            handleDrag(snapped);
        }

        if (tool === 'pad') {
            Render.setGhostPad({
                x: snapped.x,
                y: snapped.y,
                diameter: parseFloat(document.getElementById('pad-diameter').value),
                hole: parseFloat(document.getElementById('pad-hole').value)
            });
        } else {
            Render.setGhostPad(null);
        }

        if (tool === 'via') {
            Render.setGhostVia({
                x: snapped.x,
                y: snapped.y,
                diameter: 0.6,
                hole: 0.3,
                net: document.getElementById('net-select').value
            });
        } else {
            Render.setGhostVia(null);
        }

        if (tool === 'track' && drawingTrack && drawingTrack.points.length > 0) {
            const lastPoint = drawingTrack.points[drawingTrack.points.length - 1];
            const previewPoints = Geometry.computeOctilinearPathSimple(lastPoint, snapped);
            drawingTrack.previewPoints = previewPoints;

            let totalLen = 0;
            let cur = lastPoint;
            for (const p of previewPoints) {
                totalLen += Geometry.dist(cur, p);
                cur = p;
            }
            document.getElementById('track-length').textContent = totalLen.toFixed(2) + ' mm';
        }

        const drawingCopper = Render.getInteractionState().drawingCopperPour;
        if (tool === 'copper' && drawingCopper) {
        }

        updateCoordDisplay(worldPos);

        Render.render();
    }

    function onMouseUp(e) {
        if (isPanning) {
            isPanning = false;
            canvas.style.cursor = 'crosshair';
            return;
        }

        if (e.button !== 0) return;

        const dragState = Render.getInteractionState().dragState;
        if (dragState) {
            Render.setDragState(null);
            DRC.runCheck();
            updateDRCDisplay();
        }

        isMouseDown = false;

        const now = Date.now();
        const pos = getMousePos(e);
        if (lastClickPos && now - lastClickTime < DOUBLE_CLICK_TIME &&
            Geometry.dist(pos, lastClickPos) < DOUBLE_CLICK_DIST) {
            lastClickTime = 0;
            lastClickPos = null;
            return;
        }
        lastClickTime = now;
        lastClickPos = pos;

        refreshUI();
    }

    function onWheel(e) {
        e.preventDefault();
        if (e.ctrlKey) {
            const screenPos = getMousePos(e);
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            Render.zoom(factor, screenPos);
            Render.render();
            updateZoomDisplay();
        } else {
            const panSpeed = 0.8;
            let dx = 0;
            let dy = 0;
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                dx = -e.deltaX * panSpeed;
            } else {
                dy = -e.deltaY * panSpeed;
            }
            Render.pan(dx, dy);
            Render.render();
        }
    }

    function onContextMenu(e) {
        e.preventDefault();
        const worldPos = getWorldMousePos(e);
        const view = Render.getViewState();

        const pad = PCBState.findPadAt(worldPos);
        const via = PCBState.findViaAt(worldPos);
        const track = PCBState.findTrackAt(worldPos, view.displayLayers === 'both' ? null : view.currentLayer);
        const pour = PCBState.findCopperPourAt(worldPos, view.displayLayers === 'both' ? null : view.currentLayer);

        let target = null;
        if (pad) target = { type: 'pad', element: pad };
        else if (via) target = { type: 'via', element: via };
        else if (track) target = { type: 'track', element: track };
        else if (pour) target = { type: 'copperPour', element: pour };

        if (!target) {
            hideContextMenu();
            return;
        }

        contextMenuTarget = target;
        Render.setSelectedElement(target);

        const menu = document.getElementById('context-menu');
        document.getElementById('context-menu-title').textContent =
            target.type === 'pad' ? '焊盘属性' :
            target.type === 'via' ? '过孔属性' :
            target.type === 'copperPour' ? '铜区属性' : '走线属性';

        document.getElementById('context-net').value = target.element.net;

        const padGroup = document.getElementById('context-pad-group');
        const holeGroup = document.getElementById('context-hole-group');
        const clearanceGroup = document.getElementById('context-clearance-group');

        if (target.type === 'track') {
            padGroup.style.display = 'none';
            holeGroup.style.display = 'none';
            clearanceGroup.style.display = 'none';
        } else if (target.type === 'copperPour') {
            padGroup.style.display = 'none';
            holeGroup.style.display = 'none';
            clearanceGroup.style.display = 'flex';
            document.getElementById('context-clearance').value = target.element.clearance;
        } else {
            padGroup.style.display = 'flex';
            holeGroup.style.display = 'flex';
            clearanceGroup.style.display = 'none';
            document.getElementById('context-diameter').value = target.element.diameter;
            document.getElementById('context-hole').value = target.element.hole;
        }

        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
        menu.classList.add('show');

        Render.render();
    }

    function onDoubleClick(e) {
        const drawingTrack = Render.getInteractionState().drawingTrack;
        if (drawingTrack) {
            finishTrack();
        }
        const drawingCopper = Render.getInteractionState().drawingCopperPour;
        if (drawingCopper) {
            finishCopperPour();
        }
    }

    function onMouseLeave(e) {
        Render.setHoverPoint(null);
        Render.setGhostPad(null);
        Render.setGhostVia(null);
        Render.render();
    }

    function onKeyDown(e) {
        if (e.code === 'Space') {
            spacePressed = true;
            canvas.style.cursor = 'grab';
        }

        if (e.ctrlKey && e.code === 'KeyZ') {
            e.preventDefault();
            if (PCBState.undo()) {
                postChangeRefresh();
            }
            return;
        }

        if (e.ctrlKey && e.code === 'KeyY') {
            e.preventDefault();
            if (PCBState.redo()) {
                postChangeRefresh();
            }
            return;
        }

        if (e.code === 'Escape') {
            const drawingTrack = Render.getInteractionState().drawingTrack;
            if (drawingTrack) {
                cancelTrack();
            }
            const drawingCopper = Render.getInteractionState().drawingCopperPour;
            if (drawingCopper) {
                cancelCopperPour();
            }
            Render.setSelectedElement(null);
            hideContextMenu();
            Render.render();
            refreshUI();
            return;
        }

        if (e.code === 'Delete' || e.code === 'Backspace') {
            if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT')) {
                return;
            }
            deleteSelected();
            return;
        }

        const drawingTrack = Render.getInteractionState().drawingTrack;
        if (e.code === 'KeyV' && drawingTrack && drawingTrack.points.length > 0) {
            insertViaAndSwitchLayer();
            return;
        }

        if (e.code === 'KeyS') selectTool('select');
        else if (e.code === 'KeyP') selectTool('pad');
        else if (e.code === 'KeyT') selectTool('track');
        else if (e.code === 'KeyC') selectTool('copper');
    }

    function onKeyUp(e) {
        if (e.code === 'Space') {
            spacePressed = false;
            canvas.style.cursor = 'crosshair';
        }
    }

    function onDocumentClick(e) {
        const menu = document.getElementById('context-menu');
        if (!menu.contains(e.target)) {
            hideContextMenu();
        }
    }

    function handleSelectMouseDown(pos, e) {
        const view = Render.getViewState();
        const pad = PCBState.findPadAt(pos);
        const via = PCBState.findViaAt(pos);
        const track = PCBState.findTrackAt(pos, view.displayLayers === 'both' ? null : view.currentLayer);
        const pourVertex = PCBState.findCopperPourVertexAt(pos);
        const pour = !pourVertex ? PCBState.findCopperPourAt(pos, view.displayLayers === 'both' ? null : view.currentLayer) : null;

        let target = null;
        if (pad) target = { type: 'pad', element: pad };
        else if (via) target = { type: 'via', element: via };
        else if (track) target = { type: 'track', element: track };
        else if (pourVertex) target = { type: 'copperPour', element: pourVertex.pour };
        else if (pour) target = { type: 'copperPour', element: pour };

        if ((target && target.type === 'pad') || (target && target.type === 'via') || pourVertex) {
            PCBState.saveSnapshot();
        }

        if ((target && target.type === 'pad') || (target && target.type === 'via')) {
            Render.setDragState({
                type: target.type,
                id: target.element.id,
                startPos: { x: target.element.x, y: target.element.y }
            });
        }

        if (pourVertex) {
            Render.setDragState({
                type: 'copperPourVertex',
                id: pourVertex.pour.id,
                vertexIndex: pourVertex.vertexIndex,
                startPos: { x: pourVertex.point.x, y: pourVertex.point.y }
            });
        }

        Render.setSelectedElement(target);
    }

    function handleDrag(pos) {
        const dragState = Render.getInteractionState().dragState;
        if (!dragState) return;

        if (dragState.type === 'pad') {
            PCBState.movePad(dragState.id, pos);
        } else if (dragState.type === 'via') {
            PCBState.moveVia(dragState.id, pos);
        } else if (dragState.type === 'copperPourVertex') {
            PCBState.setCopperPourVertex(dragState.id, dragState.vertexIndex, pos);
        }
    }

    function handlePadMouseDown(pos) {
        if (!isInsideBoard(pos)) return;

        PCBState.addPad({
            x: pos.x,
            y: pos.y,
            net: document.getElementById('net-select').value,
            diameter: parseFloat(document.getElementById('pad-diameter').value),
            hole: parseFloat(document.getElementById('pad-hole').value)
        });

        postChangeRefresh();
    }

    function handleTrackMouseDown(pos) {
        const view = Render.getViewState();
        const drawingTrack = Render.getInteractionState().drawingTrack;

        if (!drawingTrack) {
            const pad = PCBState.findPadAt(pos);
            const via = PCBState.findViaAt(pos);
            const endpoint = PCBState.findTrackEndpointAt(pos);

            let startPoint = pos;
            let net = document.getElementById('net-select').value;

            if (pad) {
                startPoint = { x: pad.x, y: pad.y };
                net = pad.net;
            } else if (via) {
                startPoint = { x: via.x, y: via.y };
                net = via.net;
            } else if (endpoint) {
                startPoint = { x: endpoint.point.x, y: endpoint.point.y };
                net = endpoint.track.net;
            } else if (!isInsideBoard(pos)) {
                return;
            }

            const track = {
                net: net,
                layer: view.currentLayer,
                width: parseFloat(document.getElementById('track-width').value),
                points: [startPoint],
                previewPoints: []
            };
            Render.setDrawingTrack(track);
            document.getElementById('track-length-display').style.display = 'flex';
        } else {
            if (drawingTrack.previewPoints && drawingTrack.previewPoints.length > 0) {
                for (const p of drawingTrack.previewPoints) {
                    drawingTrack.points.push({ x: p.x, y: p.y });
                }
            } else {
                drawingTrack.points.push({ x: pos.x, y: pos.y });
            }
            drawingTrack.previewPoints = [];

            const pad = PCBState.findPadAt(pos);
            const via = PCBState.findViaAt(pos);
            const endpoint = PCBState.findTrackEndpointAt(pos);

            if (pad || via || endpoint) {
                finishTrack();
            }
        }
    }

    function handleViaMouseDown(pos) {
        if (!isInsideBoard(pos)) return;

        PCBState.addVia({
            x: pos.x,
            y: pos.y,
            net: document.getElementById('net-select').value
        });

        postChangeRefresh();
    }

    function handleCopperPourMouseDown(pos) {
        const view = Render.getViewState();
        const drawingCopper = Render.getInteractionState().drawingCopperPour;

        if (!drawingCopper) {
            if (!isInsideBoard(pos)) return;

            const pour = {
                net: document.getElementById('net-select').value,
                layer: view.currentLayer,
                points: [pos],
                clearance: parseFloat(document.getElementById('drc-clearance').value) || 0.3
            };
            Render.setDrawingCopperPour(pour);
        } else {
            const firstPoint = drawingCopper.points[0];
            const distToFirst = Geometry.dist(pos, firstPoint);

            if (drawingCopper.points.length >= 2 && distToFirst < 0.8) {
                finishCopperPour();
                return;
            } else {
                drawingCopper.points.push({ x: pos.x, y: pos.y });
                Render.setDrawingCopperPour(drawingCopper);
            }
        }
    }

    function finishCopperPour() {
        const drawingCopper = Render.getInteractionState().drawingCopperPour;
        if (!drawingCopper) return;

        if (drawingCopper.points.length >= 3) {
            PCBState.addCopperPour({
                net: drawingCopper.net,
                layer: drawingCopper.layer,
                points: drawingCopper.points,
                clearance: drawingCopper.clearance
            });
        }

        cancelCopperPour();
        postChangeRefresh();
    }

    function cancelCopperPour() {
        Render.setDrawingCopperPour(null);
        Render.render();
    }

    function insertViaAndSwitchLayer() {
        const drawingTrack = Render.getInteractionState().drawingTrack;
        if (!drawingTrack || drawingTrack.points.length < 1) return;

        const view = Render.getViewState();
        const lastPoint = drawingTrack.points[drawingTrack.points.length - 1];

        PCBState.addVia({
            x: lastPoint.x,
            y: lastPoint.y,
            net: drawingTrack.net
        });

        const newLayer = view.currentLayer === 'front' ? 'back' : 'front';
        drawingTrack.layer = newLayer;
        Render.setCurrentLayer(newLayer);
        updateLayerButtons();

        postChangeRefresh();
    }

    function finishTrack() {
        const drawingTrack = Render.getInteractionState().drawingTrack;
        if (!drawingTrack) return;

        if (drawingTrack.points.length >= 2) {
            PCBState.addTrack({
                net: drawingTrack.net,
                layer: drawingTrack.layer,
                width: drawingTrack.width,
                points: drawingTrack.points
            });
        }

        cancelTrack();
        postChangeRefresh();
    }

    function cancelTrack() {
        Render.setDrawingTrack(null);
        document.getElementById('track-length-display').style.display = 'none';
        Render.render();
    }

    function deleteSelected() {
        const sel = Render.getInteractionState().selectedElement;
        if (!sel) return;

        if (sel.type === 'pad') {
            PCBState.removePad(sel.element.id);
        } else if (sel.type === 'via') {
            PCBState.removeVia(sel.element.id);
        } else if (sel.type === 'track') {
            PCBState.removeTrack(sel.element.id);
        } else if (sel.type === 'copperPour') {
            PCBState.removeCopperPour(sel.element.id);
        }

        Render.setSelectedElement(null);
        hideContextMenu();
        postChangeRefresh();
    }

    function selectTool(tool) {
        const drawingTrack = Render.getInteractionState().drawingTrack;
        if (drawingTrack && tool !== 'track') {
            if (drawingTrack.points.length >= 2) {
                PCBState.addTrack({
                    net: drawingTrack.net,
                    layer: drawingTrack.layer,
                    width: drawingTrack.width,
                    points: drawingTrack.points
                });
                postChangeRefresh();
            } else {
                cancelTrack();
            }
        }

        const drawingCopper = Render.getInteractionState().drawingCopperPour;
        if (drawingCopper && tool !== 'copper') {
            if (drawingCopper.points.length >= 3) {
                PCBState.addCopperPour({
                    net: drawingCopper.net,
                    layer: drawingCopper.layer,
                    points: drawingCopper.points,
                    clearance: drawingCopper.clearance
                });
                postChangeRefresh();
            } else {
                cancelCopperPour();
            }
        }

        Render.setCurrentTool(tool);
        updateToolButtons();
        Render.render();
        refreshUI();
    }

    function updateToolButtons() {
        const tool = Render.getInteractionState().currentTool;
        document.querySelectorAll('.tool-btn[id^="tool-"]').forEach(btn => {
            btn.classList.remove('active');
        });
        const btn = document.getElementById('tool-' + tool);
        if (btn) btn.classList.add('active');

        const toolNames = { select: '选择', pad: '焊盘', track: '走线', via: '过孔', copper: '铜区' };
        document.getElementById('current-tool').textContent = toolNames[tool] || tool;
    }

    function updateLayerButtons() {
        const view = Render.getViewState();
        document.querySelectorAll('.layer-btn').forEach(btn => btn.classList.remove('active'));
        if (view.displayLayers === 'front') document.getElementById('layer-front').classList.add('active');
        else if (view.displayLayers === 'back') document.getElementById('layer-back').classList.add('active');
        else document.getElementById('layer-both').classList.add('active');

        document.getElementById('current-layer').textContent =
            view.currentLayer === 'front' ? '正面' : '背面';
    }

    function updateCoordDisplay(pos) {
        document.getElementById('mouse-pos').textContent =
            `X: ${pos.x.toFixed(2)}, Y: ${pos.y.toFixed(2)} mm`;
    }

    function updateZoomDisplay() {
        const view = Render.getViewState();
        document.getElementById('zoom-level').textContent =
            Math.round(view.scale * 20) + '%';
    }

    function updateDRCDisplay() {
        const violations = DRC.getViolations();
        const countEl = document.getElementById('drc-count');
        countEl.textContent = violations.length;
        countEl.classList.remove('ok', 'warning');
        countEl.classList.add(violations.length > 0 ? 'warning' : 'ok');

        document.getElementById('drc-min').textContent = DRC.getClearance().toFixed(2) + ' mm';
    }

    function hideContextMenu() {
        document.getElementById('context-menu').classList.remove('show');
        contextMenuTarget = null;
    }

    function postChangeRefresh() {
        DRC.runCheck();
        Render.render();
        updateDRCDisplay();
        updateZoomDisplay();
    }

    function refreshUI() {
        updateZoomDisplay();
        updateDRCDisplay();
    }

    function bindToolbarEvents() {
        document.getElementById('tool-select').addEventListener('click', () => selectTool('select'));
        document.getElementById('tool-pad').addEventListener('click', () => selectTool('pad'));
        document.getElementById('tool-track').addEventListener('click', () => selectTool('track'));
        document.getElementById('tool-via').addEventListener('click', () => selectTool('via'));
        document.getElementById('tool-copper').addEventListener('click', () => selectTool('copper'));

        document.getElementById('layer-front').addEventListener('click', () => {
            Render.setDisplayLayers('front');
            Render.setCurrentLayer('front');
            updateLayerButtons();
            Render.render();
        });
        document.getElementById('layer-back').addEventListener('click', () => {
            Render.setDisplayLayers('back');
            Render.setCurrentLayer('back');
            updateLayerButtons();
            Render.render();
        });
        document.getElementById('layer-both').addEventListener('click', () => {
            Render.setDisplayLayers('both');
            updateLayerButtons();
            Render.render();
        });

        document.getElementById('grid-toggle').addEventListener('click', (e) => {
            const view = Render.getViewState();
            Render.setGridEnabled(!view.gridEnabled);
            e.currentTarget.classList.toggle('active', view.gridEnabled);
            e.currentTarget.querySelector('.label').textContent = view.gridEnabled ? '显示' : '隐藏';
            Render.render();
        });

        document.getElementById('grid-size').addEventListener('change', (e) => {
            Render.setGridSize(parseFloat(e.target.value));
            Render.render();
        });

        document.getElementById('drc-toggle').addEventListener('click', (e) => {
            DRC.setEnabled(!DRC.isEnabled());
            e.currentTarget.classList.toggle('active', DRC.isEnabled());
            if (DRC.isEnabled()) {
                DRC.runCheck();
            }
            updateDRCDisplay();
            Render.render();
        });

        document.getElementById('drc-clearance').addEventListener('change', (e) => {
            DRC.setClearance(parseFloat(e.target.value));
            DRC.runCheck();
            updateDRCDisplay();
            Render.render();
        });

        document.getElementById('btn-undo').addEventListener('click', () => {
            if (PCBState.undo()) postChangeRefresh();
        });
        document.getElementById('btn-redo').addEventListener('click', () => {
            if (PCBState.redo()) postChangeRefresh();
        });
        document.getElementById('btn-clear').addEventListener('click', () => {
            if (confirm('确定要清空所有元素吗？')) {
                PCBState.clearAll();
                Render.setSelectedElement(null);
                postChangeRefresh();
            }
        });

        document.getElementById('btn-report').addEventListener('click', () => {
            toggleReportPanel();
            const btn = document.getElementById('btn-report');
            const panel = document.getElementById('report-panel');
            btn.classList.toggle('active', panel.classList.contains('open'));
        });

        document.getElementById('report-close').addEventListener('click', () => {
            closeReportPanel();
            document.getElementById('btn-report').classList.remove('active');
        });

        document.getElementById('btn-clear-highlight').addEventListener('click', () => {
            clearAllHighlights();
        });

        document.getElementById('btn-recheck').addEventListener('click', () => {
            recheckReport();
        });

        document.getElementById('context-apply').addEventListener('click', () => {
            if (!contextMenuTarget) return;
            const net = document.getElementById('context-net').value;
            if (contextMenuTarget.type === 'pad') {
                PCBState.updatePad(contextMenuTarget.element.id, {
                    net: net,
                    diameter: parseFloat(document.getElementById('context-diameter').value),
                    hole: parseFloat(document.getElementById('context-hole').value)
                });
            } else if (contextMenuTarget.type === 'via') {
                PCBState.updateVia(contextMenuTarget.element.id, {
                    net: net,
                    diameter: parseFloat(document.getElementById('context-diameter').value),
                    hole: parseFloat(document.getElementById('context-hole').value)
                });
            } else if (contextMenuTarget.type === 'track') {
                PCBState.updateTrack(contextMenuTarget.element.id, { net: net });
            } else if (contextMenuTarget.type === 'copperPour') {
                PCBState.updateCopperPour(contextMenuTarget.element.id, {
                    net: net,
                    clearance: parseFloat(document.getElementById('context-clearance').value)
                });
            }
            hideContextMenu();
            postChangeRefresh();
        });

        document.getElementById('context-cancel').addEventListener('click', () => {
            hideContextMenu();
        });

        document.getElementById('context-delete').addEventListener('click', () => {
            deleteSelected();
        });
    }

    function generateReport() {
        DRC.runCheck();
        renderReportPanel();
        openReportPanel();
        Render.render();
        updateDRCDisplay();
    }

    function openReportPanel() {
        const panel = document.getElementById('report-panel');
        panel.classList.add('open');
        Render.setPanelOpen(true);
        const connectivity = DRC.getConnectivityReport();
        if (connectivity && connectivity.length > 0) {
            Render.setShowRatsnest(true);
        }
        Render.render();
    }

    function closeReportPanel() {
        const panel = document.getElementById('report-panel');
        panel.classList.remove('open');
        Render.setPanelOpen(false);
        Render.setShowRatsnest(false);
        Render.setHighlightedNet(null);
        selectedViolationId = null;
        selectedConnectivityNet = null;
        Render.render();
    }

    function toggleReportPanel() {
        const panel = document.getElementById('report-panel');
        if (panel.classList.contains('open')) {
            closeReportPanel();
        } else {
            generateReport();
        }
    }

    function renderReportPanel() {
        const violations = DRC.getViolations();
        const connectivity = DRC.getConnectivityReport();

        const errors = violations.filter(v => v.severity === 'error');
        const warnings = violations.filter(v => v.severity === 'warning');

        document.getElementById('summary-total').textContent = violations.length;
        document.getElementById('summary-errors').textContent = errors.length;
        document.getElementById('summary-warnings').textContent = warnings.length;

        renderViolationList(violations);
        renderConnectivityList(connectivity);
    }

    function renderViolationList(violations) {
        const listEl = document.getElementById('violation-list');

        if (violations.length === 0) {
            listEl.innerHTML = '<div class="empty-message">暂无违规</div>';
            return;
        }

        const sorted = [...violations].sort((a, b) => {
            if (a.severity !== b.severity) {
                return a.severity === 'error' ? -1 : 1;
            }
            return a.clearance - b.clearance;
        });

        let html = '';
        for (const v of sorted) {
            const layerName = v.layer === 'front' ? '正面' : '背面';
            const selectedClass = v.id === selectedViolationId ? ' selected' : '';
            html += `
                <div class="violation-item ${v.severity}${selectedClass}" data-violation-id="${v.id}">
                    <div class="violation-header">
                        <span class="violation-severity ${v.severity}">${v.severity === 'error' ? '错误' : '警告'}</span>
                        <span class="violation-layer">${layerName}</span>
                    </div>
                    <div class="violation-detail">
                        <span class="violation-nets">${v.element1.net} ↔ ${v.element2.net}</span><br>
                        实际间距: <span class="violation-clearance">${v.clearance.toFixed(3)}mm</span>
                    </div>
                </div>
            `;
        }
        listEl.innerHTML = html;

        listEl.querySelectorAll('.violation-item').forEach(item => {
            item.addEventListener('click', () => {
                const id = parseInt(item.dataset.violationId);
                focusViolation(id);
            });
        });
    }

    function focusViolation(id) {
        const violations = DRC.getViolations();
        const violation = violations.find(v => v.id === id);
        if (!violation) return;

        selectedViolationId = id;
        selectedConnectivityNet = null;
        Render.setHighlightedNet(null);

        const view = Render.getViewState();
        const targetScale = Math.max(view.scale, 15);
        Render.centerOnPosition(violation.position, targetScale);
        Render.startPulseAnimation(violation.position);

        renderReportPanel();
        updateZoomDisplay();
        Render.render();
    }

    function renderConnectivityList(connectivity) {
        const listEl = document.getElementById('connectivity-list');

        if (!connectivity || connectivity.length === 0) {
            listEl.innerHTML = '<div class="empty-message">所有网络均已连通</div>';
            return;
        }

        let html = '';
        for (const netReport of connectivity) {
            const selectedClass = netReport.net === selectedConnectivityNet ? ' selected' : '';
            html += `
                <div class="connectivity-item${selectedClass}" data-net="${netReport.net}">
                    <div class="connectivity-header">
                        <span class="connectivity-net">${netReport.net}</span>
                        <span class="connectivity-counts">${netReport.nodes}节点 / ${netReport.components}组</span>
                    </div>
                    <div class="connectivity-missing">
            `;
            for (let i = 0; i < netReport.missing.length; i++) {
                const m = netReport.missing[i];
                html += `
                    <div class="ratsnest-item" data-net="${netReport.net}" data-missing-index="${i}">
                        ${m.from.type} → ${m.to.type}
                        <span class="ratsnest-distance">${m.distance.toFixed(2)}mm</span>
                    </div>
                `;
            }
            html += `
                    </div>
                </div>
            `;
        }
        listEl.innerHTML = html;

        listEl.querySelectorAll('.connectivity-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('ratsnest-item')) return;
                const net = item.dataset.net;
                highlightDisconnectedNet(net);
            });
        });

        listEl.querySelectorAll('.ratsnest-item').forEach(item => {
            let clickTimer = null;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const net = item.dataset.net;
                const idx = parseInt(item.dataset.missingIndex);
                if (clickTimer) {
                    clearTimeout(clickTimer);
                    clickTimer = null;
                    focusRatsnestConnection(net, idx);
                } else {
                    clickTimer = setTimeout(() => {
                        highlightDisconnectedNet(net);
                        clickTimer = null;
                    }, DOUBLE_CLICK_TIME);
                }
            });
        });
    }

    function highlightDisconnectedNet(net) {
        selectedConnectivityNet = net;
        selectedViolationId = null;
        Render.setHighlightedNet(net);
        Render.setShowRatsnest(true);
        renderReportPanel();
        Render.render();
    }

    function focusRatsnestConnection(net, missingIndex) {
        const connectivity = DRC.getConnectivityReport();
        const netReport = connectivity.find(r => r.net === net);
        if (!netReport || !netReport.missing[missingIndex]) return;

        const missing = netReport.missing[missingIndex];
        const midPoint = {
            x: (missing.from.x + missing.to.x) / 2,
            y: (missing.from.y + missing.to.y) / 2
        };

        selectedConnectivityNet = net;
        Render.setHighlightedNet(net);
        Render.setShowRatsnest(true);

        const view = Render.getViewState();
        const targetScale = Math.max(view.scale, 15);
        Render.centerOnPosition(midPoint, targetScale);
        Render.startPulseAnimation(midPoint);

        renderReportPanel();
        updateZoomDisplay();
        Render.render();
    }

    function clearAllHighlights() {
        selectedViolationId = null;
        selectedConnectivityNet = null;
        Render.setHighlightedNet(null);
        renderReportPanel();
        Render.render();
    }

    function recheckReport() {
        DRC.runCheck();
        renderReportPanel();
        const connectivity = DRC.getConnectivityReport();
        if (connectivity && connectivity.length > 0) {
            Render.setShowRatsnest(true);
        } else {
            Render.setShowRatsnest(false);
        }
        Render.render();
        updateDRCDisplay();
    }

    function initPanelResizer() {
        const resizer = document.getElementById('report-resizer');
        const panel = document.getElementById('report-panel');

        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isResizingPanel = true;
            resizeStartX = e.clientX;
            resizeStartWidth = panel.offsetWidth;
            resizer.classList.add('active');
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizingPanel) return;
            const delta = resizeStartX - e.clientX;
            let newWidth = resizeStartWidth + delta;
            newWidth = Math.max(200, Math.min(400, newWidth));
            panel.style.width = newWidth + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isResizingPanel) {
                isResizingPanel = false;
                resizer.classList.remove('active');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                setTimeout(() => Render.render(), 50);
            }
        });
    }

    return {
        init,
        bindToolbarEvents,
        selectTool,
        postChangeRefresh,
        updateZoomDisplay,
        updateDRCDisplay,
        updateLayerButtons,
        updateToolButtons,
        generateReport,
        openReportPanel,
        closeReportPanel,
        toggleReportPanel,
        renderReportPanel,
        clearAllHighlights,
        recheckReport,
        initPanelResizer
    };
})();
