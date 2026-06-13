const Annotation = (function() {
    let annotations = [];
    let listeners = [];
    let currentFilter = { status: 'all', priority: 'all', assignee: 'all' };

    function on(cb) {
        listeners.push(cb);
        return () => {
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
        };
    }

    function emit(event, data) {
        for (const l of listeners) {
            try { l(event, data); } catch (e) { console.error(e); }
        }
    }

    function loadFromServer(data) {
        annotations = data.annotations || [];
        emit('loaded', { annotations });
    }

    function getAnnotations() {
        return filterAnnotations(annotations);
    }

    function getAllAnnotations() {
        return annotations;
    }

    function filterAnnotations(list) {
        let result = list;
        if (currentFilter.status !== 'all') {
            result = result.filter(a => a.status === currentFilter.status);
        }
        if (currentFilter.priority !== 'all') {
            result = result.filter(a => a.priority === currentFilter.priority);
        }
        if (currentFilter.assignee !== 'all') {
            result = result.filter(a => a.assignee === currentFilter.assignee);
        }
        return result;
    }

    function setFilter(filter) {
        Object.assign(currentFilter, filter);
        emit('filterChanged', { filter: currentFilter });
    }

    function getFilter() {
        return currentFilter;
    }

    function getUniqueAssignees() {
        const set = new Set();
        for (const a of annotations) {
            if (a.assignee) set.add(a.assignee);
        }
        return [...set].sort();
    }

    function findById(id) {
        return annotations.find(a => a.id === id);
    }

    function findByElement(elementType, elementId) {
        return annotations.filter(a =>
            a.target_type === 'element' &&
            a.target_element_type === elementType &&
            a.target_element_id === elementId
        );
    }

    function findAtPosition(worldPos, tolerance) {
        tolerance = tolerance || 1.0;
        const results = [];
        for (const a of annotations) {
            if (a.target_type === 'element' && a.target_position) {
                const pos = a.target_position;
                if (Math.abs(worldPos.x - pos.x) <= tolerance && Math.abs(worldPos.y - pos.y) <= tolerance) {
                    results.push(a);
                }
            } else if (a.target_type === 'area' && a.area_rect) {
                const r = a.area_rect;
                if (worldPos.x >= r.x && worldPos.x <= r.x + r.w &&
                    worldPos.y >= r.y && worldPos.y <= r.y + r.h) {
                    results.push(a);
                }
            }
        }
        return results;
    }

    function isTargetElementExisting(ann) {
        if (ann.target_type !== 'element') return true;
        const state = PCBState.getState();
        const elementType = ann.target_element_type;
        const elementId = ann.target_element_id;
        if (!elementType || elementId == null) return true;
        let list;
        switch (elementType) {
            case 'pad': list = state.pads; break;
            case 'track': list = state.tracks; break;
            case 'via': list = state.vias; break;
            case 'copperPour': list = state.copperPours; break;
            default: return true;
        }
        return list.some(e => e.id === elementId);
    }

    function getAnnotationMarkerPosition(ann) {
        if (ann.target_type === 'element' && ann.target_position) {
            return { x: ann.target_position.x, y: ann.target_position.y };
        }
        if (ann.target_type === 'area' && ann.area_rect) {
            const r = ann.area_rect;
            return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
        }
        return null;
    }

    async function createAnnotation(data) {
        const boardId = Collaboration.getBoardId();
        if (!boardId) {
            const ann = {
                id: 'local_' + Date.now(),
                board_id: 'local',
                target_type: data.target_type,
                target_element_type: data.target_element_type || null,
                target_element_id: data.target_element_id || null,
                target_position: data.target_position || null,
                area_rect: data.area_rect || null,
                description: data.description,
                priority: data.priority || 'medium',
                assignee: data.assignee || '',
                status: 'open',
                created_by: 'local',
                created_at: Date.now(),
                updated_at: Date.now(),
                version_created: Collaboration.getCurrentVersion() || 1,
                replies: []
            };
            annotations.push(ann);
            emit('created', { annotation: ann });
            return ann;
        }
        try {
            const res = await fetch(`/api/boards/${boardId}/annotations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || res.statusText);
            }
            const ann = await res.json();
            const idx = annotations.findIndex(a => a.id === ann.id);
            if (idx < 0) {
                annotations.push(ann);
            } else {
                annotations[idx] = ann;
            }
            emit('created', { annotation: ann });
            return ann;
        } catch (e) {
            console.error('Failed to create annotation:', e);
            throw e;
        }
    }

    async function updateAnnotation(id, updates) {
        const boardId = Collaboration.getBoardId();
        if (!boardId) {
            const ann = annotations.find(a => a.id === id);
            if (ann) {
                Object.assign(ann, updates, { updated_at: Date.now() });
                emit('updated', { annotation: ann });
            }
            return ann;
        }
        try {
            const res = await fetch(`/api/boards/${boardId}/annotations/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || res.statusText);
            }
            const ann = await res.json();
            const idx = annotations.findIndex(a => a.id === id);
            if (idx >= 0) {
                annotations[idx] = ann;
            }
            emit('updated', { annotation: ann });
            return ann;
        } catch (e) {
            console.error('Failed to update annotation:', e);
            throw e;
        }
    }

    async function deleteAnnotation(id) {
        const boardId = Collaboration.getBoardId();
        if (!boardId) {
            annotations = annotations.filter(a => a.id !== id);
            emit('deleted', { id });
            return;
        }
        try {
            const res = await fetch(`/api/boards/${boardId}/annotations/${id}`, {
                method: 'DELETE'
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || res.statusText);
            }
            annotations = annotations.filter(a => a.id !== id);
            emit('deleted', { id });
        } catch (e) {
            console.error('Failed to delete annotation:', e);
            throw e;
        }
    }

    async function addReply(annotationId, content) {
        const boardId = Collaboration.getBoardId();
        if (!boardId) {
            const ann = annotations.find(a => a.id === annotationId);
            if (ann) {
                ann.replies.push({
                    id: 'local_reply_' + Date.now(),
                    annotation_id: annotationId,
                    content: content,
                    author: 'local',
                    created_at: Date.now()
                });
                ann.updated_at = Date.now();
                emit('replyAdded', { annotation_id: annotationId });
            }
            return;
        }
        try {
            const res = await fetch(`/api/boards/${boardId}/annotations/${annotationId}/replies`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || res.statusText);
            }
            const reply = await res.json();
            const ann = annotations.find(a => a.id === annotationId);
            if (ann) {
                const exists = ann.replies.some(r => r.id === reply.id);
                if (!exists) ann.replies.push(reply);
                ann.updated_at = Date.now();
            }
            emit('replyAdded', { annotation_id: annotationId, reply });
        } catch (e) {
            console.error('Failed to add reply:', e);
            throw e;
        }
    }

    async function resolveAnnotation(id) {
        return updateAnnotation(id, { status: 'resolved' });
    }

    async function reopenAnnotation(id) {
        return updateAnnotation(id, { status: 'open' });
    }

    function handleRemoteMessage(msg) {
        switch (msg.type) {
            case 'annotationCreated': {
                const ann = msg.payload;
                const exists = annotations.some(a => a.id === ann.id);
                if (!exists) {
                    annotations.push(ann);
                    emit('remoteCreated', { annotation: ann });
                }
                break;
            }
            case 'annotationUpdated': {
                const ann = msg.payload;
                const idx = annotations.findIndex(a => a.id === ann.id);
                if (idx >= 0) {
                    annotations[idx] = ann;
                } else {
                    annotations.push(ann);
                }
                emit('remoteUpdated', { annotation: ann });
                break;
            }
            case 'annotationDeleted': {
                const id = msg.payload.id;
                annotations = annotations.filter(a => a.id !== id);
                emit('remoteDeleted', { id });
                break;
            }
            case 'annotationReplyAdded': {
                const { annotation_id, reply } = msg.payload;
                const ann = annotations.find(a => a.id === annotation_id);
                if (ann) {
                    const exists = ann.replies.some(r => r.id === reply.id);
                    if (!exists) {
                        ann.replies.push(reply);
                        ann.updated_at = Date.now();
                    }
                }
                emit('remoteReplyAdded', { annotation_id, reply });
                break;
            }
        }
    }

    async function fetchForVersion(version) {
        const boardId = Collaboration.getBoardId();
        if (!boardId) return [];
        try {
            const res = await fetch(`/api/boards/${boardId}/annotations?version=${version}`);
            if (!res.ok) return [];
            return await res.json();
        } catch (e) {
            console.error('Failed to fetch annotations for version:', e);
            return [];
        }
    }

    async function fetchAll() {
        const boardId = Collaboration.getBoardId();
        if (!boardId) return [];
        try {
            const res = await fetch(`/api/boards/${boardId}/annotations`);
            if (!res.ok) return [];
            const data = await res.json();
            annotations = data || [];
            emit('loaded', { annotations });
            return annotations;
        } catch (e) {
            console.error('Failed to fetch annotations:', e);
            return [];
        }
    }

    function setAnnotationsList(list) {
        annotations = list || [];
        emit('loaded', { annotations });
    }

    function getOpenCount() {
        return annotations.filter(a => a.status === 'open').length;
    }

    function getStats() {
        const total = annotations.length;
        const open = annotations.filter(a => a.status === 'open').length;
        const resolved = annotations.filter(a => a.status === 'resolved').length;
        const high = annotations.filter(a => a.priority === 'high' && a.status === 'open').length;
        return { total, open, resolved, high };
    }

    return {
        on,
        loadFromServer,
        getAnnotations,
        getAllAnnotations,
        setFilter,
        getFilter,
        getUniqueAssignees,
        findById,
        findByElement,
        findAtPosition,
        isTargetElementExisting,
        getAnnotationMarkerPosition,
        createAnnotation,
        updateAnnotation,
        deleteAnnotation,
        addReply,
        resolveAnnotation,
        reopenAnnotation,
        handleRemoteMessage,
        fetchForVersion,
        fetchAll,
        setAnnotationsList,
        getOpenCount,
        getStats
    };
})();
