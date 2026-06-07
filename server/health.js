const BOARD_WIDTH = 100;
const BOARD_HEIGHT = 80;
const BOARD_AREA = BOARD_WIDTH * BOARD_HEIGHT;

const DEFAULT_WEIGHTS = {
  density: 0.25,
  balance: 0.25,
  connectivity: 0.25,
  drc: 0.25
};

function clampScore(score) {
  return Math.max(0, Math.min(100, score));
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function polygonArea(points) {
  if (!points || points.length < 3) return 0;
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += points[i].x * points[j].y;
    sum -= points[j].x * points[i].y;
  }
  return Math.abs(sum) / 2;
}

function trackLength(track) {
  if (!track.points || track.points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < track.points.length - 1; i++) {
    total += dist(track.points[i], track.points[i + 1]);
  }
  return total;
}

function circleArea(diameter) {
  const r = diameter / 2;
  return Math.PI * r * r;
}

function computeCoverageArea(state) {
  let trackArea = 0;
  const trackDetails = [];
  for (const track of state.tracks || []) {
    const len = trackLength(track);
    const area = len * (track.width || 0.25);
    trackArea += area;
    trackDetails.push({
      id: track.id,
      net: track.net,
      length: Number(len.toFixed(4)),
      width: track.width || 0.25,
      area: Number(area.toFixed(4))
    });
  }

  let padArea = 0;
  const padDetails = [];
  for (const pad of state.pads || []) {
    const area = circleArea(pad.diameter || 1.6);
    padArea += area;
    padDetails.push({
      id: pad.id,
      net: pad.net,
      diameter: pad.diameter || 1.6,
      area: Number(area.toFixed(4))
    });
  }

  for (const via of state.vias || []) {
    const area = circleArea(via.diameter || 0.6);
    padArea += area;
    padDetails.push({
      id: `via_${via.id}`,
      net: via.net,
      diameter: via.diameter || 0.6,
      area: Number(area.toFixed(4)),
      isVia: true
    });
  }

  let pourArea = 0;
  const pourDetails = [];
  for (const pour of state.copperPours || []) {
    const area = polygonArea(pour.points);
    pourArea += area;
    pourDetails.push({
      id: pour.id,
      net: pour.net,
      area: Number(area.toFixed(4))
    });
  }

  return {
    totalArea: Number((trackArea + padArea + pourArea).toFixed(4)),
    trackArea: Number(trackArea.toFixed(4)),
    padArea: Number(padArea.toFixed(4)),
    pourArea: Number(pourArea.toFixed(4)),
    trackDetails,
    padDetails,
    pourDetails
  };
}

function scoreDensity(state) {
  const coverage = computeCoverageArea(state);
  const ratio = coverage.totalArea / BOARD_AREA;
  const reasons = [];
  let score = 100;

  if (ratio >= 0.5 && ratio <= 0.8) {
    reasons.push(`布线密度 ${(ratio * 100).toFixed(2)}% 处于理想区间 [50%, 80%]`);
  } else if (ratio < 0.5) {
    const deviation = (0.5 - ratio) / 0.5;
    score = clampScore(100 - deviation * 100);
    reasons.push(`布线密度 ${(ratio * 100).toFixed(2)}% 偏低，低于理想区间下限 50%，偏离 ${(deviation * 100).toFixed(2)}%`);
  } else {
    const deviation = (ratio - 0.8) / 0.2;
    score = clampScore(100 - deviation * 100);
    reasons.push(`布线密度 ${(ratio * 100).toFixed(2)}% 偏高，超过理想区间上限 80%，偏离 ${(deviation * 100).toFixed(2)}%`);
  }

  reasons.push(`走线覆盖: ${coverage.trackArea.toFixed(2)} mm², 焊盘/过孔覆盖: ${coverage.padArea.toFixed(2)} mm², 铜区覆盖: ${coverage.pourArea.toFixed(2)} mm²`);

  return {
    score: clampScore(score),
    ratio: Number((ratio * 100).toFixed(2)),
    details: {
      boardArea: BOARD_AREA,
      coverageArea: coverage.totalArea,
      trackArea: coverage.trackArea,
      padArea: coverage.padArea,
      pourArea: coverage.pourArea
    },
    breakdown: reasons
  };
}

function scoreBalance(state) {
  const netLengths = {};
  const netTracks = {};

  for (const track of state.tracks || []) {
    const net = track.net || '(unassigned)';
    if (!netLengths[net]) {
      netLengths[net] = 0;
      netTracks[net] = [];
    }
    const len = trackLength(track);
    netLengths[net] += len;
    netTracks[net].push({ trackId: track.id, length: Number(len.toFixed(4)) });
  }

  const validNets = Object.keys(netLengths).filter(n => netLengths[n] > 0);
  const reasons = [];

  if (validNets.length === 0) {
    return {
      score: 100,
      stdDev: 0,
      mean: 0,
      cv: 0,
      details: { netCount: 0 },
      breakdown: ['无走线网络，均衡性满分']
    };
  }

  if (validNets.length === 1) {
    const onlyNet = validNets[0];
    return {
      score: 100,
      stdDev: 0,
      mean: Number(netLengths[onlyNet].toFixed(4)),
      cv: 0,
      details: {
        netCount: 1,
        netLengths: { [onlyNet]: Number(netLengths[onlyNet].toFixed(4)) }
      },
      breakdown: ['仅有 1 个走线网络，无可比性，均衡性满分']
    };
  }

  const lengths = validNets.map(n => netLengths[n]);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : 0;

  let score = 100;
  if (cv <= 0.1) {
    reasons.push(`变异系数 CV=${(cv * 100).toFixed(2)}% ≤ 10%，走线长度非常均衡`);
  } else if (cv <= 0.3) {
    score = 100 - (cv - 0.1) / 0.2 * 30;
    reasons.push(`变异系数 CV=${(cv * 100).toFixed(2)}%，处于 10%~30% 区间，走线基本均衡`);
  } else if (cv <= 0.6) {
    score = 70 - (cv - 0.3) / 0.3 * 40;
    reasons.push(`变异系数 CV=${(cv * 100).toFixed(2)}%，处于 30%~60% 区间，走线长度差异较大`);
  } else {
    score = clampScore(30 - (cv - 0.6) * 50);
    reasons.push(`变异系数 CV=${(cv * 100).toFixed(2)}% > 60%，走线长度严重不均衡`);
  }

  const sortedNetLengths = validNets
    .map(n => ({ net: n, length: Number(netLengths[n].toFixed(4)), deviationFromMean: Number((netLengths[n] - mean).toFixed(4)) }))
    .sort((a, b) => Math.abs(b.deviationFromMean) - Math.abs(a.deviationFromMean));

  if (sortedNetLengths.length > 0) {
    const worst = sortedNetLengths[0];
    reasons.push(`偏离最大的网络: ${worst.net}，长度 ${worst.length.toFixed(2)} mm，偏离均值 ${worst.deviationFromMean > 0 ? '+' : ''}${worst.deviationFromMean.toFixed(2)} mm`);
  }

  return {
    score: clampScore(score),
    stdDev: Number(stdDev.toFixed(4)),
    mean: Number(mean.toFixed(4)),
    cv: Number((cv * 100).toFixed(2)),
    details: {
      netCount: validNets.length,
      netLengths: sortedNetLengths,
      allNetLengths: netLengths
    },
    breakdown: reasons
  };
}

function checkConnectivityReport(state) {
  const allNets = new Set();
  for (const pad of state.pads || []) allNets.add(pad.net);
  for (const via of state.vias || []) allNets.add(via.net);
  for (const track of state.tracks || []) allNets.add(track.net);
  for (const pour of state.copperPours || []) allNets.add(pour.net);

  const netsWithNodes = [];
  for (const net of allNets) {
    if (!net) continue;
    const pads = (state.pads || []).filter(p => p.net === net);
    const vias = (state.vias || []).filter(v => v.net === net);
    const nodes = [
      ...pads.map(p => ({ id: `pad_${p.id}`, type: 'pad', x: p.x, y: p.y, radius: p.diameter / 2, layers: p.layers })),
      ...vias.map(v => ({ id: `via_${v.id}`, type: 'via', x: v.x, y: v.y, radius: v.diameter / 2, layers: v.layers }))
    ];
    if (nodes.length >= 2) {
      netsWithNodes.push({ net, pads, vias, nodes, tracks: (state.tracks || []).filter(t => t.net === net), pours: (state.copperPours || []).filter(p => p.net === net) });
    }
  }

  const brokenNets = [];

  for (const { net, nodes, tracks, pours } of netsWithNodes) {
    const parent = {};
    const rank = {};
    for (const n of nodes) { parent[n.id] = n.id; rank[n.id] = 0; }

    function find(x) {
      if (parent[x] !== x) parent[x] = find(parent[x]);
      return parent[x];
    }
    function union(x, y) {
      const rx = find(x), ry = find(y);
      if (rx === ry) return;
      if (rank[rx] < rank[ry]) parent[rx] = ry;
      else if (rank[rx] > rank[ry]) parent[ry] = rx;
      else { parent[ry] = rx; rank[rx]++; }
    }

    function minDistanceFromNodeToTrack(node, track) {
      let minD = Infinity;
      for (let i = 0; i < track.points.length - 1; i++) {
        const d = pointToSegmentDistance(node, track.points[i], track.points[i + 1]);
        if (d < minD) minD = d;
      }
      return minD;
    }

    for (const track of tracks) {
      if (track.points.length < 2) continue;
      const connectedToTrack = [];
      for (const node of nodes) {
        if (!node.layers.includes(track.layer)) continue;
        const d = minDistanceFromNodeToTrack(node, track);
        const tol = node.radius + track.width / 2 + 0.1;
        if (d <= tol) connectedToTrack.push(node.id);
      }
      for (let a = 0; a < connectedToTrack.length; a++) {
        for (let b = a + 1; b < connectedToTrack.length; b++) {
          union(connectedToTrack[a], connectedToTrack[b]);
        }
      }
    }

    for (const pour of pours) {
      const connectedToPour = [];
      for (const node of nodes) {
        if (!node.layers.includes(pour.layer)) continue;
        const inPour = isPointInPolygon(node, pour.points);
        const edgeDist = pointToPolygonEdgeDistance(node, pour.points);
        if (inPour || edgeDist <= node.radius) connectedToPour.push(node.id);
      }
      for (let a = 0; a < connectedToPour.length; a++) {
        for (let b = a + 1; b < connectedToPour.length; b++) {
          union(connectedToPour[a], connectedToPour[b]);
        }
      }
    }

    for (let ai = 0; ai < nodes.length; ai++) {
      for (let bi = ai + 1; bi < nodes.length; bi++) {
        const na = nodes[ai], nb = nodes[bi];
        const hasCommonLayer = na.layers.some(l => nb.layers.includes(l));
        if (!hasCommonLayer) continue;
        const d = dist(na, nb);
        const tol = na.radius + nb.radius + 0.05;
        if (d <= tol) union(na.id, nb.id);
      }
    }

    const compMap = {};
    for (const n of nodes) {
      const r = find(n.id);
      if (!compMap[r]) compMap[r] = [];
      compMap[r].push(n);
    }
    const components = Object.values(compMap);

    if (components.length > 1) {
      brokenNets.push({
        net,
        nodeCount: nodes.length,
        componentCount: components.length,
        componentSizes: components.map(c => c.length)
      });
    }
  }

  return { totalNets: netsWithNodes.length, brokenNets };
}

function pointToSegmentDistance(point, segStart, segEnd) {
  const vx = segEnd.x - segStart.x;
  const vy = segEnd.y - segStart.y;
  const wx = point.x - segStart.x;
  const wy = point.y - segStart.y;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return dist(point, segStart);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return dist(point, segEnd);
  const b = c1 / c2;
  const px = segStart.x + b * vx;
  const py = segStart.y + b * vy;
  return dist(point, { x: px, y: py });
}

function isPointInPolygon(point, polygon) {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  const n = polygon.length;
  let j = n - 1;
  const EPSILON = 1e-9;
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

function scoreConnectivity(state) {
  const { totalNets, brokenNets } = checkConnectivityReport(state);
  const reasons = [];

  if (totalNets === 0) {
    return {
      score: 100,
      totalNets: 0,
      brokenNets: 0,
      details: {},
      breakdown: ['无网络需要连通检测，连通性满分']
    };
  }

  const brokenRatio = brokenNets.length / totalNets;
  const score = clampScore((1 - brokenRatio) * 100);

  if (brokenNets.length === 0) {
    reasons.push(`所有 ${totalNets} 个网络均完全连通`);
  } else {
    reasons.push(`检测到 ${brokenNets.length}/${totalNets} 个断线网络，断线率 ${(brokenRatio * 100).toFixed(2)}%`);
    for (const bn of brokenNets) {
      reasons.push(`网络 ${bn.net}: ${bn.nodeCount} 个节点断裂为 ${bn.componentCount} 段 (各段节点数: ${bn.componentSizes.join(', ')})`);
    }
  }

  return {
    score: clampScore(score),
    totalNets,
    brokenCount: brokenNets.length,
    brokenRatio: Number((brokenRatio * 100).toFixed(2)),
    details: { brokenNets },
    breakdown: reasons
  };
}

function countElements(state) {
  const pads = (state.pads || []).length;
  const vias = (state.vias || []).length;
  const tracks = (state.tracks || []).length;
  const pours = (state.copperPours || []).length;
  return pads + vias + tracks + pours;
}

function runSimpleDRC(state) {
  const violations = [];
  const minClearance = 0.2;

  function pointDist(p1, p2) {
    return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
  }

  function pointToSegmentDist(pt, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return pointDist(pt, a);
    let t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return pointDist(pt, { x: a.x + t * dx, y: a.y + t * dy });
  }

  function collectElements(layer) {
    const elements = [];
    for (const pad of state.pads || []) {
      if (pad.layers && pad.layers.includes(layer)) {
        elements.push({ id: `pad_${pad.id}`, type: 'pad', net: pad.net, shape: { type: 'circle', center: { x: pad.x, y: pad.y }, radius: pad.diameter / 2 } });
      }
    }
    for (const via of state.vias || []) {
      if (via.layers && via.layers.includes(layer)) {
        elements.push({ id: `via_${via.id}`, type: 'via', net: via.net, shape: { type: 'circle', center: { x: via.x, y: via.y }, radius: via.diameter / 2 } });
      }
    }
    for (const track of state.tracks || []) {
      if (track.layer !== layer) continue;
      for (let i = 0; i < track.points.length - 1; i++) {
        elements.push({ id: `track_${track.id}_${i}`, type: 'track', net: track.net, trackId: track.id, shape: { type: 'segment', start: track.points[i], end: track.points[i + 1], halfWidth: track.width / 2 } });
      }
    }
    for (const pour of state.copperPours || []) {
      if (pour.layer !== layer) continue;
      elements.push({ id: `pour_${pour.id}`, type: 'copperPour', net: pour.net, shape: { type: 'polygon', points: pour.points } });
    }
    return elements;
  }

  function isPointInPolygonLocal(point, polygon) {
    if (!polygon || polygon.length < 3) return false;
    let inside = false;
    const n = polygon.length;
    let j = n - 1;
    const EPS = 1e-9;
    for (let i = 0; i < n; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y;
      const xj = polygon[j].x, yj = polygon[j].y;
      if (((yi > point.y) !== (yj > point.y)) &&
          (point.x < (xj - xi) * (point.y - yi) / (yj - yi + EPS) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function segmentToSegmentDist(a1, a2, b1, b2) {
    const d1 = pointToSegmentDist(a1, b1, b2);
    const d2 = pointToSegmentDist(a2, b1, b2);
    const d3 = pointToSegmentDist(b1, a1, a2);
    const d4 = pointToSegmentDist(b2, a1, a2);
    return Math.min(d1, d2, d3, d4);
  }

  function polygonPointDist(polygon, point) {
    if (isPointInPolygonLocal(point, polygon)) return 0;
    let minD = Infinity;
    const n = polygon.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const d = pointToSegmentDist(point, polygon[i], polygon[j]);
      if (d < minD) minD = d;
    }
    return minD;
  }

  function computeClearance(s1, s2) {
    if (s1.type === 'circle' && s2.type === 'circle') {
      return pointDist(s1.center, s2.center) - s1.radius - s2.radius;
    }
    if (s1.type === 'circle' && s2.type === 'segment') {
      return pointToSegmentDist(s1.center, s2.start, s2.end) - s1.radius - s2.halfWidth;
    }
    if (s1.type === 'segment' && s2.type === 'circle') {
      return pointToSegmentDist(s2.center, s1.start, s1.end) - s2.radius - s1.halfWidth;
    }
    if (s1.type === 'segment' && s2.type === 'segment') {
      return segmentToSegmentDist(s1.start, s1.end, s2.start, s2.end) - s1.halfWidth - s2.halfWidth;
    }
    if (s1.type === 'polygon' && s2.type === 'circle') {
      return polygonPointDist(s1.points, s2.center) - s2.radius;
    }
    if (s1.type === 'circle' && s2.type === 'polygon') {
      return polygonPointDist(s2.points, s1.center) - s1.radius;
    }
    if (s1.type === 'polygon' && s2.type === 'segment') {
      if (isPointInPolygonLocal(s2.start, s1.points) || isPointInPolygonLocal(s2.end, s1.points)) return -1;
      let minD = Infinity;
      const n = s1.points.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const d = segmentToSegmentDist(s1.points[i], s1.points[j], s2.start, s2.end) - s2.halfWidth;
        if (d < minD) minD = d;
      }
      return minD;
    }
    if (s1.type === 'segment' && s2.type === 'polygon') {
      if (isPointInPolygonLocal(s1.start, s2.points) || isPointInPolygonLocal(s1.end, s2.points)) return -1;
      let minD = Infinity;
      const n = s2.points.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const d = segmentToSegmentDist(s2.points[i], s2.points[j], s1.start, s1.end) - s1.halfWidth;
        if (d < minD) minD = d;
      }
      return minD;
    }
    if (s1.type === 'polygon' && s2.type === 'polygon') {
      for (const p of s1.points) if (isPointInPolygonLocal(p, s2.points)) return -1;
      for (const p of s2.points) if (isPointInPolygonLocal(p, s1.points)) return -1;
      let minD = Infinity;
      const n1 = s1.points.length, n2 = s2.points.length;
      for (let i = 0; i < n1; i++) {
        const j = (i + 1) % n1;
        for (let k = 0; k < n2; k++) {
          const l = (k + 1) % n2;
          const d = segmentToSegmentDist(s1.points[i], s1.points[j], s2.points[k], s2.points[l]);
          if (d < minD) minD = d;
        }
      }
      return minD;
    }
    return Infinity;
  }

  for (const layer of ['front', 'back']) {
    const elements = collectElements(layer);
    for (let i = 0; i < elements.length; i++) {
      for (let j = i + 1; j < elements.length; j++) {
        const e1 = elements[i], e2 = elements[j];
        if (e1.net === e2.net) continue;
        if (e1.type === 'track' && e2.type === 'track' && e1.trackId === e2.trackId) continue;
        const clearance = computeClearance(e1.shape, e2.shape);
        if (clearance < minClearance - 1e-6) {
          violations.push({
            layer,
            severity: clearance < minClearance * 0.5 ? 'error' : 'warning',
            element1: { id: e1.id, type: e1.type, net: e1.net },
            element2: { id: e2.id, type: e2.type, net: e2.net },
            actualClearance: Number(clearance.toFixed(4)),
            requiredClearance: minClearance,
            type: 'clearance'
          });
        }
      }
    }
  }

  for (const track of state.tracks || []) {
    if (track.width < 0.1 || track.width > 2.0) {
      violations.push({
        layer: track.layer,
        severity: track.width < 0.08 || track.width > 2.5 ? 'error' : 'warning',
        element1: { id: `track_${track.id}`, type: 'track', net: track.net },
        actualValue: track.width,
        requiredMin: 0.1,
        requiredMax: 2.0,
        type: 'track_width'
      });
    }
  }

  return violations;
}

function scoreDRC(state) {
  const violations = runSimpleDRC(state);
  const elementCount = countElements(state);
  const reasons = [];

  if (elementCount === 0) {
    return {
      score: 100,
      violationCount: 0,
      elementCount: 0,
      violationRate: 0,
      details: { violations: [] },
      breakdown: ['无元素需要检查，DRC 满分']
    };
  }

  const violationRate = violations.length / elementCount;
  let score = 100;

  if (violations.length === 0) {
    reasons.push(`0 条 DRC 违规（共 ${elementCount} 个元素）`);
  } else if (violationRate <= 0.02) {
    score = 100 - violationRate / 0.02 * 15;
    reasons.push(`DRC 违规率 ${(violationRate * 100).toFixed(2)}% (${violations.length}/${elementCount})，处于较低水平`);
  } else if (violationRate <= 0.1) {
    score = 85 - (violationRate - 0.02) / 0.08 * 35;
    reasons.push(`DRC 违规率 ${(violationRate * 100).toFixed(2)}% (${violations.length}/${elementCount})，需要关注`);
  } else if (violationRate <= 0.3) {
    score = 50 - (violationRate - 0.1) / 0.2 * 30;
    reasons.push(`DRC 违规率 ${(violationRate * 100).toFixed(2)}% (${violations.length}/${elementCount})，违规较多`);
  } else {
    score = clampScore(20 - (violationRate - 0.3) * 50);
    reasons.push(`DRC 违规率 ${(violationRate * 100).toFixed(2)}% (${violations.length}/${elementCount})，违规严重`);
  }

  const errors = violations.filter(v => v.severity === 'error').length;
  const warnings = violations.filter(v => v.severity === 'warning').length;
  if (errors > 0) reasons.push(`其中 error 级违规 ${errors} 条，warning 级违规 ${warnings} 条`);

  return {
    score: clampScore(score),
    violationCount: violations.length,
    errorCount: errors,
    warningCount: warnings,
    elementCount,
    violationRate: Number((violationRate * 100).toFixed(2)),
    details: {
      violations: violations.slice(0, 50),
      totalViolations: violations.length
    },
    breakdown: reasons
  };
}

function normalizeWeights(weights) {
  const w = Object.assign({}, DEFAULT_WEIGHTS, weights || {});
  const total = w.density + w.balance + w.connectivity + w.drc;
  if (total <= 0) return DEFAULT_WEIGHTS;
  return {
    density: w.density / total,
    balance: w.balance / total,
    connectivity: w.connectivity / total,
    drc: w.drc / total
  };
}

function evaluateBoard(state, weights) {
  const normalizedWeights = normalizeWeights(weights);

  const density = scoreDensity(state);
  const balance = scoreBalance(state);
  const connectivity = scoreConnectivity(state);
  const drc = scoreDRC(state);

  const totalScore =
    density.score * normalizedWeights.density +
    balance.score * normalizedWeights.balance +
    connectivity.score * normalizedWeights.connectivity +
    drc.score * normalizedWeights.drc;

  return {
    totalScore: Number(totalScore.toFixed(2)),
    weights: normalizedWeights,
    dimensions: {
      density,
      balance,
      connectivity,
      drc
    }
  };
}

function rankBoards(boardResults) {
  const sorted = [...boardResults].sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return b.dimensions.drc.score - a.dimensions.drc.score;
  });
  return sorted.map((r, idx) => Object.assign({ rank: idx + 1 }, r));
}

module.exports = {
  evaluateBoard,
  rankBoards,
  scoreDensity,
  scoreBalance,
  scoreConnectivity,
  scoreDRC,
  normalizeWeights,
  DEFAULT_WEIGHTS,
  BOARD_WIDTH,
  BOARD_HEIGHT,
  BOARD_AREA
};
