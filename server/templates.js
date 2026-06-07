const { v4: uuidv4 } = require('uuid');

function createTemplatesModule(db, deps) {
  const { dbRun, dbGet, dbAll } = deps;

  async function initTable() {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS design_templates (
        template_id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        tags_json TEXT NOT NULL,
        author TEXT NOT NULL,
        state_json TEXT NOT NULL,
        downloads INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);
    await dbRun(`
      CREATE TABLE IF NOT EXISTS template_ratings (
        template_id TEXT NOT NULL,
        user TEXT NOT NULL,
        score INTEGER NOT NULL,
        comment TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (template_id, user),
        FOREIGN KEY (template_id) REFERENCES design_templates(template_id) ON DELETE CASCADE
      )
    `);
    await dbRun('CREATE INDEX IF NOT EXISTS idx_templates_author ON design_templates(author)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_templates_created ON design_templates(created_at DESC)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_templates_downloads ON design_templates(downloads DESC)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_ratings_template ON template_ratings(template_id)');
  }

  function validateTemplateInput(body) {
    const { title, description, tags, author, board_id } = body || {};
    if (board_id === undefined || typeof board_id !== 'string' || board_id.trim() === '') {
      return 'board_id is required';
    }
    if (typeof title !== 'string' || title.length < 3 || title.length > 100) {
      return 'title must be 3-100 characters';
    }
    if (!Array.isArray(tags)) {
      return 'tags must be an array';
    }
    if (tags.length > 5) {
      return 'tags must have at most 5 items';
    }
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      if (typeof t !== 'string' || t.length === 0 || t.length > 20) {
        return 'tags[' + i + '] must be a string up to 20 characters';
      }
    }
    if (!author || typeof author !== 'string') {
      return 'author is required';
    }
    return null;
  }

  function formatTemplateRow(row) {
    return {
      template_id: row.template_id,
      title: row.title,
      description: row.description,
      tags: JSON.parse(row.tags_json),
      author: row.author,
      created_at: row.created_at,
      downloads: row.downloads,
      avg_rating: row.avg_rating != null ? Number(row.avg_rating) : null,
      rating_count: row.rating_count != null ? Number(row.rating_count) : 0
    };
  }

  async function computeRatingStats(templateId) {
    const row = await dbGet(
      'SELECT AVG(score) AS avg_rating, COUNT(*) AS rating_count FROM template_ratings WHERE template_id = ?',
      [templateId]
    );
    return {
      avg_rating: row && row.avg_rating != null ? Number(row.avg_rating) : null,
      rating_count: row && row.rating_count != null ? Number(row.rating_count) : 0
    };
  }

  async function publishTemplate(body) {
    const err = validateTemplateInput(body);
    if (err) throw { status: 400, message: err };

    const { board_id, title, description, tags, author } = body;
    const board = await dbGet('SELECT id FROM boards WHERE id = ?', [board_id]);
    if (!board) throw { status: 404, message: 'Board not found' };

    const latest = await dbGet(
      'SELECT state_json FROM board_versions WHERE board_id = ? ORDER BY version DESC LIMIT 1',
      [board_id]
    );
    if (!latest) throw { status: 404, message: 'No board state found' };

    const templateId = uuidv4().replace(/-/g, '').substring(0, 16);
    const now = Date.now();
    const stateJson = latest.state_json;

    await dbRun(
      'INSERT INTO design_templates (template_id, board_id, title, description, tags_json, author, state_json, downloads, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
      [templateId, board_id, title, description || '', JSON.stringify(tags), author, stateJson, now]
    );

    return { template_id: templateId, title: title, created_at: now };
  }

  async function listTemplates(query) {
    const { tag, author, sort, limit, offset } = query || {};
    const actualSort = sort || 'newest';
    const actualLimit = limit != null ? limit : 20;
    const actualOffset = offset != null ? offset : 0;

    const whereClauses = [];
    const params = [];

    if (tag && typeof tag === 'string') {
      whereClauses.push('tags_json LIKE ?');
      params.push('%"' + tag + '"%');
    }
    if (author && typeof author === 'string') {
      whereClauses.push('author = ?');
      params.push(author);
    }

    const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    let orderSql;
    switch (actualSort) {
      case 'downloads':
        orderSql = 't.downloads DESC';
        break;
      case 'rating':
        orderSql = 'avg_rating IS NULL, avg_rating DESC';
        break;
      case 'newest':
      default:
        orderSql = 't.created_at DESC';
        break;
    }

    const totalRow = await dbGet(
      'SELECT COUNT(*) AS c FROM design_templates ' + whereSql,
      params
    );
    const total = totalRow && totalRow.c ? totalRow.c : 0;

    const parsedLimit = parseInt(actualLimit);
    const parsedOffset = parseInt(actualOffset);
    const safeLimit = Math.min(isNaN(parsedLimit) ? 20 : parsedLimit, 100);
    const safeOffset = isNaN(parsedOffset) ? 0 : Math.max(parsedOffset, 0);

    const rows = await dbAll(
      'SELECT t.*, ' +
        '(SELECT AVG(r.score) FROM template_ratings r WHERE r.template_id = t.template_id) AS avg_rating, ' +
        '(SELECT COUNT(*) FROM template_ratings r WHERE r.template_id = t.template_id) AS rating_count ' +
        'FROM design_templates t ' +
        whereSql + ' ' +
        'ORDER BY ' + orderSql + ' ' +
        'LIMIT ? OFFSET ?',
      params.concat([safeLimit, safeOffset])
    );

    return {
      total: total,
      templates: rows.map(formatTemplateRow)
    };
  }

  async function getTemplateDetail(templateId) {
    const row = await dbGet(
      'SELECT t.*, ' +
        '(SELECT AVG(score) FROM template_ratings r WHERE r.template_id = t.template_id) AS avg_rating, ' +
        '(SELECT COUNT(*) FROM template_ratings r WHERE r.template_id = t.template_id) AS rating_count ' +
        'FROM design_templates t WHERE t.template_id = ?',
      [templateId]
    );
    if (!row) throw { status: 404, message: 'Template not found' };

    const base = formatTemplateRow(row);
    return Object.assign({}, base, {
      state: JSON.parse(row.state_json)
    });
  }

  async function getTemplateStats(templateId) {
    const tpl = await dbGet('SELECT template_id, downloads FROM design_templates WHERE template_id = ?', [templateId]);
    if (!tpl) throw { status: 404, message: 'Template not found' };

    const ratings = await dbAll(
      'SELECT user, score, comment, created_at FROM template_ratings WHERE template_id = ? ORDER BY created_at DESC',
      [templateId]
    );
    const stats = await computeRatingStats(templateId);

    return {
      downloads: tpl.downloads,
      ratings: ratings,
      avg_rating: stats.avg_rating
    };
  }

  async function useTemplate(templateId, operator) {
    const tpl = await dbGet('SELECT * FROM design_templates WHERE template_id = ?', [templateId]);
    if (!tpl) throw { status: 404, message: 'Template not found' };

    const newBoardId = uuidv4().replace(/-/g, '').substring(0, 12);
    const now = Date.now();
    const state = JSON.parse(tpl.state_json);
    const boardName = tpl.title + ' (copy)';

    await dbRun(
      'INSERT INTO boards (id, name, created_at) VALUES (?, ?, ?)',
      [newBoardId, boardName, now]
    );
    await dbRun(
      'INSERT INTO board_versions (board_id, version, state_json, summary, created_at) VALUES (?, ?, ?, ?, ?)',
      [newBoardId, 1, tpl.state_json, 'Created from template ' + tpl.template_id, now]
    );
    await dbRun(
      'UPDATE design_templates SET downloads = downloads + 1 WHERE template_id = ?',
      [templateId]
    );

    if (deps.boardLatestState && typeof deps.boardLatestState !== 'undefined') {
      deps.boardLatestState[newBoardId] = { version: 1, state: state };
    }

    return {
      board_id: newBoardId,
      template_id: templateId,
      message: 'Board created from template successfully'
    };
  }

  async function rateTemplate(templateId, body) {
    const { user, score, comment } = body || {};

    if (!user || typeof user !== 'string') {
      throw { status: 400, message: 'user is required' };
    }
    const s = Number(score);
    if (!Number.isInteger(s) || s < 1 || s > 5) {
      throw { status: 400, message: 'score must be an integer between 1-5' };
    }

    const tpl = await dbGet('SELECT template_id FROM design_templates WHERE template_id = ?', [templateId]);
    if (!tpl) throw { status: 404, message: 'Template not found' };

    const existing = await dbGet(
      'SELECT 1 FROM template_ratings WHERE template_id = ? AND user = ?',
      [templateId, user]
    );
    if (existing) throw { status: 409, message: 'User has already rated this template' };

    const now = Date.now();
    await dbRun(
      'INSERT INTO template_ratings (template_id, user, score, comment, created_at) VALUES (?, ?, ?, ?, ?)',
      [templateId, user, s, comment || null, now]
    );

    const stats = await computeRatingStats(templateId);
    return { ok: true, new_avg: stats.avg_rating };
  }

  function mountTemplatesRoutes(app) {
    app.post('/api/templates', async (req, res) => {
      try {
        const result = await publishTemplate(req.body);
        res.status(201).json(result);
      } catch (e) {
        console.error(e);
        const status = e.status || 500;
        res.status(status).json({ error: e.message || String(e) });
      }
    });

    app.get('/api/templates', async (req, res) => {
      try {
        const result = await listTemplates(req.query);
        res.json(result);
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/templates/:id', async (req, res) => {
      try {
        const result = await getTemplateDetail(req.params.id);
        res.json(result);
      } catch (e) {
        console.error(e);
        const status = e.status || 500;
        res.status(status).json({ error: e.message || String(e) });
      }
    });

    app.get('/api/templates/:id/stats', async (req, res) => {
      try {
        const result = await getTemplateStats(req.params.id);
        res.json(result);
      } catch (e) {
        console.error(e);
        const status = e.status || 500;
        res.status(status).json({ error: e.message || String(e) });
      }
    });

    app.post('/api/templates/:id/use', async (req, res) => {
      try {
        const operator = (req.body && req.body.operator) || 'anonymous';
        const result = await useTemplate(req.params.id, operator);
        res.status(201).json(result);
      } catch (e) {
        console.error(e);
        const status = e.status || 500;
        res.status(status).json({ error: e.message || String(e) });
      }
    });

    app.post('/api/templates/:id/rate', async (req, res) => {
      try {
        const result = await rateTemplate(req.params.id, req.body);
        res.json(result);
      } catch (e) {
        console.error(e);
        const status = e.status || 500;
        res.status(status).json({ error: e.message || String(e) });
      }
    });
  }

  return {
    initTable: initTable,
    publishTemplate: publishTemplate,
    listTemplates: listTemplates,
    getTemplateDetail: getTemplateDetail,
    getTemplateStats: getTemplateStats,
    useTemplate: useTemplate,
    rateTemplate: rateTemplate,
    mountTemplatesRoutes: mountTemplatesRoutes
  };
}

module.exports = { createTemplatesModule: createTemplatesModule };
