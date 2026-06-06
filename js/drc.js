const DRC = (function() {
    let violations = [];
    let connectivityReport = [];
    let minClearance = 0.2;
    let enabled = true;
    let nextViolationId = 1;

    function setClearance(value) {
        minClearance = value;
    }

    function getClearance() {
        return minClearance;
    }

    function setEnabled(value) {
        enabled = value;
    }

    function isEnabled() {
        return enabled;
    }

    function getViolations() {
        return violations;
    }

    function getConnectivityReport() {
        return connectivityReport;
    }

    function getReport() {
        return {
            violations: violations,
            connectivity: connectivityReport
        };
    }

    function runCheck() {
        violations = [];
        connectivityReport = [];
        nextViolationId = 1;
        if (!enabled) return getReport();

        const state = PCBState.getState();

        const frontElements = collectLayerElements(state, 'front');
        const backElements = collectLayerElements(state, 'back');

        checkLayerElements(frontElements, 'front');
        checkLayerElements(backElements, 'back');

        connectivityReport = checkConnectivity(state);

        return getReport();
    }

    function collectLayerElements(state, layer) {
        const elements = [];

        for (const pad of state.pads) {
            if (pad.layers.includes(layer)) {
                elements.push({
                    type: 'pad',
                    element: pad,
                    net: pad.net,
                    layer: layer,
                    shape: { type: 'circle', center: { x: pad.x, y: pad.y }, radius: pad.diameter / 2 }
                });
            }
        }

        for (const via of state.vias) {
            if (via.layers.includes(layer)) {
                elements.push({
                    type: 'via',
                    element: via,
                    net: via.net,
                    layer: layer,
                    shape: { type: 'circle', center: { x: via.x, y: via.y }, radius: via.diameter / 2 }
                });
            }
        }

        for (const track of state.tracks) {
            if (track.layer !== layer) continue;
            for (let i = 0; i < track.points.length - 1; i++) {
                elements.push({
                    type: 'track',
                    element: track,
                    net: track.net,
                    layer: layer,
                    shape: {
                        type: 'segment',
                        start: track.points[i],
                        end: track.points[i + 1],
                        halfWidth: track.width / 2
                    },
                    segmentIndex: i
                });
            }
        }

        for (const pour of state.copperPours) {
            if (pour.layer !== layer) continue;
            elements.push({
                type: 'copperPour',
                element: pour,
                net: pour.net,
                layer: layer,
                shape: {
                    type: 'polygon',
                    points: pour.points,
                    clearance: pour.clearance
                }
            });
        }

        return elements;
    }

    function getElementName(el) {
        if (el.type === 'pad') return `Pad#${el.element.id}(${el.net})`;
        if (el.type === 'via') return `Via#${el.element.id}(${el.net})`;
        if (el.type === 'track') return `Track#${el.element.id}(${el.net})`;
        if (el.type === 'copperPour') return `Pour#${el.element.id}(${el.net})`;
        return `${el.type}(${el.net})`;
    }

    function checkLayerElements(elements, layer) {
        for (let i = 0; i < elements.length; i++) {
            for (let j = i + 1; j < elements.length; j++) {
                const e1 = elements[i];
                const e2 = elements[j];

                if (e1.net === e2.net) continue;

                if (e1.type === 'track' && e2.type === 'track' &&
                    e1.element.id === e2.element.id &&
                    Math.abs(e1.segmentIndex - e2.segmentIndex) <= 1) {
                    continue;
                }

                const result = computeClearance(e1.shape, e2.shape);
                const requiredClearance = computeRequiredClearance(e1, e2);
                if (result.clearance < requiredClearance - 1e-6) {
                    let severity = 'warning';
                    if (result.clearance < requiredClearance * 0.5) {
                        severity = 'error';
                    }
                    violations.push({
                        id: nextViolationId++,
                        layer: layer,
                        position: result.position,
                        clearance: result.clearance,
                        severity: severity,
                        element1: {
                            name: getElementName(e1),
                            net: e1.net,
                            type: e1.type
                        },
                        element2: {
                            name: getElementName(e2),
                            net: e2.net,
                            type: e2.type
                        }
                    });
                }
            }
        }
    }

    function computeRequiredClearance(e1, e2) {
        let clearance = minClearance;
        if (e1.type === 'copperPour') {
            clearance = Math.max(clearance, e1.shape.clearance);
        }
        if (e2.type === 'copperPour') {
            clearance = Math.max(clearance, e2.shape.clearance);
        }
        return clearance;
    }

    function computeClearance(shape1, shape2) {
        if (shape1.type === 'circle' && shape2.type === 'circle') {
            return circleCircleClearance(shape1, shape2);
        } else if (shape1.type === 'circle' && shape2.type === 'segment') {
            return circleSegmentClearance(shape1, shape2);
        } else if (shape1.type === 'segment' && shape2.type === 'circle') {
            return circleSegmentClearance(shape2, shape1);
        } else if (shape1.type === 'segment' && shape2.type === 'segment') {
            return segmentSegmentClearance(shape1, shape2);
        } else if (shape1.type === 'polygon' && shape2.type === 'circle') {
            return polygonCircleClearance(shape1, shape2);
        } else if (shape1.type === 'circle' && shape2.type === 'polygon') {
            return polygonCircleClearance(shape2, shape1);
        } else if (shape1.type === 'polygon' && shape2.type === 'segment') {
            return polygonSegmentClearance(shape1, shape2);
        } else if (shape1.type === 'segment' && shape2.type === 'polygon') {
            return polygonSegmentClearance(shape2, shape1);
        } else if (shape1.type === 'polygon' && shape2.type === 'polygon') {
            return polygonPolygonClearance(shape1, shape2);
        }
        return { clearance: Infinity, position: null };
    }

    function polygonCircleClearance(polygon, circle) {
        if (Geometry.isPointInPolygon(circle.center, polygon.points)) {
            return { clearance: Infinity, position: null };
        }
        const dist = Geometry.circleToPolygonDistance(circle.center, circle.radius, polygon.points);
        let midPoint = null;
        const nearest = Geometry.findNearestPointOnPolyline(circle.center, polygon.points);
        if (nearest.point) {
            midPoint = {
                x: (circle.center.x + nearest.point.x) / 2,
                y: (circle.center.y + nearest.point.y) / 2
            };
        } else {
            midPoint = { x: circle.center.x, y: circle.center.y };
        }
        return { clearance: dist, position: midPoint };
    }

    function polygonSegmentClearance(polygon, segment) {
        const mid = {
            x: (segment.start.x + segment.end.x) / 2,
            y: (segment.start.y + segment.end.y) / 2
        };
        if (Geometry.isPointInPolygon(mid, polygon.points) ||
            Geometry.isPointInPolygon(segment.start, polygon.points) ||
            Geometry.isPointInPolygon(segment.end, polygon.points)) {
            return { clearance: Infinity, position: null };
        }
        const dist = Geometry.segmentToPolygonDistance(segment.start, segment.end, polygon.points) - segment.halfWidth;
        return { clearance: Math.max(0, dist), position: mid };
    }

    function polygonPolygonClearance(poly1, poly2) {
        for (const p of poly1.points) {
            if (Geometry.isPointInPolygon(p, poly2.points)) {
                return { clearance: Infinity, position: null };
            }
        }
        for (const p of poly2.points) {
            if (Geometry.isPointInPolygon(p, poly1.points)) {
                return { clearance: Infinity, position: null };
            }
        }
        let minDist = Infinity;
        let bestPoint = null;
        const n1 = poly1.points.length;
        const n2 = poly2.points.length;
        for (let i = 0; i < n1; i++) {
            const j = (i + 1) % n1;
            for (let k = 0; k < n2; k++) {
                const l = (k + 1) % n2;
                const d = Geometry.segmentSegmentDistance(
                    poly1.points[i], poly1.points[j],
                    poly2.points[k], poly2.points[l]
                );
                if (d < minDist) {
                    minDist = d;
                    bestPoint = {
                        x: (poly1.points[i].x + poly2.points[k].x) / 2,
                        y: (poly1.points[i].y + poly2.points[k].y) / 2
                    };
                }
            }
        }
        return { clearance: minDist, position: bestPoint };
    }

    function circleCircleClearance(c1, c2) {
        const d = Geometry.dist(c1.center, c2.center);
        const clearance = d - c1.radius - c2.radius;
        const mid = {
            x: (c1.center.x + c2.center.x) / 2,
            y: (c1.center.y + c2.center.y) / 2
        };
        return { clearance, position: mid };
    }

    function circleSegmentClearance(circle, segment) {
        const closest = Geometry.closestPointOnSegment(
            circle.center, segment.start, segment.end
        );
        const d = Geometry.dist(circle.center, closest.point);
        const clearance = d - circle.radius - segment.halfWidth;
        const mid = {
            x: (circle.center.x + closest.point.x) / 2,
            y: (circle.center.y + closest.point.y) / 2
        };
        return { clearance, position: mid };
    }

    function segmentSegmentClearance(seg1, seg2) {
        const rawDist = Geometry.segmentSegmentDistance(
            seg1.start, seg1.end, seg2.start, seg2.end
        );
        const clearance = rawDist - seg1.halfWidth - seg2.halfWidth;

        const v1 = Geometry.sub(seg1.end, seg1.start);
        const v2 = Geometry.sub(seg2.end, seg2.start);
        const u = Geometry.sub(seg1.start, seg2.start);
        const a = Geometry.dot(v1, v1);
        const b = Geometry.dot(v1, v2);
        const c = Geometry.dot(v2, v2);
        const d = Geometry.dot(v1, u);
        const e = Geometry.dot(v2, u);
        const denom = a * c - b * b;
        let s, t;

        if (denom < 1e-9) {
            s = 0;
            t = (b > c ? d / b : e / c);
        } else {
            s = Geometry.clamp((b * e - c * d) / denom, 0, 1);
            t = Geometry.clamp((a * e - b * d) / denom, 0, 1);
        }

        if (s <= 0) { s = 0; t = Geometry.clamp(e / c, 0, 1); }
        else if (s >= 1) { s = 1; t = Geometry.clamp((e + b) / c, 0, 1); }
        if (t <= 0) { t = 0; s = Geometry.clamp(-d / a, 0, 1); }
        else if (t >= 1) { t = 1; s = Geometry.clamp((b - d) / a, 0, 1); }

        const p1 = Geometry.add(seg1.start, Geometry.mul(v1, s));
        const p2 = Geometry.add(seg2.start, Geometry.mul(v2, t));
        const mid = {
            x: (p1.x + p2.x) / 2,
            y: (p1.y + p2.y) / 2
        };
        return { clearance, position: mid };
    }

    function checkConnectivity(state) {
        const allNets = new Set();
        for (const pad of state.pads) allNets.add(pad.net);
        for (const via of state.vias) allNets.add(via.net);
        for (const track of state.tracks) allNets.add(track.net);

        const report = [];

        for (const net of allNets) {
            const pads = state.pads.filter(p => p.net === net);
            const vias = state.vias.filter(v => v.net === net);
            const tracks = state.tracks.filter(t => t.net === net);

            const nodes = [];
            for (const pad of pads) {
                nodes.push({
                    id: `pad_${pad.id}`,
                    type: 'pad',
                    element: pad,
                    x: pad.x,
                    y: pad.y,
                    radius: pad.diameter / 2
                });
            }
            for (const via of vias) {
                nodes.push({
                    id: `via_${via.id}`,
                    type: 'via',
                    element: via,
                    x: via.x,
                    y: via.y,
                    radius: via.diameter / 2
                });
            }

            if (nodes.length < 2) continue;

            const adjacency = {};
            for (const node of nodes) {
                adjacency[node.id] = [];
            }

            for (const track of tracks) {
                if (track.points.length < 2) continue;

                const endpoints = [
                    track.points[0],
                    track.points[track.points.length - 1]
                ];

                const connectedNodeIds = [];
                for (const ep of endpoints) {
                    for (const node of nodes) {
                        const tol = node.radius + 0.15;
                        if (Geometry.dist(ep, node) <= tol) {
                            if (!connectedNodeIds.includes(node.id)) {
                                connectedNodeIds.push(node.id);
                            }
                        }
                    }
                }

                const midPoints = [];
                for (let i = 0; i < track.points.length - 1; i++) {
                    const segStart = track.points[i];
                    const segEnd = track.points[i + 1];
                    for (const node of nodes) {
                        const d = Geometry.pointToSegmentDistance(node, segStart, segEnd);
                        const tol = node.radius + track.width / 2 + 0.05;
                        if (d <= tol) {
                            if (!connectedNodeIds.includes(node.id)) {
                                connectedNodeIds.push(node.id);
                            }
                        }
                    }
                }

                for (let a = 0; a < connectedNodeIds.length; a++) {
                    for (let b = a + 1; b < connectedNodeIds.length; b++) {
                        const idA = connectedNodeIds[a];
                        const idB = connectedNodeIds[b];
                        if (!adjacency[idA].includes(idB)) {
                            adjacency[idA].push(idB);
                        }
                        if (!adjacency[idB].includes(idA)) {
                            adjacency[idB].push(idA);
                        }
                    }
                }

                if (tracks.length > 1) {
                    for (const otherTrack of tracks) {
                        if (otherTrack.id === track.id) continue;
                        if (otherTrack.layer !== track.layer) continue;
                        if (otherTrack.points.length < 2) continue;

                        for (let i = 0; i < track.points.length - 1; i++) {
                            const s1 = track.points[i];
                            const e1 = track.points[i + 1];
                            for (let j = 0; j < otherTrack.points.length - 1; j++) {
                                const s2 = otherTrack.points[j];
                                const e2 = otherTrack.points[j + 1];
                                const d = Geometry.segmentSegmentDistance(s1, e1, s2, e2);
                                const tol = track.width / 2 + otherTrack.width / 2 + 0.05;
                                if (d <= tol) {
                                    const trackConnectedNodes = [];
                                    const otherConnectedNodes = [];
                                    for (const node of nodes) {
                                        const d1 = minDistanceFromNodeToTrack(node, track);
                                        const tol1 = node.radius + track.width / 2 + 0.1;
                                        if (d1 <= tol1 && !trackConnectedNodes.includes(node.id)) {
                                            trackConnectedNodes.push(node.id);
                                        }
                                        const d2 = minDistanceFromNodeToTrack(node, otherTrack);
                                        const tol2 = node.radius + otherTrack.width / 2 + 0.1;
                                        if (d2 <= tol2 && !otherConnectedNodes.includes(node.id)) {
                                            otherConnectedNodes.push(node.id);
                                        }
                                    }
                                    for (const idA of trackConnectedNodes) {
                                        for (const idB of otherConnectedNodes) {
                                            if (idA !== idB) {
                                                if (!adjacency[idA].includes(idB)) {
                                                    adjacency[idA].push(idB);
                                                }
                                                if (!adjacency[idB].includes(idA)) {
                                                    adjacency[idB].push(idA);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            for (const nodeA of nodes) {
                for (const nodeB of nodes) {
                    if (nodeA.id >= nodeB.id) continue;
                    if (nodeA.type === 'via' && nodeB.type === 'via') continue;
                    const d = Geometry.dist(nodeA, nodeB);
                    const tol = nodeA.radius + nodeB.radius + 0.05;
                    if (d <= tol) {
                        if (!adjacency[nodeA.id].includes(nodeB.id)) {
                            adjacency[nodeA.id].push(nodeB.id);
                        }
                        if (!adjacency[nodeB.id].includes(nodeA.id)) {
                            adjacency[nodeB.id].push(nodeA.id);
                        }
                    }
                }
            }

            const components = findConnectedComponents(nodes, adjacency);

            if (components.length > 1) {
                const missing = findMissingConnections(components);
                report.push({
                    net: net,
                    nodes: nodes.length,
                    components: components.length,
                    missing: missing
                });
            }
        }

        return report;
    }

    function minDistanceFromNodeToTrack(node, track) {
        let minD = Infinity;
        for (let i = 0; i < track.points.length - 1; i++) {
            const d = Geometry.pointToSegmentDistance(node, track.points[i], track.points[i + 1]);
            if (d < minD) minD = d;
        }
        return minD;
    }

    function findConnectedComponents(nodes, adjacency) {
        const visited = {};
        const components = [];

        for (const node of nodes) {
            if (visited[node.id]) continue;

            const component = [];
            const queue = [node.id];
            visited[node.id] = true;

            while (queue.length > 0) {
                const currentId = queue.shift();
                const currentNode = nodes.find(n => n.id === currentId);
                if (currentNode) {
                    component.push(currentNode);
                }
                const neighbors = adjacency[currentId] || [];
                for (const neighborId of neighbors) {
                    if (!visited[neighborId]) {
                        visited[neighborId] = true;
                        queue.push(neighborId);
                    }
                }
            }

            components.push(component);
        }

        return components;
    }

    function findMissingConnections(components) {
        const missing = [];

        for (let i = 0; i < components.length; i++) {
            for (let j = i + 1; j < components.length; j++) {
                let bestPair = null;
                let bestDist = Infinity;

                for (const nodeA of components[i]) {
                    for (const nodeB of components[j]) {
                        const d = Geometry.dist(nodeA, nodeB);
                        if (d < bestDist) {
                            bestDist = d;
                            bestPair = {
                                from: { id: nodeA.id, type: nodeA.type, x: nodeA.x, y: nodeA.y },
                                to: { id: nodeB.id, type: nodeB.type, x: nodeB.x, y: nodeB.y },
                                distance: d
                            };
                        }
                    }
                }

                if (bestPair) {
                    missing.push(bestPair);
                }
            }
        }

        return missing;
    }

    return {
        runCheck,
        getViolations,
        getConnectivityReport,
        getReport,
        setClearance,
        getClearance,
        setEnabled,
        isEnabled
    };
})();
