(function() {
    let previewingVersion = null;
    let scriptPanelOpen = false;
    let currentBoardId = null;
    let errorLines = [];
    let isResizingScriptPanel = false;
    let resizeScriptStartX = 0;
    let resizeScriptStartWidth = 0;

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

        currentBoardId = boardId;
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

    function initScriptPanel() {
        const editor = document.getElementById('script-editor');
        const lineNumbers = document.getElementById('script-line-numbers');

        updateLineNumbers();

        editor.addEventListener('input', () => {
            updateLineNumbers();
            clearErrorHighlights();
        });

        editor.addEventListener('scroll', () => {
            lineNumbers.scrollTop = editor.scrollTop;
        });

        editor.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = editor.selectionStart;
                const end = editor.selectionEnd;
                editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
                editor.selectionStart = editor.selectionEnd = start + 4;
                updateLineNumbers();
            }
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                runScriptPreview();
            }
        });

        document.getElementById('btn-script-toggle').addEventListener('click', toggleScriptPanel);
        document.getElementById('script-close').addEventListener('click', () => closeScriptPanel());

        document.getElementById('btn-script-preview').addEventListener('click', runScriptPreview);
        document.getElementById('btn-script-apply').addEventListener('click', applyScript);
        document.getElementById('btn-script-save').addEventListener('click', openSaveDialog);
        document.getElementById('btn-script-load').addEventListener('click', openLoadDialog);

        document.getElementById('console-clear').addEventListener('click', () => {
            document.getElementById('console-output').innerHTML = '';
        });

        document.getElementById('script-save-cancel').addEventListener('click', closeSaveDialog);
        document.getElementById('script-save-confirm').addEventListener('click', confirmSaveScript);
        document.getElementById('script-load-cancel').addEventListener('click', closeLoadDialog);

        initScriptPanelResizer();
    }

    function toggleScriptPanel() {
        if (scriptPanelOpen) {
            closeScriptPanel();
        } else {
            openScriptPanel();
        }
    }

    function openScriptPanel() {
        document.getElementById('script-panel').classList.add('open');
        document.getElementById('btn-script-toggle').classList.add('active');
        scriptPanelOpen = true;
        setTimeout(() => Render.render(), 50);
    }

    function closeScriptPanel() {
        document.getElementById('script-panel').classList.remove('open');
        document.getElementById('btn-script-toggle').classList.remove('active');
        scriptPanelOpen = false;
        ScriptEngine.clearPreview();
        Render.setScriptPreviewElements(null);
        Render.render();
    }

    function updateLineNumbers() {
        const editor = document.getElementById('script-editor');
        const lineNumbers = document.getElementById('script-line-numbers');
        const lines = editor.value.split('\n');
        let html = '';
        for (let i = 1; i <= lines.length; i++) {
            const isError = errorLines.includes(i);
            html += '<span class="line-num' + (isError ? ' error-line' : '') + '">' + i + '</span>';
        }
        lineNumbers.innerHTML = html;
    }

    function clearErrorHighlights() {
        errorLines = [];
        updateLineNumbers();
    }

    function setErrorLines(lines) {
        errorLines = lines;
        updateLineNumbers();
    }

    function appendConsole(message, type) {
        const output = document.getElementById('console-output');
        const entry = document.createElement('div');
        entry.className = 'log-entry ' + (type || '');
        entry.textContent = message;
        output.appendChild(entry);
        output.scrollTop = output.scrollHeight;
    }

    function clearConsole() {
        document.getElementById('console-output').innerHTML = '';
    }

    function runScriptPreview() {
        const editor = document.getElementById('script-editor');
        const scriptText = editor.value.trim();
        if (!scriptText) {
            clearConsole();
            appendConsole('没有脚本内容', 'warning');
            return;
        }

        clearConsole();
        clearErrorHighlights();
        ScriptEngine.clearPreview();
        Render.setScriptPreviewElements(null);

        appendConsole('--- 开始执行脚本 ---', 'info');

        const result = ScriptEngine.runPreview(scriptText);

        for (const log of result.logs) {
            appendConsole('[行' + log.line + '] ' + log.message, '');
        }

        if (result.errors.length > 0) {
            const errLineNums = [];
            for (const err of result.errors) {
                appendConsole('[行' + err.line + '] 错误: ' + err.message, 'error');
                if (err.line > 0) errLineNums.push(err.line);
            }
            setErrorLines(errLineNums);
            appendConsole('--- 执行失败,共 ' + result.errors.length + ' 个错误 ---', 'error');
            Render.setScriptPreviewElements(null);
        } else {
            const totalElements = result.pads.length + result.tracks.length + result.vias.length + result.copperPours.length;
            Render.setScriptPreviewElements(ScriptEngine.getPreviewElements());
            appendConsole('--- 预览成功: ' +
                result.pads.length + ' 焊盘, ' +
                result.tracks.length + ' 走线, ' +
                result.vias.length + ' 过孔, ' +
                result.copperPours.length + ' 铜区 (共 ' + totalElements + ' 元素) ---', 'success');
        }

        Render.render();
    }

    function applyScript() {
        const previewEls = ScriptEngine.getPreviewElements();
        if (!previewEls) {
            appendConsole('请先运行预览再应用', 'warning');
            return;
        }

        const count = ScriptEngine.applyToState();
        Render.setScriptPreviewElements(null);

        appendConsole('--- 已应用到板面: ' + count + ' 个元素 (可通过撤销回退) ---', 'success');

        DRC.runCheck();
        Render.render();
        Interaction.updateDRCDisplay();
        Interaction.updateZoomDisplay();
    }

    function openSaveDialog() {
        document.getElementById('script-save-name').value = '';
        document.getElementById('script-save-dialog').style.display = 'flex';
        setTimeout(() => document.getElementById('script-save-name').focus(), 50);
    }

    function closeSaveDialog() {
        document.getElementById('script-save-dialog').style.display = 'none';
    }

    async function confirmSaveScript() {
        const name = document.getElementById('script-save-name').value.trim();
        if (!name) {
            alert('请输入脚本名称');
            return;
        }

        const editor = document.getElementById('script-editor');
        const content = editor.value;

        if (!currentBoardId) {
            localStorage.setItem('script_local_' + name, content);
            appendConsole('脚本已本地保存: ' + name, 'info');
            closeSaveDialog();
            return;
        }

        try {
            const resp = await fetch('/api/boards/' + currentBoardId + '/scripts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name, content: content })
            });
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.error || '保存失败');
            }
            appendConsole('脚本已保存: ' + name, 'success');
            closeSaveDialog();
        } catch (e) {
            appendConsole('保存失败: ' + e.message, 'error');
        }
    }

    async function openLoadDialog() {
        document.getElementById('script-load-dialog').style.display = 'flex';
        const listEl = document.getElementById('script-list');

        if (!currentBoardId) {
            listEl.innerHTML = '<div class="empty-message">未连接到服务器,无法加载</div>';
            return;
        }

        listEl.innerHTML = '<div class="empty-message">加载中...</div>';

        try {
            const resp = await fetch('/api/boards/' + currentBoardId + '/scripts');
            if (!resp.ok) throw new Error('加载失败');
            const scripts = await resp.json();

            if (scripts.length === 0) {
                listEl.innerHTML = '<div class="empty-message">暂无已保存的脚本</div>';
                return;
            }

            let html = '';
            for (const s of scripts) {
                const date = new Date(s.created_at);
                const timeStr = date.toLocaleString('zh-CN');
                html += '<div class="script-list-item" data-script-id="' + s.id + '">' +
                    '<div class="script-list-item-info">' +
                    '<div class="script-list-item-name">' + escapeHtml(s.name) + '</div>' +
                    '<div class="script-list-item-time">' + timeStr + '</div>' +
                    '</div>' +
                    '<button class="script-list-item-delete" data-delete-id="' + s.id + '" title="删除">×</button>' +
                    '</div>';
            }
            listEl.innerHTML = html;

            listEl.querySelectorAll('.script-list-item').forEach(item => {
                item.addEventListener('click', async (e) => {
                    if (e.target.classList.contains('script-list-item-delete')) return;
                    const id = item.dataset.scriptId;
                    await loadScriptById(id);
                });
            });

            listEl.querySelectorAll('.script-list-item-delete').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const id = btn.dataset.deleteId;
                    await deleteScriptById(id);
                });
            });
        } catch (e) {
            listEl.innerHTML = '<div class="empty-message">加载失败: ' + escapeHtml(e.message) + '</div>';
        }
    }

    async function loadScriptById(id) {
        try {
            const resp = await fetch('/api/boards/' + currentBoardId + '/scripts/' + id);
            if (!resp.ok) throw new Error('加载失败');
            const data = await resp.json();
            document.getElementById('script-editor').value = data.content;
            updateLineNumbers();
            clearErrorHighlights();
            appendConsole('已加载脚本: ' + data.name, 'info');
            closeLoadDialog();
        } catch (e) {
            appendConsole('加载失败: ' + e.message, 'error');
        }
    }

    async function deleteScriptById(id) {
        if (!confirm('确定要删除这个脚本吗?')) return;
        try {
            const resp = await fetch('/api/boards/' + currentBoardId + '/scripts/' + id, {
                method: 'DELETE'
            });
            if (!resp.ok) throw new Error('删除失败');
            appendConsole('脚本已删除', 'info');
            openLoadDialog();
        } catch (e) {
            appendConsole('删除失败: ' + e.message, 'error');
        }
    }

    function closeLoadDialog() {
        document.getElementById('script-load-dialog').style.display = 'none';
    }

    function initScriptPanelResizer() {
        const resizer = document.getElementById('script-resizer');
        const panel = document.getElementById('script-panel');

        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isResizingScriptPanel = true;
            resizeScriptStartX = e.clientX;
            resizeScriptStartWidth = panel.offsetWidth;
            resizer.classList.add('active');
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizingScriptPanel) return;
            const delta = e.clientX - resizeScriptStartX;
            let newWidth = resizeScriptStartWidth + delta;
            newWidth = Math.max(250, Math.min(500, newWidth));
            panel.style.width = newWidth + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isResizingScriptPanel) {
                isResizingScriptPanel = false;
                const resizer = document.getElementById('script-resizer');
                resizer.classList.remove('active');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                setTimeout(() => Render.render(), 50);
            }
        });
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
