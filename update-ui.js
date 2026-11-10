// Update banner and the Updates section in Settings. Checks on launch and every 6 hours.
(() => {
    const { ipcRenderer } = require('electron');
    const remote = require('@electron/remote');

    const KEYS = { auto: 'philament_update_auto', skip: 'philament_update_skip', last: 'philament_update_last' };
    const FIRST_CHECK_MS = 5000;
    const EVERY_MS = 6 * 60 * 60 * 1000;
    const CURRENT = remote.app.getVersion();

    const $ = (id) => document.getElementById(id);
    const read = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } };
    const write = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
    const cleanError = (e) => String((e && e.message) || e || 'Something went wrong.').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

    const state = {
        release: null, // last check result
        file: null, // downloaded installer
        laterFor: null, // version dismissed with "Later" for this session
        busy: false,
    };

    // Release notes: GitHub markdown → simple, safe HTML
    function esc(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function inline(s) {
        return esc(s)
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1');
    }

    function notesHtml(md) {
        const lines = String(md || '').replace(/\r/g, '').split('\n');
        let html = '';
        let inList = false;
        for (const raw of lines) {
            const line = raw.trim();
            const bullet = /^[-*+]\s+(.*)/.exec(line);
            if (bullet) {
                if (!inList) { html += '<ul>'; inList = true; }
                html += `<li>${inline(bullet[1])}</li>`;
                continue;
            }
            if (inList) { html += '</ul>'; inList = false; }
            if (!line) continue;
            const heading = /^#{1,6}\s+(.*)/.exec(line);
            html += heading ? `<h5>${inline(heading[1])}</h5>` : `<p>${inline(line)}</p>`;
        }
        if (inList) html += '</ul>';
        return html || '<p>No release notes.</p>';
    }

    // Banner
    function button(label, onClick, kind = 'secondary') {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = kind === 'primary' ? 'btn-primary' : kind === 'link' ? 'link-btn' : 'btn-secondary';
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
    }

    function mb(bytes) {
        return (bytes / 1048576).toFixed(1);
    }

    function show(view) {
        const banner = $('update-banner');
        banner.dataset.view = view.kind;
        $('update-title').textContent = view.title;
        $('update-detail').textContent = view.detail || '';
        $('update-progress').classList.toggle('hidden', view.kind !== 'downloading');
        $('update-actions').replaceChildren(...(view.actions || []));
        if (view.kind !== 'available') $('update-notes').classList.add('hidden');
        banner.classList.remove('hidden');
    }

    function hide() {
        $('update-banner').classList.add('hidden');
        $('update-notes').classList.add('hidden');
    }

    function showAvailable(r) {
        const notes = $('update-notes');
        const whatsNew = button('What’s New', () => {
            const open = notes.classList.toggle('hidden') === false;
            whatsNew.classList.toggle('active', open);
        });
        $('update-notes-body').innerHTML = notesHtml(r.notes);
        show({
            kind: 'available',
            title: `Philament ${r.version} is available`,
            detail: `You have ${CURRENT}.${r.asset ? ` Download size ${mb(r.asset.size)} MB.` : ''}`,
            actions: [
                whatsNew,
                button('Later', () => { state.laterFor = r.version; hide(); }),
                r.asset
                    ? button('Download Update', startDownload, 'primary')
                    : button('Open on GitHub', () => ipcRenderer.invoke('update-release-page'), 'primary'),
            ],
        });
    }

    function showDownloading(received, total) {
        const pct = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
        $('update-progress-bar').style.width = `${pct}%`;
        const detail = total ? `${pct}% · ${mb(received)} of ${mb(total)} MB` : `${mb(received)} MB`;
        if ($('update-banner').dataset.view === 'downloading') {
            $('update-detail').textContent = detail;
            return;
        }
        show({
            kind: 'downloading',
            title: `Downloading Philament ${state.release.version}…`,
            detail,
            actions: [button('Cancel', () => ipcRenderer.invoke('update-cancel'))],
        });
    }

    function showReady() {
        show({
            kind: 'ready',
            title: `Philament ${state.release.version} is ready to install`,
            detail: 'Philament will quit and open the installer. Drag Philament into Applications and choose Replace, then open it again.',
            actions: [
                button('Later', hide),
                button('Install & Quit', install, 'primary'),
            ],
        });
    }

    function showError(message, retry) {
        show({
            kind: 'error',
            title: 'Couldn’t update Philament',
            detail: message,
            actions: [
                button('Close', hide),
                button('View on GitHub', () => ipcRenderer.invoke('update-release-page')),
                ...(retry ? [button('Try Again', retry, 'primary')] : []),
            ],
        });
    }

    function showUpToDate() {
        show({
            kind: 'uptodate',
            title: 'Philament is up to date',
            detail: `${CURRENT} is the latest version.`,
            actions: [button('OK', hide)],
        });
        clearTimeout(state.okTimer);
        state.okTimer = setTimeout(() => { if ($('update-banner').dataset.view === 'uptodate') hide(); }, 6000);
    }

    // Actions
    async function check({ manual = false } = {}) {
        if (state.busy) return;
        state.busy = true;
        setSettingsStatus('Checking…');
        $('update-check-btn').disabled = true;
        try {
            const r = await ipcRenderer.invoke('update-check');
            write(KEYS.last, String(Date.now()));
            state.release = r;
            if (r.available) {
                setSettingsStatus(`Version ${r.version} is available`);
                const skipped = read(KEYS.skip, '') === r.version;
                const deferred = state.laterFor === r.version;
                const inProgress = ['downloading', 'ready'].includes($('update-banner').dataset.view) && !$('update-banner').classList.contains('hidden');
                if (!inProgress && (manual || (!skipped && !deferred))) showAvailable(r);
            } else {
                setSettingsStatus(r.none ? 'No releases published yet' : 'You’re up to date');
                if (manual) showUpToDate();
            }
        } catch (e) {
            setSettingsStatus('Couldn’t check for updates');
            if (manual) showError(cleanError(e), () => check({ manual: true }));
        } finally {
            state.busy = false;
            $('update-check-btn').disabled = false;
            stampLastChecked();
        }
    }

    async function startDownload() {
        showDownloading(0, state.release.asset ? state.release.asset.size : 0);
        try {
            const { file } = await ipcRenderer.invoke('update-download');
            state.file = file;
            showReady();
        } catch (e) {
            const msg = cleanError(e);
            if (/canceled/i.test(msg)) showAvailable(state.release);
            else showError(msg, startDownload);
        }
    }

    async function install() {
        try {
            await ipcRenderer.invoke('update-install', state.file);
            $('update-title').textContent = 'Opening the installer…';
        } catch (e) {
            showError(cleanError(e), startDownload);
        }
    }

    ipcRenderer.on('update-progress', (event, { received, total }) => {
        if (state.release) showDownloading(received, total);
    });

    // Settings
    function setSettingsStatus(text) {
        $('update-settings-status').dataset.status = text;
        stampLastChecked();
    }

    function stampLastChecked() {
        const status = $('update-settings-status').dataset.status || '';
        const last = Number(read(KEYS.last, 0));
        const when = last ? new Date(last).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
        $('update-settings-status').textContent = [status, when && status !== 'Checking…' ? `checked ${when}` : ''].filter(Boolean).join(' · ') || 'Not checked yet';
    }

    function autoEnabled() {
        return read(KEYS.auto, '1') !== '0';
    }

    function init() {
        $('update-settings-version').textContent = `Philament ${CURRENT}`;
        stampLastChecked();
        const auto = $('update-auto');
        auto.checked = autoEnabled();
        auto.addEventListener('change', () => write(KEYS.auto, auto.checked ? '1' : '0'));
        $('update-check-btn').addEventListener('click', () => check({ manual: true }));
        $('update-skip').addEventListener('click', () => {
            if (state.release) write(KEYS.skip, state.release.version);
            hide();
        });
        $('update-github').addEventListener('click', () => ipcRenderer.invoke('update-release-page'));

        ipcRenderer.on('update-menu-check', () => check({ manual: true }));
        ipcRenderer.on('open-settings', () => { openSettingsModal(); });

        setTimeout(() => { if (autoEnabled()) check(); }, FIRST_CHECK_MS);
        setInterval(() => { if (autoEnabled()) check(); }, EVERY_MS);
    }

    window.philamentUpdates = { check, notesHtml };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
