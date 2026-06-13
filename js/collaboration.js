const Collaboration = (function() {
    let ws = null;
    let boardId = null;
    let currentVersion = 1;
    let onlineCount = 0;
    let isReadOnly = false;
    let previewVersion = null;
    let previewState = null;
    let previewAnnotations = null;
    let listeners = {};

    function on(event, cb) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(cb);
    }

    function emit(event, data) {
        (listeners[event] || []).forEach(cb => { try { cb(data); } catch (e) { console.error(e); } });
    }

    function getWsUrl() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        return `${proto}://${location.host}/ws`;
    }

    async function promptBoardId() {
        const saved = localStorage.getItem('pcb_board_id');
        const input = prompt('请输入 Board ID（留空创建新板，demo 为演示板）:', saved || 'demo');
        if (input === null) return null;
        const id = input.trim();
        if (id) {
            localStorage.setItem('pcb_board_id', id);
            return id;
        }
        try {
            const res = await fetch('/api/boards', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'New Board' })
            });
            const data = await res.json();
            localStorage.setItem('pcb_board_id', data.board_id);
            return data.board_id;
        } catch (e) {
            alert('创建新板失败: ' + e.message);
            return null;
        }
    }

    async function connect(id) {
        boardId = id;
        const url = getWsUrl() + `?board_id=${encodeURIComponent(id)}`;
        ws = new WebSocket(url);

        ws.onopen = async () => {
            emit('connected', { boardId: id });
            if (typeof Annotation !== 'undefined') {
                try {
                    await Annotation.fetchAll();
                    emit('annotationsLoaded');
                } catch (e) {
                    console.error('Failed to load annotations on connect:', e);
                }
            }
        };

        ws.onclose = (e) => {
            emit('disconnected', { code: e.code, reason: e.reason });
        };

        ws.onerror = (err) => {
            emit('error', err);
        };

        ws.onmessage = (evt) => {
            let msg;
            try { msg = JSON.parse(evt.data); } catch { return; }
            handleMessage(msg);
        };
    }

    function handleMessage(msg) {
        switch (msg.type) {
            case 'fullState':
                currentVersion = msg.payload.version;
                PCBState.setState(msg.payload.state, { silent: true, noEmit: true });
                emit('stateLoaded', { version: currentVersion });
                break;
            case 'operation':
                if (!isReadOnly) {
                    PCBState.applyOperation(msg.payload);
                    emit('remoteOperation', msg.payload);
                }
                break;
            case 'onlineCount':
                onlineCount = msg.payload.count;
                emit('onlineCount', onlineCount);
                break;
            case 'annotationsInit':
                if (typeof Annotation !== 'undefined') {
                    Annotation.loadFromServer(msg.payload);
                }
                break;
            case 'annotationCreated':
            case 'annotationUpdated':
            case 'annotationDeleted':
            case 'annotationReplyAdded':
                if (typeof Annotation !== 'undefined') {
                    Annotation.handleRemoteMessage(msg);
                }
                break;
            case 'revert':
                currentVersion = msg.payload.version;
                PCBState.setState(msg.payload.state, { silent: true, noEmit: true });
                previewVersion = null;
                previewState = null;
                isReadOnly = false;
                emit('reverted', { version: currentVersion });
                break;
        }
    }

    function sendOperation(op) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'operation', payload: op }));
    }

    function getBoardId() { return boardId; }
    function getOnlineCount() { return onlineCount; }
    function getCurrentVersion() { return currentVersion; }
    function isPreviewMode() { return previewVersion !== null; }
    function isReadOnlyMode() { return isReadOnly; }

    async function fetchVersions() {
        const res = await fetch(`/api/boards/${boardId}/versions`);
        return res.json();
    }

    async function fetchVersion(ver) {
        const res = await fetch(`/api/boards/${boardId}/versions/${ver}`);
        return res.json();
    }

    async function previewVersionState(ver) {
        const data = await fetchVersion(ver);
        previewVersion = ver;
        previewState = PCBState.getState();
        if (typeof Annotation !== 'undefined') {
            previewAnnotations = Annotation.getAllAnnotations();
            const versionAnnotations = await Annotation.fetchForVersion(ver);
            Annotation.setAnnotationsList(versionAnnotations);
        }
        isReadOnly = true;
        PCBState.setState(data.state, { silent: true, noEmit: true });
        emit('previewEnter', { version: ver });
        return data;
    }

    function exitPreview() {
        if (previewState) {
            PCBState.setState(previewState, { silent: true, noEmit: true });
        }
        if (typeof Annotation !== 'undefined' && previewAnnotations) {
            Annotation.setAnnotationsList(previewAnnotations);
            previewAnnotations = null;
        }
        previewVersion = null;
        previewState = null;
        isReadOnly = false;
        emit('previewExit', {});
    }

    async function revertToVersion(ver) {
        const res = await fetch(`/api/boards/${boardId}/revert/${ver}`, { method: 'POST' });
        return res.json();
    }

    async function saveCurrentState(summary) {
        const res = await fetch(`/api/boards/${boardId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: PCBState.getState(), summary })
        });
        const data = await res.json();
        currentVersion = data.version;
        emit('saved', { version: currentVersion });
        return data;
    }

    function init() {
        PCBState.onOperation((op) => {
            if (!isReadOnly) sendOperation(op);
        });
    }

    return {
        init,
        connect,
        promptBoardId,
        getBoardId,
        getOnlineCount,
        getCurrentVersion,
        isPreviewMode,
        isReadOnlyMode,
        fetchVersions,
        fetchVersion,
        previewVersionState,
        exitPreview,
        revertToVersion,
        saveCurrentState,
        on
    };
})();
