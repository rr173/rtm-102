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
        for (const pour of state.copperPours) allNets.add(pour.net);

        const report = [];

        for (const net of allNets) {
            const pads = state.pads.filter(p => p.net === net);
            const vias = state.vias.filter(v => v.net === net);
            const tracks = state.tracks.filter(t => t.net === net);
            const pours = state.copperPours.filter(p => p.net === net);

            const nodes = [];
            for (const pad of pads) {
                nodes.push({
                    id: `pad_${pad.id}`,
                    type: 'pad',
                    element: pad,
                    x: pad.x,
                    y: pad.y,
                    radius: pad.diameter / 2,
                    layers: pad.layers
                });
            }
            for (const via of vias) {
                nodes.push({
                    id: `via_${via.id}`,
                    type: 'via',
                    element: via,
                    x: via.x,
                    y: via.y,
                    radius: via.diameter / 2,
                    layers: via.layers
                });
            }

            if (nodes.length < 2) continue;

            const uf = new UnionFind(nodes.map(n => n.id));

            for (const track of tracks) {
                if (track.points.length < 2) continue;
                const connectedToTrack = [];
                for (const node of nodes) {
                    if (!node.layers.includes(track.layer)) continue;
                    const d = minDistanceFromNodeToTrack(node, track);
                    const tol = node.radius + track.width / 2 + 0.1;
                    if (d <= tol) {
                        connectedToTrack.push(node.id);
                    }
                }
                for (let a = 0; a < connectedToTrack.length; a++) {
                    for (let b = a + 1; b < connectedToTrack.length; b++) {
                        uf.union(connectedToTrack[a], connectedToTrack[b]);
                    }
                }
            }

            for (let ti = 0; ti < tracks.length; ti++) {
                const t1 = tracks[ti];
                if (t1.points.length < 2) continue;
                for (let tj = ti + 1; tj < tracks.length; tj++) {
                    const t2 = tracks[tj];
                    if (t2.points.length < 2) continue;
                    if (t2.layer !== t1.layer) continue;
                    if (!doTracksIntersect(t1, t2)) continue;
                    const connectedToEither = new Set();
                    for (const node of nodes) {
                        if (!node.layers.includes(t1.layer)) continue;
                        const d1 = minDistanceFromNodeToTrack(node, t1);
                        const tol = node.radius + t1.width / 2 + 0.1;
                        if (d1 <= tol) connectedToEither.add(node.id);
                        const d2 = minDistanceFromNodeToTrack(node, t2);
                        const tol2 = node.radius + t2.width / 2 + 0.1;
                        if (d2 <= tol2) connectedToEither.add(node.id);
                    }
                    const ids = Array.from(connectedToEither);
                    for (let a = 0; a < ids.length; a++) {
                        for (let b = a + 1; b < ids.length; b++) {
                            uf.union(ids[a], ids[b]);
                        }
                    }
                }
            }

            for (const pour of pours) {
                const connectedToPour = [];
                for (const node of nodes) {
                    if (!node.layers.includes(pour.layer)) continue;
                    const inPour = Geometry.isPointInPolygon(node, pour.points);
                    const edgeDist = Geometry.pointToPolygonEdgeDistance(node, pour.points);
                    if (inPour || edgeDist <= node.radius) {
                        connectedToPour.push(node.id);
                    }
                }
                for (const track of tracks) {
                    if (track.layer !== pour.layer) continue;
                    if (track.points.length < 2) continue;
                    if (doesTrackConnectToPour(track, pour)) {
                        for (const node of nodes) {
                            if (!node.layers.includes(track.layer)) continue;
                            const d = minDistanceFromNodeToTrack(node, track);
                            const tol = node.radius + track.width / 2 + 0.1;
                            if (d <= tol && !connectedToPour.includes(node.id)) {
                                connectedToPour.push(node.id);
                            }
                        }
                    }
                }
                for (let a = 0; a < connectedToPour.length; a++) {
                    for (let b = a + 1; b < connectedToPour.length; b++) {
                        uf.union(connectedToPour[a], connectedToPour[b]);
                    }
                }
            }

            for (let ai = 0; ai < nodes.length; ai++) {
                for (let bi = ai + 1; bi < nodes.length; bi++) {
                    const na = nodes[ai];
                    const nb = nodes[bi];
                    const hasCommonLayer = na.layers.some(l => nb.layers.includes(l));
                    if (!hasCommonLayer) continue;
                    const d = Geometry.dist(na, nb);
                    const tol = na.radius + nb.radius + 0.05;
                    if (d <= tol) {
                        uf.union(na.id, nb.id);
                    }
                }
            }

            const componentMap = {};
            for (const node of nodes) {
                const root = uf.find(node.id);
                if (!componentMap[root]) componentMap[root] = [];
                componentMap[root].push(node);
            }
            const components = Object.values(componentMap);

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

    function doTracksIntersect(t1, t2) {
        for (let i = 0; i < t1.points.length - 1; i++) {
            for (let j = 0; j < t2.points.length - 1; j++) {
                const d = Geometry.segmentSegmentDistance(
                    t1.points[i], t1.points[i + 1],
                    t2.points[j], t2.points[j + 1]
                );
                const tol = t1.width / 2 + t2.width / 2 + 0.05;
                if (d <= tol) return true;
            }
        }
        return false;
    }

    class UnionFind {
        constructor(elements) {
            this.parent = {};
            this.rank = {};
            for (const el of elements) {
                this.parent[el] = el;
                this.rank[el] = 0;
            }
        }
        find(x) {
            if (this.parent[x] !== x) {
                this.parent[x] = this.find(this.parent[x]);
            }
            return this.parent[x];
        }
        union(x, y) {
            const rx = this.find(x);
            const ry = this.find(y);
            if (rx === ry) return;
            if (this.rank[rx] < this.rank[ry]) {
                this.parent[rx] = ry;
            } else if (this.rank[rx] > this.rank[ry]) {
                this.parent[ry] = rx;
            } else {
                this.parent[ry] = rx;
                this.rank[rx]++;
            }
        }
    }

    function doesTrackConnectToPour(track, pour) {
        for (let i = 0; i < track.points.length - 1; i++) {
            const segStart = track.points[i];
            const segEnd = track.points[i + 1];
            if (Geometry.isPointInPolygon(segStart, pour.points) ||
                Geometry.isPointInPolygon(segEnd, pour.points)) {
                return true;
            }
            const mid = {
                x: (segStart.x + segEnd.x) / 2,
                y: (segStart.y + segEnd.y) / 2
            };
            if (Geometry.isPointInPolygon(mid, pour.points)) {
                return true;
            }
            for (let j = 0; j < pour.points.length; j++) {
                const k = (j + 1) % pour.points.length;
                const d = Geometry.segmentSegmentDistance(
                    segStart, segEnd,
                    pour.points[j], pour.points[k]
                );
                const tol = track.width / 2 + 0.05;
                if (d <= tol) {
                    return true;
                }
            }
        }
        return false;
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
