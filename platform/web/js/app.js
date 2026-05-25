// ── Router ──
const PAGES = {
    dashboard: { title: '总览', render: renderDashboard },
    pools: { title: '资源池管理', render: renderPools },
    nodes: { title: 'GPU 节点管理', render: renderNodes },
    tasks: { title: '训练任务', render: renderTasks },
    audit: { title: '审计日志', render: renderAuditLog },
    costs: { title: '费用管理', render: renderCosts },
};

let currentPage = 'dashboard';

function navigate(page) {
    currentPage = page;
    document.querySelectorAll('.nav-list li').forEach(el => {
        el.classList.toggle('active', el.dataset.page === page);
    });
    const pageConfig = PAGES[page] || PAGES.dashboard;
    document.getElementById('pageTitle').textContent = pageConfig.title;
    document.getElementById('pageContent').innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';
    pageConfig.render();
}

function refreshCurrentPage() {
    const pageConfig = PAGES[currentPage] || PAGES.dashboard;
    pageConfig.render();
}

document.querySelectorAll('.nav-list li').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.page));
});

// ── Utility ──
function statusBadge(status) {
    const map = {
        'active': 'badge-green', 'online': 'badge-green', 'running': 'badge-green', 'completed': 'badge-green', 'success': 'badge-green',
        'paused': 'badge-yellow', 'queued': 'badge-yellow', 'pending': 'badge-yellow', 'offline': 'badge-orange',
        'maintenance': 'badge-blue', 'failed': 'badge-red', 'error': 'badge-red', 'preempted': 'badge-orange', 'cancelled': 'badge-gray',
        'free': 'badge-green', 'allocated': 'badge-blue', 'degraded': 'badge-orange', 'settled': 'badge-blue', 'refunded': 'badge-purple',
    };
    const cls = map[status] || 'badge-gray';
    return `<span class="badge ${cls}">${status}</span>`;
}

function timeAgo(dateStr) {
    if (!dateStr) return '-';
    const sec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec/3600)}h ago`;
    return new Date(dateStr).toLocaleDateString();
}

function formatTime(dateStr) {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString('zh-CN');
}

function showToast(msg, type = 'success') {
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

function openModal(html, title = '操作') {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal"><h3 class="modal-title">${title}</h3>${html}</div>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    return overlay;
}

function closeModal(overlay) { overlay.remove(); }

async function handleApi(apiCall, successMsg) {
    try {
        const result = await apiCall();
        if (successMsg) showToast(successMsg);
        return result;
    } catch (e) {
        showToast(e.message, 'error');
        throw e;
    }
}

// ── Dashboard ──
async function renderDashboard() {
    const el = document.getElementById('pageContent');
    try {
        const [queue, stats] = await Promise.all([
            API.queueStatus(),
            API.queueStats(),
        ]);
        el.innerHTML = `
            <div class="stats-grid">
                <div class="stat-card blue"><div class="stat-label">排队任务</div><div class="stat-value">${queue.queued}</div></div>
                <div class="stat-card green"><div class="stat-label">运行中</div><div class="stat-value">${queue.running}</div></div>
                <div class="stat-card orange"><div class="stat-label">资源池</div><div class="stat-value">${queue.by_pool ? queue.by_pool.length : 0}</div></div>
                <div class="stat-card purple"><div class="stat-label">平均等待</div><div class="stat-value">${stats.avg_wait_time_seconds ? Math.round(stats.avg_wait_time_seconds/60) : 0}<span style="font-size:14px">min</span></div></div>
            </div>
            <div class="card">
                <div class="card-header"><span class="card-title">资源池概览</span></div>
                <div class="table-wrap">
                    <table>
                        <thead><tr><th>资源池</th><th>策略</th><th>状态</th><th>排队</th><th>运行中</th></tr></thead>
                        <tbody>
                            ${(queue.by_pool || []).map(p => `<tr>
                                <td><strong>${p.pool_id.substring(0,8)}...</strong></td>
                                <td>${statusBadge('active')}</td>
                                <td>${statusBadge('online')}</td>
                                <td>${p.queued}</td>
                                <td>${p.running}</td>
                            </tr>`).join('') || '<tr><td colspan="5" class="text-muted" style="text-align:center">暂无数据</td></tr>'}
                        </tbody>
                    </table>
                </div>
            </div>
            <div class="card">
                <div class="card-header"><span class="card-title">最近任务</span></div>
                <div id="recentTasks"><div class="loading"><div class="spinner"></div></div></div>
            </div>
        `;
        // Load recent tasks
        const tasksRes = await API.listTasks({ page: 1, page_size: 5 });
        const tasksEl = document.getElementById('recentTasks');
        if (tasksRes.items && tasksRes.items.length > 0) {
            tasksEl.innerHTML = `<div class="table-wrap"><table>
                <thead><tr><th>任务名</th><th>类型</th><th>状态</th><th>优先级</th><th>创建时间</th></tr></thead>
                <tbody>${tasksRes.items.map(t => `<tr>
                    <td><strong>${t.name}</strong></td>
                    <td>${t.type}</td>
                    <td>${statusBadge(t.status)}</td>
                    <td>${t.priority}</td>
                    <td class="text-sm text-muted">${formatTime(t.created_at)}</td>
                </tr>`).join('')}</tbody>
            </table></div>`;
        } else {
            tasksEl.innerHTML = '<div class="empty-state"><div class="icon">📋</div><p>暂无任务</p></div>';
        }
    } catch (e) {
        el.innerHTML = `<div class="card"><div class="empty-state"><div class="icon">⚠️</div><p>加载失败: ${e.message}</p></div></div>`;
    }
}

// ── Pools ──
async function renderPools() {
    const el = document.getElementById('pageContent');
    el.innerHTML = `
        <div class="card">
            <div class="card-header"><span class="card-title">资源池列表</span>
                <button class="btn btn-primary btn-sm" onclick="showCreatePoolForm()">+ 新建资源池</button>
            </div>
            <div class="table-wrap"><table>
                <thead><tr><th>名称</th><th>调度策略</th><th>状态</th><th>标签</th><th>创建时间</th><th>操作</th></tr></thead>
                <tbody id="poolList"><tr><td colspan="6" class="loading"><div class="spinner"></div></td></tr></tbody>
            </table></div>
        </div>`;
    try {
        const res = await API.listPools();
        const tbody = document.getElementById('poolList');
        if (res.items && res.items.length > 0) {
            tbody.innerHTML = res.items.map(p => `<tr>
                <td><strong>${p.name}</strong></td>
                <td>${statusBadge(p.scheduler_policy)}</td>
                <td>${statusBadge(p.status)}</td>
                <td class="text-sm text-muted">${Object.keys(p.labels || {}).length} 个标签</td>
                <td class="text-sm">${formatTime(p.created_at)}</td>
                <td>
                    <button class="btn btn-sm" onclick="showEditPoolForm('${p.id}')">编辑</button>
                    <button class="btn btn-sm btn-danger" onclick="deletePool('${p.id}')">删除</button>
                </td>
            </tr>`).join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="icon">🗂️</div><p>暂无资源池，点击上方按钮创建</p></div></td></tr>';
        }
    } catch (e) {
        document.getElementById('poolList').innerHTML = `<tr><td colspan="6" style="color:red;text-align:center">加载失败: ${e.message}</td></tr>`;
    }
}

function showCreatePoolForm() {
    const overlay = openModal(`
        <div class="form-group"><label>名称</label><input class="form-control" id="poolName" placeholder="例如: gpu-pool-a"></div>
        <div class="form-group"><label>调度策略</label>
            <select class="form-control" id="poolPolicy"><option value="fifo">FIFO（先入先出）</option><option value="fair">Fair（公平调度）</option><option value="priority">Priority（优先级）</option></select>
        </div>
        <div class="form-group"><label>标签 (JSON)</label><textarea class="form-control" id="poolLabels">{"gpu_type": "A100", "location": "机房A"}</textarea></div>
        <div class="modal-actions">
            <button class="btn" onclick="this.closest('.modal-overlay').remove()">取消</button>
            <button class="btn btn-primary" onclick="createPool()">创建</button>
        </div>
    `, '新建资源池');
}

async function createPool() {
    try {
        const name = document.getElementById('poolName').value;
        const policy = document.getElementById('poolPolicy').value;
        const labels = JSON.parse(document.getElementById('poolLabels').value || '{}');
        await API.createPool({ name, scheduler_policy: policy, labels });
        showToast('资源池创建成功');
        document.querySelector('.modal-overlay').remove();
        renderPools();
    } catch (e) { showToast(e.message, 'error'); }
}

async function deletePool(id) {
    if (!confirm('确定删除此资源池？')) return;
    await handleApi(API.deletePool(id), '删除成功');
    renderPools();
}

// ── Nodes ──
async function renderNodes() {
    const el = document.getElementById('pageContent');
    try {
        const poolsRes = await API.listPools();
        const pools = poolsRes.items || [];
        if (pools.length === 0) {
            el.innerHTML = '<div class="card"><div class="empty-state"><div class="icon">🗂️</div><p>请先创建资源池</p></div></div>';
            return;
        }
        const poolId = pools[0].id;
        const nodesRes = await API.listNodes(poolId);
        const nodes = nodesRes.items || [];
        el.innerHTML = `
            <div class="filter-bar">
                <div class="form-group"><label>资源池</label><select class="form-control" id="nodePoolSelect" onchange="renderNodes()">${pools.map(p => `<option value="${p.id}" ${p.id===poolId?'selected':''}>${p.name}</option>`).join('')}</select></div>
                <button class="btn btn-primary btn-sm" onclick="showCreateNodeForm(document.getElementById('nodePoolSelect').value)">+ 注册节点</button>
            </div>
            <div class="stats-grid">
                <div class="stat-card green"><div class="stat-label">在线</div><div class="stat-value">${nodes.filter(n=>n.status==='online').length}</div></div>
                <div class="stat-card orange"><div class="stat-label">维护中</div><div class="stat-value">${nodes.filter(n=>n.status==='maintenance').length}</div></div>
                <div class="stat-card red"><div class="stat-label">离线</div><div class="stat-value">${nodes.filter(n=>n.status==='offline').length}</div></div>
            </div>
            <div class="card">
                <div class="card-header"><span class="card-title">节点列表</span></div>
                <div class="table-wrap"><table>
                    <thead><tr><th>主机名</th><th>IP</th><th>状态</th><th>GPU 规格</th><th>心跳</th><th>操作</th></tr></thead>
                    <tbody>${nodes.map(n => `<tr>
                        <td><strong>${n.hostname}</strong></td>
                        <td class="text-sm">${n.ip_address}</td>
                        <td>${statusBadge(n.status)}</td>
                        <td class="text-sm">${n.specs ? (n.specs.gpu_model || '-') : '-'}</td>
                        <td class="text-sm text-muted">${timeAgo(n.last_heartbeat)}</td>
                        <td>
                            <button class="btn btn-sm" onclick="showEditNodeForm('${poolId}','${n.id}')">编辑</button>
                            ${n.status === 'online' ? `<button class="btn btn-sm" onclick="drainNode('${poolId}','${n.id}')">排空</button>` : ''}
                            <button class="btn btn-sm btn-danger" onclick="deleteNode('${poolId}','${n.id}')">移除</button>
                        </td>
                    </tr>`).join('') || '<tr><td colspan="6"><div class="empty-state"><div class="icon">🖥️</div><p>暂无节点</p></div></td></tr>'}
                    </tbody>
                </table></div>
            </div>`;
    } catch (e) {
        el.innerHTML = `<div class="card"><div class="empty-state"><div class="icon">⚠️</div><p>${e.message}</p></div></div>`;
    }
}

function showCreateNodeForm(poolId) {
    const overlay = openModal(`
        <div class="form-group"><label>主机名</label><input class="form-control" id="nodeHostname" placeholder="node-01"></div>
        <div class="form-group"><label>IP 地址</label><input class="form-control" id="nodeIP" placeholder="10.0.1.101"></div>
        <div class="form-group"><label>GPU 规格 (JSON)</label><textarea class="form-control" id="nodeSpecs">{"gpu_model":"A100","gpu_count":8,"cpu":128,"memory_gb":1024}</textarea></div>
        <div class="modal-actions">
            <button class="btn" onclick="this.closest('.modal-overlay').remove()">取消</button>
            <button class="btn btn-primary" onclick="createNode('${poolId}')">注册</button>
        </div>
    `, '注册 GPU 节点');
}

async function createNode(poolId) {
    try {
        await API.createNode(poolId, {
            hostname: document.getElementById('nodeHostname').value,
            ip_address: document.getElementById('nodeIP').value,
            specs: JSON.parse(document.getElementById('nodeSpecs').value || '{}'),
        });
        showToast('节点注册成功');
        document.querySelector('.modal-overlay').remove();
        renderNodes();
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteNode(poolId, nodeId) {
    if (!confirm('确定移除节点？')) return;
    await handleApi(API.deleteNode(poolId, nodeId), '节点已移除');
    renderNodes();
}

async function drainNode(poolId, nodeId) {
    if (!confirm('确定排空节点？')) return;
    await handleApi(API.drainNode(poolId, nodeId), '节点已进入排空模式');
    renderNodes();
}

// ── Tasks ──
async function renderTasks() {
    const el = document.getElementById('pageContent');
    el.innerHTML = `
        <div class="filter-bar">
            <div class="form-group"><label>状态</label><select class="form-control" id="taskStatusFilter"><option value="">全部</option><option value="queued">排队中</option><option value="running">运行中</option><option value="completed">已完成</option><option value="failed">失败</option></select></div>
            <button class="btn btn-primary btn-sm" onclick="showCreateTaskForm()">+ 提交任务</button>
            <button class="btn btn-sm" onclick="renderTasks()">🔍 筛选</button>
        </div>
        <div class="card">
            <div class="card-header"><span class="card-title">任务列表</span></div>
            <div class="table-wrap"><table>
                <thead><tr><th>名称</th><th>类型</th><th>状态</th><th>优先级</th><th>GPU</th><th>创建时间</th><th>操作</th></tr></thead>
                <tbody id="taskList"><tr><td colspan="7" class="loading"><div class="spinner"></div></td></tr></tbody>
            </table></div>
            <div class="pagination" id="taskPagination"></div>
        </div>`;
    await loadTasks();
}

async function loadTasks(page = 1) {
    try {
        const status = document.getElementById('taskStatusFilter')?.value || '';
        const res = await API.listTasks({ page, page_size: 15, status });
        const tbody = document.getElementById('taskList');
        if (res.items && res.items.length > 0) {
            tbody.innerHTML = res.items.map(t => `<tr>
                <td><strong>${t.name}</strong></td>
                <td class="text-sm">${t.type}</td>
                <td>${statusBadge(t.status)}</td>
                <td>${t.priority}</td>
                <td>${t.spec?.gpu_count || '-'}</td>
                <td class="text-sm text-muted">${formatTime(t.created_at)}</td>
                <td>
                    <button class="btn btn-sm" onclick="viewTask('${t.id}')">详情</button>
                    ${t.status === 'queued' ? `<button class="btn btn-sm btn-danger" onclick="cancelTask('${t.id}')">取消</button>` : ''}
                </td>
            </tr>`).join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="icon">📋</div><p>暂无任务</p></div></td></tr>';
        }
        // Pagination
        const totalPages = Math.ceil((res.total || 0) / 15);
        document.getElementById('taskPagination').innerHTML = totalPages > 1
            ? `<button class="btn btn-sm" onclick="loadTasks(${page-1})" ${page<=1?'disabled':''}>上一页</button>
               <span>第 ${page}/${totalPages} 页</span>
               <button class="btn btn-sm" onclick="loadTasks(${page+1})" ${page>=totalPages?'disabled':''}>下一页</button>`
            : '';
    } catch (e) {
        document.getElementById('taskList').innerHTML = `<tr><td colspan="7" style="color:red;text-align:center">${e.message}</td></tr>`;
    }
}

function showCreateTaskForm() {
    const overlay = openModal(`
        <div class="form-group"><label>任务名称</label><input class="form-control" id="taskName" placeholder="bert-finetune-v3"></div>
        <div class="grid-2">
            <div class="form-group"><label>类型</label><select class="form-control" id="taskType"><option value="training">训练</option><option value="evaluation">评估</option></select></div>
            <div class="form-group"><label>优先级 (0-100)</label><input class="form-control" id="taskPriority" type="number" value="50"></div>
        </div>
        <div class="grid-2">
            <div class="form-group"><label>GPU 数量</label><input class="form-control" id="taskGPUCount" type="number" value="1"></div>
            <div class="form-group"><label>最大运行时间(秒)</label><input class="form-control" id="taskMaxRuntime" type="number" value="86400"></div>
        </div>
        <div class="form-group"><label>镜像</label><input class="form-control" id="taskImage" placeholder="harbor.internal/ai-training/bert:latest"></div>
        <div class="form-group"><label>启动命令</label><input class="form-control" id="taskEntrypoint" placeholder="python train.py"></div>
        <div class="form-group"><label>环境变量 (JSON)</label><textarea class="form-control" id="taskEnv">{"WANDB_API_KEY":"xxx"}</textarea></div>
        <div class="modal-actions">
            <button class="btn" onclick="this.closest('.modal-overlay').remove()">取消</button>
            <button class="btn btn-primary" onclick="createTask()">提交</button>
        </div>
    `, '提交训练任务');
}

async function createTask() {
    try {
        const data = {
            name: document.getElementById('taskName').value,
            type: document.getElementById('taskType').value,
            pool_id: '',
            priority: parseInt(document.getElementById('taskPriority').value) || 50,
            spec: {
                gpu_count: parseInt(document.getElementById('taskGPUCount').value) || 1,
                max_runtime_seconds: parseInt(document.getElementById('taskMaxRuntime').value) || 86400,
                image: document.getElementById('taskImage').value,
                entrypoint: document.getElementById('taskEntrypoint').value,
                env_vars: JSON.parse(document.getElementById('taskEnv').value || '{}'),
            },
        };
        // Get first pool
        const poolsRes = await API.listPools();
        if (poolsRes.items && poolsRes.items.length > 0) {
            data.pool_id = poolsRes.items[0].id;
        }
        await API.createTask(data);
        showToast('任务提交成功');
        document.querySelector('.modal-overlay').remove();
        loadTasks();
    } catch (e) { showToast(e.message, 'error'); }
}

async function cancelTask(id) {
    if (!confirm('确定取消此任务？')) return;
    await handleApi(API.cancelTask(id), '已取消');
    loadTasks();
}

async function viewTask(id) {
    try {
        const [task, events] = await Promise.all([API.getTask(id), API.getTaskEvents(id)]);
        const overlay = openModal(`
            <div style="margin-bottom:16px">
                <div class="flex items-center gap-2"><h3 style="font-size:20px">${task.name}</h3> ${statusBadge(task.status)}</div>
                <div class="text-muted text-sm mt-4">
                    <div class="grid-2">
                        <div>ID: <code>${task.id}</code></div>
                        <div>类型: ${task.type}</div>
                        <div>优先级: ${task.priority}</div>
                        <div>GPU: ${task.spec?.gpu_count || '-'}</div>
                        <div>镜像: ${task.spec?.image || '-'}</div>
                        <div>创建: ${formatTime(task.created_at)}</div>
                        ${task.started_at ? `<div>开始: ${formatTime(task.started_at)}</div>` : ''}
                        ${task.completed_at ? `<div>完成: ${formatTime(task.completed_at)}</div>` : ''}
                    </div>
                </div>
            </div>
            <div class="form-group"><label>事件时间线</label></div>
            <div class="table-wrap"><table>
                <thead><tr><th>事件</th><th>时间</th></tr></thead>
                <tbody>${(events.items || []).map(e => `<tr><td>${e.event_type}</td><td class="text-sm text-muted">${formatTime(e.created_at)}</td></tr>`).join('') || '<tr><td colspan="2" style="text-align:center">暂无事件</td></tr>'}</tbody>
            </table></div>
            <div class="modal-actions"><button class="btn" onclick="this.closest('.modal-overlay').remove()">关闭</button></div>
        `, '任务详情');
    } catch (e) { showToast(e.message, 'error'); }
}

// ── Audit Log ──
async function renderAuditLog() {
    const el = document.getElementById('pageContent');
    el.innerHTML = `
        <div class="filter-bar">
            <div class="form-group"><label>资源类型</label><select class="form-control" id="auditResourceType"><option value="">全部</option><option value="job">任务</option><option value="node">节点</option><option value="user">用户</option><option value="team">团队</option></select></div>
            <div class="form-group"><label>操作</label><select class="form-control" id="auditAction"><option value="">全部</option><option value="create">创建</option><option value="update">修改</option><option value="delete">删除</option><option value="start">启动</option><option value="stop">停止</option></select></div>
            <div class="form-group"><label>结果</label><select class="form-control" id="auditResult"><option value="">全部</option><option value="success">成功</option><option value="failure">失败</option></select></div>
            <button class="btn btn-primary btn-sm" onclick="loadAuditLog()">🔍 查询</button>
            <button class="btn btn-sm" onclick="exportAuditLog()">📥 导出 CSV</button>
        </div>
        <div class="card">
            <div class="card-header"><span class="card-title">审计事件</span></div>
            <div class="table-wrap"><table>
                <thead><tr><th>ID</th><th>操作者</th><th>资源</th><th>操作</th><th>结果</th><th>时间</th></tr></thead>
                <tbody id="auditList"><tr><td colspan="6" class="loading"><div class="spinner"></div></td></tr></tbody>
            </table></div>
            <div class="pagination" id="auditPagination"></div>
        </div>`;
    await loadAuditLog();
}

async function loadAuditLog(page = 1) {
    try {
        const params = { page, page_size: 20 };
        const rt = document.getElementById('auditResourceType')?.value;
        const action = document.getElementById('auditAction')?.value;
        const result = document.getElementById('auditResult')?.value;
        if (rt) params.resource_type = rt;
        if (action) params.action = action;
        if (result) params.result = result;

        const res = await API.listAuditEvents(params);
        const tbody = document.getElementById('auditList');
        if (res.items && res.items.length > 0) {
            tbody.innerHTML = res.items.map(e => `<tr>
                <td class="text-sm text-muted">${e.id}</td>
                <td>${e.actor_name || e.actor_id}</td>
                <td><span class="badge badge-blue">${e.resource_type}</span> ${e.resource_name || e.resource_id}</td>
                <td>${e.action}</td>
                <td>${statusBadge(e.result)}</td>
                <td class="text-sm text-muted">${formatTime(e.created_at)}</td>
            </tr>`).join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="icon">📝</div><p>暂无审计事件</p></div></td></tr>';
        }
        const totalPages = Math.ceil((res.total || 0) / 20);
        document.getElementById('auditPagination').innerHTML = totalPages > 1
            ? `<button class="btn btn-sm" onclick="loadAuditLog(${page-1})" ${page<=1?'disabled':''}>上一页</button>
               <span>第 ${page}/${totalPages} 页</span>
               <button class="btn btn-sm" onclick="loadAuditLog(${page+1})" ${page>=totalPages?'disabled':''}>下一页</button>`
            : '';
    } catch (e) {
        document.getElementById('auditList').innerHTML = `<tr><td colspan="6" style="color:red;text-align:center">${e.message}</td></tr>`;
    }
}

async function exportAuditLog() {
    try {
        const blob = await API.exportAuditEvents({});
        const url = URL.createObjectURL(new Blob([blob], { type: 'text/csv' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `audit_events_${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('导出成功');
    } catch (e) { showToast(e.message, 'error'); }
}

// ── Costs ──
async function renderCosts() {
    const el = document.getElementById('pageContent');
    el.innerHTML = `
        <div class="stats-grid">
            <div class="stat-card blue"><div class="stat-label">本月总费用</div><div class="stat-value" id="costTotal">-</div></div>
            <div class="stat-card purple"><div class="stat-label">任务数</div><div class="stat-value" id="costTaskCount">-</div></div>
        </div>
        <div class="card">
            <div class="card-header"><span class="card-title">费用流水</span></div>
            <div class="table-wrap"><table>
                <thead><tr><th>任务</th><th>GPU 型号</th><th>GPU 数</th><th>时长</th><th>单价</th><th>总费用</th><th>状态</th><th>时间</th></tr></thead>
                <tbody id="costList"><tr><td colspan="8" class="loading"><div class="spinner"></div></td></tr></tbody>
            </table></div>
        </div>`;
    try {
        const [records, summary] = await Promise.all([
            API.listCostRecords({ page: 1, page_size: 20 }),
            API.getCostSummary({ tenant_id: 'default-tenant', start: new Date(Date.now()-30*86400000).toISOString(), end: new Date().toISOString() }),
        ]);
        const totalCost = (summary.items || []).reduce((s, c) => s + c.total_cost, 0);
        const taskCount = (summary.items || []).reduce((s, c) => s + c.task_count, 0);
        document.getElementById('costTotal').textContent = `¥${totalCost.toFixed(2)}`;
        document.getElementById('costTaskCount').textContent = taskCount;

        const tbody = document.getElementById('costList');
        if (records.items && records.items.length > 0) {
            tbody.innerHTML = records.items.map(r => `<tr>
                <td><strong>${r.task_name}</strong></td>
                <td>${r.gpu_model || '-'}</td>
                <td>${r.gpu_count}</td>
                <td>${Math.round(r.duration_seconds/60)} min</td>
                <td>¥${r.unit_price_per_hour}/h</td>
                <td><strong>¥${r.total_cost.toFixed(2)}</strong></td>
                <td>${statusBadge(r.status)}</td>
                <td class="text-sm text-muted">${formatTime(r.created_at)}</td>
            </tr>`).join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="icon">💰</div><p>暂无费用记录</p></div></td></tr>';
        }
    } catch (e) {
        document.getElementById('costList').innerHTML = `<tr><td colspan="8" style="color:red;text-align:center">${e.message}</td></tr>`;
    }
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
    navigate('dashboard');
});
