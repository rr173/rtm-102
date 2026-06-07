const ELEMENT_TYPES = ['pads', 'tracks', 'vias', 'copperPours'];

function fieldToElementType(field) {
  const map = {
    pads: 'pad',
    tracks: 'track',
    vias: 'via',
    copperPours: 'copperPour'
  };
  return map[field] || field;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

function diffFields(before, after) {
  const beforeDiff = {};
  const afterDiff = {};
  const allKeys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of allKeys) {
    if (key === 'id') continue;
    const bVal = before ? before[key] : undefined;
    const aVal = after ? after[key] : undefined;
    if (!deepEqual(bVal, aVal)) {
      if (before && before.hasOwnProperty(key)) beforeDiff[key] = bVal;
      if (after && after.hasOwnProperty(key)) afterDiff[key] = aVal;
    }
  }
  return { before: beforeDiff, after: afterDiff };
}

function computeDetailedDiff(stateA, stateB) {
  const summary = { added: 0, removed: 0, modified: 0 };
  const details = [];
  const before = stateA || {};
  const after = stateB || {};

  for (const field of ELEMENT_TYPES) {
    const beforeArr = before[field] || [];
    const afterArr = after[field] || [];
    const elementType = fieldToElementType(field);

    const beforeMap = new Map();
    for (const el of beforeArr) {
      if (el && el.id != null) beforeMap.set(String(el.id), el);
    }
    const afterMap = new Map();
    for (const el of afterArr) {
      if (el && el.id != null) afterMap.set(String(el.id), el);
    }

    for (const [id, afterEl] of afterMap) {
      if (!beforeMap.has(id)) {
        summary.added++;
        details.push({
          element_type: elementType,
          element_id: id,
          change: 'added',
          before: {},
          after: afterEl
        });
      } else {
        const beforeEl = beforeMap.get(id);
        const fieldsDiff = diffFields(beforeEl, afterEl);
        if (Object.keys(fieldsDiff.before).length > 0 || Object.keys(fieldsDiff.after).length > 0) {
          summary.modified++;
          details.push({
            element_type: elementType,
            element_id: id,
            change: 'modified',
            before: fieldsDiff.before,
            after: fieldsDiff.after
          });
        }
      }
    }

    for (const [id, beforeEl] of beforeMap) {
      if (!afterMap.has(id)) {
        summary.removed++;
        details.push({
          element_type: elementType,
          element_id: id,
          change: 'removed',
          before: beforeEl,
          after: {}
        });
      }
    }
  }

  return { summary, details };
}

function computeDiffSummary(stateA, stateB) {
  const summary = { added: 0, removed: 0, modified: 0 };
  const before = stateA || {};
  const after = stateB || {};

  for (const field of ELEMENT_TYPES) {
    const beforeArr = before[field] || [];
    const afterArr = after[field] || [];

    const beforeMap = new Map();
    for (const el of beforeArr) {
      if (el && el.id != null) beforeMap.set(String(el.id), el);
    }
    const afterMap = new Map();
    for (const el of afterArr) {
      if (el && el.id != null) afterMap.set(String(el.id), el);
    }

    for (const [id, afterEl] of afterMap) {
      if (!beforeMap.has(id)) {
        summary.added++;
      } else {
        const beforeEl = beforeMap.get(id);
        const fieldsDiff = diffFields(beforeEl, afterEl);
        if (Object.keys(fieldsDiff.before).length > 0 || Object.keys(fieldsDiff.after).length > 0) {
          summary.modified++;
        }
      }
    }

    for (const [id] of beforeMap) {
      if (!afterMap.has(id)) {
        summary.removed++;
      }
    }
  }

  return summary;
}

function createDiffModule(db, deps) {
  const { dbGet, dbAll, getLatestVersion } = deps;

  async function getVersionState(boardId, version) {
    const row = await dbGet(
      'SELECT state_json FROM board_versions WHERE board_id = ? AND version = ?',
      [boardId, version]
    );
    if (!row) return null;
    return JSON.parse(row.state_json);
  }

  function mountDiffRoutes(app) {
    app.post('/api/boards/:id/diff', async (req, res) => {
      try {
        const boardId = req.params.id;
        const { version_a, version_b } = req.body || {};

        if (version_a == null || version_b == null) {
          return res.status(400).json({ error: 'version_a and version_b are required' });
        }

        const va = parseInt(version_a);
        const vb = parseInt(version_b);

        const stateA = await getVersionState(boardId, va);
        if (stateA === null) {
          return res.status(404).json({ error: `Version ${va} not found` });
        }

        const stateB = await getVersionState(boardId, vb);
        if (stateB === null) {
          return res.status(404).json({ error: `Version ${vb} not found` });
        }

        const result = computeDetailedDiff(stateA, stateB);
        res.json(result);
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/boards/:id/revert-preview/:ver', async (req, res) => {
      try {
        const boardId = req.params.id;
        const ver = parseInt(req.params.ver);

        const latest = await getLatestVersion(boardId);
        if (!latest) {
          return res.status(404).json({ error: 'Board not found or no versions' });
        }

        const targetState = await getVersionState(boardId, ver);
        if (targetState === null) {
          return res.status(404).json({ error: `Version ${ver} not found` });
        }

        const result = computeDetailedDiff(latest.state, targetState);
        res.json(result);
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/boards/:id/revert-confirm/:ver', async (req, res) => {
      try {
        const boardId = req.params.id;
        const ver = parseInt(req.params.ver);
        const { confirm } = req.body || {};

        if (confirm !== true) {
          return res.status(400).json({ error: 'confirm must be true' });
        }

        const target = await dbGet(
          'SELECT state_json FROM board_versions WHERE board_id = ? AND version = ?',
          [boardId, ver]
        );
        if (!target) {
          return res.status(404).json({ error: `Version ${ver} not found` });
        }

        const state = JSON.parse(target.state_json);
        const latest = await getLatestVersion(boardId);
        const beforeState = latest ? latest.state : null;

        const newVersion = await deps.saveVersion(boardId, state, `Revert to version ${ver}`);
        deps.audit.recordAuditLog({
          board_id: boardId,
          action_type: 'revert',
          operator: deps.getOperator(req),
          before_state: beforeState,
          after_state: state
        });
        deps.broadcast(boardId, { type: 'revert', payload: { version: newVersion, state } });
        res.json({ version: newVersion });
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/boards/:id/changelog', async (req, res) => {
      try {
        const boardId = req.params.id;
        const limit = Math.min(parseInt(req.query.limit) || 10, 100);

        const rows = await dbAll(
          'SELECT version, state_json, created_at FROM board_versions WHERE board_id = ? ORDER BY version DESC LIMIT ?',
          [boardId, limit + 1]
        );

        if (rows.length === 0) {
          return res.json([]);
        }

        const changelog = [];
        for (let i = 0; i < rows.length - 1; i++) {
          const toRow = rows[i];
          const fromRow = rows[i + 1];
          const fromState = JSON.parse(fromRow.state_json);
          const toState = JSON.parse(toRow.state_json);
          const summary = computeDiffSummary(fromState, toState);
          changelog.push({
            from_version: fromRow.version,
            to_version: toRow.version,
            summary,
            timestamp: toRow.created_at
          });
        }

        res.json(changelog);
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
      }
    });
  }

  return {
    mountDiffRoutes,
    computeDetailedDiff,
    computeDiffSummary
  };
}

module.exports = {
  createDiffModule,
  computeDetailedDiff,
  computeDiffSummary
};
