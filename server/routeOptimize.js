const EPSILON = 1e-9;
const ANGLE_TOLERANCE = 0.01;

function dist(p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function sub(p1, p2) {
  return { x: p1.x - p2.x, y: p1.y - p2.y };
}

function len(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

function normalize(v) {
  const l = len(v);
  if (l < EPSILON) return { x: 0, y: 0 };
  return { x: v.x / l, y: v.y / l };
}

function dot(v1, v2) {
  return v1.x * v2.x + v1.y * v2.y;
}

function angleBetween(v1, v2) {
  const u1 = normalize(v1);
  const u2 = normalize(v2);
  const d = Math.max(-1, Math.min(1, dot(u1, u2)));
  return Math.acos(d);
}

function isAngle45OrMultiple(radians) {
  const step = Math.PI / 4;
  const normalized = ((radians % step) + step) % step;
  return normalized < ANGLE_TOLERANCE || (step - normalized) < ANGLE_TOLERANCE;
}

function isColinearOr45(A, B, C) {
  const v1 = sub(B, A);
  const v2 = sub(C, B);
  if (len(v1) < EPSILON || len(v2) < EPSILON) return true;
  const angle = angleBetween(v1, v2);
  if (angle < ANGLE_TOLERANCE) return true;
  if (isAngle45OrMultiple(Math.atan2(v1.y, v1.x)) &&
      isAngle45OrMultiple(Math.atan2(v2.y, v2.x))) {
    const u1 = normalize(v1);
    const u2 = normalize(v2);
    const angleDiff = angleBetween(v1, v2);
    if (angleDiff < ANGLE_TOLERANCE) return true;
  }
  const crossZ = v1.x * v2.y - v1.y * v2.x;
  return Math.abs(crossZ) < EPSILON;
}

function polylineLength(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += dist(points[i], points[i + 1]);
  }
  return total;
}

function removeRedundantPoints(points) {
  if (points.length < 3) {
    return { points: points.slice(), removedCount: 0 };
  }
  const result = [points[0]];
  let removedCount = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];
    const next = points[i + 1];
    if (isColinearOr45(prev, curr, next)) {
      removedCount++;
    } else {
      result.push(curr);
    }
  }
  result.push(points[points.length - 1]);
  return { points: result, removedCount };
}

function analyzeColinearOptimization(track) {
  const originalPoints = track.points || [];
  const originalLength = polylineLength(originalPoints);
  const { points: optimizedPoints, removedCount } = removeRedundantPoints(originalPoints);
  const optimizedLength = polylineLength(optimizedPoints);
  const savedLength = originalLength - optimizedLength;
  const savedPercent = originalLength > 0 ? (savedLength / originalLength) * 100 : 0;
  return {
    trackId: track.id,
    net: track.net,
    layer: track.layer,
    originalPointCount: originalPoints.length,
    optimizedPointCount: optimizedPoints.length,
    removedPointCount: removedCount,
    originalLength,
    optimizedLength,
    savedLength,
    savedPercent,
    originalPoints,
    optimizedPoints,
    canOptimize: removedCount > 0
  };
}

function computeEfficiencyRatio(track) {
  const points = track.points || [];
  if (points.length < 2) return { ratio: 1, straightDistance: 0, pathLength: 0 };
  const start = points[0];
  const end = points[points.length - 1];
  const straightDistance = dist(start, end);
  const pathLength = polylineLength(points);
  const ratio = pathLength > 0 ? straightDistance / pathLength : 1;
  return { ratio, straightDistance, pathLength };
}

function classifyDetour(ratio) {
  if (ratio < 0.5) return 'severe';
  if (ratio < 0.7) return 'mild';
  return 'normal';
}

function computeOctilinearPath(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  if (absDx < EPSILON || absDy < EPSILON) {
    return [from, to];
  }
  if (absDx >= absDy) {
    const diagonalLen = absDy;
    const midPoint = {
      x: from.x + Math.sign(dx) * diagonalLen,
      y: from.y + Math.sign(dy) * diagonalLen
    };
    return [from, midPoint, to];
  } else {
    const diagonalLen = absDx;
    const midPoint = {
      x: from.x + Math.sign(dx) * diagonalLen,
      y: from.y + Math.sign(dy) * diagonalLen
    };
    return [from, midPoint, to];
  }
}

function analyzeDetour(track) {
  const { ratio, straightDistance, pathLength } = computeEfficiencyRatio(track);
  const classification = classifyDetour(ratio);
  const points = track.points || [];
  let suggestedPath = null;
  let suggestedLength = null;
  let suggestedSavedLength = null;
  let suggestedSavedPercent = null;
  if (classification === 'severe' && points.length >= 2) {
    const start = points[0];
    const end = points[points.length - 1];
    suggestedPath = computeOctilinearPath(start, end);
    suggestedLength = polylineLength(suggestedPath);
    suggestedSavedLength = pathLength - suggestedLength;
    suggestedSavedPercent = pathLength > 0 ? (suggestedSavedLength / pathLength) * 100 : 0;
  }
  return {
    trackId: track.id,
    net: track.net,
    layer: track.layer,
    efficiencyRatio: ratio,
    straightDistance,
    pathLength,
    detourLevel: classification,
    isDetour: classification !== 'normal',
    suggestedPath,
    suggestedLength,
    suggestedSavedLength,
    suggestedSavedPercent
  };
}

function analyzeBoard(state) {
  const tracks = state.tracks || [];
  const colinearResults = [];
  const detourResults = [];
  let totalOriginalLength = 0;
  let totalOptimizedLength = 0;
  let totalRemovedPoints = 0;
  let optimizableTrackCount = 0;
  let severeDetourCount = 0;
  let mildDetourCount = 0;
  for (const track of tracks) {
    const colinear = analyzeColinearOptimization(track);
    colinearResults.push(colinear);
    totalOriginalLength += colinear.originalLength;
    totalOptimizedLength += colinear.optimizedLength;
    totalRemovedPoints += colinear.removedPointCount;
    if (colinear.canOptimize) optimizableTrackCount++;
    const detour = analyzeDetour(track);
    detourResults.push(detour);
    if (detour.detourLevel === 'severe') severeDetourCount++;
    else if (detour.detourLevel === 'mild') mildDetourCount++;
  }
  const totalSavedLength = totalOriginalLength - totalOptimizedLength;
  const totalSavedPercent = totalOriginalLength > 0 ? (totalSavedLength / totalOriginalLength) * 100 : 0;
  const suggestions = [];
  for (const c of colinearResults) {
    if (c.canOptimize) {
      suggestions.push({
        type: 'colinear',
        trackId: c.trackId,
        net: c.net,
        layer: c.layer,
        description: `共线冗余点可合并：移除 ${c.removedPointCount} 个冗余点`,
        originalPoints: c.originalPoints,
        optimizedPoints: c.optimizedPoints,
        originalLength: c.originalLength,
        optimizedLength: c.optimizedLength,
        savedLength: c.savedLength,
        savedPercent: c.savedPercent,
        removedPointCount: c.removedPointCount
      });
    }
  }
  for (const d of detourResults) {
    if (d.isDetour) {
      suggestions.push({
        type: 'detour',
        trackId: d.trackId,
        net: d.net,
        layer: d.layer,
        description: d.detourLevel === 'severe' ? '严重绕行：建议使用八方向直连路径' : '轻度绕行',
        efficiencyRatio: d.efficiencyRatio,
        detourLevel: d.detourLevel,
        originalPoints: (state.tracks.find(t => t.id === d.trackId) || {}).points || [],
        originalLength: d.pathLength,
        straightDistance: d.straightDistance,
        suggestedPath: d.suggestedPath,
        suggestedLength: d.suggestedLength,
        suggestedSavedLength: d.suggestedSavedLength,
        suggestedSavedPercent: d.suggestedSavedPercent
      });
    }
  }
  return {
    totalTracks: tracks.length,
    optimizableTrackCount,
    totalRemovedPoints,
    totalOriginalLength,
    totalOptimizedLength,
    totalSavedLength,
    totalSavedPercent,
    severeDetourCount,
    mildDetourCount,
    colinearResults,
    detourResults,
    suggestions
  };
}

function applyColinearOptimization(state, trackIds) {
  const tracks = state.tracks || [];
  const newState = JSON.parse(JSON.stringify(state));
  let optimizedCount = 0;
  let totalRemovedPoints = 0;
  let totalSavedLength = 0;
  const optimizedTrackIds = [];
  const targetIds = trackIds === 'all'
    ? tracks.map(t => t.id)
    : (Array.isArray(trackIds) ? trackIds : []);
  const targetIdSet = new Set(targetIds);
  for (let i = 0; i < newState.tracks.length; i++) {
    const track = newState.tracks[i];
    if (!targetIdSet.has(track.id)) continue;
    const analysis = analyzeColinearOptimization(track);
    if (analysis.canOptimize) {
      newState.tracks[i].points = analysis.optimizedPoints;
      optimizedCount++;
      totalRemovedPoints += analysis.removedPointCount;
      totalSavedLength += analysis.savedLength;
      optimizedTrackIds.push(track.id);
    }
  }
  return {
    newState,
    optimizedCount,
    totalRemovedPoints,
    totalSavedLength,
    optimizedTrackIds
  };
}

module.exports = {
  dist,
  polylineLength,
  removeRedundantPoints,
  analyzeColinearOptimization,
  computeEfficiencyRatio,
  classifyDetour,
  computeOctilinearPath,
  analyzeDetour,
  analyzeBoard,
  applyColinearOptimization
};
