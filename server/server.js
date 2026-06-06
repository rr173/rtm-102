const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const MAX_VERSIONS = 50;
const AUTO_SAVE_INTERVAL = 30000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
  await initDemoBoard();
  server.listen(PORT, () => {
    console.log(`PCB Editor server listening on port ${PORT}`);
  });
})().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});

const boardClients = {};
const boardPendingOps = {};
const boardAutoSaveTimers = {};
const boardLatestState = {};

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

function scheduleAutoSave(boardId) {
  if (boardAutoSaveTimers[boardId]) return;
  boardAutoSaveTimers[boardId] = setTimeout(async () => {
    delete boardAutoSaveTimers[boardId];
    const ops = boardPendingOps[boardId];
    if (ops && ops.length > 0) {
      const latest = await getLatestVersion(boardId);
      if (latest) {
        const summary = ops.length > 1
          ? `${ops.length} operations`
          : describeOperation(ops[0]);
        await saveVersion(boardId, latest.state, summary);
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

function accumulateOp(boardId, op) {
  if (!boardPendingOps[boardId]) boardPendingOps[boardId] = [];
  boardPendingOps[boardId].push(op);
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
    const version = await saveVersion(req.params.id, state, summary);
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
    const newVersion = await saveVersion(req.params.id, state, `Revert to version ${ver}`);
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

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'operation') {
      accumulateOp(boardId, msg.payload);
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
            const latest = await getLatestVersion(boardId);
            if (latest) {
              const ops = boardPendingOps[boardId];
              const summary = ops.length > 1
                ? `${ops.length} operations`
                : describeOperation(ops[0]);
              await saveVersion(boardId, latest.state, summary);
            }
          } catch (e) {
            console.error('Auto-save on close failed:', e);
          }
        }
        delete boardPendingOps[boardId];
        delete boardLatestState[boardId];
      }
    }
    broadcastOnlineCount(boardId);
  });
});

