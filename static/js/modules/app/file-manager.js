(function (global) {
    function escapeHtml(value) {
        if (typeof global.escapeHtml === 'function') return global.escapeHtml(value);
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    function escapeAttr(value) {
        return escapeHtml(value);
    }

    function parseModifiedMs(value) {
        const text = String(value || '').trim();
        if (!text) return 0;
        if (/^\d{10,17}$/.test(text)) {
            const numeric = Number(text);
            if (Number.isFinite(numeric)) return text.length === 10 ? numeric * 1000 : numeric;
        }
        const parsed = Date.parse(text);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function formatDateMinute(date) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
        const pad = value => String(value).padStart(2, '0');
        return [
            date.getFullYear(),
            pad(date.getMonth() + 1),
            pad(date.getDate()),
        ].join('-') + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function formatModified(value) {
        const text = String(value || '').trim();
        if (!text) return '--';
        if (/^\d{10,17}$/.test(text)) {
            const numeric = Number(text);
            if (Number.isFinite(numeric)) {
                const timestamp = text.length === 10 ? numeric * 1000 : numeric;
                return formatDateMinute(new Date(timestamp)) || text;
            }
        }
        const parsed = Date.parse(text);
        if (Number.isFinite(parsed)) return formatDateMinute(new Date(parsed)) || text;
        return text.replace('T', ' ').slice(0, 16);
    }

    function formatFileSize(value) {
        const size = Number(value || 0);
        if (!Number.isFinite(size) || size <= 0) return '--';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let next = size;
        let unit = 0;
        while (next >= 1024 && unit < units.length - 1) {
            next /= 1024;
            unit += 1;
        }
        return `${next.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
    }

    function getEntryId(entry = {}) {
        return String(entry?.id || entry?.cid || entry?.fid || entry?.pick_code || entry?.path || entry?.name || '').trim();
    }

    function getEntryName(entry = {}) {
        return String(entry?.name || entry?.file_name || entry?.path || '--').trim() || '--';
    }

    function getEntryModified(entry = {}) {
        return entry?.modified_at || entry?.last_modified || entry?.updated_at || entry?.create_time || entry?.time || '';
    }

    function getSortDataset(entry = {}) {
        return {
            name: getEntryName(entry),
            size: String(Number(entry?.size || 0) || 0),
            modified: String(parseModifiedMs(getEntryModified(entry))),
            isDir: entry?.is_dir ? '1' : '0',
        };
    }

    function getIconSvg(isDir) {
        if (isDir) {
            return `
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path fill="currentColor" d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h3.172c.597 0 1.169.237 1.591.659l1.078 1.078c.14.14.33.22.53.22H18A2.25 2.25 0 0 1 20.25 8.7v.6H3.75v-2.55Z"/>
                    <path fill="currentColor" d="M3 10.8A1.8 1.8 0 0 1 4.8 9h14.4A1.8 1.8 0 0 1 21 10.8v4.95A3.75 3.75 0 0 1 17.25 19.5H6.75A3.75 3.75 0 0 1 3 15.75V10.8Z"/>
                </svg>
            `;
        }
        return `
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path fill="currentColor" d="M7.5 3.75A2.25 2.25 0 0 0 5.25 6v12A2.25 2.25 0 0 0 7.5 20.25h9A2.25 2.25 0 0 0 18.75 18V8.56a2.25 2.25 0 0 0-.659-1.591l-2.56-2.56A2.25 2.25 0 0 0 13.94 3.75H7.5Z"/>
                <path fill="rgba(15,23,42,0.18)" d="M14.25 3.9v3.6c0 .414.336.75.75.75h3.6"/>
            </svg>
        `;
    }

    function renderIcon(entryOrIsDir, extraClass = '') {
        const isDir = typeof entryOrIsDir === 'boolean' ? entryOrIsDir : !!entryOrIsDir?.is_dir;
        const typeClass = isDir ? 'is-folder' : 'is-file';
        return `<span class="resource-entry-icon file-manager-icon scraper-entry-icon ${typeClass} ${escapeAttr(extraClass)}">${getIconSvg(isDir)}</span>`;
    }

    function renderNameCell(entry = {}, {
        checkboxHtml = '',
        nameHtml = '',
        metaHtml = '',
        allowMeta = false,
        iconClass = '',
        mainClass = '',
    } = {}) {
        const name = nameHtml || `<span class="file-manager-entry-name scraper-entry-filename" title="${escapeAttr(getEntryName(entry))}">${escapeHtml(getEntryName(entry))}</span>`;
        const meta = allowMeta && metaHtml ? `<div class="file-manager-entry-sub resource-browser-entry-sub">${metaHtml}</div>` : '';
        return `
            <div class="file-manager-name-cell scraper-entry-name-cell">
                ${checkboxHtml}
                ${renderIcon(entry, iconClass)}
                <div class="file-manager-entry-main scraper-entry-main ${escapeAttr(mainClass)}">
                    ${name}
                    ${meta}
                </div>
            </div>
        `;
    }

    function normalizeEntryFilter(filter) {
        const value = String(filter || 'all').trim().toLowerCase();
        if (value === 'folders' || value === 'files') return value;
        return 'all';
    }

    function filterEntries(entries = [], filter = 'all') {
        const normalized = normalizeEntryFilter(filter);
        const list = Array.isArray(entries) ? entries : [];
        if (normalized === 'folders') return list.filter(entry => !!entry?.is_dir);
        if (normalized === 'files') return list.filter(entry => !entry?.is_dir);
        return list.slice();
    }

    function compareEntries(a = {}, b = {}, sort = {}, { foldersFirst = true } = {}) {
        if (foldersFirst && !!a?.is_dir !== !!b?.is_dir) return a?.is_dir ? -1 : 1;
        const key = ['name', 'size', 'modified_at'].includes(String(sort?.key || '')) ? String(sort.key) : 'name';
        const direction = sort?.direction === 'desc' ? -1 : 1;
        let result = 0;
        if (key === 'size') {
            result = (Number(a?.size || 0) || 0) - (Number(b?.size || 0) || 0);
        } else if (key === 'modified_at') {
            result = parseModifiedMs(getEntryModified(a)) - parseModifiedMs(getEntryModified(b));
        }
        if (result === 0) {
            result = getEntryName(a).localeCompare(getEntryName(b), 'zh-Hans-CN');
        }
        return result * direction;
    }

    function sortEntries(entries = [], sort = {}, options = {}) {
        return filterEntries(entries, options.entryFilter || 'all')
            .slice()
            .sort((a, b) => compareEntries(a, b, sort, options));
    }

    function renderSortButton(column = {}, sort = {}, {
        sortDataAttr = 'data-file-manager-sort',
        sortButtonClass = 'file-manager-sort-button scraper-sort-button',
    } = {}) {
        const key = String(column.key || '');
        const label = String(column.label || key || '--');
        const active = sort?.key === key;
        const direction = active && sort?.direction === 'desc' ? 'desc' : 'asc';
        const nextDirection = active && direction === 'asc' ? 'desc' : 'asc';
        const indicator = active ? (direction === 'asc' ? '↑' : '↓') : '';
        return `
            <button
                type="button"
                class="${sortButtonClass} ${active ? 'is-active' : ''}"
                ${sortDataAttr}="${escapeAttr(key)}"
                aria-label="按${escapeAttr(label)}${nextDirection === 'asc' ? '升序' : '降序'}排序"
                aria-pressed="${active ? 'true' : 'false'}"
            >
                <span>${escapeHtml(label)}</span>
                <span class="file-manager-sort-indicator scraper-sort-indicator" aria-hidden="true">${escapeHtml(indicator)}</span>
            </button>
        `;
    }

    function renderHeader(columns = [], options = {}) {
        const sort = options.sort || {};
        const cells = columns.map((column) => {
            const className = [
                column.className || '',
                column.cellClass || '',
                column.headerClass || '',
            ].filter(Boolean).join(' ');
            const html = column.headerHtml
                ? (typeof column.headerHtml === 'function' ? column.headerHtml(column) : column.headerHtml)
                : (column.sortable ? renderSortButton(column, sort, options) : escapeHtml(column.label || column.key || '--'));
            return `<div class="file-manager-header-cell ${escapeAttr(className)}">${html}</div>`;
        }).join('');
        return `<div class="file-manager-header scraper-entry-header ${escapeAttr(options.headerClass || '')}">${cells}</div>`;
    }

    function renderEmpty(message = '当前没有可显示条目。', className = '') {
        return `<div class="file-manager-empty scraper-empty-row ${escapeAttr(className)}">${escapeHtml(message)}</div>`;
    }

    function renderRows(entries = [], columns = [], options = {}) {
        const list = Array.isArray(entries) ? entries : [];
        if (!list.length) return renderEmpty(options.emptyText, options.emptyClass || '');
        const rowTag = options.rowTag || 'div';
        return list.map((entry, index) => {
            const isDir = !!entry?.is_dir;
            const id = getEntryId(entry);
            const typeClass = isDir ? 'resource-entry-dir' : 'resource-entry-file';
            const selectedClass = typeof options.isSelected === 'function' && options.isSelected(entry, index) ? 'is-selected' : '';
            const rowClass = typeof options.rowClass === 'function' ? options.rowClass(entry, index) : String(options.rowClass || '');
            const attrs = typeof options.rowAttrs === 'function' ? options.rowAttrs(entry, index) : String(options.rowAttrs || '');
            const sortDataset = getSortDataset(entry);
            const cells = columns.map((column) => {
                const className = column.cellClass || column.className || '';
                const html = typeof column.render === 'function'
                    ? column.render(entry, index)
                    : renderDefaultCell(entry, column);
                return `<div class="file-manager-cell ${escapeAttr(className)}">${html}</div>`;
            }).join('');
            const typeAttr = rowTag === 'button' && !/\btype=/.test(attrs) ? ' type="button"' : '';
            return `<${rowTag}${typeAttr} class="file-manager-row scraper-entry-row ${typeClass} ${selectedClass} ${escapeAttr(rowClass)}" data-file-manager-entry-id="${escapeAttr(id)}" data-file-manager-name="${escapeAttr(sortDataset.name)}" data-file-manager-size="${escapeAttr(sortDataset.size)}" data-file-manager-modified="${escapeAttr(sortDataset.modified)}" data-file-manager-is-dir="${escapeAttr(sortDataset.isDir)}" ${attrs}>${cells}</${rowTag}>`;
        }).join('');
    }

    function renderDefaultCell(entry = {}, column = {}) {
        const key = String(column.key || '');
        if (key === 'name') return renderNameCell(entry);
        if (key === 'size') return entry?.is_dir ? '--' : escapeHtml(formatFileSize(entry?.size || 0));
        if (key === 'modified_at') return escapeHtml(formatModified(getEntryModified(entry)));
        if (key === 'kind') return entry?.is_dir ? '文件夹' : '文件';
        return escapeHtml(entry?.[key] ?? '--');
    }

    function renderTable({
        entries = [],
        columns = [],
        sort = null,
        entryFilter = 'all',
        foldersFirst = true,
        sortable = false,
        tableClass = '',
        headerClass = '',
        listClass = '',
        emptyText = '当前没有可显示条目。',
        rowClass = '',
        rowAttrs = '',
        rowTag = 'div',
        isSelected = null,
        loading = false,
        loadingText = '正在读取目录...',
        errorText = '',
        minWidth = '620px',
        gridTemplate = '',
        sortDataAttr = 'data-file-manager-sort',
        sortButtonClass = 'file-manager-sort-button scraper-sort-button',
    } = {}) {
        const activeSort = sort || { key: 'name', direction: 'asc' };
        const visibleEntries = sortable || sort
            ? sortEntries(entries, activeSort, { foldersFirst, entryFilter })
            : filterEntries(entries, entryFilter);
        const tableStyle = [
            gridTemplate ? `--file-manager-columns:${gridTemplate}` : '',
            minWidth ? `--file-manager-min-width:${minWidth}` : '',
        ].filter(Boolean).join(';');
        const styleAttr = tableStyle ? ` style="${escapeAttr(tableStyle)}"` : '';
        const header = renderHeader(columns, {
            sort: activeSort,
            sortDataAttr,
            sortButtonClass,
            headerClass,
        });
        const rows = errorText
            ? renderEmpty(errorText, 'file-manager-empty-error')
            : (loading
                ? renderEmpty(loadingText, 'file-manager-empty-loading')
                : renderRows(visibleEntries, columns, {
                    emptyText,
                    rowClass,
                    rowAttrs,
                    rowTag,
                    isSelected,
                }));
        return `
            <div class="file-manager-table scraper-entry-table ${escapeAttr(tableClass)}" data-file-manager-sort-key="${escapeAttr(activeSort.key || 'name')}" data-file-manager-sort-direction="${escapeAttr(activeSort.direction === 'desc' ? 'desc' : 'asc')}" data-file-manager-folders-first="${foldersFirst ? '1' : '0'}"${styleAttr}>
                ${header}
                <div class="file-manager-list scraper-entry-list ${escapeAttr(listClass)}">${rows}</div>
            </div>
        `;
    }

    function compareRowSortValues(a, b, key, direction, foldersFirst) {
        if (foldersFirst && a.dataset.fileManagerIsDir !== b.dataset.fileManagerIsDir) {
            return a.dataset.fileManagerIsDir === '1' ? -1 : 1;
        }
        let result = 0;
        if (key === 'size') {
            result = (Number(a.dataset.fileManagerSize || 0) || 0) - (Number(b.dataset.fileManagerSize || 0) || 0);
        } else if (key === 'modified_at') {
            result = (Number(a.dataset.fileManagerModified || 0) || 0) - (Number(b.dataset.fileManagerModified || 0) || 0);
        } else {
            result = String(a.dataset.fileManagerName || '').localeCompare(String(b.dataset.fileManagerName || ''), 'zh-Hans-CN');
        }
        if (result === 0) {
            result = String(a.dataset.fileManagerName || '').localeCompare(String(b.dataset.fileManagerName || ''), 'zh-Hans-CN');
        }
        return result * (direction === 'desc' ? -1 : 1);
    }

    function syncSortButtons(table, key, direction) {
        table.querySelectorAll('[data-file-manager-sort]').forEach((button) => {
            const active = button.dataset.fileManagerSort === key;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
            const indicator = button.querySelector('.file-manager-sort-indicator, .scraper-sort-indicator');
            if (indicator) indicator.textContent = active ? (direction === 'asc' ? '↑' : '↓') : '';
        });
    }

    function sortRenderedTable(table, key) {
        const list = table?.querySelector('.file-manager-list');
        if (!table || !list) return;
        const normalizedKey = ['name', 'size', 'modified_at'].includes(String(key || '')) ? String(key) : 'name';
        const currentKey = table.dataset.fileManagerSortKey || 'name';
        const currentDirection = table.dataset.fileManagerSortDirection === 'desc' ? 'desc' : 'asc';
        const nextDirection = currentKey === normalizedKey && currentDirection === 'asc' ? 'desc' : 'asc';
        const foldersFirst = table.dataset.fileManagerFoldersFirst !== '0';
        const rows = Array.from(list.querySelectorAll('.file-manager-row'));
        rows
            .sort((a, b) => compareRowSortValues(a, b, normalizedKey, nextDirection, foldersFirst))
            .forEach(row => list.appendChild(row));
        table.dataset.fileManagerSortKey = normalizedKey;
        table.dataset.fileManagerSortDirection = nextDirection;
        syncSortButtons(table, normalizedKey, nextDirection);
    }

    function handleSortClick(event) {
        const button = event.target?.closest?.('[data-file-manager-sort]');
        if (!button) return;
        const table = button.closest('.file-manager-table');
        if (!table) return;
        event.preventDefault();
        sortRenderedTable(table, button.dataset.fileManagerSort || 'name');
    }

    if (!global.__mediaHubFileManagerSortBound) {
        global.__mediaHubFileManagerSortBound = true;
        global.document?.addEventListener('click', handleSortClick);
    }

    global.MediaHubFileManager = {
        escapeHtml,
        escapeAttr,
        parseModifiedMs,
        formatModified,
        formatFileSize,
        getEntryId,
        getEntryName,
        getEntryModified,
        getSortDataset,
        getIconSvg,
        renderIcon,
        renderNameCell,
        filterEntries,
        compareEntries,
        sortEntries,
        renderSortButton,
        renderHeader,
        renderRows,
        renderEmpty,
        renderTable,
    };
})(window);
