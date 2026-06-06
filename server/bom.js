function round2(x) {
  return Math.round(x * 100) / 100;
}

function specKey(spec) {
  return `${spec.type}|${spec.diameter}|${spec.hole}`;
}

function extractBom(state) {
  const groups = new Map();

  for (const pad of state.pads || []) {
    const key = `pad|${pad.diameter}|${pad.hole}`;
    if (!groups.has(key)) {
      groups.set(key, {
        spec: { diameter: pad.diameter, hole: pad.hole, type: 'pad' },
        quantity: 0,
        positions: []
      });
    }
    const g = groups.get(key);
    g.quantity++;
    g.positions.push({ x: pad.x, y: pad.y });
  }

  for (const via of state.vias || []) {
    const key = `via|${via.diameter}|${via.hole}`;
    if (!groups.has(key)) {
      groups.set(key, {
        spec: { diameter: via.diameter, hole: via.hole, type: 'via' },
        quantity: 0,
        positions: []
      });
    }
    const g = groups.get(key);
    g.quantity++;
    g.positions.push({ x: via.x, y: via.y });
  }

  const items = Array.from(groups.values());
  const totalComponents = items.reduce((s, it) => s + it.quantity, 0);

  return {
    items,
    unique_specs: items.length,
    total_components: totalComponents
  };
}

function getBasePrice(spec) {
  if (spec.type === 'via') {
    return 0.03;
  }
  if (spec.diameter <= 1.0) {
    return 0.02;
  } else if (spec.diameter <= 2.0) {
    return 0.05;
  } else {
    return 0.12;
  }
}

function getDiscount(quantity) {
  if (quantity >= 100) return 0.7;
  if (quantity >= 50) return 0.8;
  if (quantity >= 10) return 0.9;
  return 1.0;
}

function computeQuote(bom) {
  const quoteItems = [];
  let subtotal = 0;

  for (const item of bom.items) {
    const basePrice = getBasePrice(item.spec);
    const discount = getDiscount(item.quantity);
    const unitPrice = round2(basePrice * discount);
    const lineTotal = round2(unitPrice * item.quantity);
    subtotal = round2(subtotal + lineTotal);

    quoteItems.push({
      spec: item.spec,
      quantity: item.quantity,
      unit_price: unitPrice,
      discount: discount,
      line_total: lineTotal
    });
  }

  const tax = round2(subtotal * 0.13);
  const grandTotal = round2(subtotal + tax);

  return {
    items: quoteItems,
    subtotal,
    tax,
    grand_total: grandTotal
  };
}

function mountBomRoutes(app, deps) {
  const { getLatestVersion } = deps;

  app.post('/api/boards/:id/bom', async (req, res) => {
    try {
      const boardId = req.params.id;
      const latest = await getLatestVersion(boardId);
      if (!latest) {
        return res.status(404).json({ error: 'Board not found' });
      }
      const state = latest.state || {};
      const bom = extractBom(state);
      res.json(bom);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/boards/:id/quote', async (req, res) => {
    try {
      const boardId = req.params.id;
      const latest = await getLatestVersion(boardId);
      if (!latest) {
        return res.status(404).json({ error: 'Board not found' });
      }
      const state = latest.state || {};
      const bom = extractBom(state);
      const quote = computeQuote(bom);
      res.json(quote);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/bom/compare', async (req, res) => {
    try {
      const { board_ids } = req.body || {};
      if (!Array.isArray(board_ids) || board_ids.length !== 2) {
        return res.status(400).json({ error: 'board_ids must be an array of exactly two board IDs' });
      }

      const [id1, id2] = board_ids;
      const latest1 = await getLatestVersion(id1);
      const latest2 = await getLatestVersion(id2);

      if (!latest1) return res.status(404).json({ error: `Board not found: ${id1}` });
      if (!latest2) return res.status(404).json({ error: `Board not found: ${id2}` });

      const bom1 = extractBom(latest1.state || {});
      const bom2 = extractBom(latest2.state || {});
      const quote1 = computeQuote(bom1);
      const quote2 = computeQuote(bom2);

      const map1 = new Map();
      const map2 = new Map();
      for (const it of bom1.items) map1.set(specKey(it.spec), it);
      for (const it of bom2.items) map2.set(specKey(it.spec), it);

      const onlyInFirst = [];
      const onlyInSecond = [];
      const common = [];

      for (const [key, item] of map1) {
        if (!map2.has(key)) {
          onlyInFirst.push(item.spec);
        } else {
          const other = map2.get(key);
          common.push({
            spec: item.spec,
            qty_first: item.quantity,
            qty_second: other.quantity,
            qty_diff: item.quantity - other.quantity
          });
        }
      }
      for (const [key, item] of map2) {
        if (!map1.has(key)) {
          onlyInSecond.push(item.spec);
        }
      }

      res.json({
        only_in_first: onlyInFirst,
        only_in_second: onlyInSecond,
        common,
        cost_diff: {
          first_total: quote1.grand_total,
          second_total: quote2.grand_total,
          difference: round2(quote1.grand_total - quote2.grand_total)
        }
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { mountBomRoutes, extractBom, computeQuote };
