const MIN_DURATION = 30;
const MAX_DURATION = 3600;

const WRITE_OPS = new Set([
  'removePad', 'updatePad', 'movePad',
  'removeTrack', 'updateTrack',
  'removeVia', 'updateVia', 'moveVia',
  'removeCopperPour', 'updateCopperPour', 'setCopperPourVertex',
  'clearAll', 'setState'
]);

function getElementIdFromOp(op) {
  if (!op || !op.type || !op.payload) return null;
  if (op.payload.id != null) return String(op.payload.id);
  return null;
}

function getElementIdsFromStateDiff(affected) {
  const ids = new Set();
  if (!Array.isArray(affected)) return ids;
  for (const el of affected) {
    if (el && el.element_id != null && el.change !== 'added') {
      ids.add(String(el.element_id));
    }
  }
  return ids;
}

function createLocksModule(db, deps) {
  const { dbRun, dbGet, dbAll } = deps;

  async function initTable() {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS element_locks (
        board_id TEXT NOT NULL,
        element_id TEXT NOT NULL,
        operator TEXT NOT NULL,
        locked_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (board_id, element_id),
        FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
      )
    `);
    await dbRun('CREATE INDEX IF NOT EXISTS idx_locks_board ON element_locks(board_id)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_locks_expires ON element_locks(expires_at)');
  }

  async function cleanupExpiredLocks(boardId) {
    const now = Date.now();
    const result = await dbRun(
      'DELETE FROM element_locks WHERE board_id = ? AND expires_at < ?',
      [boardId, now]
    );
    return result.changes || 0;
  }

  async function getElementType(boardId, elementId) {
    const row = await dbGet(
      'SELECT state_json FROM board_versions WHERE board_id = ? ORDER BY version DESC LIMIT 1',
      [boardId]
    );
    if (!row) return null;
    try {
      const state = JSON.parse(row.state_json);
      const elId = String(elementId);
      if ((state.pads || []).some(p => String(p.id) === elId)) return 'pad';
      if ((state.tracks || []).some(t => String(t.id) === elId)) return 'track';
      if ((state.vias || []).some(v => String(v.id) === elId)) return 'via';
      if ((state.copperPours || []).some(c => String(c.id) === elId)) return 'copperPour';
    } catch (e) {}
    return null;
  }

  async function acquireLocks(boardId, elementIds, operator, durationSec) {
    const locks = [];
    const failed = [];
    const now = Date.now();
    const expiresAt = now + durationSec * 1000;

    for (const rawId of elementIds) {
      const elementId = String(rawId);
      try {
        const existing = await dbGet(
          'SELECT * FROM element_locks WHERE board_id = ? AND element_id = ?',
          [boardId, elementId]
        );

        if (existing && existing.expires_at >= now) {
          if (existing.operator === operator) {
            await dbRun(
              'UPDATE element_locks SET locked_at = ?, expires_at = ? WHERE board_id = ? AND element_id = ?',
              [now, expiresAt, boardId, elementId]
            );
            locks.push({ element_id: elementId, operator, expires_at: expiresAt });
          } else {
            failed.push({ element_id: elementId, reason: `locked by ${existing.operator}` });
          }
        } else {
          if (existing) {
            await dbRun(
              'UPDATE element_locks SET operator = ?, locked_at = ?, expires_at = ? WHERE board_id = ? AND element_id = ?',
              [operator, now, expiresAt, boardId, elementId]
            );
          } else {
            await dbRun(
              'INSERT INTO element_locks (board_id, element_id, operator, locked_at, expires_at) VALUES (?, ?, ?, ?, ?)',
              [boardId, elementId, operator, now, expiresAt]
            );
          }
          locks.push({ element_id: elementId, operator, expires_at: expiresAt });
        }
      } catch (e) {
        failed.push({ element_id: elementId, reason: e.message });
      }
    }

    return { locks, failed };
  }

  async function releaseLocks(boardId, elementIds, operator) {
    const released = [];
    const denied = [];
    const now = Date.now();
    const isAdmin = operator === 'admin';

    for (const rawId of elementIds) {
      const elementId = String(rawId);
      try {
        const existing = await dbGet(
          'SELECT * FROM element_locks WHERE board_id = ? AND element_id = ?',
          [boardId, elementId]
        );

        if (!existing || existing.expires_at < now) {
          if (existing) {
            await dbRun(
              'DELETE FROM element_locks WHERE board_id = ? AND element_id = ?',
              [boardId, elementId]
            );
          }
          released.push(elementId);
        } else if (isAdmin || existing.operator === operator) {
          await dbRun(
            'DELETE FROM element_locks WHERE board_id = ? AND element_id = ?',
            [boardId, elementId]
          );
          released.push(elementId);
        } else {
          denied.push({ element_id: elementId, reason: `locked by ${existing.operator}` });
        }
      } catch (e) {
        denied.push({ element_id: elementId, reason: e.message });
      }
    }

    return { released, denied };
  }

  async function getLocks(boardId) {
    const expiredCount = await cleanupExpiredLocks(boardId);
    const rows = await dbAll(
      'SELECT * FROM element_locks WHERE board_id = ? ORDER BY locked_at DESC',
      [boardId]
    );
    const now = Date.now();
    const locks = [];
    for (const row of rows) {
      const elementType = await getElementType(boardId, row.element_id);
      locks.push({
        element_id: row.element_id,
        element_type: elementType,
        operator: row.operator,
        locked_at: row.locked_at,
        expires_at: row.expires_at,
        remaining_sec: Math.max(0, Math.floor((row.expires_at - now) / 1000))
      });
    }
    return { locks, expired_count: expiredCount };
  }

  async function checkOperationAllowed(boardId, op, operator, beforeState, afterState) {
    if (!op || !op.type) return { allowed: true };
    if (!WRITE_OPS.has(op.type)) return { allowed: true };

    await cleanupExpiredLocks(boardId);

    let elementIds = new Set();

    if (op.type === 'clearAll' || op.type === 'setState') {
      if (beforeState && afterState && deps.computeStateDiff) {
        const affected = deps.computeStateDiff(beforeState, afterState);
        elementIds = getElementIdsFromStateDiff(affected);
      }
      if (elementIds.size === 0 && beforeState) {
        for (const p of beforeState.pads || []) elementIds.add(String(p.id));
        for (const t of beforeState.tracks || []) elementIds.add(String(t.id));
        for (const v of beforeState.vias || []) elementIds.add(String(v.id));
        for (const c of beforeState.copperPours || []) elementIds.add(String(c.id));
      }
    } else {
      const id = getElementIdFromOp(op);
      if (id) elementIds.add(id);
    }

    if (elementIds.size === 0) return { allowed: true };

    const placeholders = Array.from(elementIds).map(() => '?').join(',');
    const rows = await dbAll(
      `SELECT element_id, operator FROM element_locks 
       WHERE board_id = ? AND element_id IN (${placeholders})`,
      [boardId, ...Array.from(elementIds)]
    );

    for (const row of rows) {
      if (row.operator !== operator && operator !== 'admin') {
        return {
          allowed: false,
          error: 'element locked',
          locked_by: row.operator,
          element_id: row.element_id
        };
      }
    }

    return { allowed: true };
  }

  async function checkStateSaveAllowed(boardId, beforeState, afterState, operator) {
    await cleanupExpiredLocks(boardId);

    let affected = [];
    if (deps.computeStateDiff) {
      affected = deps.computeStateDiff(beforeState, afterState);
    }
    const elementIds = getElementIdsFromStateDiff(affected);

    if (elementIds.size === 0) return { allowed: true };

    const placeholders = Array.from(elementIds).map(() => '?').join(',');
    const rows = await dbAll(
      `SELECT element_id, operator FROM element_locks 
       WHERE board_id = ? AND element_id IN (${placeholders})`,
      [boardId, ...Array.from(elementIds)]
    );

    for (const row of rows) {
      if (row.operator !== operator && operator !== 'admin') {
        return {
          allowed: false,
          error: 'element locked',
          locked_by: row.operator,
          element_id: row.element_id
        };
      }
    }

    return { allowed: true };
  }

  function mountLockRoutes(app, getOperatorFn) {
    app.post('/api/boards/:id/locks', async (req, res) => {
      try {
        const boardId = req.params.id;
        const board = await dbGet('SELECT id FROM boards WHERE id = ?', [boardId]);
        if (!board) return res.status(404).json({ error: 'Board not found' });

        const { element_ids, operator, duration_sec } = req.body || {};
        if (!Array.isArray(element_ids) || element_ids.length === 0) {
          return res.status(400).json({ error: 'element_ids must be a non-empty array' });
        }
        if (!operator || typeof operator !== 'string') {
          return res.status(400).json({ error: 'operator is required' });
        }
        const duration = Number(duration_sec);
        if (isNaN(duration) || duration < MIN_DURATION || duration > MAX_DURATION) {
          return res.status(400).json({
            error: `duration_sec must be between ${MIN_DURATION} and ${MAX_DURATION}`
          });
        }

        await cleanupExpiredLocks(boardId);
        const result = await acquireLocks(boardId, element_ids, operator, duration);
        res.json(result);
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
      }
    });

    app.delete('/api/boards/:id/locks', async (req, res) => {
      try {
        const boardId = req.params.id;
        const board = await dbGet('SELECT id FROM boards WHERE id = ?', [boardId]);
        if (!board) return res.status(404).json({ error: 'Board not found' });

        const { element_ids, operator } = req.body || {};
        if (!Array.isArray(element_ids) || element_ids.length === 0) {
          return res.status(400).json({ error: 'element_ids must be a non-empty array' });
        }
        if (!operator || typeof operator !== 'string') {
          return res.status(400).json({ error: 'operator is required' });
        }

        const result = await releaseLocks(boardId, element_ids, operator);
        res.json(result);
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/boards/:id/locks', async (req, res) => {
      try {
        const boardId = req.params.id;
        const board = await dbGet('SELECT id FROM boards WHERE id = ?', [boardId]);
        if (!board) return res.status(404).json({ error: 'Board not found' });

        const result = await getLocks(boardId);
        res.json(result);
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
      }
    });
  }

  return {
    initTable,
    cleanupExpiredLocks,
    acquireLocks,
    releaseLocks,
    getLocks,
    checkOperationAllowed,
    checkStateSaveAllowed,
    mountLockRoutes
  };
}

module.exports = { createLocksModule, WRITE_OPS, MIN_DURATION, MAX_DURATION };
