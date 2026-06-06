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
                if (result.clearance < minClearance - 1e-6) {
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

    function computeClearance(shape1, shape2) {
        if (shape1.type === 'circle' && shape2.type === 'circle') {
            return circleCircleClearance(shape1, shape2);
        } else if (shape1.type === 'circle' && shape2.type === 'segment') {
            return circleSegmentClearance(shape1, shape2);
        } else if (shape1.type === 'segment' && shape2.type === 'circle') {
            return circleSegmentClearance(shape2, shape1);
        } else if (shape1.type === 'segment' && shape2.type === 'segment') {
            return segmentSegmentClearance(shape1, shape2);
        }
        return { clearance: Infinity, position: null };
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
