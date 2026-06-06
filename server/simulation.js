function round2(x) {
  return Math.round(x * 100) / 100;
}

function simulateEtch(tracks, etchFactor, copperThickness) {
  const results = [];
  let minFinalWidth = Infinity;

  for (const track of tracks || []) {
    const designWidth = track.width || 0;
    const finalWidthRaw = designWidth * etchFactor;
    const finalWidthRounded = round2(finalWidthRaw);
    const status = finalWidthRaw < 0.1 ? 'risk' : 'ok';

    if (finalWidthRaw < minFinalWidth) {
      minFinalWidth = finalWidthRaw;
    }

    results.push({
      id: track.id,
      net: track.net || '',
      layer: track.layer || '',
      design_width: designWidth,
      final_width: finalWidthRounded,
      status
    });
  }

  const riskCount = results.filter(r => r.status === 'risk').length;

  return {
    tracks: results,
    risk_count: riskCount,
    min_final_width: minFinalWidth === Infinity ? 0 : round2(minFinalWidth)
  };
}

function calculateImpedance(finalWidth, copperThickness, dielectricHeight, dielectricConstant) {
  const Er = dielectricConstant;
  const H = dielectricHeight;
  const W = finalWidth;
  const T = copperThickness;

  const numerator = 5.98 * H;
  const denominator = 0.8 * W + T;
  const lnArg = numerator / denominator;
  const naturalLog = Math.log(lnArg);
  const sqrtTerm = Math.sqrt(Er + 1.41);
  const Z0 = (87 / sqrtTerm) * naturalLog;

  return Z0;
}

function simulateImpedance(tracks, etchResult, params) {
  const { dielectric_height, dielectric_constant, target_impedance, tolerance_pct, copper_thickness } = params;

  const finalWidthMap = new Map();
  for (const t of etchResult.tracks) {
    finalWidthMap.set(t.id, t.final_width);
  }

  const results = [];
  let totalImpedance = 0;
  let validCount = 0;

  for (const track of tracks || []) {
    const finalWidth = finalWidthMap.get(track.id) != null
      ? finalWidthMap.get(track.id)
      : (track.width || 0) * (params.etch_factor || 0.85);

    const impedanceRaw = calculateImpedance(finalWidth, copper_thickness, dielectric_height, dielectric_constant);
    const impedance = round2(impedanceRaw);
    const deviationPct = round2(Math.abs((impedance - target_impedance) / target_impedance) * 100);
    const status = deviationPct > tolerance_pct ? 'fail' : 'pass';

    totalImpedance += impedance;
    validCount++;

    results.push({
      id: track.id,
      net: track.net || '',
      layer: track.layer || '',
      width: finalWidth,
      impedance,
      target: target_impedance,
      deviation_pct: deviationPct,
      status
    });
  }

  const passCount = results.filter(r => r.status === 'pass').length;
  const failCount = results.filter(r => r.status === 'fail').length;
  const avgImpedance = validCount > 0 ? round2(totalImpedance / validCount) : 0;

  return {
    tracks: results,
    pass_count: passCount,
    fail_count: failCount,
    avg_impedance: avgImpedance
  };
}

function validateEtchParams(body) {
  const etchFactor = body.etch_factor != null ? Number(body.etch_factor) : 0.85;
  const copperThickness = body.copper_thickness != null ? Number(body.copper_thickness) : 0.035;

  if (isNaN(etchFactor) || etchFactor < 0.5 || etchFactor > 1.0) {
    return { error: 'etch_factor must be a number between 0.5 and 1.0' };
  }
  if (isNaN(copperThickness) || copperThickness < 0.01 || copperThickness > 0.1) {
    return { error: 'copper_thickness must be a number between 0.01 and 0.1 mm' };
  }

  return { etchFactor, copperThickness };
}

function validateImpedanceParams(body) {
  const dielectricHeight = body.dielectric_height != null ? Number(body.dielectric_height) : 0.2;
  const dielectricConstant = body.dielectric_constant != null ? Number(body.dielectric_constant) : 4.5;
  const targetImpedance = body.target_impedance != null ? Number(body.target_impedance) : 50;
  const tolerancePct = body.tolerance_pct != null ? Number(body.tolerance_pct) : 10;

  if (isNaN(dielectricHeight) || dielectricHeight <= 0) {
    return { error: 'dielectric_height must be a positive number' };
  }
  if (isNaN(dielectricConstant) || dielectricConstant <= 0) {
    return { error: 'dielectric_constant must be a positive number' };
  }
  if (isNaN(targetImpedance) || targetImpedance <= 0) {
    return { error: 'target_impedance must be a positive number' };
  }
  if (isNaN(tolerancePct) || tolerancePct < 0) {
    return { error: 'tolerance_pct must be a non-negative number' };
  }

  return {
    dielectric_height: dielectricHeight,
    dielectric_constant: dielectricConstant,
    target_impedance: targetImpedance,
    tolerance_pct: tolerancePct
  };
}

function mountSimulationRoutes(app, deps) {
  const { getLatestVersion } = deps;

  app.post('/api/boards/:id/simulate/etch', async (req, res) => {
    try {
      const boardId = req.params.id;
      const latest = await getLatestVersion(boardId);
      if (!latest) {
        return res.status(404).json({ error: 'Board not found' });
      }

      const validated = validateEtchParams(req.body || {});
      if (validated.error) {
        return res.status(400).json({ error: validated.error });
      }

      const state = latest.state || {};
      const tracks = state.tracks || [];
      const result = simulateEtch(tracks, validated.etchFactor, validated.copperThickness);

      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/boards/:id/simulate/impedance', async (req, res) => {
    try {
      const boardId = req.params.id;
      const latest = await getLatestVersion(boardId);
      if (!latest) {
        return res.status(404).json({ error: 'Board not found' });
      }

      const impedanceValidated = validateImpedanceParams(req.body || {});
      if (impedanceValidated.error) {
        return res.status(400).json({ error: impedanceValidated.error });
      }

      const etchValidated = validateEtchParams(req.body || {});
      if (etchValidated.error) {
        return res.status(400).json({ error: etchValidated.error });
      }

      const state = latest.state || {};
      const tracks = state.tracks || [];

      const etchResult = simulateEtch(tracks, etchValidated.etchFactor, etchValidated.copperThickness);

      const impedanceParams = {
        ...impedanceValidated,
        copper_thickness: etchValidated.copperThickness,
        etch_factor: etchValidated.etchFactor
      };
      const result = simulateImpedance(tracks, etchResult, impedanceParams);

      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/boards/:id/simulate/full', async (req, res) => {
    try {
      const boardId = req.params.id;
      const latest = await getLatestVersion(boardId);
      if (!latest) {
        return res.status(404).json({ error: 'Board not found' });
      }

      const etchValidated = validateEtchParams(req.body || {});
      if (etchValidated.error) {
        return res.status(400).json({ error: etchValidated.error });
      }

      const impedanceValidated = validateImpedanceParams(req.body || {});
      if (impedanceValidated.error) {
        return res.status(400).json({ error: impedanceValidated.error });
      }

      const state = latest.state || {};
      const tracks = state.tracks || [];

      const etchResult = simulateEtch(tracks, etchValidated.etchFactor, etchValidated.copperThickness);

      const impedanceParams = {
        ...impedanceValidated,
        copper_thickness: etchValidated.copperThickness,
        etch_factor: etchValidated.etchFactor
      };
      const impedanceResult = simulateImpedance(tracks, etchResult, impedanceParams);

      const etchMap = new Map();
      for (const t of etchResult.tracks) {
        etchMap.set(t.id, t);
      }
      const impedanceMap = new Map();
      for (const t of impedanceResult.tracks) {
        impedanceMap.set(t.id, t);
      }

      const details = [];
      for (const track of tracks || []) {
        const etchInfo = etchMap.get(track.id);
        const impedanceInfo = impedanceMap.get(track.id);
        details.push({
          id: track.id,
          net: track.net || '',
          design_width: track.width || 0,
          final_width: etchInfo ? etchInfo.final_width : 0,
          impedance: impedanceInfo ? impedanceInfo.impedance : 0,
          impedance_status: impedanceInfo ? impedanceInfo.status : 'fail',
          etch_status: etchInfo ? etchInfo.status : 'ok'
        });
      }

      res.json({
        etch_summary: {
          risk_count: etchResult.risk_count,
          min_width: etchResult.min_final_width
        },
        impedance_summary: {
          fail_count: impedanceResult.fail_count,
          avg_impedance: impedanceResult.avg_impedance
        },
        details
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  mountSimulationRoutes,
  simulateEtch,
  calculateImpedance,
  simulateImpedance
};
