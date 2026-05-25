// API Client
const API = {
    baseURL: '/api/v1',
    token: localStorage.getItem('auth_token') || 'dev-token',

    async request(method, path, body) {
        const opts = {
            method,
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json',
            },
        };
        if (body) opts.body = JSON.stringify(body);

        const res = await fetch(`${this.baseURL}${path}`, opts);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('text/csv')) {
            return res.text();
        }
        return res.json();
    },

    // Resource Pools
    listPools() { return this.request('GET', '/pools'); },
    getPool(id) { return this.request('GET', `/pools/${id}`); },
    createPool(data) { return this.request('POST', '/pools', data); },
    updatePool(id, data) { return this.request('PUT', `/pools/${id}`, data); },
    deletePool(id) { return this.request('DELETE', `/pools/${id}`); },

    // Nodes
    listNodes(poolId) { return this.request('GET', `/pools/${poolId}/nodes`); },
    getNode(poolId, nodeId) { return this.request('GET', `/pools/${poolId}/nodes/${nodeId}`); },
    createNode(poolId, data) { return this.request('POST', `/pools/${poolId}/nodes`, data); },
    updateNode(poolId, nodeId, data) { return this.request('PUT', `/pools/${poolId}/nodes/${nodeId}`, data); },
    deleteNode(poolId, nodeId) { return this.request('DELETE', `/pools/${poolId}/nodes/${nodeId}`); },
    drainNode(poolId, nodeId) { return this.request('POST', `/pools/${poolId}/nodes/${nodeId}/drain`); },

    // Tasks
    listTasks(params = {}) {
        const q = new URLSearchParams(params).toString();
        return this.request('GET', `/tasks?${q}`);
    },
    getTask(id) { return this.request('GET', `/tasks/${id}`); },
    createTask(data) { return this.request('POST', '/tasks', data); },
    cancelTask(id) { return this.request('POST', `/tasks/${id}/cancel`); },
    updateTaskPriority(id, priority) { return this.request('POST', `/tasks/${id}/priority`, { priority }); },
    getTaskEvents(id) { return this.request('GET', `/tasks/${id}/events`); },

    // Queue
    queueStatus() { return this.request('GET', '/queue'); },
    queueStats() { return this.request('GET', '/queue/stats'); },

    // Audit
    listAuditEvents(params = {}) {
        const q = new URLSearchParams(params).toString();
        return this.request('GET', `/audit-events?${q}`);
    },
    getAuditEvent(id) { return this.request('GET', `/audit-events/${id}`); },
    exportAuditEvents(params = {}) {
        const q = new URLSearchParams(params).toString();
        return this.request('GET', `/audit-events/export?${q}`);
    },

    // Cost Records
    listCostRecords(params = {}) {
        const q = new URLSearchParams(params).toString();
        return this.request('GET', `/cost-records?${q}`);
    },
    getCostSummary(params = {}) {
        const q = new URLSearchParams(params).toString();
        return this.request('GET', `/cost-records/summary?${q}`);
    },
};
