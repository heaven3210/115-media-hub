const SCRAPER_JOB_ACTIVE_STATUSES = new Set(['pending', 'running', 'rollback_running']);
const SCRAPER_PROVIDER_LABELS = { '115': '115', quark: '夸克' };

const state = {
    initialized: false,
    provider: '115',
    providers: [],
    cid: '0',
    trail: [{ id: '0', name: '根目录' }],
    entries: [],
    summary: { folder_count: 0, file_count: 0 },
    selected: new Map(),
    search: '',
    loading: false,
    moveBuffer: null,
    identifyBusy: false,
    identifyResult: null,
    tmdb: null,
    manualBusy: false,
    manualResults: [],
    planBusy: false,
    plan: null,
    executeBusy: false,
    jobs: [],
    jobsBusy: false,
    jobsPollTimer: 0,
};

function $(id) {
    return document.getElementById(id);
}

function escapeHtml(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(value);
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function showToast(message, options = {}) {
    if (typeof window.showToast === 'function') {
        window.showToast(message, options);
        return;
    }
    console.log(message);
}

async function showConfirm(message, options = {}) {
    if (typeof window.showAppConfirm === 'function') {
        return window.showAppConfirm(message, options);
    }
    return window.confirm(message);
}

function normalizeProvider(value) {
    const raw = String(value || '').trim().toLowerCase();
    return raw === 'quark' || raw === '夸克' ? 'quark' : '115';
}

function getProviderLabel(provider = state.provider) {
    return SCRAPER_PROVIDER_LABELS[normalizeProvider(provider)] || '115';
}

function isProviderConfigured(provider = state.provider) {
    const normalized = normalizeProvider(provider);
    const item = state.providers.find(providerInfo => normalizeProvider(providerInfo.provider) === normalized);
    return !!item?.configured;
}

function normalizeCid(value) {
    return String(value || '0').trim() || '0';
}

function normalizePath(value) {
    return String(value || '')
        .split(/[\\/]+/)
        .map(part => part.trim())
        .filter(Boolean)
        .join('/');
}

function joinPath(...parts) {
    return normalizePath(parts.join('/'));
}

function currentParentPath() {
    return normalizePath(state.trail.slice(1).map(item => item.name || '').join('/'));
}

function formatFileSize(size) {
    const value = Number(size || 0);
    if (!Number.isFinite(value) || value <= 0) return '--';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let next = value;
    let unit = 0;
    while (next >= 1024 && unit < units.length - 1) {
        next /= 1024;
        unit += 1;
    }
    return `${next.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatTimeText(value) {
    const text = String(value || '').trim();
    if (!text) return '--';
    return text.replace('T', ' ').slice(0, 16);
}

function getEntryIcon(isDir) {
    if (isDir) {
        return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 8.5C4 7.67 4.67 7 5.5 7H9L10.5 8.5H18.5C19.33 8.5 20 9.17 20 10V16.5C20 17.33 19.33 18 18.5 18H5.5C4.67 18 4 17.33 4 16.5V8.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 4.5H14L18 8.5V19.5H7V4.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 4.5V8.5H18" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
}

function enrichEntry(entry) {
    const item = entry && typeof entry === 'object' ? entry : {};
    const id = String(item.id || item.cid || item.fid || '').trim();
    const name = String(item.name || '').trim();
    const parentPath = currentParentPath();
    const path = normalizePath(item.path || joinPath(parentPath, name));
    return {
        ...item,
        id,
        name,
        parent_id: normalizeCid(item.parent_id || state.cid),
        parent_path: parentPath,
        path,
        is_dir: !!item.is_dir,
        size: Number(item.size || 0) || 0,
    };
}

function getSelectedEntries() {
    return Array.from(state.selected.values())
        .filter(item => item && item.id && item.name)
        .map(item => ({ ...item }));
}

function clearSelection() {
    state.selected.clear();
}

function clearPlan() {
    state.plan = null;
    renderPlan();
}

function setBusyButton(button, busy, busyText = '处理中...', idleText = '') {
    if (!button) return;
    button.disabled = !!busy;
    button.classList.toggle('btn-disabled', !!busy);
    if (busy) {
        button.dataset.idleText = button.textContent || idleText;
        button.textContent = busyText;
    } else if (button.dataset.idleText) {
        button.textContent = button.dataset.idleText;
        delete button.dataset.idleText;
    }
}

async function promptText({ title = '输入名称', message = '', defaultValue = '', confirmText = '确认' } = {}) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'scraper-prompt-modal';
        modal.innerHTML = `
            <div class="scraper-prompt-shell" role="dialog" aria-modal="true">
                <div class="scraper-prompt-title">${escapeHtml(title)}</div>
                ${message ? `<div class="scraper-prompt-message">${escapeHtml(message)}</div>` : ''}
                <input class="scraper-input scraper-prompt-input" value="${escapeHtml(defaultValue)}">
                <div class="scraper-prompt-actions">
                    <button type="button" class="scraper-compact-btn" data-prompt-cancel>取消</button>
                    <button type="button" class="scraper-compact-btn scraper-primary-soft" data-prompt-confirm>${escapeHtml(confirmText)}</button>
                </div>
            </div>
        `;
        const input = modal.querySelector('.scraper-prompt-input');
        const cleanup = (value) => {
            document.removeEventListener('keydown', onKeydown);
            modal.remove();
            resolve(value);
        };
        const onKeydown = (event) => {
            if (event.key === 'Escape') cleanup(null);
            if (event.key === 'Enter' && !event.isComposing) cleanup(String(input.value || '').trim());
        };
        modal.addEventListener('click', (event) => {
            if (event.target === modal || event.target.closest('[data-prompt-cancel]')) cleanup(null);
            if (event.target.closest('[data-prompt-confirm]')) cleanup(String(input.value || '').trim());
        });
        document.addEventListener('keydown', onKeydown);
        document.body.appendChild(modal);
        setTimeout(() => {
            input.focus();
            input.select();
        }, 20);
    });
}

function renderProviderTabs() {
    const container = $('scraper-provider-tabs');
    if (!container) return;
    const providers = state.providers.length
        ? state.providers
        : [
            { provider: '115', label: '115', configured: false },
            { provider: 'quark', label: '夸克', configured: false },
        ];
    container.innerHTML = providers.map((item) => {
        const provider = normalizeProvider(item.provider);
        const active = provider === state.provider;
        const configured = !!item.configured;
        return `
            <button
                type="button"
                class="scraper-provider-tab ${active ? 'is-active' : ''} ${configured ? '' : 'is-muted'}"
                data-scraper-provider="${escapeHtml(provider)}"
                aria-pressed="${active ? 'true' : 'false'}"
            >
                <span>${escapeHtml(item.label || getProviderLabel(provider))}</span>
                <small>${configured ? '已配置' : '未配置'}</small>
            </button>
        `;
    }).join('');
}

function renderProviderStatus() {
    const el = $('scraper-provider-status');
    if (!el) return;
    const providerLabel = getProviderLabel();
    if (!isProviderConfigured()) {
        el.textContent = `${providerLabel} Cookie 未配置，文件管理和刮削执行暂不可用。`;
        return;
    }
    const folderCount = Number(state.summary.folder_count || 0);
    const fileCount = Number(state.summary.file_count || 0);
    el.textContent = `${providerLabel} / 当前目录 ${folderCount} 个文件夹、${fileCount} 个文件`;
}

function renderBreadcrumbs() {
    const container = $('scraper-breadcrumbs');
    if (!container) return;
    container.innerHTML = state.trail.map((item, index) => {
        const active = index === state.trail.length - 1;
        const separator = index > 0 ? '<span class="scraper-breadcrumb-sep">/</span>' : '';
        if (active) {
            return `${separator}<span class="scraper-breadcrumb is-active">${escapeHtml(item.name || '根目录')}</span>`;
        }
        return `${separator}<button type="button" class="scraper-breadcrumb" data-scraper-trail-index="${index}">${escapeHtml(item.name || '根目录')}</button>`;
    }).join('');
}

function renderSelection() {
    const countEl = $('scraper-selection-count');
    if (countEl) {
        const count = state.selected.size;
        countEl.textContent = count ? `已选择 ${count} 项` : '未选择条目';
    }
    const checkAll = $('scraper-check-all');
    if (checkAll) {
        const selectable = state.entries;
        const selectedInCurrent = selectable.filter(item => state.selected.has(item.id)).length;
        checkAll.checked = selectable.length > 0 && selectedInCurrent === selectable.length;
        checkAll.indeterminate = selectedInCurrent > 0 && selectedInCurrent < selectable.length;
        checkAll.disabled = state.loading || selectable.length <= 0;
    }
}

function renderMoveBuffer() {
    const el = $('scraper-move-buffer');
    if (!el) return;
    const buffer = state.moveBuffer;
    if (!buffer || !Array.isArray(buffer.entries) || buffer.entries.length <= 0) {
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
    }
    el.classList.remove('hidden');
    el.innerHTML = `
        <div>
            <strong>待移动 ${escapeHtml(String(buffer.entries.length))} 项</strong>
            <span>来源：${escapeHtml(buffer.source_path || '根目录')}</span>
        </div>
        <div class="scraper-move-actions">
            <button type="button" class="scraper-compact-btn scraper-primary-soft" data-scraper-action="move-here">移动到当前目录</button>
            <button type="button" class="scraper-compact-btn" data-scraper-action="clear-move">取消</button>
        </div>
    `;
}

function renderEntries() {
    const list = $('scraper-entry-list');
    if (!list) return;
    renderProviderStatus();
    renderBreadcrumbs();
    renderSelection();
    renderMoveBuffer();
    const refreshBtn = $('scraper-refresh-btn');
    if (refreshBtn) {
        refreshBtn.disabled = !!state.loading;
        refreshBtn.classList.toggle('btn-disabled', !!state.loading);
    }
    if (state.loading && !state.entries.length) {
        list.innerHTML = `<div class="scraper-empty-row">正在读取${escapeHtml(getProviderLabel())}目录...</div>`;
        return;
    }
    if (!isProviderConfigured()) {
        list.innerHTML = `<div class="scraper-empty-row">请先到参数配置填写 ${escapeHtml(getProviderLabel())} Cookie。</div>`;
        return;
    }
    if (!state.entries.length) {
        list.innerHTML = '<div class="scraper-empty-row">当前目录没有可显示条目。</div>';
        return;
    }
    const rows = state.entries.slice().sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
    }).map((entry) => {
        const selected = state.selected.has(entry.id);
        const nameHtml = entry.is_dir
            ? `<button type="button" class="scraper-entry-link" data-scraper-entry-enter="${escapeHtml(entry.id)}">${escapeHtml(entry.name || '--')}</button>`
            : `<span class="scraper-entry-filename">${escapeHtml(entry.name || '--')}</span>`;
        return `
            <div class="scraper-entry-row ${selected ? 'is-selected' : ''}" data-scraper-entry-id="${escapeHtml(entry.id)}">
                <div class="scraper-entry-name-cell">
                    <input type="checkbox" class="ui-checkbox ui-checkbox-sm" data-scraper-check="${escapeHtml(entry.id)}" ${selected ? 'checked' : ''}>
                    <span class="scraper-entry-icon ${entry.is_dir ? 'is-folder' : 'is-file'}">${getEntryIcon(entry.is_dir)}</span>
                    <div class="scraper-entry-main">
                        ${nameHtml}
                        <span>${escapeHtml(entry.path || entry.name || '')}</span>
                    </div>
                </div>
                <span>${entry.is_dir ? '--' : escapeHtml(formatFileSize(entry.size))}</span>
                <span>${escapeHtml(formatTimeText(entry.modified_at))}</span>
            </div>
        `;
    });
    list.innerHTML = rows.join('');
}

function getTmdbDisplayTitle(binding = state.tmdb) {
    const item = binding && typeof binding === 'object' ? binding : {};
    const title = item.tmdb_title || item.title || item.tmdb_localized_title || item.tmdb_english_title || '';
    const year = item.tmdb_year || item.year || '';
    return `${title || '--'}${year ? ` (${year})` : ''}`;
}

function renderIdentify() {
    const summary = $('scraper-identify-summary');
    const candidates = $('scraper-candidate-list');
    const manualResults = $('scraper-manual-results');
    const identifyResult = state.identifyResult || {};
    if (summary) {
        if (state.identifyBusy) {
            summary.textContent = '正在识别 TMDB 信息...';
        } else if (state.tmdb) {
            const typeLabel = (state.tmdb.tmdb_media_type || state.tmdb.media_type) === 'tv' ? '电视剧' : '电影';
            summary.innerHTML = `已选择 <strong>${escapeHtml(typeLabel)} #${escapeHtml(String(state.tmdb.tmdb_id || state.tmdb.id || 0))}</strong>：${escapeHtml(getTmdbDisplayTitle())}`;
        } else if (identifyResult.msg) {
            summary.textContent = identifyResult.msg;
        } else if (identifyResult.query) {
            summary.textContent = `自动识别关键词：${identifyResult.query}`;
        } else {
            summary.textContent = '等待选择文件或文件夹。';
        }
    }
    if (candidates) {
        const items = Array.isArray(identifyResult.candidates || identifyResult.items) ? (identifyResult.candidates || identifyResult.items) : [];
        if (state.identifyBusy) {
            candidates.innerHTML = '<div class="scraper-empty-small">识别中...</div>';
        } else if (!items.length) {
            candidates.innerHTML = '';
        } else {
            candidates.innerHTML = items.slice(0, 5).map((item, index) => {
                const typeLabel = item.media_type === 'tv' ? '电视剧' : '电影';
                const confidence = Number(item.confidence || 0) || 0;
                return `
                    <div class="scraper-candidate-row">
                        <div>
                            <strong>${escapeHtml(item.title || '--')}</strong>
                            <span>${escapeHtml(typeLabel)}${item.year ? ` / ${escapeHtml(item.year)}` : ''} / 置信度 ${escapeHtml(String(confidence))}</span>
                        </div>
                        <button type="button" class="scraper-compact-btn" data-scraper-candidate-index="${index}">选择</button>
                    </div>
                `;
            }).join('');
        }
    }
    if (manualResults) {
        if (state.manualBusy) {
            manualResults.innerHTML = '<div class="scraper-empty-small">搜索中...</div>';
        } else if (!state.manualResults.length) {
            manualResults.innerHTML = '';
        } else {
            manualResults.innerHTML = state.manualResults.slice(0, 8).map((item, index) => {
                const typeLabel = item.media_type === 'tv' ? '电视剧' : '电影';
                return `
                    <div class="scraper-manual-result">
                        <div class="scraper-manual-result-main">
                            <strong>${escapeHtml(item.title || '--')}</strong>
                            <span>${escapeHtml(typeLabel)}${item.year ? ` / ${escapeHtml(item.year)}` : ''}${item.vote_average ? ` / ${escapeHtml(String(item.vote_average))}` : ''}</span>
                        </div>
                        <button type="button" class="scraper-compact-btn" data-scraper-manual-index="${index}">绑定</button>
                    </div>
                `;
            }).join('');
        }
    }
    const manualInput = $('scraper-manual-query');
    if (manualInput && !String(manualInput.value || '').trim() && identifyResult.query) {
        manualInput.value = String(identifyResult.query || '');
    }
    const mediaSelect = $('scraper-manual-media-type');
    if (mediaSelect && identifyResult.media_type) {
        mediaSelect.value = identifyResult.media_type === 'tv' ? 'tv' : 'movie';
    }
}

function collectOptions() {
    const preserveTags = {};
    document.querySelectorAll('[data-scraper-tag]').forEach((input) => {
        preserveTags[String(input.dataset.scraperTag || '').trim()] = !!input.checked;
    });
    return {
        title_language: String($('scraper-title-language')?.value || 'zh'),
        season: Math.max(1, Number($('scraper-season')?.value || 1) || 1),
        preserve_tags: preserveTags,
    };
}

function renderPlan() {
    const summary = $('scraper-plan-summary');
    const list = $('scraper-plan-list');
    const executeBtn = $('scraper-execute-btn');
    const plan = state.plan || null;
    if (executeBtn) {
        executeBtn.disabled = state.executeBusy || !plan?.ready;
        executeBtn.classList.toggle('btn-disabled', state.executeBusy || !plan?.ready);
        executeBtn.textContent = state.executeBusy ? '提交中...' : '确认执行';
    }
    if (!summary || !list) return;
    if (state.planBusy) {
        summary.textContent = '正在生成 dry-run 预览...';
        list.innerHTML = '';
        return;
    }
    if (!plan) {
        summary.textContent = '生成预览后会显示旧路径、新路径、识别依据和冲突状态。';
        list.innerHTML = '';
        return;
    }
    const total = Number(plan.total_count || 0);
    const ready = Number(plan.ready_count || 0);
    const issues = Array.isArray(plan.issues) ? plan.issues : [];
    summary.innerHTML = `
        <span class="${plan.ready ? 'scraper-ok-text' : 'scraper-warn-text'}">${plan.ready ? '可执行' : '需要处理'}</span>
        <span> / ${escapeHtml(String(ready))} / ${escapeHtml(String(total))} 项可执行${issues.length ? ` / ${escapeHtml(String(issues.length))} 个提示` : ''}</span>
    `;
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    if (!actions.length) {
        list.innerHTML = '<div class="scraper-empty-row">没有可改名文件。</div>';
        return;
    }
    list.innerHTML = actions.map((action) => {
        const readyClass = action.ready ? 'is-ready' : 'is-blocked';
        return `
            <div class="scraper-plan-row ${readyClass}">
                <div class="scraper-plan-status">${action.ready ? 'Ready' : 'Blocked'}</div>
                <div class="scraper-plan-paths">
                    <div><span>旧</span>${escapeHtml(action.old_path || action.old_name || '--')}</div>
                    <div><span>新</span>${escapeHtml(action.new_path || '--')}</div>
                    ${action.issue ? `<div class="scraper-plan-issue">${escapeHtml(action.issue)}</div>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function getJobStatusLabel(status) {
    const normalized = String(status || '').trim();
    const labels = {
        pending: '等待中',
        running: '执行中',
        completed: '已完成',
        partial: '部分完成',
        failed: '失败',
        rollback_running: '回退中',
        rolled_back: '已回退',
        rollback_failed: '回退失败',
    };
    return labels[normalized] || normalized || '--';
}

function renderJobs() {
    const list = $('scraper-job-list');
    if (!list) return;
    if (state.jobsBusy && !state.jobs.length) {
        list.innerHTML = '<div class="scraper-empty-row">正在读取任务记录...</div>';
        return;
    }
    if (!state.jobs.length) {
        list.innerHTML = '<div class="scraper-empty-row">暂无刮削任务记录。</div>';
        return;
    }
    list.innerHTML = state.jobs.map((job) => {
        const actions = Array.isArray(job.actions) ? job.actions : [];
        const actionPreview = actions.slice(0, 4).map(action => `
            <div class="scraper-job-action">
                <span>${escapeHtml(getJobStatusLabel(action.rollback_status || action.status))}</span>
                <span>${escapeHtml(action.new_path || action.old_path || action.old_name || '--')}</span>
            </div>
        `).join('');
        return `
            <div class="scraper-job-card">
                <div class="scraper-job-head">
                    <div>
                        <strong>#${escapeHtml(String(job.id || 0))} ${escapeHtml(getProviderLabel(job.provider))} · ${escapeHtml(getJobStatusLabel(job.status))}</strong>
                        <span>${escapeHtml(job.status_detail || '')}</span>
                    </div>
                    <div class="scraper-job-actions">
                        ${job.can_rollback ? `<button type="button" class="scraper-compact-btn" data-scraper-rollback-job="${escapeHtml(String(job.id || 0))}">回退</button>` : ''}
                    </div>
                </div>
                <div class="scraper-job-meta">
                    <span>成功 ${escapeHtml(String(job.succeeded_actions || 0))}</span>
                    <span>失败 ${escapeHtml(String(job.failed_actions || 0))}</span>
                    <span>${escapeHtml(formatTimeText(job.created_at))}</span>
                    <span>${escapeHtml(getTmdbDisplayTitle(job.tmdb || {}))}</span>
                </div>
                ${actionPreview ? `<div class="scraper-job-action-list">${actionPreview}</div>` : ''}
            </div>
        `;
    }).join('');
}

async function loadProviders() {
    const data = await window.MediaHubApi.getJson('/scraper/providers');
    state.providers = Array.isArray(data.providers) ? data.providers : [];
    const current = state.providers.find(item => normalizeProvider(item.provider) === state.provider);
    if (!current || !current.configured) {
        const firstConfigured = state.providers.find(item => item.configured);
        if (firstConfigured) state.provider = normalizeProvider(firstConfigured.provider);
    }
    renderProviderTabs();
    renderProviderStatus();
}

async function loadEntries({ force = false, keepSearch = true } = {}) {
    state.loading = true;
    renderEntries();
    try {
        const params = new URLSearchParams({ cid: state.cid });
        if (force) params.set('force_refresh', '1');
        if (keepSearch && state.search) params.set('q', state.search);
        const data = await window.MediaHubApi.getJson(`/scraper/${encodeURIComponent(state.provider)}/entries?${params.toString()}`);
        state.entries = (Array.isArray(data.entries) ? data.entries : []).map(enrichEntry);
        state.summary = data.summary || { folder_count: 0, file_count: 0 };
        clearSelection();
    } catch (error) {
        state.entries = [];
        state.summary = { folder_count: 0, file_count: 0 };
        showToast(`读取目录失败：${error.message || '未知错误'}`, { tone: 'error', duration: 3200, placement: 'top-center' });
    } finally {
        state.loading = false;
        renderEntries();
    }
}

async function switchProvider(provider) {
    const nextProvider = normalizeProvider(provider);
    if (state.provider === nextProvider) return;
    state.provider = nextProvider;
    state.cid = '0';
    state.trail = [{ id: '0', name: '根目录' }];
    state.search = '';
    $('scraper-search-input').value = '';
    clearSelection();
    clearPlan();
    state.identifyResult = null;
    state.tmdb = null;
    state.manualResults = [];
    renderProviderTabs();
    renderIdentify();
    await loadEntries();
}

async function enterFolder(entryId) {
    const entry = state.entries.find(item => item.id === String(entryId || ''));
    if (!entry || !entry.is_dir) return;
    state.cid = normalizeCid(entry.cid || entry.id);
    state.trail = state.trail.concat([{ id: state.cid, name: entry.name }]);
    state.search = '';
    $('scraper-search-input').value = '';
    clearPlan();
    await loadEntries({ keepSearch: false });
}

async function goTrail(index) {
    const targetIndex = Math.max(0, Number(index || 0) || 0);
    const target = state.trail[targetIndex] || state.trail[0];
    state.trail = state.trail.slice(0, targetIndex + 1);
    state.cid = normalizeCid(target.id);
    state.search = '';
    $('scraper-search-input').value = '';
    clearPlan();
    await loadEntries({ keepSearch: false });
}

async function createFolder() {
    const input = $('scraper-new-folder-name');
    const name = String(input?.value || '').trim();
    if (!name) {
        showToast('请先输入文件夹名称', { tone: 'warn', duration: 2200, placement: 'top-center' });
        return;
    }
    try {
        await window.MediaHubApi.postJson(`/scraper/${encodeURIComponent(state.provider)}/folders`, {
            cid: state.cid,
            name,
        });
        if (input) input.value = '';
        showToast('文件夹已创建', { tone: 'success', duration: 2200, placement: 'top-center' });
        await loadEntries({ force: true });
    } catch (error) {
        showToast(`新建失败：${error.message || '未知错误'}`, { tone: 'error', duration: 3200, placement: 'top-center' });
    }
}

async function renameSelected() {
    const selected = getSelectedEntries();
    if (selected.length !== 1) {
        showToast('请选择一个条目进行重命名', { tone: 'warn', duration: 2400, placement: 'top-center' });
        return;
    }
    const target = selected[0];
    const name = await promptText({
        title: '重命名',
        message: target.name,
        defaultValue: target.name,
        confirmText: '保存',
    });
    if (!name || name === target.name) return;
    try {
        await window.MediaHubApi.postJson(`/scraper/${encodeURIComponent(state.provider)}/rename`, {
            entry_id: target.id,
            parent_id: target.parent_id || state.cid,
            name,
        });
        showToast('已重命名', { tone: 'success', duration: 2200, placement: 'top-center' });
        await loadEntries({ force: true });
    } catch (error) {
        showToast(`重命名失败：${error.message || '未知错误'}`, { tone: 'error', duration: 3200, placement: 'top-center' });
    }
}

function prepareMove() {
    const selected = getSelectedEntries();
    if (!selected.length) {
        showToast('请先选择要移动的条目', { tone: 'warn', duration: 2200, placement: 'top-center' });
        return;
    }
    state.moveBuffer = {
        provider: state.provider,
        source_cid: state.cid,
        source_path: currentParentPath() || '根目录',
        entries: selected,
    };
    clearSelection();
    renderEntries();
    showToast('已记录待移动条目，请进入目标目录后执行移动', { tone: 'info', duration: 3000, placement: 'top-center' });
}

async function moveHere() {
    const buffer = state.moveBuffer;
    if (!buffer || !buffer.entries?.length) return;
    if (buffer.provider !== state.provider) {
        showToast('待移动条目与当前网盘不一致', { tone: 'warn', duration: 2600, placement: 'top-center' });
        return;
    }
    if (normalizeCid(buffer.source_cid) === normalizeCid(state.cid)) {
        showToast('目标目录与来源目录相同', { tone: 'warn', duration: 2200, placement: 'top-center' });
        return;
    }
    const ok = await showConfirm(`将 ${buffer.entries.length} 个条目移动到当前目录，确定继续吗？`, {
        title: '确认移动',
        confirmText: '移动',
    });
    if (!ok) return;
    try {
        await window.MediaHubApi.postJson(`/scraper/${encodeURIComponent(state.provider)}/move`, {
            entry_ids: buffer.entries.map(item => item.id),
            source_cid: buffer.source_cid,
            target_cid: state.cid,
        });
        state.moveBuffer = null;
        showToast('移动已完成', { tone: 'success', duration: 2400, placement: 'top-center' });
        await loadEntries({ force: true });
    } catch (error) {
        showToast(`移动失败：${error.message || '未知错误'}`, { tone: 'error', duration: 3400, placement: 'top-center' });
    }
}

async function deleteSelected() {
    const selected = getSelectedEntries();
    if (!selected.length) {
        showToast('请先选择要删除的条目', { tone: 'warn', duration: 2200, placement: 'top-center' });
        return;
    }
    const ok = await showConfirm(`确定删除 ${selected.length} 个条目吗？删除不纳入刮削任务回退。`, {
        title: '确认删除',
        confirmText: '删除',
        tone: 'error',
    });
    if (!ok) return;
    try {
        await window.MediaHubApi.postJson(`/scraper/${encodeURIComponent(state.provider)}/delete`, {
            entry_ids: selected.map(item => item.id),
            parent_id: state.cid,
        });
        showToast('已删除选中条目', { tone: 'success', duration: 2400, placement: 'top-center' });
        await loadEntries({ force: true });
    } catch (error) {
        showToast(`删除失败：${error.message || '未知错误'}`, { tone: 'error', duration: 3400, placement: 'top-center' });
    }
}

async function identifySelected() {
    const entries = getSelectedEntries();
    if (!entries.length) {
        showToast('请先选择要识别的文件或文件夹', { tone: 'warn', duration: 2400, placement: 'top-center' });
        return;
    }
    state.identifyBusy = true;
    state.identifyResult = null;
    state.tmdb = null;
    state.manualResults = [];
    clearPlan();
    renderIdentify();
    try {
        const data = await window.MediaHubApi.postJson('/scraper/identify', {
            provider: state.provider,
            entries,
        });
        state.identifyResult = data || {};
        const binding = data?.binding && Number(data.binding.tmdb_id || 0) > 0 ? data.binding : null;
        state.tmdb = binding;
        showToast(binding ? '已自动绑定 TMDB 条目' : '已完成初步识别，请选择 TMDB 条目', {
            tone: binding ? 'success' : 'info',
            duration: 2600,
            placement: 'top-center',
        });
    } catch (error) {
        state.identifyResult = { msg: error.message || '识别失败' };
        showToast(`识别失败：${error.message || '未知错误'}`, { tone: 'error', duration: 3400, placement: 'top-center' });
    } finally {
        state.identifyBusy = false;
        renderIdentify();
    }
}

async function bindTmdbCandidate(item) {
    if (!item) return;
    try {
        const mediaType = item.media_type === 'tv' ? 'tv' : 'movie';
        const params = new URLSearchParams({
            tmdb_id: String(item.id || item.tmdb_id || 0),
            media_type: mediaType,
        });
        const data = await window.MediaHubApi.getJson(`/tmdb/detail?${params.toString()}`);
        state.tmdb = data.task_binding || null;
        if (state.tmdb?.tmdb_media_type) {
            const mediaSelect = $('scraper-manual-media-type');
            if (mediaSelect) mediaSelect.value = state.tmdb.tmdb_media_type === 'tv' ? 'tv' : 'movie';
        }
        clearPlan();
        renderIdentify();
        showToast(`已绑定 TMDB：${getTmdbDisplayTitle()}`, { tone: 'success', duration: 2600, placement: 'top-center' });
    } catch (error) {
        showToast(`读取 TMDB 详情失败：${error.message || '未知错误'}`, { tone: 'error', duration: 3400, placement: 'top-center' });
    }
}

async function manualSearchTmdb() {
    const query = String($('scraper-manual-query')?.value || '').trim();
    if (!query) {
        showToast('请先输入影视名称', { tone: 'warn', duration: 2200, placement: 'top-center' });
        return;
    }
    const mediaType = $('scraper-manual-media-type')?.value === 'tv' ? 'tv' : 'movie';
    state.manualBusy = true;
    state.manualResults = [];
    renderIdentify();
    try {
        const params = new URLSearchParams({ q: query, media_type: mediaType });
        const data = await window.MediaHubApi.getJson(`/tmdb/search?${params.toString()}`);
        state.manualResults = Array.isArray(data.items) ? data.items : [];
        if (!state.manualResults.length) {
            showToast('未找到 TMDB 条目', { tone: 'warn', duration: 2400, placement: 'top-center' });
        }
    } catch (error) {
        showToast(`TMDB 搜索失败：${error.message || '未知错误'}`, { tone: 'error', duration: 3400, placement: 'top-center' });
    } finally {
        state.manualBusy = false;
        renderIdentify();
    }
}

async function buildPlan() {
    const entries = getSelectedEntries();
    if (!entries.length) {
        showToast('请先选择要刮削的文件或文件夹', { tone: 'warn', duration: 2400, placement: 'top-center' });
        return;
    }
    if (!state.tmdb || Number(state.tmdb.tmdb_id || state.tmdb.id || 0) <= 0) {
        showToast('请先绑定 TMDB 条目', { tone: 'warn', duration: 2400, placement: 'top-center' });
        return;
    }
    state.planBusy = true;
    state.plan = null;
    renderPlan();
    try {
        const data = await window.MediaHubApi.postJson('/scraper/rename-plan', {
            provider: state.provider,
            base_cid: state.cid,
            entries,
            tmdb: state.tmdb,
            options: collectOptions(),
        });
        state.plan = data;
        showToast(data.ready ? '预览已生成，可确认执行' : '预览存在冲突，请处理后再执行', {
            tone: data.ready ? 'success' : 'warn',
            duration: 2800,
            placement: 'top-center',
        });
    } catch (error) {
        showToast(`生成预览失败：${error.message || '未知错误'}`, { tone: 'error', duration: 3600, placement: 'top-center' });
    } finally {
        state.planBusy = false;
        renderPlan();
    }
}

async function executePlan() {
    if (!state.plan?.ready) return;
    const ok = await showConfirm('确认按当前预览执行重命名和移动吗？', {
        title: '确认执行',
        confirmText: '执行',
    });
    if (!ok) return;
    state.executeBusy = true;
    renderPlan();
    try {
        const data = await window.MediaHubApi.postJson('/scraper/jobs/create', { plan: state.plan });
        showToast(`刮削任务已提交 #${data.job_id}`, { tone: 'success', duration: 2600, placement: 'top-center' });
        await refreshJobs();
        scheduleJobsPoll();
        await loadEntries({ force: true });
    } catch (error) {
        showToast(`提交失败：${error.message || '未知错误'}`, { tone: 'error', duration: 3600, placement: 'top-center' });
    } finally {
        state.executeBusy = false;
        renderPlan();
    }
}

async function refreshJobs() {
    state.jobsBusy = true;
    renderJobs();
    try {
        const data = await window.MediaHubApi.getJson('/scraper/jobs/state?limit=20');
        state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
    } catch (error) {
        showToast(`读取任务记录失败：${error.message || '未知错误'}`, { tone: 'error', duration: 3200, placement: 'top-center' });
    } finally {
        state.jobsBusy = false;
        renderJobs();
    }
}

function hasActiveJobs() {
    return state.jobs.some(job => SCRAPER_JOB_ACTIVE_STATUSES.has(String(job.status || '').trim()));
}

function scheduleJobsPoll() {
    if (state.jobsPollTimer) return;
    state.jobsPollTimer = window.setInterval(async () => {
        await refreshJobs();
        if (!hasActiveJobs()) {
            window.clearInterval(state.jobsPollTimer);
            state.jobsPollTimer = 0;
            await loadEntries({ force: true });
        }
    }, 3000);
}

async function rollbackJob(jobId) {
    const normalizedJobId = Number(jobId || 0) || 0;
    if (normalizedJobId <= 0) return;
    const ok = await showConfirm(`回退刮削任务 #${normalizedJobId} 的成功动作吗？`, {
        title: '确认回退',
        confirmText: '回退',
    });
    if (!ok) return;
    try {
        await window.MediaHubApi.postJson(`/scraper/jobs/${encodeURIComponent(String(normalizedJobId))}/rollback`, {});
        showToast('回退任务已提交', { tone: 'success', duration: 2400, placement: 'top-center' });
        await refreshJobs();
        scheduleJobsPoll();
    } catch (error) {
        showToast(`回退提交失败：${error.message || '未知错误'}`, { tone: 'error', duration: 3400, placement: 'top-center' });
    }
}

function setSelected(entryId, checked) {
    const id = String(entryId || '').trim();
    if (!id) return;
    const entry = state.entries.find(item => item.id === id);
    if (!entry) return;
    if (checked) {
        state.selected.set(id, entry);
    } else {
        state.selected.delete(id);
    }
    clearPlan();
    renderEntries();
}

function toggleAll(checked) {
    if (checked) {
        state.entries.forEach(entry => state.selected.set(entry.id, entry));
    } else {
        clearSelection();
    }
    clearPlan();
    renderEntries();
}

function handleClick(event) {
    const providerButton = event.target.closest('[data-scraper-provider]');
    if (providerButton) {
        void switchProvider(providerButton.dataset.scraperProvider);
        return;
    }
    const trailButton = event.target.closest('[data-scraper-trail-index]');
    if (trailButton) {
        void goTrail(trailButton.dataset.scraperTrailIndex);
        return;
    }
    const entryButton = event.target.closest('[data-scraper-entry-enter]');
    if (entryButton) {
        void enterFolder(entryButton.dataset.scraperEntryEnter);
        return;
    }
    const candidateButton = event.target.closest('[data-scraper-candidate-index]');
    if (candidateButton) {
        const items = state.identifyResult?.candidates || state.identifyResult?.items || [];
        void bindTmdbCandidate(items[Number(candidateButton.dataset.scraperCandidateIndex || 0)]);
        return;
    }
    const manualButton = event.target.closest('[data-scraper-manual-index]');
    if (manualButton) {
        void bindTmdbCandidate(state.manualResults[Number(manualButton.dataset.scraperManualIndex || 0)]);
        return;
    }
    const rollbackButton = event.target.closest('[data-scraper-rollback-job]');
    if (rollbackButton) {
        void rollbackJob(rollbackButton.dataset.scraperRollbackJob);
        return;
    }
    const actionButton = event.target.closest('[data-scraper-action]');
    if (!actionButton) return;
    const action = String(actionButton.dataset.scraperAction || '').trim();
    if (action === 'refresh') void loadEntries({ force: true });
    if (action === 'search') {
        state.search = String($('scraper-search-input')?.value || '').trim();
        void loadEntries();
    }
    if (action === 'create-folder') void createFolder();
    if (action === 'rename-selected') void renameSelected();
    if (action === 'prepare-move') prepareMove();
    if (action === 'delete-selected') void deleteSelected();
    if (action === 'identify') void identifySelected();
    if (action === 'manual-search') void manualSearchTmdb();
    if (action === 'build-plan') void buildPlan();
    if (action === 'execute-plan') void executePlan();
    if (action === 'refresh-jobs') void refreshJobs();
    if (action === 'move-here') void moveHere();
    if (action === 'clear-move') {
        state.moveBuffer = null;
        renderEntries();
    }
}

function handleChange(event) {
    const check = event.target.closest('[data-scraper-check]');
    if (check) {
        setSelected(check.dataset.scraperCheck, check.checked);
        return;
    }
    if (event.target?.id === 'scraper-check-all') {
        toggleAll(!!event.target.checked);
        return;
    }
    if (event.target?.matches('[data-scraper-tag], #scraper-title-language, #scraper-season')) {
        clearPlan();
    }
}

function bindEvents() {
    const root = $('page-scraper');
    if (!root || root.dataset.scraperBound === '1') return;
    root.dataset.scraperBound = '1';
    root.addEventListener('click', handleClick);
    root.addEventListener('change', handleChange);
    $('scraper-search-input')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.isComposing) return;
        state.search = String(event.target.value || '').trim();
        void loadEntries();
    });
    $('scraper-new-folder-name')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.isComposing) return;
        void createFolder();
    });
    $('scraper-manual-query')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.isComposing) return;
        void manualSearchTmdb();
    });
}

async function refreshInitialData() {
    await loadProviders();
    renderProviderTabs();
    renderIdentify();
    renderPlan();
    await Promise.all([
        loadEntries(),
        refreshJobs(),
    ]);
    if (hasActiveJobs()) scheduleJobsPoll();
}

export async function ensureScraperManager({ firstVisit = false } = {}) {
    bindEvents();
    if (!state.initialized || firstVisit) {
        state.initialized = true;
        await refreshInitialData();
        return;
    }
    renderProviderTabs();
    renderEntries();
    renderIdentify();
    renderPlan();
    renderJobs();
    if (hasActiveJobs()) scheduleJobsPoll();
}
