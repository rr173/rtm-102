const PCBState = (function() {
    let state = {
        pads: [],
        tracks: [],
        vias: [],
        copperPours: [],
        nextId: 1
    };

    const MAX_HISTORY = 30;
    let undoStack = [];
    let redoStack = [];

    function saveSnapshot() {
        const snapshot = JSON.parse(JSON.stringify(state));
        undoStack.push(snapshot);
        if (undoStack.length > MAX_HISTORY) {
            undoStack.shift();
        }
        redoStack = [];
    }

    function undo() {
        if (undoStack.length === 0) return false;
        redoStack.push(JSON.parse(JSON.stringify(state)));
        state = undoStack.pop();
        return true;
    }

    function redo() {
        if (redoStack.length === 0) return false;
        undoStack.push(JSON.parse(JSON.stringify(state)));
        state = redoStack.pop();
        return true;
    }

    function canUndo() {
        return undoStack.length > 0;
    }

    function canRedo() {
        return redoStack.length > 0;
    }

    function getState() {
        return state;
    }

    function setState(newState) {
        saveSnapshot();
        state = JSON.parse(JSON.stringify(newState));
    }

    function clearAll() {
        saveSnapshot();
        state.pads = [];
        state.tracks = [];
        state.vias = [];
        state.copperPours = [];
    }

    function addCopperPour(pour) {
        saveSnapshot();
        const newPour = {
            id: genId(),
            type: 'copperPour',
            net: pour.net || 'NET1',
            layer: pour.layer || 'front',
            points: pour.points.map(p => ({ x: p.x, y: p.y })),
            clearance: pour.clearance !== undefined ? pour.clearance : 0.3
        };
        state.copperPours.push(newPour);
        return newPour;
    }

    function updateCopperPour(id, updates) {
        saveSnapshot();
        const pour = state.copperPours.find(p => p.id === id);
        if (pour) {
            Object.assign(pour, updates);
            if (updates.points) {
                pour.points = updates.points.map(p => ({ x: p.x, y: p.y }));
            }
        }
        return pour;
    }

    function setCopperPourVertex(id, vertexIndex, newPosition) {
        const pour = state.copperPours.find(p => p.id === id);
        if (pour && vertexIndex >= 0 && vertexIndex < pour.points.length) {
            pour.points[vertexIndex] = { x: newPosition.x, y: newPosition.y };
        }
    }

    function removeCopperPour(id) {
        saveSnapshot();
        const idx = state.copperPours.findIndex(p => p.id === id);
        if (idx >= 0) {
            state.copperPours.splice(idx, 1);
        }
    }

    function findCopperPourAt(point, layer = null, tolerance = 0.5) {
        for (let i = state.copperPours.length - 1; i >= 0; i--) {
            const pour = state.copperPours[i];
            if (layer && pour.layer !== layer) continue;
            if (Geometry.isPointInPolygon(point, pour.points)) {
                return pour;
            }
            if (Geometry.pointToPolygonEdgeDistance(point, pour.points) <= tolerance) {
                return pour;
            }
        }
        return null;
    }

    function findCopperPourVertexAt(point, tolerance = 0.5) {
        for (let i = state.copperPours.length - 1; i >= 0; i--) {
            const pour = state.copperPours[i];
            const vertex = Geometry.findNearestPolygonVertex(point, pour.points, tolerance);
            if (vertex) {
                return { pour, vertexIndex: vertex.index, point: vertex.point };
            }
        }
        return null;
    }

    function genId() {
        return state.nextId++;
    }

    function addPad(pad) {
        saveSnapshot();
        const newPad = {
            id: genId(),
            type: 'pad',
            net: pad.net || 'NET1',
            x: pad.x,
            y: pad.y,
            diameter: pad.diameter || 1.6,
            hole: pad.hole || 0.8,
            layers: ['front', 'back']
        };
        state.pads.push(newPad);
        return newPad;
    }

    function updatePad(id, updates) {
        saveSnapshot();
        const pad = state.pads.find(p => p.id === id);
        if (pad) {
            Object.assign(pad, updates);
            if (pad.hole >= pad.diameter) {
                pad.hole = pad.diameter * 0.5;
            }
        }
        return pad;
    }

    function removePad(id) {
        saveSnapshot();
        const idx = state.pads.findIndex(p => p.id === id);
        if (idx >= 0) {
            state.pads.splice(idx, 1);
        }
        state.tracks = state.tracks.filter(t => !isTrackConnectedToPad(t, id));
    }

    function isTrackConnectedToPad(track, padId) {
        const pad = state.pads.find(p => p.id === padId);
        if (!pad) return false;
        if (track.points.length < 2) return false;
        const start = track.points[0];
        const end = track.points[track.points.length - 1];
        const tol = pad.diameter / 2 + 0.1;
        const dist1 = Geometry.dist(start, pad);
        const dist2 = Geometry.dist(end, pad);
        return dist1 <= tol || dist2 <= tol;
    }

    function addTrack(track) {
        saveSnapshot();
        const newTrack = {
            id: genId(),
            type: 'track',
            net: track.net || 'NET1',
            layer: track.layer || 'front',
            width: track.width || 0.25,
            points: track.points.map(p => ({ x: p.x, y: p.y }))
        };
        state.tracks.push(newTrack);
        return newTrack;
    }

    function updateTrack(id, updates) {
        saveSnapshot();
        const track = state.tracks.find(t => t.id === id);
        if (track) {
            Object.assign(track, updates);
            if (updates.points) {
                track.points = updates.points.map(p => ({ x: p.x, y: p.y }));
            }
        }
        return track;
    }

    function removeTrack(id) {
        saveSnapshot();
        const idx = state.tracks.findIndex(t => t.id === id);
        if (idx >= 0) {
            state.tracks.splice(idx, 1);
        }
    }

    function addVia(via) {
        saveSnapshot();
        const newVia = {
            id: genId(),
            type: 'via',
            net: via.net || 'NET1',
            x: via.x,
            y: via.y,
            diameter: via.diameter || 0.6,
            hole: via.hole || 0.3,
            layers: ['front', 'back']
        };
        state.vias.push(newVia);
        return newVia;
    }

    function updateVia(id, updates) {
        saveSnapshot();
        const via = state.vias.find(v => v.id === id);
        if (via) {
            Object.assign(via, updates);
        }
        return via;
    }

    function removeVia(id) {
        saveSnapshot();
        const idx = state.vias.findIndex(v => v.id === id);
        if (idx >= 0) {
            state.vias.splice(idx, 1);
        }
    }

    function findPadAt(point, tolerance = 0.5) {
        for (let i = state.pads.length - 1; i >= 0; i--) {
            const pad = state.pads[i];
            const r = Math.max(pad.diameter / 2, tolerance);
            if (Geometry.dist(point, pad) <= r) {
                return pad;
            }
        }
        return null;
    }

    function findViaAt(point, tolerance = 0.5) {
        for (let i = state.vias.length - 1; i >= 0; i--) {
            const via = state.vias[i];
            const r = Math.max(via.diameter / 2, tolerance);
            if (Geometry.dist(point, via) <= r) {
                return via;
            }
        }
        return null;
    }

    function findTrackAt(point, layer = null, tolerance = 0.3) {
        for (let i = state.tracks.length - 1; i >= 0; i--) {
            const track = state.tracks[i];
            if (layer && track.layer !== layer) continue;
            if (track.points.length < 2) continue;
            const halfWidth = track.width / 2;
            const tol = Math.max(halfWidth, tolerance);
            for (let j = 0; j < track.points.length - 1; j++) {
                const d = Geometry.pointToSegmentDistance(point, track.points[j], track.points[j + 1]);
                if (d <= tol) {
                    return track;
                }
            }
        }
        return null;
    }

    function findTrackEndpointAt(point, tolerance = 0.5) {
        for (let i = state.tracks.length - 1; i >= 0; i--) {
            const track = state.tracks[i];
            if (track.points.length < 1) continue;
            const start = track.points[0];
            const end = track.points[track.points.length - 1];
            if (Geometry.dist(point, start) <= tolerance) {
                return { track, point: start, isEnd: false };
            }
            if (Geometry.dist(point, end) <= tolerance) {
                return { track, point: end, isEnd: true };
            }
        }
        return null;
    }

    function findElementAt(point, layer = null) {
        const pad = findPadAt(point);
        if (pad) return { type: 'pad', element: pad };
        const via = findViaAt(point);
        if (via) return { type: 'via', element: via };
        const track = findTrackAt(point, layer);
        if (track) return { type: 'track', element: track };
        const pour = findCopperPourAt(point, layer);
        if (pour) return { type: 'copperPour', element: pour };
        return null;
    }

    function movePad(padId, newPosition) {
        const pad = state.pads.find(p => p.id === padId);
        if (!pad) return;
        const dx = newPosition.x - pad.x;
        const dy = newPosition.y - pad.y;
        pad.x = newPosition.x;
        pad.y = newPosition.y;

        for (const track of state.tracks) {
            if (track.points.length < 1) continue;
            const start = track.points[0];
            const end = track.points[track.points.length - 1];
            const tol = pad.diameter / 2 + 0.1;
            if (Geometry.dist(start, { x: pad.x - dx, y: pad.y - dy }) <= tol) {
                start.x = pad.x;
                start.y = pad.y;
            }
            if (Geometry.dist(end, { x: pad.x - dx, y: pad.y - dy }) <= tol) {
                end.x = pad.x;
                end.y = pad.y;
            }
        }
    }

    function moveVia(viaId, newPosition) {
        const via = state.vias.find(v => v.id === viaId);
        if (!via) return;
        const dx = newPosition.x - via.x;
        const dy = newPosition.y - via.y;
        via.x = newPosition.x;
        via.y = newPosition.y;

        for (const track of state.tracks) {
            if (track.points.length < 1) continue;
            const start = track.points[0];
            const end = track.points[track.points.length - 1];
            const tol = via.diameter / 2 + 0.1;
            if (Geometry.dist(start, { x: via.x - dx, y: via.y - dy }) <= tol) {
                start.x = via.x;
                start.y = via.y;
            }
            if (Geometry.dist(end, { x: via.x - dx, y: via.y - dy }) <= tol) {
                end.x = via.x;
                end.y = via.y;
            }
        }
    }

    function getPadsByNet(net) {
        return state.pads.filter(p => p.net === net);
    }

    function getTracksByNet(net) {
        return state.tracks.filter(t => t.net === net);
    }

    function getViasByNet(net) {
        return state.vias.filter(v => v.net === net);
    }

    function loadDemoData() {
        saveSnapshot();
        state.pads = [
            { id: genId(), type: 'pad', net: 'NET1', x: 15, y: 20, diameter: 1.6, hole: 0.8, layers: ['front', 'back'] },
            { id: genId(), type: 'pad', net: 'NET1', x: 85, y: 20, diameter: 1.6, hole: 0.8, layers: ['front', 'back'] },
            { id: genId(), type: 'pad', net: 'NET2', x: 15, y: 40, diameter: 1.6, hole: 0.8, layers: ['front', 'back'] },
            { id: genId(), type: 'pad', net: 'NET2', x: 85, y: 60, diameter: 1.6, hole: 0.8, layers: ['front', 'back'] },
            { id: genId(), type: 'pad', net: 'NET3', x: 15, y: 60, diameter: 1.6, hole: 0.8, layers: ['front', 'back'] },
            { id: genId(), type: 'pad', net: 'NET3', x: 50, y: 30, diameter: 1.6, hole: 0.8, layers: ['front', 'back'] }
        ];

        state.tracks = [
            {
                id: genId(),
                type: 'track',
                net: 'NET1',
                layer: 'front',
                width: 0.25,
                points: [
                    { x: 15, y: 20 },
                    { x: 30, y: 20 },
                    { x: 45, y: 35 },
                    { x: 70, y: 35 },
                    { x: 85, y: 20 }
                ]
            },
            {
                id: genId(),
                type: 'track',
                net: 'NET2',
                layer: 'front',
                width: 0.25,
                points: [
                    { x: 15, y: 40 },
                    { x: 40, y: 40 },
                    { x: 50, y: 50 }
                ]
            },
            {
                id: genId(),
                type: 'track',
                net: 'NET2',
                layer: 'back',
                width: 0.25,
                points: [
                    { x: 50, y: 50 },
                    { x: 70, y: 50 },
                    { x: 85, y: 60 }
                ]
            },
            {
                id: genId(),
                type: 'track',
                net: 'NET3',
                layer: 'front',
                width: 0.25,
                points: [
                    { x: 15, y: 60 },
                    { x: 25, y: 60 },
                    { x: 40, y: 45 },
                    { x: 50, y: 45 },
                    { x: 50, y: 30 }
                ]
            },
            {
                id: genId(),
                type: 'track',
                net: 'NET1',
                layer: 'front',
                width: 0.25,
                points: [
                    { x: 30, y: 35.1 },
                    { x: 65, y: 35.1 }
                ]
            }
        ];

        state.vias = [
            { id: genId(), type: 'via', net: 'NET2', x: 50, y: 50, diameter: 0.6, hole: 0.3, layers: ['front', 'back'] }
        ];

        state.copperPours = [
            {
                id: genId(),
                type: 'copperPour',
                net: 'NET1',
                layer: 'front',
                clearance: 0.3,
                points: [
                    { x: 50, y: 5 },
                    { x: 95, y: 5 },
                    { x: 95, y: 75 },
                    { x: 50, y: 75 }
                ]
            }
        ];
    }

    return {
        getState,
        setState,
        clearAll,
        addPad,
        updatePad,
        removePad,
        addTrack,
        updateTrack,
        removeTrack,
        addVia,
        updateVia,
        removeVia,
        addCopperPour,
        updateCopperPour,
        removeCopperPour,
        findPadAt,
        findViaAt,
        findTrackAt,
        findTrackEndpointAt,
        findCopperPourAt,
        findCopperPourVertexAt,
        findElementAt,
        movePad,
        moveVia,
        setCopperPourVertex,
        getPadsByNet,
        getTracksByNet,
        getViasByNet,
        undo,
        redo,
        canUndo,
        canRedo,
        saveSnapshot,
        loadDemoData
    };
})();
