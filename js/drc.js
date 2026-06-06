const DRC = (function() {
    let violations = [];
    let minClearance = 0.2;
    let enabled = true;

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

    function runCheck() {
        violations = [];
        if (!enabled) return violations;

        const state = PCBState.getState();

        const frontElements = collectLayerElements(state, 'front');
        const backElements = collectLayerElements(state, 'back');

        checkLayerElements(frontElements, 'front');
        checkLayerElements(backElements, 'back');

        return violations;
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
                    violations.push({
                        layer: layer,
                        position: result.position,
                        clearance: result.clearance,
                        element1: e1,
                        element2: e2
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

    return {
        runCheck,
        getViolations,
        setClearance,
        getClearance,
        setEnabled,
        isEnabled
    };
})();
