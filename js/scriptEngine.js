const ScriptEngine = (function() {
    const BOARD_WIDTH = 100;
    const BOARD_HEIGHT = 80;
    const MAX_REPEAT_DEPTH = 3;
    const MAX_HISTORY = 20;

    let previewElements = null;
    let executionHistory = [];

    function evaluateExpression(expr, variables) {
        if (typeof expr !== 'string') return expr;
        let resolved = expr;
        resolved = resolved.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name) => {
            if (variables.hasOwnProperty(name)) {
                return String(variables[name]);
            }
            throw new Error('Undefined variable: $' + name);
        });
        if (!/^[\d\s\+\-\*\/\.\(\)]+$/.test(resolved)) {
            return resolved;
        }
        try {
            const fn = new Function('return (' + resolved + ')');
            const result = fn();
            if (typeof result === 'number' && isFinite(result)) {
                return result;
            }
            return resolved;
        } catch (e) {
            return resolved;
        }
    }

    function parseArgList(argsStr) {
        const args = [];
        let depth = 0;
        let current = '';
        for (let i = 0; i < argsStr.length; i++) {
            const ch = argsStr[i];
            if (ch === '(') { depth++; current += ch; }
            else if (ch === ')') { depth--; current += ch; }
            else if (ch === ',' && depth === 0) {
                args.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
        if (current.trim()) args.push(current.trim());
        return args;
    }

    function tokenizeLines(scriptText) {
        const rawLines = scriptText.split('\n');
        const tokens = [];
        let i = 0;
        while (i < rawLines.length) {
            const trimmed = rawLines[i].trim();
            if (!trimmed || trimmed.startsWith('//')) {
                i++;
                continue;
            }
            if (trimmed.startsWith('LET ')) {
                tokens.push({ line: i + 1, type: 'let', text: trimmed });
                i++;
            } else if (trimmed.startsWith('REPEAT(')) {
                const repeatBody = [];
                const startLine = i + 1;
                let fullText = trimmed;
                let braceDepth = 0;
                let foundOpen = false;
                for (let ci = 0; ci < trimmed.length; ci++) {
                    if (trimmed[ci] === '{') { braceDepth++; foundOpen = true; }
                    if (trimmed[ci] === '}') braceDepth--;
                }
                if (foundOpen && braceDepth === 0) {
                    tokens.push({ line: startLine, type: 'repeat_inline', text: trimmed });
                    i++;
                    continue;
                }
                i++;
                while (i < rawLines.length && braceDepth > 0) {
                    const inner = rawLines[i];
                    for (let ci = 0; ci < inner.length; ci++) {
                        if (inner[ci] === '{') { braceDepth++; foundOpen = true; }
                        if (inner[ci] === '}') braceDepth--;
                    }
                    repeatBody.push(inner);
                    i++;
                }
                tokens.push({
                    line: startLine,
                    type: 'repeat_block',
                    header: fullText,
                    body: repeatBody.join('\n')
                });
            } else if (trimmed.startsWith('PLACE_PAD(') ||
                       trimmed.startsWith('TRACE(') ||
                       trimmed.startsWith('VIA(') ||
                       trimmed.startsWith('COPPER(')) {
                let full = trimmed;
                let parenDepth = 0;
                for (const ch of trimmed) {
                    if (ch === '(') parenDepth++;
                    if (ch === ')') parenDepth--;
                }
                let startLine = i + 1;
                while (parenDepth > 0 && i + 1 < rawLines.length) {
                    i++;
                    const next = rawLines[i];
                    for (const ch of next) {
                        if (ch === '(') parenDepth++;
                        if (ch === ')') parenDepth--;
                    }
                    full += ' ' + next.trim();
                }
                tokens.push({ line: startLine, type: 'command', text: full });
                i++;
            } else {
                tokens.push({ line: i + 1, type: 'command', text: trimmed });
                i++;
            }
        }
        return tokens;
    }

    function executeScript(scriptText) {
        const result = {
            pads: [],
            tracks: [],
            vias: [],
            copperPours: [],
            errors: [],
            logs: []
        };

        const variables = {};
        const tokens = tokenizeLines(scriptText);

        function processTokens(tokList, repeatDepth) {
            if (repeatDepth > MAX_REPEAT_DEPTH) {
                result.errors.push({ line: 0, message: 'REPEAT nesting exceeds maximum depth of ' + MAX_REPEAT_DEPTH });
                return;
            }
            for (const token of tokList) {
                try {
                    if (token.type === 'let') {
                        processLet(token, variables);
                    } else if (token.type === 'repeat_inline' || token.type === 'repeat_block') {
                        processRepeat(token, variables, repeatDepth + 1);
                    } else if (token.type === 'command') {
                        processCommand(token, variables);
                    }
                } catch (e) {
                    result.errors.push({ line: token.line, message: e.message });
                    return;
                }
            }
        }

        function processLet(token, vars) {
            const rest = token.text.substring(4).trim();
            const eqIdx = rest.indexOf('=');
            if (eqIdx < 0) throw new Error('LET syntax error: expected LET name=value');
            const name = rest.substring(0, eqIdx).trim();
            const valueStr = rest.substring(eqIdx + 1).trim();
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
                throw new Error('Invalid variable name: ' + name);
            }
            const val = evaluateExpression(valueStr, vars);
            if (typeof val !== 'number') {
                throw new Error('LET value must be a number, got: ' + val);
            }
            vars[name] = val;
            result.logs.push({ line: token.line, message: 'LET ' + name + ' = ' + val });
        }

        function processRepeat(token, vars, newDepth) {
            let header = token.header || token.text;
            const parenStart = header.indexOf('(');
            const parenEnd = header.indexOf(')');
            if (parenStart < 0 || parenEnd < 0) {
                throw new Error('REPEAT syntax error: expected REPEAT(count,dx,dy){...}');
            }
            const argsStr = header.substring(parenStart + 1, parenEnd);
            const rawArgs = argsStr.split(',').map(s => s.trim());
            if (rawArgs.length < 3) {
                throw new Error('REPEAT requires 3 arguments: count, dx, dy');
            }
            const count = Math.round(evaluateExpression(rawArgs[0], vars));
            const dx = evaluateExpression(rawArgs[1], vars);
            const dy = evaluateExpression(rawArgs[2], vars);
            if (typeof count !== 'number' || typeof dx !== 'number' || typeof dy !== 'number') {
                throw new Error('REPEAT arguments must be numbers');
            }
            if (count < 0 || count > 1000) {
                throw new Error('REPEAT count must be between 0 and 1000');
            }

            let bodyText;
            if (token.type === 'repeat_inline') {
                const braceStart = header.indexOf('{');
                const braceEnd = header.lastIndexOf('}');
                if (braceStart < 0 || braceEnd < 0) {
                    throw new Error('REPEAT missing braces {...}');
                }
                bodyText = header.substring(braceStart + 1, braceEnd).trim();
            } else {
                let body = token.body;
                const lastBrace = body.lastIndexOf('}');
                if (lastBrace >= 0) body = body.substring(0, lastBrace);
                const firstBrace = body.indexOf('{');
                if (firstBrace >= 0) body = body.substring(firstBrace + 1);
                bodyText = body.trim();
            }

            for (let i = 0; i < count; i++) {
                const savedVars = Object.assign({}, vars);
                vars['_i'] = i;
                vars['_dx'] = dx;
                vars['_dy'] = dy;
                const innerTokens = tokenizeLines(bodyText);
                for (const innerToken of innerTokens) {
                    try {
                        if (innerToken.type === 'let') {
                            processLet(innerToken, vars);
                        } else if (innerToken.type === 'repeat_inline' || innerToken.type === 'repeat_block') {
                            processRepeat(innerToken, vars, newDepth + 1);
                        } else if (innerToken.type === 'command') {
                            processCommandWithOffset(innerToken, vars, dx * i, dy * i);
                        }
                    } catch (e) {
                        result.errors.push({ line: token.line, message: e.message });
                        Object.assign(vars, savedVars);
                        return;
                    }
                }
                Object.assign(vars, savedVars);
                vars['_i'] = i;
            }
        }

        function processCommand(token, vars) {
            processCommandWithOffset(token, vars, 0, 0);
        }

        function processCommandWithOffset(token, vars, offsetX, offsetY) {
            const text = token.text;
            if (text.startsWith('PLACE_PAD(')) {
                processPlacePad(token, vars, offsetX, offsetY);
            } else if (text.startsWith('TRACE(')) {
                processTrace(token, vars, offsetX, offsetY);
            } else if (text.startsWith('VIA(')) {
                processVia(token, vars, offsetX, offsetY);
            } else if (text.startsWith('COPPER(')) {
                processCopper(token, vars, offsetX, offsetY);
            } else {
                throw new Error('Unknown command: ' + text.split('(')[0]);
            }
        }

        function extractCallArgs(text, cmdName) {
            const prefix = cmdName + '(';
            if (!text.startsWith(prefix)) throw new Error('Expected ' + cmdName + '(...)');
            let depth = 0;
            let start = -1;
            let end = -1;
            for (let i = 0; i < text.length; i++) {
                if (text[i] === '(') {
                    if (start < 0) start = i + 1;
                    depth++;
                }
                if (text[i] === ')') {
                    depth--;
                    if (depth === 0) { end = i; break; }
                }
            }
            if (start < 0 || end < 0) throw new Error(cmdName + ' missing closing parenthesis');
            return parseArgList(text.substring(start, end));
        }

        function checkBounds(x, y, line) {
            if (x < 0 || x > BOARD_WIDTH || y < 0 || y > BOARD_HEIGHT) {
                throw new Error('Coordinate out of bounds: (' + x.toFixed(2) + ', ' + y.toFixed(2) + ')');
            }
        }

        function processPlacePad(token, vars, ox, oy) {
            const rawArgs = extractCallArgs(token.text, 'PLACE_PAD');
            if (rawArgs.length < 5) throw new Error('PLACE_PAD requires 5 arguments: x, y, diameter, hole, net');
            const x = evaluateExpression(rawArgs[0], vars) + ox;
            const y = evaluateExpression(rawArgs[1], vars) + oy;
            const diameter = evaluateExpression(rawArgs[2], vars);
            const hole = evaluateExpression(rawArgs[3], vars);
            const net = String(evaluateExpression(rawArgs[4], vars));
            if (typeof x !== 'number' || typeof y !== 'number') throw new Error('PLACE_PAD x,y must be numbers');
            if (typeof diameter !== 'number' || typeof hole !== 'number') throw new Error('PLACE_PAD diameter,hole must be numbers');
            checkBounds(x, y, token.line);
            result.pads.push({
                id: '__script__' + result.pads.length,
                type: 'pad',
                net: net,
                x: x,
                y: y,
                diameter: diameter,
                hole: hole,
                layers: ['front', 'back']
            });
            result.logs.push({ line: token.line, message: 'PLACE_PAD at (' + x.toFixed(2) + ', ' + y.toFixed(2) + ') net=' + net });
        }

        function processTrace(token, vars, ox, oy) {
            const rawArgs = extractCallArgs(token.text, 'TRACE');
            if (rawArgs.length < 5) throw new Error('TRACE requires: net, layer, width, x1, y1, ...');
            const net = String(evaluateExpression(rawArgs[0], vars));
            const layer = String(evaluateExpression(rawArgs[1], vars));
            const width = evaluateExpression(rawArgs[2], vars);
            if (typeof width !== 'number') throw new Error('TRACE width must be a number');
            if (layer !== 'front' && layer !== 'back') throw new Error('TRACE layer must be "front" or "back"');
            const points = [];
            for (let i = 3; i < rawArgs.length - 1; i += 2) {
                const px = evaluateExpression(rawArgs[i], vars) + ox;
                const py = evaluateExpression(rawArgs[i + 1], vars) + oy;
                if (typeof px !== 'number' || typeof py !== 'number') {
                    throw new Error('TRACE point coordinates must be numbers');
                }
                checkBounds(px, py, token.line);
                points.push({ x: px, y: py });
            }
            if (points.length < 2) throw new Error('TRACE needs at least 2 points');
            result.tracks.push({
                id: '__script__' + result.tracks.length,
                type: 'track',
                net: net,
                layer: layer,
                width: width,
                points: points
            });
            result.logs.push({ line: token.line, message: 'TRACE ' + net + ' on ' + layer + ', ' + points.length + ' points' });
        }

        function processVia(token, vars, ox, oy) {
            const rawArgs = extractCallArgs(token.text, 'VIA');
            if (rawArgs.length < 2) throw new Error('VIA requires 2 arguments: x, y');
            const x = evaluateExpression(rawArgs[0], vars) + ox;
            const y = evaluateExpression(rawArgs[1], vars) + oy;
            if (typeof x !== 'number' || typeof y !== 'number') throw new Error('VIA x,y must be numbers');
            checkBounds(x, y, token.line);
            result.vias.push({
                id: '__script__' + result.vias.length,
                type: 'via',
                net: 'NET1',
                x: x,
                y: y,
                diameter: 0.6,
                hole: 0.3,
                layers: ['front', 'back']
            });
            result.logs.push({ line: token.line, message: 'VIA at (' + x.toFixed(2) + ', ' + y.toFixed(2) + ')' });
        }

        function processCopper(token, vars, ox, oy) {
            const rawArgs = extractCallArgs(token.text, 'COPPER');
            if (rawArgs.length < 4) throw new Error('COPPER requires: net, layer, x1, y1, ...');
            const net = String(evaluateExpression(rawArgs[0], vars));
            const layer = String(evaluateExpression(rawArgs[1], vars));
            if (layer !== 'front' && layer !== 'back') throw new Error('COPPER layer must be "front" or "back"');
            const points = [];
            for (let i = 2; i < rawArgs.length - 1; i += 2) {
                const px = evaluateExpression(rawArgs[i], vars) + ox;
                const py = evaluateExpression(rawArgs[i + 1], vars) + oy;
                if (typeof px !== 'number' || typeof py !== 'number') {
                    throw new Error('COPPER point coordinates must be numbers');
                }
                checkBounds(px, py, token.line);
                points.push({ x: px, y: py });
            }
            if (points.length < 3) throw new Error('COPPER needs at least 3 points');
            result.copperPours.push({
                id: '__script__' + result.copperPours.length,
                type: 'copperPour',
                net: net,
                layer: layer,
                points: points,
                clearance: 0.3
            });
            result.logs.push({ line: token.line, message: 'COPPER ' + net + ' on ' + layer + ', ' + points.length + ' points' });
        }

        processTokens(tokens, 0);
        return result;
    }

    let _lastScriptContent = '';

    function runPreview(scriptText) {
        const result = executeScript(scriptText);
        if (result.errors.length === 0) {
            previewElements = {
                pads: result.pads,
                tracks: result.tracks,
                vias: result.vias,
                copperPours: result.copperPours
            };
            _lastScriptContent = scriptText;
        }
        return result;
    }

    function clearPreview() {
        previewElements = null;
    }

    function getPreviewElements() {
        return previewElements;
    }

    function applyToState() {
        if (!previewElements) return 0;
        let count = 0;
        count += (previewElements.pads || []).length;
        count += (previewElements.tracks || []).length;
        count += (previewElements.vias || []).length;
        count += (previewElements.copperPours || []).length;
        PCBState.batchApply(previewElements);
        const historyEntry = {
            time: new Date().toISOString(),
            scriptContent: _lastScriptContent,
            elementCount: count
        };
        executionHistory.push(historyEntry);
        if (executionHistory.length > MAX_HISTORY) {
            executionHistory = executionHistory.slice(-MAX_HISTORY);
        }
        previewElements = null;
        return count;
    }

    function getHistory() {
        return executionHistory;
    }

    return {
        runPreview,
        clearPreview,
        getPreviewElements,
        applyToState,
        getHistory,
        executeScript
    };
})();
