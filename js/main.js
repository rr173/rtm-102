(function() {
    let previewingVersion = null;

    async function init() {
        const canvas = document.getElementById('pcb-canvas');

        Render.init(canvas);
        Interaction.init(canvas);
        Interaction.bindToolbarEvents();
        Interaction.initPanelResizer();

        Collaboration.init();

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
