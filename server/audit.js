const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

function md5Hash8(obj) {
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return crypto.createHash('md5').update(str).digest('hex').substring(0, 8);
}

function getElementTypes() {
  return ['pads', 'tracks', 'vias', 'copperPours'];
}

function elementTypeToField(type) {
  const map = {
    pad: 'pads',
    track: 'tracks',
    via: 'vias',
    copperPour: 'copperPours'
  };
  return map[type] || type;
}

function fieldToElementType(field) {
  const map = {
    pads: 'pad',
    tracks: 'track',
    vias: 'via',
    copperPours: 'copperPour'
  };
  return map[field] || field;
}

function computeStateDiff(beforeState, afterState) {
  const affected = [];
  const before = beforeState || {};
  const after = afterState || {};

  for (const field of getElementTypes()) {
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

    for (const [id, el] of afterMap) {
      if (!beforeMap.has(id)) {
        affected.push({ element_type: elementType, element_id: id, change: 'added' });
      } else {
        const beforeEl = beforeMap.get(id);
        if (JSON.stringify(beforeEl) !== JSON.stringify(el)) {
          affected.push({ element_type: elementType, element_id: id, change: 'modified' });
        }
      }
    }

    for (const [id] of beforeMap) {
      if (!afterMap.has(id)) {
        affected.push({ element_type: elementType, element_id: id, change: 'removed' });
      }
    }
  }

  return affected;
}

function extractAffectedElementsFromOp(op) {
  if (!op || !op.type) return [];
  const payload = op.payload || {};
  const affected = [];

  const addOps = {
    addPad: 'pad', addTrack: 'track', addVia: 'via', addCopperPour: 'copperPour'
  };
  const removeOps = {
    removePad: 'pad', removeTrack: 'track', removeVia: 'via', removeCopperPour: 'copperPour'
  };
  const updateOps = {
    updatePad: 'pad', updateTrack: 'track', updateVia: 'via', updateCopperPour: 'copperPour',
    movePad: 'pad', moveVia: 'via', setCopperPourVertex: 'copperPour'
  };

  if (addOps[op.type]) {
    const el = payload.pad || payload.track || payload.via || payload.pour;
    if (el && el.id != null) {
      affected.push({ element_type: addOps[op.type], element_id: String(el.id), change: 'added' });
    }
  } else if (removeOps[op.type]) {
    if (payload.id != null) {
      affected.push({ element_type: removeOps[op.type], element_id: String(payload.id), change: 'removed' });
    }
  } else if (updateOps[op.type]) {
    if (payload.id != null) {
      affected.push({ element_type: updateOps[op.type], element_id: String(payload.id), change: 'modified' });
    }
  } else if (op.type === 'setState') {
    return [];
  } else if (op.type === 'clearAll') {
    return [];
  }

  return affected;
}

function createAuditModule(db, deps) {
  const { dbRun, dbGet, dbAll } = deps;

  async function initTable() {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        log_id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        action_type TEXT NOT NULL,
        operator TEXT NOT NULL DEFAULT 'anonymous',
        affected_elements_json TEXT NOT NULL DEFAULT '[]',
        before_hash TEXT,
        after_hash TEXT,
        FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
      )
    `);
    await dbRun('CREATE INDEX IF NOT EXISTS idx_audit_board_time ON audit_logs(board_id, timestamp DESC)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_audit_board_action ON audit_logs(board_id, action_type)');
  }

  function recordAuditLog({ board_id, action_type, operator, before_state, after_state, affected_elements }) {
    const log_id = uuidv4().replace(/-/g, '');
    const timestamp = Date.now();
    const op = operator || 'anonymous';
    const before_hash = before_state != null ? md5Hash8(before_state) : null;
    const after_hash = after_state != null ? md5Hash8(after_state) : null;

    let elements = affected_elements || [];
    if (!Array.isArray(elements)) elements = [];
    if (elements.length === 0 && before_state && after_state) {
      elements = computeStateDiff(before_state, after_state);
    }

    const affected_elements_json = JSON.stringify(elements);

    setImmediate(async () => {
      try {
        await dbRun(
          `INSERT INTO audit_logs (log_id, board_id, timestamp, action_type, operator, affected_elements_json, before_hash, after_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [log_id, board_id, timestamp, action_type, op, affected_elements_json, before_hash, after_hash]
        );
      } catch (e) {
        console.error('Audit log write failed:', e.message);
      }
    });
  }

  function formatLogRow(row) {
    return {
      log_id: row.log_id,
      board_id: row.board_id,
      timestamp: row.timestamp,
      action_type: row.action_type,
      operator: row.operator,
      affected_elements: JSON.parse(row.affected_elements_json || '[]'),
      before_hash: row.before_hash,
      after_hash: row.after_hash
    };
  }

  function mountAuditRoutes(app) {
    app.get('/api/boards/:id/audit', async (req, res) => {
      try {
        const boardId = req.params.id;
        const { from, to, action, element_id, limit, offset } = req.query;

        const where = ['board_id = ?'];
        const params = [boardId];

        if (from !== undefined && from !== '') {
          const fromTs = parseInt(from);
          if (!isNaN(fromTs)) {
            where.push('timestamp >= ?');
            params.push(fromTs);
          }
        }
        if (to !== undefined && to !== '') {
          const toTs = parseInt(to);
          if (!isNaN(toTs)) {
            where.push('timestamp <= ?');
            params.push(toTs);
          }
        }
        if (action !== undefined && action !== '') {
          where.push('action_type = ?');
          params.push(action);
        }

        let elementFilterSql = '';
        let elementFilterParams = [];
        if (element_id !== undefined && element_id !== '') {
          elementFilterSql = "AND affected_elements_json LIKE ?";
          elementFilterParams.push(`%"element_id":"${element_id}"%`);
        }

        const whereSql = where.join(' AND ');

        const countRow = await dbGet(
          `SELECT COUNT(*) AS c FROM audit_logs WHERE ${whereSql} ${elementFilterSql}`,
          [...params, ...elementFilterParams]
        );
        const total = countRow?.c || 0;

        const limitVal = Math.min(parseInt(limit) || 50, 500);
        const offsetVal = parseInt(offset) || 0;

        const rows = await dbAll(
          `SELECT * FROM audit_logs WHERE ${whereSql} ${elementFilterSql}
           ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
          [...params, ...elementFilterParams, limitVal, offsetVal]
        );

        let logs = rows.map(formatLogRow);

        if (element_id !== undefined && element_id !== '') {
          logs = logs.filter(log =>
            log.affected_elements.some(e => String(e.element_id) === String(element_id))
          );
        }

        res.json({ total, logs });
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/boards/:id/audit/stats', async (req, res) => {
      try {
        const boardId = req.params.id;
        const { from, to } = req.query;

        const where = ['board_id = ?'];
        const params = [boardId];

        if (from !== undefined && from !== '') {
          const fromTs = parseInt(from);
          if (!isNaN(fromTs)) {
            where.push('timestamp >= ?');
            params.push(fromTs);
          }
        }
        if (to !== undefined && to !== '') {
          const toTs = parseInt(to);
          if (!isNaN(toTs)) {
            where.push('timestamp <= ?');
            params.push(toTs);
          }
        }

        const whereSql = where.join(' AND ');

        const actionRows = await dbAll(
          `SELECT action_type, COUNT(*) AS cnt FROM audit_logs WHERE ${whereSql} GROUP BY action_type`,
          params
        );
        const action_counts = {};
        for (const r of actionRows) action_counts[r.action_type] = r.cnt;

        const dailyRows = await dbAll(
          `SELECT DATE(timestamp/1000, 'unixepoch') AS date, COUNT(*) AS cnt
           FROM audit_logs WHERE ${whereSql}
           GROUP BY DATE(timestamp/1000, 'unixepoch')
           ORDER BY date ASC`,
          params
        );
        const daily_activity = dailyRows.map(r => ({ date: r.date, count: r.cnt }));

        const operatorRows = await dbAll(
          `SELECT operator, COUNT(*) AS cnt FROM audit_logs WHERE ${whereSql}
           GROUP BY operator ORDER BY cnt DESC LIMIT 5`,
          params
        );
        const top_operators = operatorRows.map(r => ({ operator: r.operator, count: r.cnt }));

        const allRows = await dbAll(
          `SELECT affected_elements_json FROM audit_logs WHERE ${whereSql}`,
          params
        );
        const elementCounts = new Map();
        for (const r of allRows) {
          const elements = JSON.parse(r.affected_elements_json || '[]');
          for (const e of elements) {
            const key = `${e.element_type}:${e.element_id}`;
            elementCounts.set(key, (elementCounts.get(key) || 0) + 1);
          }
        }
        const most_modified_elements = Array.from(elementCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([key, count]) => {
            const [element_type, element_id] = key.split(':');
            return { element_type, element_id, count };
          });

        res.json({
          action_counts,
          daily_activity,
          top_operators,
          most_modified_elements
        });
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
      }
    });
  }

  return {
    initTable,
    recordAuditLog,
    mountAuditRoutes,
    computeStateDiff,
    extractAffectedElementsFromOp,
    md5Hash8
  };
}

module.exports = { createAuditModule, computeStateDiff, extractAffectedElementsFromOp, md5Hash8 };
