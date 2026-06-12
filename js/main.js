(function() {
    let previewingVersion = null;
    let scriptPanelOpen = false;
    let errorLines = [];
    let currentEditorLine = 0;
    let isResizingScript = false;
    let scriptResizeStartX = 0;
    let scriptResizeStartWidth = 0;
    let consoleCollapsed = false;

    async function init() {
        const canvas = document.getElementById('pcb-canvas');

        Render.init(canvas);
        Interaction.init(canvas);
        Interaction.bindToolbarEvents();
        Interaction.initPanelResizer();

        Collaboration.init();

        initScriptPanel();

        const boardId = await Collaboration.promptBoardId();
        if (!boardId) {
            PCBState.loadDemoData();
            afterStateInit();
            return;
        }

        setConnStatus('连接中...', 'warning');

        Collaboration.on('connected', (data) => {
            document.getElementById('board-id').textContent = data.boardId;
            setConnStatus('已连接', 'ok');
        });

        Collaboration.on('disconnected', () => {
            setConnStatus('已断开', 'warning');
        });

        Collaboration.on('error', () => {
            setConnStatus('错误', 'warning');
        });

        Collaboration.on('stateLoaded', (data) => {
            document.getElementById('version-label').textContent = 'v' + data.version;
            afterStateInit();
        });

        Collaboration.on('onlineCount', (count) => {
            document.getElementById('online-count').textContent = count;
        });

        Collaboration.on('remoteOperation', () => {
            afterChangeRefresh();
        });

        Collaboration.on('reverted', (data) => {
            document.getElementById('version-label').textContent = 'v' + data.version;
            hideVersionMenu();
            hidePreviewStatus();
            afterChangeRefresh();
        });

        Collaboration.on('previewEnter', (data) => {
            document.getElementById('version-label').textContent = 'v' + data.version + ' (预览)';
            showPreviewStatus();
            document.getElementById('version-preview-actions').style.display = 'flex';
            afterChangeRefresh();
        });

        Collaboration.on('previewExit', () => {
            const v = Collaboration.getCurrentVersion();
            document.getElementById('version-label').textContent = 'v' + v;
            hidePreviewStatus();
            document.getElementById('version-preview-actions').style.display = 'none';
            afterChangeRefresh();
        });

        Collaboration.connect(boardId);
        bindCollabUI();
    }

    function setConnStatus(text, cls) {
        const el = document.getElementById('conn-status');
        el.textContent = text;
        el.classList.remove('ok', 'warning');
        el.classList.add(cls);
    }

    function showPreviewStatus() {
        document.getElementById('preview-status').style.display = 'flex';
    }

    function hidePreviewStatus() {
        document.getElementById('preview-status').style.display = 'none';
    }

    function afterStateInit() {
        DRC.runCheck();
        Render.render();
        Interaction.updateZoomDisplay();
        Interaction.updateDRCDisplay();
        Interaction.updateLayerButtons();
        Interaction.updateToolButtons();

        window.addEventListener('resize', () => {
            Render.render();
        });
    }

    function afterChangeRefresh() {
        DRC.runCheck();
        Render.render();
        Interaction.updateDRCDisplay();
        Interaction.updateZoomDisplay();
        const panel = document.getElementById('report-panel');
        if (panel && panel.classList.contains('open')) {
            Interaction.renderReportPanel();
        }
    }

    function initScriptPanel() {
        const editor = document.getElementById('script-editor');
        const panel = document.getElementById('script-panel');

        editor.value = ScriptEngine.getExampleScript();
        updateLineNumbers();

        document.getElementById('btn-script').addEventListener('click', () => {
            toggleScriptPanel();
        });

        document.getElementById('script-close').addEventListener('click', () => {
            closeScriptPanel();
        });

        document.getElementById('script-run-preview').addEventListener('click', () => {
            runScriptPreview();
        });

        document.getElementById('script-apply').addEventListener('click', () => {
            applyScript();
        });

        document.getElementById('script-save').addEventListener('click', () => {
            saveScript();
        });

        document.getElementById('script-load').addEventListener('click', () => {
            showLoadDialog();
        });

        document.getElementById('script-console-toggle').addEventListener('click', () => {
            toggleConsole();
        });

        document.getElementById('script-load-close').addEventListener('click', () => {
            hideLoadDialog();
        });

        document.addEventListener('click', (e) => {
            const dialog = document.getElementById('script-load-dialog');
            if (dialog.classList.contains('show') && !dialog.contains(e.target) && e.target.id !== 'script-load') {
                hideLoadDialog();
            }
        });

        editor.addEventListener('input', () => {
            updateLineNumbers();
            clearErrorHighlights();
        });

        editor.addEventListener('scroll', () => {
            syncLineNumbers();
        });

        editor.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = editor.selectionStart;
                const end = editor.selectionEnd;
                editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
                editor.selectionStart = editor.selectionEnd = start + 2;
                updateLineNumbers();
            }
        });

        editor.addEventListener('click', () => {
            updateCurrentLine();
        });

        editor.addEventListener('keyup', () => {
            updateCurrentLine();
        });

        initScriptPanelResizer();
    }

    function toggleScriptPanel() {
        const panel = document.getElementById('script-panel');
        const btn = document.getElementById('btn-script');
        if (scriptPanelOpen) {
            closeScriptPanel();
        } else {
            panel.classList.add('open');
            btn.classList.add('active');
            scriptPanelOpen = true;
            setTimeout(() => Render.render(), 50);
        }
    }

    function closeScriptPanel() {
        const panel = document.getElementById('script-panel');
        const btn = document.getElementById('btn-script');
        panel.classList.remove('open');
        btn.classList.remove('active');
        scriptPanelOpen = false;
        ScriptEngine.clearPreview();
        errorLines = [];
        Render.render();
    }

    function updateLineNumbers() {
        const editor = document.getElementById('script-editor');
        const lineNumEl = document.getElementById('script-line-numbers');
        const lines = editor.value.split('\n');
        let html = '';
        for (let i = 1; i <= lines.length; i++) {
            const isError = errorLines.includes(i);
            const isCurrent = i === currentEditorLine;
            let cls = 'line-num';
            if (isError) cls += ' error-line';
            if (isCurrent) cls += ' current-line';
            html += `<span class="${cls}">${i}</span>`;
        }
        lineNumEl.innerHTML = html;
        syncLineNumbers();
    }

    function syncLineNumbers() {
        const editor = document.getElementById('script-editor');
        const lineNumEl = document.getElementById('script-line-numbers');
        lineNumEl.scrollTop = editor.scrollTop;
    }

    function updateCurrentLine() {
        const editor = document.getElementById('script-editor');
        const pos = editor.selectionStart;
        const textBefore = editor.value.substring(0, pos);
        const newLine = textBefore.split('\n').length;
        if (newLine !== currentEditorLine) {
            currentEditorLine = newLine;
            updateLineNumbers();
        }
    }

    function clearErrorHighlights() {
        errorLines = [];
        updateLineNumbers();
    }

    function runScriptPreview() {
        const editor = document.getElementById('script-editor');
        const scriptText = editor.value;

        clearConsole();
        appendConsole('info', '开始执行脚本...');

        const result = ScriptEngine.runPreview(scriptText);

        if (result.success) {
            const el = result.elements;
            const total = el.pads.length + el.tracks.length + el.vias.length + el.copperPours.length;
            appendConsole('success', `脚本解析成功! 共生成 ${total} 个元素:`);
            if (el.pads.length > 0) appendConsole('info', `  焊盘: ${el.pads.length}`);
            if (el.tracks.length > 0) appendConsole('info', `  走线: ${el.tracks.length}`);
            if (el.vias.length > 0) appendConsole('info', `  过孔: ${el.vias.length}`);
            if (el.copperPours.length > 0) appendConsole('info', `  铜区: ${el.copperPours.length}`);
            appendConsole('info', '预览叠加层已显示在画布上，点击"应用"写入板面');
            errorLines = [];
        } else {
            appendConsole('error', `脚本执行失败，共 ${result.errors.length} 个错误:`);
            for (const err of result.errors) {
                appendConsole('error', `  行 ${err.line}: ${err.message}`);
            }
            errorLines = result.errorLines;
        }

        updateLineNumbers();
        Render.render();
    }

    function applyScript() {
        const elements = ScriptEngine.getPreviewElements();
        if (!elements) {
            appendConsole('warn', '没有预览数据。请先点击"预览"运行脚本。');
            return;
        }

        const count = ScriptEngine.applyToBoard();
        appendConsole('success', `已应用 ${count} 个元素到板面!`);

        errorLines = [];
        updateLineNumbers();
        afterChangeRefresh();
    }

    function saveScript() {
        const editor = document.getElementById('script-editor');
        const name = prompt('请输入脚本名称:');
        if (!name || !name.trim()) return;

        const boardId = Collaboration.getBoardId();
        if (!boardId) {
            appendConsole('warn', '未连接到板面，脚本仅保存到本地');
            saveScriptLocal(name.trim(), editor.value);
            return;
        }

        saveScriptRemote(boardId, name.trim(), editor.value);
    }

    function saveScriptLocal(name, content) {
        let scripts = {};
        try {
            scripts = JSON.parse(localStorage.getItem('pcb_scripts') || '{}');
        } catch (e) {
            scripts = {};
        }
        scripts[name] = { content: content, savedAt: Date.now() };
        localStorage.setItem('pcb_scripts', JSON.stringify(scripts));
        appendConsole('success', `脚本 "${name}" 已保存到本地`);
    }

    async function saveScriptRemote(boardId, name, content) {
        try {
            const res = await fetch(`/api/boards/${boardId}/scripts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, content })
            });
            if (res.ok) {
                appendConsole('success', `脚本 "${name}" 已保存到服务器`);
            } else {
                const data = await res.json();
                appendConsole('error', `保存失败: ${data.error || res.statusText}`);
                saveScriptLocal(name, content);
            }
        } catch (e) {
            appendConsole('warn', `服务器不可达，脚本已保存到本地`);
            saveScriptLocal(name, content);
        }
    }

    function showLoadDialog() {
        const dialog = document.getElementById('script-load-dialog');
        dialog.classList.add('show');
        loadScriptList();
    }

    function hideLoadDialog() {
        const dialog = document.getElementById('script-load-dialog');
        dialog.classList.remove('show');
    }

    async function loadScriptList() {
        const listEl = document.getElementById('script-load-list');
        const boardId = Collaboration.getBoardId();

        let remoteScripts = [];
        if (boardId) {
            try {
                const res = await fetch(`/api/boards/${boardId}/scripts`);
                if (res.ok) {
                    remoteScripts = await res.json();
                }
            } catch (e) {
                // ignore
            }
        }

        let localScripts = [];
        try {
            const stored = JSON.parse(localStorage.getItem('pcb_scripts') || '{}');
            for (const [name, data] of Object.entries(stored)) {
                localScripts.push({
                    name: name,
                    savedAt: data.savedAt,
                    content: data.content,
                    source: 'local'
                });
            }
        } catch (e) {
            // ignore
        }

        const allScripts = [
            ...remoteScripts.map(s => ({ ...s, source: 'remote' })),
            ...localScripts
        ];

        if (allScripts.length === 0) {
            listEl.innerHTML = '<div class="empty-message">暂无已保存的脚本</div>';
            return;
        }

        let html = '';
        for (const s of allScripts) {
            const date = new Date(s.savedAt || s.created_at);
            const timeStr = date.toLocaleString('zh-CN');
            const sourceTag = s.source === 'remote' ? ' [服务器]' : ' [本地]';
            const id = s.id || '';
            html += `
                <div class="script-load-item" data-source="${s.source}" data-id="${id}" data-name="${escapeHtml(s.name)}">
                    <div class="script-load-item-info">
                        <span class="script-load-item-name">${escapeHtml(s.name)}${sourceTag}</span>
                        <span class="script-load-item-time">${timeStr}</span>
                    </div>
                    <button class="script-load-item-delete" data-source="${s.source}" data-id="${id}" data-name="${escapeHtml(s.name)}">删除</button>
                </div>
            `;
        }
        listEl.innerHTML = html;

        listEl.querySelectorAll('.script-load-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('script-load-item-delete')) return;
                loadScript(item);
            });
        });

        listEl.querySelectorAll('.script-load-item-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteScript(btn.dataset.source, btn.dataset.id, btn.dataset.name);
            });
        });
    }

    async function loadScript(item) {
        const source = item.dataset.source;
        const id = item.dataset.id;
        const name = item.dataset.name;
        let content = '';

        if (source === 'remote' && id) {
            try {
                const boardId = Collaboration.getBoardId();
                const res = await fetch(`/api/boards/${boardId}/scripts/${id}`);
                if (res.ok) {
                    const data = await res.json();
                    content = data.content;
                } else {
                    appendConsole('error', '加载远程脚本失败');
                    return;
                }
            } catch (e) {
                appendConsole('error', '加载远程脚本失败: ' + e.message);
                return;
            }
        } else {
            try {
                const stored = JSON.parse(localStorage.getItem('pcb_scripts') || '{}');
                if (stored[name]) {
                    content = stored[name].content;
                }
            } catch (e) {
                appendConsole('error', '加载本地脚本失败');
                return;
            }
        }

        if (content) {
            const editor = document.getElementById('script-editor');
            editor.value = content;
            updateLineNumbers();
            appendConsole('success', `已加载脚本: ${name}`);
        }

        hideLoadDialog();
    }

    async function deleteScript(source, id, name) {
        if (!confirm(`确定要删除脚本 "${name}" 吗?`)) return;

        if (source === 'remote' && id) {
            try {
                const boardId = Collaboration.getBoardId();
                await fetch(`/api/boards/${boardId}/scripts/${id}`, { method: 'DELETE' });
                appendConsole('info', `已删除远程脚本: ${name}`);
            } catch (e) {
                appendConsole('error', '删除远程脚本失败: ' + e.message);
                return;
            }
        } else {
            try {
                const stored = JSON.parse(localStorage.getItem('pcb_scripts') || '{}');
                delete stored[name];
                localStorage.setItem('pcb_scripts', JSON.stringify(stored));
                appendConsole('info', `已删除本地脚本: ${name}`);
            } catch (e) {
                // ignore
            }
        }

        loadScriptList();
    }

    function toggleConsole() {
        const console_ = document.getElementById('script-console');
        const icon = document.querySelector('.console-toggle-icon');
        consoleCollapsed = !consoleCollapsed;
        if (consoleCollapsed) {
            console_.classList.add('collapsed');
            icon.textContent = '▸';
        } else {
            console_.classList.remove('collapsed');
            icon.textContent = '▾';
        }
    }

    function clearConsole() {
        document.getElementById('console-content').innerHTML = '';
    }

    function appendConsole(type, message) {
        const content = document.getElementById('console-content');
        const line = document.createElement('div');
        line.className = 'console-line ' + type;
        const prefix = type === 'error' ? '✗ ' : type === 'success' ? '✓ ' : type === 'warn' ? '⚠ ' : '› ';
        line.textContent = prefix + message;
        content.appendChild(line);
        content.scrollTop = content.scrollHeight;
    }

    function initScriptPanelResizer() {
        const resizer = document.getElementById('script-resizer');
        const panel = document.getElementById('script-panel');

        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isResizingScript = true;
            scriptResizeStartX = e.clientX;
            scriptResizeStartWidth = panel.offsetWidth;
            resizer.classList.add('active');
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizingScript) return;
            const delta = e.clientX - scriptResizeStartX;
            let newWidth = scriptResizeStartWidth + delta;
            newWidth = Math.max(250, Math.min(500, newWidth));
            panel.style.width = newWidth + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isResizingScript) {
                isResizingScript = false;
                const resizer = document.getElementById('script-resizer');
                resizer.classList.remove('active');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                setTimeout(() => Render.render(), 50);
            }
        });
    }

    function bindCollabUI() {
        document.getElementById('btn-versions').addEventListener('click', async (e) => {
            e.stopPropagation();
            toggleVersionMenu();
        });

        document.getElementById('version-close').addEventListener('click', (e) => {
            e.stopPropagation();
            hideVersionMenu();
        });

        document.addEventListener('click', (e) => {
            const menu = document.getElementById('version-menu');
            if (!menu.contains(e.target) && e.target.id !== 'btn-versions') {
                hideVersionMenu();
            }
        });

        document.getElementById('btn-exit-preview').addEventListener('click', () => {
            Collaboration.exitPreview();
        });

        document.getElementById('btn-revert-confirm').addEventListener('click', async () => {
            if (!Collaboration.isPreviewMode() || previewingVersion === null) return;
            if (!confirm(`确定要回退到版本 v${previewingVersion} 吗？此操作将创建一个新版本。`)) return;
            try {
                await Collaboration.revertToVersion(previewingVersion);
                previewingVersion = null;
            } catch (e) {
                alert('回退失败: ' + e.message);
            }
        });

        document.getElementById('btn-save').addEventListener('click', async () => {
            const summary = prompt('请输入保存备注:', 'Manual save');
            if (summary === null) return;
            try {
                const data = await Collaboration.saveCurrentState(summary || 'Manual save');
                document.getElementById('version-label').textContent = 'v' + data.version;
                alert('已保存为版本 ' + data.version);
            } catch (e) {
                alert('保存失败: ' + e.message);
            }
        });
    }

    async function toggleVersionMenu() {
        const menu = document.getElementById('version-menu');
        if (menu.classList.contains('show')) {
            hideVersionMenu();
        } else {
            menu.classList.add('show');
            await loadVersions();
        }
    }

    function hideVersionMenu() {
        document.getElementById('version-menu').classList.remove('show');
    }

    async function loadVersions() {
        const listEl = document.getElementById('version-list');
        try {
            const versions = await Collaboration.fetchVersions();
            const recent = versions.slice(0, 10);
            if (recent.length === 0) {
                listEl.innerHTML = '<div class="empty-message">暂无版本</div>';
                return;
            }
            let html = '';
            for (const v of recent) {
                const date = new Date(v.created_at);
                const timeStr = date.toLocaleString('zh-CN');
                html += `
                    <div class="version-item" data-version="${v.version}">
                        <div class="version-row">
                            <span class="version-ver">v${v.version}</span>
                            <span class="version-time">${timeStr}</span>
                        </div>
                        <div class="version-summary">${escapeHtml(v.summary || '')}</div>
                    </div>
                `;
            }
            listEl.innerHTML = html;
            listEl.querySelectorAll('.version-item').forEach(item => {
                item.addEventListener('click', async () => {
                    const ver = parseInt(item.dataset.version);
                    try {
                        document.querySelectorAll('.version-item').forEach(i => i.classList.remove('selected'));
                        item.classList.add('selected');
                        await Collaboration.previewVersionState(ver);
                        previewingVersion = ver;
                    } catch (e) {
                        alert('加载版本失败: ' + e.message);
                    }
                });
            });
        } catch (e) {
            listEl.innerHTML = `<div class="empty-message">加载失败: ${escapeHtml(e.message)}</div>`;
        }
    }

    function escapeHtml(s) {
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
