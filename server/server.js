const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { mountBomRoutes } = require('./bom');
const { mountSimulationRoutes } = require('./simulation');
const { createAuditModule, extractAffectedElementsFromOp, computeStateDiff } = require('./audit');
const { createLocksModule } = require('./locks');
const { createTemplatesModule } = require('./templates');
const { createDiffModule } = require('./diff');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const MAX_VERSIONS = 50;
const AUTO_SAVE_INTERVAL = parseInt(process.env.AUTO_SAVE_INTERVAL || '30000');

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const boardClients = {};
const boardPendingOps = {};
const boardAutoSaveTimers = {};
const boardLatestState = {};
const boardLastOperator = {};

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'pcb.db');
const db = new sqlite3.Database(dbPath);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

const audit = createAuditModule(db, { dbRun, dbGet, dbAll });
const locks = createLocksModule(db, { dbRun, dbGet, dbAll, computeStateDiff });
const templates = createTemplatesModule(db, { dbRun, dbGet, dbAll, boardLatestState });
const diff = createDiffModule(db, { dbGet, dbAll, getLatestVersion, saveVersion, audit, getOperator, broadcast });

function getOperator(req) {
  return (req && req.headers && req.headers['x-operator']) || 'anonymous';
}

(async function bootstrap() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Untitled Board',
      created_at INTEGER NOT NULL
    )
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS board_versions (
      board_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      summary TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (board_id, version),
      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
    )
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS design_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      constraints_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS import_batches (
      batch_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS import_tasks (
      task_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      status TEXT NOT NULL,
      content TEXT,
      error TEXT,
      board_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES import_batches(batch_id) ON DELETE CASCADE
    )
  `);
  await audit.initTable();
  await locks.initTable();
  await templates.initTable();
  locks.mountLockRoutes(app, getOperator);
  templates.mountTemplatesRoutes(app);
  await initDemoBoard();
  await initDemoRules();
  await recoverImportTasks();
  startImportQueue();
  audit.mountAuditRoutes(app);
  diff.mountDiffRoutes(app);
  mountBomRoutes(app, { getLatestVersion });
  mountSimulationRoutes(app, { getLatestVersion });
  server.listen(PORT, () => {
    console.log(`PCB Editor server listening on port ${PORT}`);
  });
})().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});

function getDemoState() {
  let nextId = 1;
  const genId = () => nextId++;
  return {
    pads: [
      { id: genId(), type: 'pad', net: 'NET1', x: 15, y: 20, diameter: 1.6, hole: 0.8, layers: ['front', 'back'] },
      { id: genId(), type: 'pad', net: 'NET1', x: 85, y: 20, diameter: 1.6, hole: 0.8, layers: ['front', 'back'] },
      { id: genId(), type: 'pad', net: 'NET2', x: 15, y: 40, diameter: 1.6, hole: 0.8, layers: ['front', 'back'] },
      { id: genId(), type: 'pad', net: 'NET2', x: 85, y: 60, diameter: 1.6, hole: 0.8, layers: ['front', 'back'] },
      { id: genId(), type: 'pad', net: 'NET3', x: 15, y: 60, diameter: 1.6, hole: 0.8, layers: ['front', 'back'] },
      { id: genId(), type: 'pad', net: 'NET3', x: 50, y: 30, diameter: 1.6, hole: 0.8, layers: ['front', 'back'] }
    ],
    tracks: [
      {
        id: genId(), type: 'track', net: 'NET1', layer: 'front', width: 0.25,
        points: [
          { x: 15, y: 20 }, { x: 30, y: 20 }, { x: 45, y: 35 },
          { x: 70, y: 35 }, { x: 85, y: 20 }
        ]
      },
      {
        id: genId(), type: 'track', net: 'NET2', layer: 'front', width: 0.25,
        points: [{ x: 15, y: 40 }, { x: 40, y: 40 }, { x: 50, y: 50 }]
      },
      {
        id: genId(), type: 'track', net: 'NET2', layer: 'back', width: 0.25,
        points: [{ x: 50, y: 50 }, { x: 70, y: 50 }, { x: 85, y: 60 }]
      },
      {
        id: genId(), type: 'track', net: 'NET3', layer: 'front', width: 0.25,
        points: [
          { x: 15, y: 60 }, { x: 25, y: 60 }, { x: 40, y: 45 },
          { x: 50, y: 45 }, { x: 50, y: 32 }
        ]
      },
      {
        id: genId(), type: 'track', net: 'NET1', layer: 'front', width: 0.25,
        points: [{ x: 30, y: 35.1 }, { x: 65, y: 35.1 }]
      }
    ],
    vias: [
      { id: genId(), type: 'via', net: 'NET2', x: 50, y: 50, diameter: 0.6, hole: 0.3, layers: ['front', 'back'] }
    ],
    copperPours: [
      {
        id: genId(), type: 'copperPour', net: 'NET1', layer: 'front', clearance: 0.3,
        points: [
          { x: 50, y: 5 }, { x: 95, y: 5 }, { x: 95, y: 75 }, { x: 50, y: 75 }
        ]
      }
    ],
    nextId: nextId
  };
}

async function initDemoBoard() {
  const existing = await dbGet('SELECT id FROM boards WHERE id = ?', ['demo']);
  if (existing) return;
  const now = Date.now();
  await dbRun('INSERT INTO boards (id, name, created_at) VALUES (?, ?, ?)', ['demo', 'Demo Board', now]);
  const demoState = getDemoState();
  await dbRun(
    'INSERT INTO board_versions (board_id, version, state_json, summary, created_at) VALUES (?, ?, ?, ?, ?)',
    ['demo', 1, JSON.stringify(demoState), 'Initial demo board', now]
  );
  boardLatestState['demo'] = { version: 1, state: demoState };
}

async function getLatestVersion(boardId) {
  if (boardLatestState[boardId]) return boardLatestState[boardId];
  const row = await dbGet(
    'SELECT version, state_json FROM board_versions WHERE board_id = ? ORDER BY version DESC LIMIT 1',
    [boardId]
  );
  if (!row) return null;
  const result = { version: row.version, state: JSON.parse(row.state_json) };
  boardLatestState[boardId] = result;
  return result;
}

async function saveVersion(boardId, state, summary) {
  const latestRow = await dbGet(
    'SELECT COALESCE(MAX(version), 0) AS v FROM board_versions WHERE board_id = ?',
    [boardId]
  );
  const newVersion = (latestRow?.v || 0) + 1;
  const now = Date.now();
  await dbRun(
    'INSERT INTO board_versions (board_id, version, state_json, summary, created_at) VALUES (?, ?, ?, ?, ?)',
    [boardId, newVersion, JSON.stringify(state), summary || `Version ${newVersion}`, now]
  );
  boardLatestState[boardId] = { version: newVersion, state };

  const countRow = await dbGet('SELECT COUNT(*) AS c FROM board_versions WHERE board_id = ?', [boardId]);
  if (countRow.c > MAX_VERSIONS) {
    const toDelete = countRow.c - MAX_VERSIONS;
    await dbRun(
      `DELETE FROM board_versions WHERE board_id = ? AND version IN (
        SELECT version FROM board_versions WHERE board_id = ? ORDER BY version ASC LIMIT ?
      )`,
      [boardId, boardId, toDelete]
    );
  }
  return newVersion;
}

async function getLastPersistedState(boardId) {
  const row = await dbGet(
    'SELECT state_json FROM board_versions WHERE board_id = ? ORDER BY version DESC LIMIT 1',
    [boardId]
  );
  return row ? JSON.parse(row.state_json) : null;
}

function scheduleAutoSave(boardId) {
  if (boardAutoSaveTimers[boardId]) return;
  boardAutoSaveTimers[boardId] = setTimeout(async () => {
    delete boardAutoSaveTimers[boardId];
    const ops = boardPendingOps[boardId];
    if (ops && ops.length > 0) {
      const beforeState = await getLastPersistedState(boardId);
      const latest = boardLatestState[boardId];
      if (latest) {
        const summary = ops.length > 1
          ? `${ops.length} operations`
          : describeOperation(ops[0]);
        const afterState = latest.state;
        await saveVersion(boardId, afterState, summary);
        audit.recordAuditLog({
          board_id: boardId,
          action_type: 'save',
          operator: boardLastOperator[boardId] || 'anonymous',
          before_state: beforeState,
          after_state: afterState
        });
      }
    }
    boardPendingOps[boardId] = [];
  }, AUTO_SAVE_INTERVAL);
}

function describeOperation(op) {
  if (!op) return 'save';
  const t = op.type || 'op';
  const typeMap = {
    addPad: 'Add pad', removePad: 'Remove pad', updatePad: 'Update pad', movePad: 'Move pad',
    addTrack: 'Add track', removeTrack: 'Remove track', updateTrack: 'Update track',
    addVia: 'Add via', removeVia: 'Remove via', updateVia: 'Update via', moveVia: 'Move via',
    addCopperPour: 'Add copper pour', removeCopperPour: 'Remove copper pour',
    updateCopperPour: 'Update copper pour', setCopperPourVertex: 'Edit copper pour',
    clearAll: 'Clear board', setState: 'Update state'
  };
  return typeMap[t] || t;
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function isTrackConnectedToPadLocal(track, padId, pads) {
  const pad = pads.find(p => p.id === padId);
  if (!pad) return false;
  if (track.points.length < 2) return false;
  const start = track.points[0];
  const end = track.points[track.points.length - 1];
  const tol = pad.diameter / 2 + 0.1;
  return dist(start, pad) <= tol || dist(end, pad) <= tol;
}

function applyOperationToState(state, op) {
  if (!op || !op.type) return state;
  switch (op.type) {
    case 'setState':
      return JSON.parse(JSON.stringify(op.payload.state));
    case 'clearAll':
      return { pads: [], tracks: [], vias: [], copperPours: [], nextId: state.nextId || 1 };
    case 'addPad':
      if (op.payload.pad) state.pads.push(JSON.parse(JSON.stringify(op.payload.pad)));
      return state;
    case 'updatePad': {
        const pad = state.pads.find(p => p.id === op.payload.id);
        if (pad) Object.assign(pad, op.payload.updates);
        return state;
      }
    case 'removePad': {
        const idx = state.pads.findIndex(p => p.id === op.payload.id);
        if (idx >= 0) state.pads.splice(idx, 1);
        state.tracks = state.tracks.filter(t => !isTrackConnectedToPadLocal(t, op.payload.id, state.pads));
        return state;
      }
    case 'movePad': {
        const pad = state.pads.find(p => p.id === op.payload.id);
        if (pad) {
          const dx = op.payload.newPosition.x - pad.x;
          const dy = op.payload.newPosition.y - pad.y;
          pad.x = op.payload.newPosition.x;
          pad.y = op.payload.newPosition.y;
          for (const track of state.tracks) {
            if (track.points.length < 1) continue;
            const start = track.points[0];
            const end = track.points[track.points.length - 1];
            const tol = pad.diameter / 2 + 0.1;
            if (dist(start, { x: pad.x - dx, y: pad.y - dy }) <= tol) {
              start.x = pad.x;
              start.y = pad.y;
            }
            if (dist(end, { x: pad.x - dx, y: pad.y - dy }) <= tol) {
              end.x = pad.x;
              end.y = pad.y;
            }
          }
        }
        return state;
      }
    case 'addTrack':
      if (op.payload.track) state.tracks.push(JSON.parse(JSON.stringify(op.payload.track)));
      return state;
    case 'updateTrack': {
        const track = state.tracks.find(t => t.id === op.payload.id);
        if (track) {
          Object.assign(track, op.payload.updates);
          if (op.payload.updates && op.payload.updates.points) {
            track.points = op.payload.updates.points.map(p => ({ x: p.x, y: p.y }));
          }
        }
        return state;
      }
    case 'removeTrack': {
        const idx = state.tracks.findIndex(t => t.id === op.payload.id);
        if (idx >= 0) state.tracks.splice(idx, 1);
        return state;
      }
    case 'addVia':
      if (op.payload.via) state.vias.push(JSON.parse(JSON.stringify(op.payload.via)));
      return state;
    case 'updateVia': {
        const via = state.vias.find(v => v.id === op.payload.id);
        if (via) Object.assign(via, op.payload.updates);
        return state;
      }
    case 'removeVia': {
        const idx = state.vias.findIndex(v => v.id === op.payload.id);
        if (idx >= 0) state.vias.splice(idx, 1);
        return state;
      }
    case 'moveVia': {
        const via = state.vias.find(v => v.id === op.payload.id);
        if (via) {
          const dx = op.payload.newPosition.x - via.x;
          const dy = op.payload.newPosition.y - via.y;
          via.x = op.payload.newPosition.x;
          via.y = op.payload.newPosition.y;
          for (const track of state.tracks) {
            if (track.points.length < 1) continue;
            const start = track.points[0];
            const end = track.points[track.points.length - 1];
            const tol = via.diameter / 2 + 0.1;
            if (dist(start, { x: via.x - dx, y: via.y - dy }) <= tol) {
              start.x = via.x;
              start.y = via.y;
            }
            if (dist(end, { x: via.x - dx, y: via.y - dy }) <= tol) {
              end.x = via.x;
              end.y = via.y;
            }
          }
        }
        return state;
      }
    case 'addCopperPour':
      if (op.payload.pour) state.copperPours.push(JSON.parse(JSON.stringify(op.payload.pour)));
      return state;
    case 'updateCopperPour': {
        const pour = state.copperPours.find(p => p.id === op.payload.id);
        if (pour) {
          Object.assign(pour, op.payload.updates);
          if (op.payload.updates && op.payload.updates.points) {
            pour.points = op.payload.updates.points.map(p => ({ x: p.x, y: p.y }));
          }
        }
        return state;
      }
    case 'removeCopperPour': {
        const idx = state.copperPours.findIndex(p => p.id === op.payload.id);
        if (idx >= 0) state.copperPours.splice(idx, 1);
        return state;
      }
    case 'setCopperPourVertex': {
        const pour = state.copperPours.find(p => p.id === op.payload.id);
        if (pour && op.payload.vertexIndex >= 0 && op.payload.vertexIndex < pour.points.length) {
          pour.points[op.payload.vertexIndex] = { x: op.payload.newPosition.x, y: op.payload.newPosition.y };
        }
        return state;
      }
  }
  return state;
}

async function ensureBoardState(boardId) {
  if (boardLatestState[boardId]) return boardLatestState[boardId];
  const latest = await getLatestVersion(boardId);
  if (latest) {
    boardLatestState[boardId] = latest;
    return latest;
  }
  return null;
}

function accumulateOp(boardId, op) {
  if (!boardPendingOps[boardId]) boardPendingOps[boardId] = [];
  boardPendingOps[boardId].push(op);
  if (boardLatestState[boardId]) {
    boardLatestState[boardId].state = applyOperationToState(boardLatestState[boardId].state, op);
  }
  scheduleAutoSave(boardId);
}

function broadcast(boardId, message, excludeWs) {
  const clients = boardClients[boardId] || [];
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function broadcastOnlineCount(boardId) {
  const count = (boardClients[boardId] || []).length;
  broadcast(boardId, { type: 'onlineCount', payload: { count } });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/boards', async (req, res) => {
  try {
    const id = uuidv4().replace(/-/g, '').substring(0, 12);
    const name = req.body?.name || 'New Board';
    const now = Date.now();
    const initialState = { pads: [], tracks: [], vias: [], copperPours: [], nextId: 1 };
    await dbRun('INSERT INTO boards (id, name, created_at) VALUES (?, ?, ?)', [id, name, now]);
    await dbRun(
      'INSERT INTO board_versions (board_id, version, state_json, summary, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, 1, JSON.stringify(initialState), 'Create board', now]
    );
    boardLatestState[id] = { version: 1, state: initialState };
    res.json({ board_id: id, name, created_at: now });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/boards/:id', async (req, res) => {
  try {
    const board = await dbGet('SELECT id, name, created_at FROM boards WHERE id = ?', [req.params.id]);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const latest = await getLatestVersion(req.params.id);
    if (!latest) return res.status(404).json({ error: 'No version found' });
    res.json({
      id: board.id,
      name: board.name,
      created_at: board.created_at,
      version: latest.version,
      state: latest.state
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/boards/:id', async (req, res) => {
  try {
    const board = await dbGet('SELECT id FROM boards WHERE id = ?', [req.params.id]);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const state = req.body?.state;
    if (!state) return res.status(400).json({ error: 'state is required' });
    const summary = req.body?.summary || 'Manual save';
    const latest = await getLatestVersion(req.params.id);
    const beforeState = latest ? latest.state : null;
    const operator = getOperator(req);

    const lockCheck = await locks.checkStateSaveAllowed(
      req.params.id, beforeState, state, operator
    );
    if (!lockCheck.allowed) {
      return res.status(403).json({
        error: lockCheck.error,
        locked_by: lockCheck.locked_by,
        element_id: lockCheck.element_id
      });
    }

    const version = await saveVersion(req.params.id, state, summary);
    audit.recordAuditLog({
      board_id: req.params.id,
      action_type: 'save',
      operator: operator,
      before_state: beforeState,
      after_state: state
    });
    res.json({ version });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/boards/:id/versions', async (req, res) => {
  try {
    const rows = await dbAll(
      'SELECT version, summary, created_at FROM board_versions WHERE board_id = ? ORDER BY version DESC',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/boards/:id/versions/:ver', async (req, res) => {
  try {
    const ver = parseInt(req.params.ver);
    const row = await dbGet(
      `SELECT v.version, v.state_json, v.summary, v.created_at, b.name
       FROM board_versions v JOIN boards b ON v.board_id = b.id
       WHERE v.board_id = ? AND v.version = ?`,
      [req.params.id, ver]
    );
    if (!row) return res.status(404).json({ error: 'Version not found' });
    res.json({
      version: row.version,
      name: row.name,
      summary: row.summary,
      created_at: row.created_at,
      state: JSON.parse(row.state_json)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/boards/:id/revert/:ver', async (req, res) => {
  try {
    const ver = parseInt(req.params.ver);
    const target = await dbGet(
      'SELECT state_json FROM board_versions WHERE board_id = ? AND version = ?',
      [req.params.id, ver]
    );
    if (!target) return res.status(404).json({ error: 'Version not found' });
    const state = JSON.parse(target.state_json);
    const latest = await getLatestVersion(req.params.id);
    const beforeState = latest ? latest.state : null;
    const newVersion = await saveVersion(req.params.id, state, `Revert to version ${ver}`);
    audit.recordAuditLog({
      board_id: req.params.id,
      action_type: 'revert',
      operator: getOperator(req),
      before_state: beforeState,
      after_state: state
    });
    broadcast(req.params.id, { type: 'revert', payload: { version: newVersion, state } });
    res.json({ version: newVersion });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const boardId = url.searchParams.get('board_id');
  const wsOperator = url.searchParams.get('operator')
    || (req.headers && req.headers['x-operator'])
    || 'anonymous';

  if (!boardId) {
    ws.close(4000, 'board_id required');
    return;
  }

  try {
    const board = await dbGet('SELECT id FROM boards WHERE id = ?', [boardId]);
    if (!board) {
      ws.close(4004, 'Board not found');
      return;
    }
  } catch (e) {
    ws.close(5000, 'Internal error');
    return;
  }

  if (!boardClients[boardId]) boardClients[boardId] = [];
  boardClients[boardId].push(ws);
  ws.boardId = boardId;
  ws.operator = wsOperator;

  try {
    const latest = await getLatestVersion(boardId);
    if (latest) {
      ws.send(JSON.stringify({ type: 'fullState', payload: { version: latest.version, state: latest.state } }));
    }
    ws.send(JSON.stringify({ type: 'onlineCount', payload: { count: boardClients[boardId].length } }));
    broadcastOnlineCount(boardId);
  } catch (e) {
    console.error(e);
  }

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'operation') {
      await ensureBoardState(boardId);
      const op = msg.payload;
      const beforeState = boardLatestState[boardId]
        ? JSON.parse(JSON.stringify(boardLatestState[boardId].state))
        : null;

      let tempAfterState = null;
      if (beforeState && (op.type === 'setState' || op.type === 'clearAll')) {
        tempAfterState = applyOperationToState(JSON.parse(JSON.stringify(beforeState)), op);
      }

      const lockCheck = await locks.checkOperationAllowed(
        boardId, op, ws.operator, beforeState, tempAfterState
      );
      if (!lockCheck.allowed) {
        ws.send(JSON.stringify({
          type: 'reject',
          payload: {
            error: lockCheck.error,
            locked_by: lockCheck.locked_by,
            element_id: lockCheck.element_id
          }
        }));
        return;
      }

      accumulateOp(boardId, op);
      const afterState = boardLatestState[boardId]
        ? boardLatestState[boardId].state
        : null;

      let affected = extractAffectedElementsFromOp(op);
      if (affected.length === 0 && beforeState && afterState) {
        affected = computeStateDiff(beforeState, afterState);
      }

      audit.recordAuditLog({
        board_id: boardId,
        action_type: 'operation',
        operator: ws.operator,
        before_state: beforeState,
        after_state: afterState,
        affected_elements: affected
      });

      boardLastOperator[boardId] = ws.operator;
      broadcast(boardId, { type: 'operation', payload: msg.payload, from: 'server' }, ws);
    }
  });

  ws.on('close', async () => {
    const arr = boardClients[boardId];
    if (arr) {
      const i = arr.indexOf(ws);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) {
        delete boardClients[boardId];
        if (boardAutoSaveTimers[boardId]) {
          clearTimeout(boardAutoSaveTimers[boardId]);
          delete boardAutoSaveTimers[boardId];
        }
        if (boardPendingOps[boardId] && boardPendingOps[boardId].length > 0) {
          try {
            const beforeState = await getLastPersistedState(boardId);
            const latest = boardLatestState[boardId];
            if (latest) {
              const ops = boardPendingOps[boardId];
              const summary = ops.length > 1
                ? `${ops.length} operations`
                : describeOperation(ops[0]);
              const afterState = latest.state;
              await saveVersion(boardId, afterState, summary);
              audit.recordAuditLog({
                board_id: boardId,
                action_type: 'save',
                operator: boardLastOperator[boardId] || 'anonymous',
                before_state: beforeState,
                after_state: afterState
              });
            }
          } catch (e) {
            console.error('Auto-save on close failed:', e);
          }
        }
        delete boardPendingOps[boardId];
        delete boardLatestState[boardId];
        delete boardLastOperator[boardId];
      }
    }
    broadcastOnlineCount(boardId);
  });
});

const VALID_CONSTRAINT_TYPES = ['clearance', 'track_width', 'hole_size', 'pad_size'];
const VALID_LAYERS = ['front', 'back', 'both'];

function validateConstraint(c) {
  if (!c || typeof c !== 'object') return 'constraint must be an object';
  if (!VALID_CONSTRAINT_TYPES.includes(c.type)) return `invalid constraint type: ${c.type}, must be one of ${VALID_CONSTRAINT_TYPES.join(', ')}`;
  if (!VALID_LAYERS.includes(c.layer)) return `invalid layer: ${c.layer}, must be one of ${VALID_LAYERS.join(', ')}`;
  if (c.min === undefined || c.min === null || typeof c.min !== 'number') return 'min must be a number';
  if (c.max !== undefined && c.max !== null && typeof c.max !== 'number') return 'max must be a number or null';
  if (c.max !== undefined && c.max !== null && c.min > c.max) return 'min cannot be greater than max';
  return null;
}

function validateConstraints(constraints) {
  if (!Array.isArray(constraints)) return 'constraints must be an array';
  const seen = new Set();
  for (let i = 0; i < constraints.length; i++) {
    const err = validateConstraint(constraints[i]);
    if (err) return `constraints[${i}]: ${err}`;
    const key = `${constraints[i].type}:${constraints[i].layer}`;
    if (seen.has(key)) return `duplicate constraint: type=${constraints[i].type}, layer=${constraints[i].layer}`;
    seen.add(key);
  }
  return null;
}

function formatRuleRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    constraints: JSON.parse(row.constraints_json),
    created_at: row.created_at
  };
}

async function initDemoRules() {
  const countRow = await dbGet('SELECT COUNT(*) AS c FROM design_rules');
  if (countRow.c > 0) return;
  const now = Date.now();

  const relaxedConstraints = [
    { type: 'clearance', layer: 'both', min: 0.15, max: null },
    { type: 'track_width', layer: 'both', min: 0.1, max: 2.0 }
  ];
  await dbRun(
    'INSERT INTO design_rules (id, name, description, constraints_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ['relaxed', '宽松', '宽松的设计规则', JSON.stringify(relaxedConstraints), now]
  );

  const strictConstraints = [
    { type: 'clearance', layer: 'both', min: 0.3, max: null },
    { type: 'track_width', layer: 'both', min: 0.2, max: 1.0 },
    { type: 'hole_size', layer: 'both', min: 0.3, max: 1.5 }
  ];
  await dbRun(
    'INSERT INTO design_rules (id, name, description, constraints_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ['strict', '严格', '严格的设计规则', JSON.stringify(strictConstraints), now]
  );
}

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

function segmentToSegmentDist(a1, a2, b1, b2) {
  const d1 = pointToSegmentDist(a1, b1, b2);
  const d2 = pointToSegmentDist(a2, b1, b2);
  const d3 = pointToSegmentDist(b1, a1, a2);
  const d4 = pointToSegmentDist(b2, a1, a2);
  return Math.min(d1, d2, d3, d4);
}

function circleCircleDist(c1, c2) {
  return pointDist(c1.center, c2.center) - c1.radius - c2.radius;
}

function circleSegmentDist(circle, segStart, segEnd, halfWidth) {
  return pointToSegmentDist(circle.center, segStart, segEnd) - circle.radius - halfWidth;
}

function collectLayerElementsWithShape(state, layer) {
  const elements = [];
  for (const pad of state.pads || []) {
    if (pad.layers && pad.layers.includes(layer)) {
      elements.push({
        id: pad.id,
        type: 'pad',
        net: pad.net,
        layer,
        shape: { type: 'circle', center: { x: pad.x, y: pad.y }, radius: pad.diameter / 2 },
        diameter: pad.diameter,
        hole: pad.hole
      });
    }
  }
  for (const via of state.vias || []) {
    if (via.layers && via.layers.includes(layer)) {
      elements.push({
        id: via.id,
        type: 'via',
        net: via.net,
        layer,
        shape: { type: 'circle', center: { x: via.x, y: via.y }, radius: via.diameter / 2 },
        diameter: via.diameter,
        hole: via.hole
      });
    }
  }
  for (const track of state.tracks || []) {
    if (track.layer !== layer) continue;
    for (let i = 0; i < track.points.length - 1; i++) {
      elements.push({
        id: track.id,
        type: 'track',
        net: track.net,
        layer,
        shape: {
          type: 'segment',
          start: track.points[i],
          end: track.points[i + 1],
          halfWidth: track.width / 2
        },
        width: track.width,
        segmentIndex: i
      });
    }
  }
  for (const pour of state.copperPours || []) {
    if (pour.layer !== layer) continue;
    elements.push({
      id: pour.id,
      type: 'copperPour',
      net: pour.net,
      layer,
      shape: { type: 'polygon', points: pour.points, clearance: pour.clearance },
      clearance: pour.clearance
    });
  }
  return elements;
}

function computeShapeClearance(s1, s2) {
  if (s1.type === 'circle' && s2.type === 'circle') {
    return circleCircleDist(s1, s2);
  }
  if (s1.type === 'circle' && s2.type === 'segment') {
    return circleSegmentDist(s1, s2.start, s2.end, s2.halfWidth);
  }
  if (s1.type === 'segment' && s2.type === 'circle') {
    return circleSegmentDist(s2, s1.start, s1.end, s1.halfWidth);
  }
  if (s1.type === 'segment' && s2.type === 'segment') {
    return segmentToSegmentDist(s1.start, s1.end, s2.start, s2.end) - s1.halfWidth - s2.halfWidth;
  }
  return Infinity;
}

function computeSeverity(actual, min, max) {
  let deviation = 0;
  if (min !== null && min !== undefined && actual < min) {
    deviation = Math.abs(min - actual) / min;
  } else if (max !== null && max !== undefined && actual > max) {
    deviation = Math.abs(actual - max) / max;
  }
  return deviation > 0.2 ? 'error' : 'warning';
}

function checkClearance(state, constraint) {
  const violations = [];
  const layersToCheck = constraint.layer === 'both' ? ['front', 'back'] : [constraint.layer];
  for (const layer of layersToCheck) {
    const elements = collectLayerElementsWithShape(state, layer);
    for (let i = 0; i < elements.length; i++) {
      for (let j = i + 1; j < elements.length; j++) {
        const e1 = elements[i];
        const e2 = elements[j];
        if (e1.net === e2.net) continue;
        if (e1.type === 'track' && e2.type === 'track' && e1.id === e2.id) continue;
        const actual = computeShapeClearance(e1.shape, e2.shape);
        if (actual < constraint.min) {
          violations.push({
            constraint_type: 'clearance',
            layer,
            element_id: `${e1.type}_${e1.id}_${e2.type}_${e2.id}`,
            element_type: `${e1.type}-${e2.type}`,
            actual_value: Number(actual.toFixed(4)),
            required_min: constraint.min,
            required_max: constraint.max,
            severity: computeSeverity(actual, constraint.min, constraint.max)
          });
        }
      }
    }
  }
  return violations;
}

function checkTrackWidth(state, constraint) {
  const violations = [];
  const layersToCheck = constraint.layer === 'both' ? ['front', 'back'] : [constraint.layer];
  const seen = new Set();
  for (const track of state.tracks || []) {
    if (!layersToCheck.includes(track.layer)) continue;
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    const w = track.width;
    const belowMin = w < constraint.min;
    const aboveMax = constraint.max !== null && constraint.max !== undefined && w > constraint.max;
    if (belowMin || aboveMax) {
      violations.push({
        constraint_type: 'track_width',
        layer: track.layer,
        element_id: `track_${track.id}`,
        element_type: 'track',
        actual_value: w,
        required_min: constraint.min,
        required_max: constraint.max,
        severity: computeSeverity(w, constraint.min, constraint.max)
      });
    }
  }
  return violations;
}

function checkHoleSize(state, constraint) {
  const violations = [];
  const layersToCheck = constraint.layer === 'both' ? ['front', 'back'] : [constraint.layer];
  for (const pad of state.pads || []) {
    if (!pad.layers || !pad.layers.some(l => layersToCheck.includes(l))) continue;
    const h = pad.hole;
    const belowMin = h < constraint.min;
    const aboveMax = constraint.max !== null && constraint.max !== undefined && h > constraint.max;
    if (belowMin || aboveMax) {
      violations.push({
        constraint_type: 'hole_size',
        layer: pad.layers.length > 1 ? 'both' : pad.layers[0],
        element_id: `pad_${pad.id}`,
        element_type: 'pad',
        actual_value: h,
        required_min: constraint.min,
        required_max: constraint.max,
        severity: computeSeverity(h, constraint.min, constraint.max)
      });
    }
  }
  for (const via of state.vias || []) {
    if (!via.layers || !via.layers.some(l => layersToCheck.includes(l))) continue;
    const h = via.hole;
    const belowMin = h < constraint.min;
    const aboveMax = constraint.max !== null && constraint.max !== undefined && h > constraint.max;
    if (belowMin || aboveMax) {
      violations.push({
        constraint_type: 'hole_size',
        layer: via.layers.length > 1 ? 'both' : via.layers[0],
        element_id: `via_${via.id}`,
        element_type: 'via',
        actual_value: h,
        required_min: constraint.min,
        required_max: constraint.max,
        severity: computeSeverity(h, constraint.min, constraint.max)
      });
    }
  }
  return violations;
}

function checkPadSize(state, constraint) {
  const violations = [];
  const layersToCheck = constraint.layer === 'both' ? ['front', 'back'] : [constraint.layer];
  for (const pad of state.pads || []) {
    if (!pad.layers || !pad.layers.some(l => layersToCheck.includes(l))) continue;
    const d = pad.diameter;
    const belowMin = d < constraint.min;
    const aboveMax = constraint.max !== null && constraint.max !== undefined && d > constraint.max;
    if (belowMin || aboveMax) {
      violations.push({
        constraint_type: 'pad_size',
        layer: pad.layers.length > 1 ? 'both' : pad.layers[0],
        element_id: `pad_${pad.id}`,
        element_type: 'pad',
        actual_value: d,
        required_min: constraint.min,
        required_max: constraint.max,
        severity: computeSeverity(d, constraint.min, constraint.max)
      });
    }
  }
  return violations;
}

function runDRC(state, constraints) {
  const allViolations = [];
  for (const c of constraints) {
    let violations = [];
    switch (c.type) {
      case 'clearance':
        violations = checkClearance(state, c);
        break;
      case 'track_width':
        violations = checkTrackWidth(state, c);
        break;
      case 'hole_size':
        violations = checkHoleSize(state, c);
        break;
      case 'pad_size':
        violations = checkPadSize(state, c);
        break;
    }
    allViolations.push(...violations);
  }
  return allViolations;
}

app.post('/api/rules', async (req, res) => {
  try {
    const { name, description, constraints } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    const err = validateConstraints(constraints);
    if (err) return res.status(400).json({ error: err });
    const id = uuidv4().replace(/-/g, '').substring(0, 12);
    const now = Date.now();
    await dbRun(
      'INSERT INTO design_rules (id, name, description, constraints_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, name, description || '', JSON.stringify(constraints), now]
    );
    const row = await dbGet('SELECT * FROM design_rules WHERE id = ?', [id]);
    res.status(201).json(formatRuleRow(row));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/rules', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM design_rules ORDER BY created_at DESC');
    res.json(rows.map(formatRuleRow));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/rules/:id', async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM design_rules WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Rule template not found' });
    res.json(formatRuleRow(row));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/rules/:id', async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM design_rules WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Rule template not found' });
    const { name, description, constraints } = req.body || {};
    let finalName = existing.name;
    let finalDescription = existing.description;
    let finalConstraints = JSON.parse(existing.constraints_json);
    if (name !== undefined) {
      if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'name must be a non-empty string' });
      finalName = name;
    }
    if (description !== undefined) {
      finalDescription = description;
    }
    if (constraints !== undefined) {
      const err = validateConstraints(constraints);
      if (err) return res.status(400).json({ error: err });
      finalConstraints = constraints;
    }
    await dbRun(
      'UPDATE design_rules SET name = ?, description = ?, constraints_json = ? WHERE id = ?',
      [finalName, finalDescription, JSON.stringify(finalConstraints), req.params.id]
    );
    const row = await dbGet('SELECT * FROM design_rules WHERE id = ?', [req.params.id]);
    res.json(formatRuleRow(row));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/rules/:id', async (req, res) => {
  try {
    const existing = await dbGet('SELECT id FROM design_rules WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Rule template not found' });
    await dbRun('DELETE FROM design_rules WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/boards/:boardId/check', async (req, res) => {
  try {
    const { rules_id } = req.body || {};
    if (!rules_id) return res.status(400).json({ error: 'rules_id is required' });
    const ruleRow = await dbGet('SELECT * FROM design_rules WHERE id = ?', [rules_id]);
    if (!ruleRow) return res.status(404).json({ error: 'Rule template not found' });
    const board = await dbGet('SELECT id FROM boards WHERE id = ?', [req.params.boardId]);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const latest = await getLatestVersion(req.params.boardId);
    if (!latest) return res.status(404).json({ error: 'No board state found' });
    const constraints = JSON.parse(ruleRow.constraints_json);
    const violations = runDRC(latest.state, constraints);
    res.json({
      rules_id,
      rules_name: ruleRow.name,
      violations
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/boards/:boardId/compare', async (req, res) => {
  try {
    const { rules_ids } = req.body || {};
    if (!Array.isArray(rules_ids)) return res.status(400).json({ error: 'rules_ids must be an array' });
    if (rules_ids.length < 2 || rules_ids.length > 5) {
      return res.status(400).json({ error: 'rules_ids must contain 2-5 rule template IDs' });
    }
    const uniqueIds = [...new Set(rules_ids)];
    if (uniqueIds.length !== rules_ids.length) {
      return res.status(400).json({ error: 'rules_ids must contain unique IDs' });
    }
    const board = await dbGet('SELECT id FROM boards WHERE id = ?', [req.params.boardId]);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const latest = await getLatestVersion(req.params.boardId);
    if (!latest) return res.status(404).json({ error: 'No board state found' });

    const rules = [];
    for (const id of rules_ids) {
      const row = await dbGet('SELECT * FROM design_rules WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ error: `Rule template not found: ${id}` });
      rules.push(row);
    }

    const results = [];
    const elementViolationsMap = {};

    for (const rule of rules) {
      const constraints = JSON.parse(rule.constraints_json);
      const violations = runDRC(latest.state, constraints);
      const errors = violations.filter(v => v.severity === 'error').length;
      const warnings = violations.filter(v => v.severity === 'warning').length;
      results.push({
        rules_id: rule.id,
        rules_name: rule.name,
        violation_count: violations.length,
        errors,
        warnings
      });
      for (const v of violations) {
        if (!elementViolationsMap[v.element_id]) {
          elementViolationsMap[v.element_id] = new Set();
        }
        elementViolationsMap[v.element_id].add(rule.id);
      }
    }

    const allRuleIds = rules_ids;
    const diff = [];
    for (const [elementId, failingRuleIds] of Object.entries(elementViolationsMap)) {
      const failing = [...failingRuleIds];
      const passing = allRuleIds.filter(id => !failingRuleIds.has(id));
      if (passing.length > 0 && failing.length > 0) {
        diff.push({
          element_id: elementId,
          passes_in: passing,
          fails_in: failing
        });
      }
    }

    res.json({ results, diff });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const MAX_FILES_PER_BATCH = 10;
const MAX_FILE_SIZE_BYTES = 500 * 1024;
const PROCESS_INTERVAL_MS = 500;

const importQueue = [];
let isProcessing = false;
let queueTimer = null;

function parseSExpression(text) {
  let pos = 0;
  const len = text.length;

  function skipWhitespace() {
    while (pos < len && /\s/.test(text[pos])) pos++;
  }

  function parseAtom() {
    const start = pos;
    while (pos < len && !/\s|\(|\)/.test(text[pos])) pos++;
    if (pos === start) throw new Error('Expected atom');
    const raw = text.substring(start, pos);
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      return raw.substring(1, raw.length - 1);
    }
    const num = Number(raw);
    if (!isNaN(num) && raw.trim() !== '') return num;
    return raw;
  }

  function parseList() {
    if (text[pos] !== '(') throw new Error('Expected (');
    pos++;
    const items = [];
    while (true) {
      skipWhitespace();
      if (pos >= len) throw new Error('Unclosed parenthesis');
      if (text[pos] === ')') {
        pos++;
        return items;
      }
      if (text[pos] === '(') {
        items.push(parseList());
      } else {
        items.push(parseAtom());
      }
    }
  }

  skipWhitespace();
  if (pos >= len) throw new Error('Empty input');
  if (text[pos] !== '(') throw new Error('Expected top-level (');
  const result = parseList();
  skipWhitespace();
  if (pos < len) throw new Error('Unexpected trailing content');
  return result;
}

function findAll(expr, tagName) {
  const results = [];
  if (!Array.isArray(expr)) return results;
  for (const item of expr) {
    if (Array.isArray(item) && item.length > 0 && item[0] === tagName) {
      results.push(item);
    }
    if (Array.isArray(item)) {
      results.push(...findAll(item, tagName));
    }
  }
  return results;
}

function findInList(list, tagName) {
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    if (Array.isArray(item) && item.length > 0 && item[0] === tagName) {
      return item;
    }
  }
  return null;
}

function getAtCoord(expr) {
  const at = findInList(expr, 'at');
  if (!at || at.length < 3) throw new Error('Missing (at x y)');
  return { x: Number(at[1]), y: Number(at[2]) };
}

function getSize(expr) {
  const sz = findInList(expr, 'size');
  if (!sz || sz.length < 3) throw new Error('Missing (size w h)');
  return { w: Number(sz[1]), h: Number(sz[2]) };
}

function getNetNumber(expr) {
  const net = findInList(expr, 'net');
  if (!net || net.length < 2) return null;
  return Number(net[1]);
}

function getDrill(expr) {
  const drill = findInList(expr, 'drill');
  if (!drill || drill.length < 2) return null;
  return Number(drill[1]);
}

function getLayer(expr) {
  const layerEntry = findInList(expr, 'layer');
  if (layerEntry && layerEntry.length >= 2) {
    const layerName = layerEntry[1];
    if (layerName === 'F.Cu') return 'front';
    if (layerName === 'B.Cu') return 'back';
    return layerName;
  }
  for (const item of expr) {
    if (typeof item === 'string' && (item === 'F.Cu' || item === 'B.Cu')) {
      return item === 'F.Cu' ? 'front' : 'back';
    }
  }
  return null;
}

function convertKiCadToInternal(content) {
  const parsed = parseSExpression(content);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed[0] !== 'pcb') {
    throw new Error('Top-level must be (pcb ...)');
  }

  const netMap = {};
  const netEntries = findAll(parsed, 'net');
  for (const net of netEntries) {
    if (net.length >= 3) {
      const num = Number(net[1]);
      const name = typeof net[2] === 'string' ? net[2] : String(net[1]);
      netMap[num] = name;
    }
  }

  const pads = [];
  const tracks = [];
  let nextId = 1;
  const genId = () => nextId++;

  const modules = findAll(parsed, 'module');
  for (const mod of modules) {
    const padEntries = findAll(mod, 'pad');
    for (const pad of padEntries) {
      if (pad.length < 4) throw new Error('Invalid pad entry');
      const coord = getAtCoord(pad);
      const size = getSize(pad);
      const netNum = getNetNumber(pad);
      const drill = getDrill(pad);
      const padShape = pad[3];
      let diameter = Math.max(size.w, size.h);
      if (padShape === 'circle') {
        diameter = size.w;
      }
      const layers = pad.includes('thru_hole') ? ['front', 'back'] : [getLayer(pad) || 'front'];
      pads.push({
        id: genId(),
        type: 'pad',
        net: netNum !== null && netMap[netNum] ? netMap[netNum] : '',
        x: coord.x,
        y: coord.y,
        diameter: diameter,
        hole: drill || 0,
        layers: layers
      });
    }
  }

  const segments = findAll(parsed, 'segment');
  for (const seg of segments) {
    const startEntry = findInList(seg, 'start');
    const endEntry = findInList(seg, 'end');
    if (!startEntry || startEntry.length < 3) throw new Error('Missing (start x y) in segment');
    if (!endEntry || endEntry.length < 3) throw new Error('Missing (end x y) in segment');
    const widthEntry = findInList(seg, 'width');
    if (!widthEntry || widthEntry.length < 2) throw new Error('Missing (width w) in segment');
    const layer = getLayer(seg);
    if (!layer) throw new Error('Missing layer (F.Cu/B.Cu) in segment');
    const netNum = getNetNumber(seg);
    tracks.push({
      id: genId(),
      type: 'track',
      net: netNum !== null && netMap[netNum] ? netMap[netNum] : '',
      layer: layer,
      width: Number(widthEntry[1]),
      points: [
        { x: Number(startEntry[1]), y: Number(startEntry[2]) },
        { x: Number(endEntry[1]), y: Number(endEntry[2]) }
      ]
    });
  }

  return {
    pads,
    tracks,
    vias: [],
    copperPours: [],
    nextId
  };
}

async function updateTaskStatus(taskId, status, updates = {}) {
  const now = Date.now();
  const fields = ['status = ?', 'updated_at = ?'];
  const params = [status, now];
  if (updates.error !== undefined) {
    fields.push('error = ?');
    params.push(updates.error);
  }
  if (updates.board_id !== undefined) {
    fields.push('board_id = ?');
    params.push(updates.board_id);
  }
  params.push(taskId);
  await dbRun(`UPDATE import_tasks SET ${fields.join(', ')} WHERE task_id = ?`, params);
}

async function processTask(task) {
  try {
    await updateTaskStatus(task.task_id, 'processing');
    const state = convertKiCadToInternal(task.content);
    const boardId = uuidv4().replace(/-/g, '').substring(0, 12);
    const now = Date.now();
    await dbRun(
      'INSERT INTO boards (id, name, created_at) VALUES (?, ?, ?)',
      [boardId, task.filename.replace(/\.[^.]+$/, ''), now]
    );
    await dbRun(
      'INSERT INTO board_versions (board_id, version, state_json, summary, created_at) VALUES (?, ?, ?, ?, ?)',
      [boardId, 1, JSON.stringify(state), 'Imported from KiCad', now]
    );
    boardLatestState[boardId] = { version: 1, state };
    audit.recordAuditLog({
      board_id: boardId,
      action_type: 'import',
      operator: 'anonymous',
      before_state: null,
      after_state: state
    });
    await updateTaskStatus(task.task_id, 'completed', { board_id: boardId });
  } catch (e) {
    console.error(`Task ${task.task_id} failed:`, e.message);
    await updateTaskStatus(task.task_id, 'failed', { error: e.message });
  }
}

async function processQueueStep() {
  if (isProcessing) return;
  if (importQueue.length === 0) return;

  isProcessing = true;
  const taskId = importQueue.shift();
  try {
    const task = await dbGet('SELECT * FROM import_tasks WHERE task_id = ?', [taskId]);
    if (task && task.status === 'queued') {
      await processTask(task);
    }
  } catch (e) {
    console.error('Queue processing error:', e);
  } finally {
    isProcessing = false;
  }
}

function startImportQueue() {
  if (queueTimer) return;
  queueTimer = setInterval(processQueueStep, PROCESS_INTERVAL_MS);
  console.log('Import queue started');
}

async function recoverImportTasks() {
  try {
    const rows = await dbAll(
      "SELECT task_id FROM import_tasks WHERE status IN ('queued', 'processing') ORDER BY created_at ASC"
    );
    for (const row of rows) {
      await updateTaskStatus(row.task_id, 'queued', { error: null });
      importQueue.push(row.task_id);
    }
    if (rows.length > 0) {
      console.log(`Recovered ${rows.length} import tasks from database`);
    }
  } catch (e) {
    console.error('Failed to recover import tasks:', e);
  }
}

function enqueueTask(taskId) {
  importQueue.push(taskId);
}

app.post('/api/import/batch', async (req, res) => {
  try {
    const { files } = req.body || {};
    if (!Array.isArray(files)) {
      return res.status(400).json({ error: 'files must be an array' });
    }
    if (files.length > MAX_FILES_PER_BATCH) {
      return res.status(400).json({ error: `Maximum ${MAX_FILES_PER_BATCH} files per batch` });
    }

    const batchId = uuidv4().replace(/-/g, '').substring(0, 12);
    const now = Date.now();
    await dbRun('INSERT INTO import_batches (batch_id, created_at) VALUES (?, ?)', [batchId, now]);

    const tasks = [];
    for (const file of files) {
      const taskId = uuidv4().replace(/-/g, '').substring(0, 12);
      const filename = file?.filename || 'unknown.kicad_pcb';
      const content = file?.content || '';
      const contentSize = Buffer.byteLength(content, 'utf8');

      let status = 'queued';
      let error = null;
      let storedContent = content;

      if (contentSize > MAX_FILE_SIZE_BYTES) {
        status = 'failed';
        error = `File too large: ${contentSize} bytes (max ${MAX_FILE_SIZE_BYTES})`;
        storedContent = '';
      }

      await dbRun(
        `INSERT INTO import_tasks (task_id, batch_id, filename, status, content, error, board_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [taskId, batchId, filename, status, storedContent, error, null, now, now]
      );

      if (status === 'queued') {
        enqueueTask(taskId);
      }

      tasks.push({ task_id: taskId, filename, status });
    }

    res.status(201).json({ batch_id: batchId, tasks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/import/batches', async (req, res) => {
  try {
    const batches = await dbAll('SELECT * FROM import_batches ORDER BY created_at DESC');
    const result = [];
    for (const batch of batches) {
      const tasks = await dbAll(
        'SELECT status FROM import_tasks WHERE batch_id = ?',
        [batch.batch_id]
      );
      const total = tasks.length;
      const completed = tasks.filter(t => t.status === 'completed').length;
      const failed = tasks.filter(t => t.status === 'failed').length;
      result.push({
        batch_id: batch.batch_id,
        created_at: batch.created_at,
        total_tasks: total,
        completed,
        failed
      });
    }
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/import/batches/:batchId', async (req, res) => {
  try {
    const batch = await dbGet('SELECT * FROM import_batches WHERE batch_id = ?', [req.params.batchId]);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const tasks = await dbAll(
      'SELECT task_id, filename, status, error, board_id, created_at, updated_at FROM import_tasks WHERE batch_id = ? ORDER BY created_at ASC',
      [req.params.batchId]
    );
    res.json({
      batch_id: batch.batch_id,
      created_at: batch.created_at,
      tasks
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/import/tasks/:taskId/cancel', async (req, res) => {
  try {
    const task = await dbGet('SELECT * FROM import_tasks WHERE task_id = ?', [req.params.taskId]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status !== 'queued') {
      return res.status(409).json({ error: `Cannot cancel task with status: ${task.status}` });
    }
    const idx = importQueue.indexOf(task.task_id);
    if (idx >= 0) importQueue.splice(idx, 1);
    await updateTaskStatus(task.task_id, 'cancelled');
    res.json({ ok: true, task_id: task.task_id, status: 'cancelled' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/import/tasks/:taskId/retry', async (req, res) => {
  try {
    const task = await dbGet('SELECT * FROM import_tasks WHERE task_id = ?', [req.params.taskId]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status !== 'failed') {
      return res.status(409).json({ error: `Cannot retry task with status: ${task.status}` });
    }
    await updateTaskStatus(task.task_id, 'queued', { error: null, board_id: null });
    enqueueTask(task.task_id);
    res.json({ ok: true, task_id: task.task_id, status: 'queued' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

