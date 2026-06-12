const ScriptEngine = (function() {
    const BOARD_WIDTH = 100;
    const BOARD_HEIGHT = 80;
    const MAX_REPEAT_DEPTH = 3;

    let previewElements = null;
    let executionHistory = [];
    const MAX_HISTORY = 20;

    function parseAndExecute(scriptText) {
        const lines = scriptText.split('\n');
        const context = {
            variables: {},
            errors: [],
            errorLines: [],
            elements: {
                pads: [],
                tracks: [],
                vias: [],
                copperPours: []
            },
            repeatDepth: 0,
            lines: lines
        };

        const expandedLines = [];
        for (let i = 0; i < lines.length; i++) {
            expandedLines.push({ text: lines[i], lineNumber: i + 1 });
        }

        executeLines(expandedLines, 0, expandedLines.length, context, 0, 0);

        if (context.errors.length > 0) {
            return {
                success: false,
                errors: context.errors,
                errorLines: context.errorLines,
                elements: null
            };
        }

        return {
            success: true,
            elements: context.elements,
            errors: [],
            errorLines: []
        };
    }

    function executeLines(expandedLines, start, end, context, offsetDx, offsetDy) {
        let i = start;
        while (i < end) {
            const { text, lineNumber } = expandedLines[i];
            const trimmed = text.trim();

            if (trimmed === '' || trimmed.startsWith('//')) {
                i++;
                continue;
            }

            if (trimmed.startsWith('LET ')) {
                executeLet(trimmed, lineNumber, context);
                i++;
                continue;
            }

            if (trimmed.startsWith('REPEAT(')) {
                const repeatResult = parseRepeat(expandedLines, i, end, context);
                if (repeatResult.error) {
                    i++;
                    continue;
                }
                executeRepeat(repeatResult, expandedLines, context, offsetDx, offsetDy);
                i = repeatResult.endIndex + 1;
                continue;
            }

            if (trimmed.startsWith('PLACE_PAD(')) {
                executePlacePad(trimmed, lineNumber, context, offsetDx, offsetDy);
                i++;
                continue;
            }

            if (trimmed.startsWith('TRACE(')) {
                executeTrace(trimmed, lineNumber, context, offsetDx, offsetDy);
                i++;
                continue;
            }

            if (trimmed.startsWith('VIA(')) {
                executeVia(trimmed, lineNumber, context, offsetDx, offsetDy);
                i++;
                continue;
            }

            if (trimmed.startsWith('COPPER(')) {
                executeCopper(trimmed, lineNumber, context, offsetDx, offsetDy);
                i++;
                continue;
            }

            addError(context, lineNumber, `未知指令: ${trimmed.split('(')[0]}`);
            i++;
        }
    }

    function addError(context, lineNumber, message) {
        context.errors.push({ line: lineNumber, message: message });
        if (!context.errorLines.includes(lineNumber)) {
            context.errorLines.push(lineNumber);
        }
    }

    function substituteVariables(text, lineNumber, context) {
        return text.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name) => {
            if (context.variables.hasOwnProperty(name)) {
                return String(context.variables[name]);
            }
            addError(context, lineNumber, `未定义变量: $${name}`);
            return '0';
        });
    }

    function evaluateExpression(expr) {
        const safe = expr.replace(/[^0-9+\-*/().eE\s]/g, '');
        if (safe.length === 0) return 0;
        try {
            const result = new Function('return (' + safe + ')')();
            if (typeof result !== 'number' || !isFinite(result)) return NaN;
            return result;
        } catch (e) {
            return NaN;
        }
    }

    function resolveValue(text, lineNumber, context) {
        const substituted = substituteVariables(text, lineNumber, context);
        const result = evaluateExpression(substituted);
        if (isNaN(result)) {
            addError(context, lineNumber, `表达式求值失败: ${text}`);
        }
        return result;
    }

    function executeLet(line, lineNumber, context) {
        const rest = line.substring(4).trim();
        const eqIndex = rest.indexOf('=');
        if (eqIndex < 0) {
            addError(context, lineNumber, 'LET 语法错误: 缺少 =');
            return;
        }
        const name = rest.substring(0, eqIndex).trim();
        const valueExpr = rest.substring(eqIndex + 1).trim();

        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            addError(context, lineNumber, `无效变量名: ${name}`);
            return;
        }

        const value = resolveValue(valueExpr, lineNumber, context);
        if (!isNaN(value)) {
            context.variables[name] = value;
        }
    }

    function parseRepeat(expandedLines, startIndex, parentEnd, context) {
        const { text, lineNumber } = expandedLines[startIndex];
        const trimmed = text.trim();

        const match = trimmed.match(/^REPEAT\(([^,]+),([^,]+),([^)]*)\)\s*\{?\s*$/);
        if (!match) {
            addError(context, lineNumber, 'REPEAT 语法错误: REPEAT(count,dx,dy){');
            return { error: true };
        }

        const count = resolveValue(match[1].trim(), lineNumber, context);
        const dx = resolveValue(match[2].trim(), lineNumber, context);
        const dy = resolveValue(match[3].trim(), lineNumber, context);

        if (isNaN(count) || count < 0 || !Number.isInteger(count)) {
            addError(context, lineNumber, 'REPEAT count 必须为非负整数');
            return { error: true };
        }

        if (count > 1000) {
            addError(context, lineNumber, 'REPEAT count 不能超过 1000');
            return { error: true };
        }

        let braceDepth = 1;
        let bodyStart = startIndex + 1;
        let bodyEnd = -1;

        for (let j = bodyStart; j < parentEnd; j++) {
            const t = expandedLines[j].text.trim();
            if (t.match(/^REPEAT\([^)]*\)\s*\{/)) braceDepth++;
            if (t === '}') {
                braceDepth--;
                if (braceDepth === 0) {
                    bodyEnd = j;
                    break;
                }
            }
        }

        if (bodyEnd < 0) {
            addError(context, lineNumber, 'REPEAT 缺少闭合花括号 }');
            return { error: true };
        }

        return {
            error: false,
            count: count,
            dx: dx,
            dy: dy,
            bodyStart: bodyStart,
            bodyEnd: bodyEnd,
            endIndex: bodyEnd
        };
    }

    function executeRepeat(repeatResult, expandedLines, context, offsetDx, offsetDy) {
        context.repeatDepth++;
        if (context.repeatDepth > MAX_REPEAT_DEPTH) {
            addError(context, context.lines.length, `REPEAT 嵌套超过 ${MAX_REPEAT_DEPTH} 层`);
            context.repeatDepth--;
            return;
        }

        for (let iter = 0; iter < repeatResult.count; iter++) {
            const iterDx = offsetDx + repeatResult.dx * iter;
            const iterDy = offsetDy + repeatResult.dy * iter;
            executeLines(
                expandedLines,
                repeatResult.bodyStart,
                repeatResult.bodyEnd,
                context,
                iterDx,
                iterDy
            );
        }

        context.repeatDepth--;
    }

    function expandedLinesFromContext(context) {
        return context.lines.map((text, idx) => ({ text, lineNumber: idx + 1 }));
    }

    function parseArgs(text, lineNumber, context) {
        const substituted = substituteVariables(text, lineNumber, context);
        const parts = [];
        let current = '';
        let depth = 0;
        for (let i = 0; i < substituted.length; i++) {
            const ch = substituted[i];
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            if (ch === ',' && depth === 0) {
                parts.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
        if (current.trim()) parts.push(current.trim());
        return parts;
    }

    function executePlacePad(line, lineNumber, context, offsetDx, offsetDy) {
        const innerMatch = line.match(/^PLACE_PAD\((.*)\)\s*;?\s*$/);
        if (!innerMatch) {
            addError(context, lineNumber, 'PLACE_PAD 语法错误');
            return;
        }
        const args = parseArgs(innerMatch[1], lineNumber, context);
        if (args.length < 5) {
            addError(context, lineNumber, 'PLACE_PAD 需要 5 个参数: (x,y,diameter,hole,net)');
            return;
        }

        const x = resolveValue(args[0], lineNumber, context) + offsetDx;
        const y = resolveValue(args[1], lineNumber, context) + offsetDy;
        const diameter = resolveValue(args[2], lineNumber, context);
        const hole = resolveValue(args[3], lineNumber, context);
        const net = args[4].trim().replace(/^["']|["']$/g, '');

        if (isNaN(x) || isNaN(y) || isNaN(diameter) || isNaN(hole)) {
            addError(context, lineNumber, 'PLACE_PAD 参数包含无效数值');
            return;
        }

        if (!isInsideBoard(x, y)) {
            addError(context, lineNumber, `坐标越界: (${x.toFixed(2)}, ${y.toFixed(2)}) 超出板面范围`);
            return;
        }

        if (diameter <= 0 || hole < 0) {
            addError(context, lineNumber, 'PLACE_PAD 直径必须大于0, 内孔不能为负');
            return;
        }

        if (hole >= diameter) {
            addError(context, lineNumber, 'PLACE_PAD 内孔径不能大于等于焊盘直径');
            return;
        }

        context.elements.pads.push({
            type: 'pad',
            x: x,
            y: y,
            diameter: diameter,
            hole: hole,
            net: net,
            layers: ['front', 'back'],
            _sourceLine: lineNumber
        });
    }

    function executeTrace(line, lineNumber, context, offsetDx, offsetDy) {
        const innerMatch = line.match(/^TRACE\((.*)\)\s*;?\s*$/);
        if (!innerMatch) {
            addError(context, lineNumber, 'TRACE 语法错误');
            return;
        }
        const args = parseArgs(innerMatch[1], lineNumber, context);
        if (args.length < 5) {
            addError(context, lineNumber, 'TRACE 至少需要 net,layer,width,x1,y1,...xn,yn');
            return;
        }

        const net = args[0].trim().replace(/^["']|["']$/g, '');
        const layer = args[1].trim().replace(/^["']|["']$/g, '');
        const width = resolveValue(args[2], lineNumber, context);

        if (layer !== 'front' && layer !== 'back') {
            addError(context, lineNumber, `TRACE layer 必须是 front 或 back: ${layer}`);
            return;
        }

        if (isNaN(width) || width <= 0) {
            addError(context, lineNumber, 'TRACE width 必须大于0');
            return;
        }

        const coordArgs = args.slice(3);
        if (coordArgs.length < 2 || coordArgs.length % 2 !== 0) {
            addError(context, lineNumber, 'TRACE 坐标参数必须成对出现 (x1,y1,...xn,yn)');
            return;
        }

        const points = [];
        for (let j = 0; j < coordArgs.length; j += 2) {
            const px = resolveValue(coordArgs[j], lineNumber, context) + offsetDx;
            const py = resolveValue(coordArgs[j + 1], lineNumber, context) + offsetDy;
            if (isNaN(px) || isNaN(py)) {
                addError(context, lineNumber, 'TRACE 坐标包含无效数值');
                return;
            }
            points.push({ x: px, y: py });
        }

        if (points.length < 2) {
            addError(context, lineNumber, 'TRACE 至少需要 2 个坐标点');
            return;
        }

        for (const p of points) {
            if (!isInsideBoard(p.x, p.y)) {
                addError(context, lineNumber, `坐标越界: (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) 超出板面范围`);
                return;
            }
        }

        context.elements.tracks.push({
            type: 'track',
            net: net,
            layer: layer,
            width: width,
            points: points,
            _sourceLine: lineNumber
        });
    }

    function executeVia(line, lineNumber, context, offsetDx, offsetDy) {
        const innerMatch = line.match(/^VIA\((.*)\)\s*;?\s*$/);
        if (!innerMatch) {
            addError(context, lineNumber, 'VIA 语法错误');
            return;
        }
        const args = parseArgs(innerMatch[1], lineNumber, context);
        if (args.length < 2) {
            addError(context, lineNumber, 'VIA 需要 2 个参数: (x,y)');
            return;
        }

        const x = resolveValue(args[0], lineNumber, context) + offsetDx;
        const y = resolveValue(args[1], lineNumber, context) + offsetDy;

        if (isNaN(x) || isNaN(y)) {
            addError(context, lineNumber, 'VIA 坐标包含无效数值');
            return;
        }

        if (!isInsideBoard(x, y)) {
            addError(context, lineNumber, `坐标越界: (${x.toFixed(2)}, ${y.toFixed(2)}) 超出板面范围`);
            return;
        }

        const net = args.length > 2 ? args[2].trim().replace(/^["']|["']$/g, '') : 'NET1';

        context.elements.vias.push({
            type: 'via',
            x: x,
            y: y,
            diameter: 0.6,
            hole: 0.3,
            net: net,
            layers: ['front', 'back'],
            _sourceLine: lineNumber
        });
    }

    function executeCopper(line, lineNumber, context, offsetDx, offsetDy) {
        const innerMatch = line.match(/^COPPER\((.*)\)\s*;?\s*$/);
        if (!innerMatch) {
            addError(context, lineNumber, 'COPPER 语法错误');
            return;
        }
        const args = parseArgs(innerMatch[1], lineNumber, context);
        if (args.length < 5) {
            addError(context, lineNumber, 'COPPER 至少需要 net,layer,x1,y1,...xn,yn');
            return;
        }

        const net = args[0].trim().replace(/^["']|["']$/g, '');
        const layer = args[1].trim().replace(/^["']|["']$/g, '');

        if (layer !== 'front' && layer !== 'back') {
            addError(context, lineNumber, `COPPER layer 必须是 front 或 back: ${layer}`);
            return;
        }

        const coordArgs = args.slice(2);
        if (coordArgs.length < 2 || coordArgs.length % 2 !== 0) {
            addError(context, lineNumber, 'COPPER 坐标参数必须成对出现');
            return;
        }

        const points = [];
        for (let j = 0; j < coordArgs.length; j += 2) {
            const px = resolveValue(coordArgs[j], lineNumber, context) + offsetDx;
            const py = resolveValue(coordArgs[j + 1], lineNumber, context) + offsetDy;
            if (isNaN(px) || isNaN(py)) {
                addError(context, lineNumber, 'COPPER 坐标包含无效数值');
                return;
            }
            points.push({ x: px, y: py });
        }

        if (points.length < 3) {
            addError(context, lineNumber, 'COPPER 至少需要 3 个坐标点');
            return;
        }

        for (const p of points) {
            if (!isInsideBoard(p.x, p.y)) {
                addError(context, lineNumber, `坐标越界: (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) 超出板面范围`);
                return;
            }
        }

        context.elements.copperPours.push({
            type: 'copperPour',
            net: net,
            layer: layer,
            clearance: 0.3,
            points: points,
            _sourceLine: lineNumber
        });
    }

    function isInsideBoard(x, y) {
        return x >= 0 && x <= BOARD_WIDTH && y >= 0 && y <= BOARD_HEIGHT;
    }

    function runPreview(scriptText) {
        const result = parseAndExecute(scriptText);
        if (result.success) {
            previewElements = result.elements;
        } else {
            previewElements = null;
        }
        return result;
    }

    function getPreviewElements() {
        return previewElements;
    }

    function clearPreview() {
        previewElements = null;
    }

    function applyToBoard() {
        if (!previewElements) return 0;

        PCBState.saveSnapshot();

        const state = PCBState.getState();
        let count = 0;

        for (const pad of previewElements.pads) {
            const newPad = {
                id: state.nextId++,
                type: 'pad',
                net: pad.net,
                x: pad.x,
                y: pad.y,
                diameter: pad.diameter,
                hole: pad.hole,
                layers: ['front', 'back']
            };
            state.pads.push(newPad);
            count++;
        }
        for (const track of previewElements.tracks) {
            const newTrack = {
                id: state.nextId++,
                type: 'track',
                net: track.net,
                layer: track.layer,
                width: track.width,
                points: track.points.map(p => ({ x: p.x, y: p.y }))
            };
            state.tracks.push(newTrack);
            count++;
        }
        for (const via of previewElements.vias) {
            const newVia = {
                id: state.nextId++,
                type: 'via',
                net: via.net,
                x: via.x,
                y: via.y,
                diameter: via.diameter || 0.6,
                hole: via.hole || 0.3,
                layers: ['front', 'back']
            };
            state.vias.push(newVia);
            count++;
        }
        for (const pour of previewElements.copperPours) {
            const newPour = {
                id: state.nextId++,
                type: 'copperPour',
                net: pour.net,
                layer: pour.layer,
                clearance: pour.clearance || 0.3,
                points: pour.points.map(p => ({ x: p.x, y: p.y }))
            };
            state.copperPours.push(newPour);
            count++;
        }

        PCBState.setState(state, { silent: true });

        addHistoryEntry(previewElements, count);

        previewElements = null;
        return count;
    }

    function addHistoryEntry(elements, count) {
        const totalPads = elements.pads.length;
        const totalTracks = elements.tracks.length;
        const totalVias = elements.vias.length;
        const totalPours = elements.copperPours.length;

        executionHistory.unshift({
            timestamp: Date.now(),
            elementCount: count,
            summary: {
                pads: totalPads,
                tracks: totalTracks,
                vias: totalVias,
                copperPours: totalPours
            }
        });

        if (executionHistory.length > MAX_HISTORY) {
            executionHistory = executionHistory.slice(0, MAX_HISTORY);
        }
    }

    function getExecutionHistory() {
        return executionHistory;
    }

    function getExampleScript() {
        return [
            '// 示例: BGA焊盘阵列',
            'LET cols = 4',
            'LET rows = 4',
            'LET spacing = 2.5',
            'LET start_x = 20',
            'LET start_y = 20',
            '',
            '// 放置4x4焊盘阵列',
            'REPEAT(rows, 0, spacing) {',
            '  REPEAT(cols, spacing, 0) {',
            '    PLACE_PAD($start_x, $start_y, 1.2, 0.6, NET1)',
            '  }',
            '}',
            '',
            '// 在中心位置打过孔',
            'LET cx = $start_x + ($cols - 1) * $spacing / 2',
            'LET cy = $start_y + ($rows - 1) * $spacing / 2',
            'VIA($cx, $cy, NET1)',
            '',
            '// 画走线连接',
            'TRACE(NET1, front, 0.25, $start_x, $start_y, $cx, $cy, $start_x + ($cols-1)*$spacing, $start_y)',
        ].join('\n');
    }

    return {
        parseAndExecute,
        runPreview,
        applyToBoard,
        getPreviewElements,
        clearPreview,
        getExecutionHistory,
        getExampleScript
    };
})();
