const Geometry = (function() {
    const EPSILON = 1e-9;

    function dist(p1, p2) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function distSq(p1, p2) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        return dx * dx + dy * dy;
    }

    function sub(p1, p2) {
        return { x: p1.x - p2.x, y: p1.y - p2.y };
    }

    function add(p1, p2) {
        return { x: p1.x + p2.x, y: p1.y + p2.y };
    }

    function mul(p, s) {
        return { x: p.x * s, y: p.y * s };
    }

    function dot(p1, p2) {
        return p1.x * p2.x + p1.y * p2.y;
    }

    function cross(p1, p2) {
        return p1.x * p2.y - p1.y * p2.x;
    }

    function len(p) {
        return Math.sqrt(p.x * p.x + p.y * p.y);
    }

    function normalize(p) {
        const l = len(p);
        if (l < EPSILON) return { x: 0, y: 0 };
        return { x: p.x / l, y: p.y / l };
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    function pointToSegmentDistance(point, segStart, segEnd) {
        const v = sub(segEnd, segStart);
        const w = sub(point, segStart);
        const c1 = dot(w, v);
        if (c1 <= 0) return dist(point, segStart);
        const c2 = dot(v, v);
        if (c2 <= c1) return dist(point, segEnd);
        const b = c1 / c2;
        const pb = add(segStart, mul(v, b));
        return dist(point, pb);
    }

    function pointToSegmentDistanceSq(point, segStart, segEnd) {
        const v = sub(segEnd, segStart);
        const w = sub(point, segStart);
        const c1 = dot(w, v);
        if (c1 <= 0) return distSq(point, segStart);
        const c2 = dot(v, v);
        if (c2 <= c1) return distSq(point, segEnd);
        const b = c1 / c2;
        const pb = add(segStart, mul(v, b));
        return distSq(point, pb);
    }

    function closestPointOnSegment(point, segStart, segEnd) {
        const v = sub(segEnd, segStart);
        const w = sub(point, segStart);
        const c1 = dot(w, v);
        if (c1 <= 0) return { point: segStart, t: 0 };
        const c2 = dot(v, v);
        if (c2 <= c1) return { point: segEnd, t: 1 };
        const b = c1 / c2;
        return { point: add(segStart, mul(v, b)), t: b };
    }

    function segmentSegmentDistance(s1a, s1b, s2a, s2b) {
        const v1 = sub(s1b, s1a);
        const v2 = sub(s2b, s2a);
        const u = sub(s1a, s2a);
        const a = dot(v1, v1);
        const b = dot(v1, v2);
        const c = dot(v2, v2);
        const d = dot(v1, u);
        const e = dot(v2, u);
        const denom = a * c - b * b;
        let s, t;

        if (denom < EPSILON) {
            s = 0;
            t = (b > c ? d / b : e / c);
        } else {
            s = clamp((b * e - c * d) / denom, 0, 1);
            t = clamp((a * e - b * d) / denom, 0, 1);
        }

        if (s <= 0) {
            s = 0;
            t = clamp(e / c, 0, 1);
        } else if (s >= 1) {
            s = 1;
            t = clamp((e + b) / c, 0, 1);
        }

        if (t <= 0) {
            t = 0;
            s = clamp(-d / a, 0, 1);
        } else if (t >= 1) {
            t = 1;
            s = clamp((b - d) / a, 0, 1);
        }

        const p1 = add(s1a, mul(v1, s));
        const p2 = add(s2a, mul(v2, t));
        return dist(p1, p2);
    }

    function segmentsIntersect(s1a, s1b, s2a, s2b) {
        const d1 = direction(s2a, s2b, s1a);
        const d2 = direction(s2a, s2b, s1b);
        const d3 = direction(s1a, s1b, s2a);
        const d4 = direction(s1a, s1b, s2b);

        if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
            ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
            return true;
        }

        if (Math.abs(d1) < EPSILON && onSegment(s2a, s2b, s1a)) return true;
        if (Math.abs(d2) < EPSILON && onSegment(s2a, s2b, s1b)) return true;
        if (Math.abs(d3) < EPSILON && onSegment(s1a, s1b, s2a)) return true;
        if (Math.abs(d4) < EPSILON && onSegment(s1a, s1b, s2b)) return true;

        return false;
    }

    function direction(p1, p2, p3) {
        return cross(sub(p3, p1), sub(p2, p1));
    }

    function onSegment(pi, pj, pk) {
        return Math.min(pi.x, pj.x) - EPSILON <= pk.x && pk.x <= Math.max(pi.x, pj.x) + EPSILON &&
               Math.min(pi.y, pj.y) - EPSILON <= pk.y && pk.y <= Math.max(pi.y, pj.y) + EPSILON;
    }

    function pointToCircleDistance(point, center, radius) {
        return Math.max(0, dist(point, center) - radius);
    }

    function segmentToCircleDistance(segStart, segEnd, center, radius) {
        return Math.max(0, pointToSegmentDistance(center, segStart, segEnd) - radius);
    }

    function circleCircleDistance(c1, r1, c2, r2) {
        return Math.max(0, dist(c1, c2) - r1 - r2);
    }

    function snapToGrid(point, gridSize) {
        return {
            x: Math.round(point.x / gridSize) * gridSize,
            y: Math.round(point.y / gridSize) * gridSize
        };
    }

    function computeOctilinearPath(from, to) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        if (absDx < EPSILON || absDy < EPSILON) {
            return [to];
        }

        const ratio = absDx / absDy;

        if (Math.abs(ratio - 1) < 0.1) {
            return [to];
        }

        if (absDx > absDy) {
            const midY = from.y + (absDx > absDy * 1.5 ? 0 : Math.sign(dy) * (absDx - absDy));
            const mid = {
                x: from.x + (absDx > absDy * 1.5 ? dx - Math.sign(dx) * absDy : Math.sign(dx) * absDy),
                y: absDx > absDy * 1.5 ? to.y : from.y + Math.sign(dy) * absDy
            };

            if (absDx > absDy * 2) {
                const mid1 = { x: from.x + Math.sign(dx) * absDy, y: from.y + Math.sign(dy) * absDy };
                const mid2 = { x: to.x - Math.sign(dx) * absDy, y: from.y + Math.sign(dy) * absDy };
                return [mid1, mid2, to];
            }

            return [mid, to];
        } else {
            if (absDy > absDx * 2) {
                const mid1 = { x: from.x + Math.sign(dx) * absDx, y: from.y + Math.sign(dy) * absDx };
                const mid2 = { x: from.x + Math.sign(dx) * absDx, y: to.y - Math.sign(dy) * absDx };
                return [mid1, mid2, to];
            }

            const mid = {
                x: from.x + Math.sign(dx) * absDx,
                y: absDy > absDx * 1.5 ? from.y + Math.sign(dy) * (absDy - absDx) : from.y + Math.sign(dy) * absDx
            };
            return [mid, to];
        }
    }

    function computeOctilinearPathSimple(from, to) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        if (absDx < EPSILON || absDy < EPSILON) {
            return [to];
        }

        const slope = absDy / absDx;

        if (absDx >= absDy) {
            const diagonalLen = absDx - absDy;
            const midPoint = {
                x: from.x + Math.sign(dx) * diagonalLen,
                y: from.y + Math.sign(dy) * absDy
            };
            return [midPoint, to];
        } else {
            const diagonalLen = absDy - absDx;
            const midPoint = {
                x: from.x + Math.sign(dx) * absDx,
                y: from.y + Math.sign(dy) * diagonalLen
            };
            return [midPoint, to];
        }
    }

    function isPointOnPolyline(point, points, tolerance = 0.1) {
        for (let i = 0; i < points.length - 1; i++) {
            const d = pointToSegmentDistance(point, points[i], points[i + 1]);
            if (d <= tolerance) return true;
        }
        return false;
    }

    function findNearestPointOnPolyline(point, points) {
        let minDist = Infinity;
        let nearest = null;
        let segmentIndex = -1;

        for (let i = 0; i < points.length - 1; i++) {
            const cp = closestPointOnSegment(point, points[i], points[i + 1]);
            const d = dist(point, cp.point);
            if (d < minDist) {
                minDist = d;
                nearest = cp.point;
                segmentIndex = i;
            }
        }

        return { point: nearest, distance: minDist, segmentIndex };
    }

    function polylineSegments(points) {
        const segs = [];
        for (let i = 0; i < points.length - 1; i++) {
            segs.push([points[i], points[i + 1]]);
        }
        return segs;
    }

    function isPointInPolygon(point, polygon) {
        if (!polygon || polygon.length < 3) return false;
        let inside = false;
        const n = polygon.length;
        let j = n - 1;
        for (let i = 0; i < n; j = i++) {
            const xi = polygon[i].x, yi = polygon[i].y;
            const xj = polygon[j].x, yj = polygon[j].y;
            if (((yi > point.y) !== (yj > point.y)) &&
                (point.x < (xj - xi) * (point.y - yi) / (yj - yi + EPSILON) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    function pointToPolygonDistance(point, polygon) {
        if (!polygon || polygon.length === 0) return Infinity;
        if (isPointInPolygon(point, polygon)) return 0;
        let minDist = Infinity;
        const n = polygon.length;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const d = pointToSegmentDistance(point, polygon[i], polygon[j]);
            if (d < minDist) minDist = d;
        }
        return minDist;
    }

    function segmentToPolygonDistance(segStart, segEnd, polygon) {
        if (!polygon || polygon.length < 3) return Infinity;
        let minDist = Infinity;
        const n = polygon.length;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            if (segmentsIntersect(segStart, segEnd, polygon[i], polygon[j])) {
                return 0;
            }
            const d = segmentSegmentDistance(segStart, segEnd, polygon[i], polygon[j]);
            if (d < minDist) minDist = d;
        }
        const mid = { x: (segStart.x + segEnd.x) / 2, y: (segStart.y + segEnd.y) / 2 };
        if (isPointInPolygon(mid, polygon)) return 0;
        if (isPointInPolygon(segStart, polygon) || isPointInPolygon(segEnd, polygon)) return 0;
        return minDist;
    }

    function circleToPolygonDistance(center, radius, polygon) {
        if (!polygon || polygon.length < 3) return Infinity;
        const distToPoly = pointToPolygonDistance(center, polygon);
        return Math.max(0, distToPoly - radius);
    }

    function findNearestPolygonVertex(point, polygon, tolerance = 0.5) {
        if (!polygon) return null;
        let minDist = tolerance;
        let nearestIdx = -1;
        for (let i = 0; i < polygon.length; i++) {
            const d = dist(point, polygon[i]);
            if (d <= minDist) {
                minDist = d;
                nearestIdx = i;
            }
        }
        return nearestIdx >= 0 ? { index: nearestIdx, point: polygon[nearestIdx] } : null;
    }

    function pointToPolygonEdgeDistance(point, polygon) {
        if (!polygon || polygon.length < 2) return Infinity;
        let minDist = Infinity;
        const n = polygon.length;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const d = pointToSegmentDistance(point, polygon[i], polygon[j]);
            if (d < minDist) minDist = d;
        }
        return minDist;
    }

    return {
        dist,
        distSq,
        sub,
        add,
        mul,
        dot,
        cross,
        len,
        normalize,
        clamp,
        pointToSegmentDistance,
        pointToSegmentDistanceSq,
        closestPointOnSegment,
        segmentSegmentDistance,
        segmentsIntersect,
        pointToCircleDistance,
        segmentToCircleDistance,
        circleCircleDistance,
        snapToGrid,
        computeOctilinearPath,
        computeOctilinearPathSimple,
        isPointOnPolyline,
        findNearestPointOnPolyline,
        polylineSegments,
        isPointInPolygon,
        pointToPolygonDistance,
        segmentToPolygonDistance,
        circleToPolygonDistance,
        findNearestPolygonVertex,
        pointToPolygonEdgeDistance
    };
})();
