// Saved tab: links to models on any 3D printing site.

(() => {
    const { ipcRenderer, shell } = require('electron');
    const copyText = (text) => ipcRenderer.invoke('copy-text', String(text));
    const remote = require('@electron/remote');
    const fs = require('fs');
    const path = require('path');

    const STORE_KEY = 'philament_saved_links';
    const VIEW_KEY = 'philament_view';
    const IMAGE_DIR = path.join(remote.app.getPath('userData'), 'saved-images');
    const IMAGE_MAX = 640;

    // Known sites get a proper name and a colored badge; any other site still works
    const SITES = [
        { match: 'makerworld.com', name: 'MakerWorld', color: '#00ae42' },
        { match: 'printables.com', name: 'Printables', color: '#fa6831' },
        { match: 'thingiverse.com', name: 'Thingiverse', color: '#248bfb' },
        { match: 'cults3d.com', name: 'Cults', color: '#7c3aed' },
        { match: 'thangs.com', name: 'Thangs', color: '#4f46e5' },
        { match: 'myminifactory.com', name: 'MyMiniFactory', color: '#e11d48' },
        { match: 'crealitycloud.com', name: 'Creality Cloud', color: '#2563eb' },
        { match: 'grabcad.com', name: 'GrabCAD', color: '#0284c7' },
        { match: 'cgtrader.com', name: 'CGTrader', color: '#0f766e' },
        { match: 'pinshape.com', name: 'Pinshape', color: '#db2777' },
        { match: 'yeggi.com', name: 'Yeggi', color: '#ca8a04' },
        { match: 'youmagine.com', name: 'YouMagine', color: '#0891b2' },
        { match: 'makeronline.com', name: 'Makeronline', color: '#ea580c' },
        { match: 'github.com', name: 'GitHub', color: '#334155' },
    ];
    const OTHER_COLORS = ['#0ea5e9', '#14b8a6', '#8b5cf6', '#f59e0b', '#ef4444', '#64748b'];

    const $ = (id) => document.getElementById(id);
    const state = {
        items: load(),
        site: 'all',
        tag: null,
        query: '',
        imageCache: new Map(),
        undo: null,
    };

    // Storage

    function load() {
        try {
            const v = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
            return Array.isArray(v) ? v.filter((i) => i && typeof i.url === 'string') : [];
        } catch (e) {
            return [];
        }
    }

    function save() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(state.items)); } catch (e) { console.error('Could not save links', e); }
    }

    function imagePath(file) {
        return path.join(IMAGE_DIR, path.basename(file));
    }

    function imageUrl(item) {
        if (!item.image) return null;
        if (state.imageCache.has(item.image)) return state.imageCache.get(item.image);
        try {
            const data = fs.readFileSync(imagePath(item.image));
            const url = 'data:image/jpeg;base64,' + data.toString('base64');
            state.imageCache.set(item.image, url);
            return url;
        } catch (e) {
            return null;
        }
    }

    function deleteImage(file) {
        if (!file) return;
        state.imageCache.delete(file);
        fs.promises.unlink(imagePath(file)).catch(() => {});
    }

    // Shrinks any image to a small JPEG and keeps it on disk, so cards show instantly and work offline
    async function storeImage(id, bytes, type) {
        const blob = new Blob([bytes], { type: type || 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);
        const scale = Math.min(1, IMAGE_MAX / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
        const file = `${id}-${Date.now()}.jpg`;
        await fs.promises.mkdir(IMAGE_DIR, { recursive: true });
        await fs.promises.writeFile(imagePath(file), Buffer.from(await jpeg.arrayBuffer()));
        return file;
    }

    // Links

    // Accepts "makerworld.com/…" too; drops tracking parameters and #fragments so duplicates are caught
    function normalizeUrl(raw) {
        let text = String(raw || '').trim();
        if (!text) return null;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(text) && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(text)) text = 'https://' + text;
        let u;
        try { u = new URL(text); } catch (e) { return null; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        u.hash = '';
        for (const key of [...u.searchParams.keys()]) {
            if (/^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|from$)/i.test(key)) u.searchParams.delete(key);
        }
        return u.href;
    }

    function sameLink(a, b) {
        const strip = (s) => s.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '').toLowerCase();
        return strip(a) === strip(b);
    }

    function hostOf(url) {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
    }

    function siteOf(url, siteName) {
        const host = hostOf(url);
        const known = SITES.find((s) => host === s.match || host.endsWith('.' + s.match));
        if (known) return { key: known.match, name: known.name, color: known.color };
        const name = cleanSiteName(siteName) || prettyHost(host);
        const color = OTHER_COLORS[[...host].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % OTHER_COLORS.length];
        return { key: host, name, color };
    }

    function cleanSiteName(name) {
        return String(name || '').replace(/\.(com|org|net|io|co)$/i, '').trim().slice(0, 30);
    }

    function prettyHost(host) {
        const base = host.split('.').slice(-2, -1)[0] || host;
        return base.charAt(0).toUpperCase() + base.slice(1);
    }

    // A readable title from the link itself, used until (or if) the page can't be read
    function titleFromUrl(url) {
        try {
            const u = new URL(url);
            const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
            for (let i = parts.length - 1; i >= 0; i--) {
                let p = parts[i].replace(/\.(html?|php|aspx?)$/i, '');
                if (/^(models?|things?|files?|design|en|us|de|print|3d-models?)$/i.test(p)) continue;
                p = p.replace(/^thing:(\d+)$/i, 'Thing $1').replace(/^\d+[-_]/, '').replace(/[-_]+/g, ' ').trim();
                if (p && !/^\d+$/.test(p)) return p.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 120);
            }
            return prettyHost(u.hostname.replace(/^www\./, '')) + ' model';
        } catch (e) {
            return 'Saved link';
        }
    }

    // "Articulated Dragon | Printables.com" → "Articulated Dragon"; "Dragon by Jane - Thingiverse" → title + author
    function cleanTitle(title, site) {
        let t = String(title || '').replace(/\s+/g, ' ').trim();
        let author = '';
        const names = [site.name, site.key, 'MakerWorld', 'Printables', 'Printables.com', 'Thingiverse', 'Cults', 'Thangs', 'MyMiniFactory'];
        const SEP = '[|\\-–—:·・•]';
        for (let i = 0; i < 3; i++) {
            for (const n of names) {
                const re = new RegExp(`\\s*${SEP}\\s*${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^|\\-–—・•]*$`, 'i');
                t = t.replace(re, '').trim();
            }
            // Generic endings sites add, like "- Free 3D Print Model" or "・3D printer design to download"
            t = t.replace(new RegExp(`\\s*${SEP}\\s*(free\\s+)?(stl\\s+files?|3d\\s+(print(er|able|ing)?\\s+)?(models?|designs?|files?))\\b[^|]*$`, 'i'), '').trim();
        }
        const by = /^(.*\S)\s+by\s+([^|]{1,60})$/i.exec(t);
        if (by && /thingiverse|cults/i.test(site.key)) { t = by[1]; author = by[2].trim(); }
        t = t.replace(/^(free\s+)?(stl|3mf|3d)\s+file\s+/i, '');
        return { title: t.slice(0, 160), author };
    }

    function newId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    // Tags

    const MAX_TAGS = 12;

    // "  Gifts , desk toys " → ["Gifts", "desk toys"]; a leading # is optional
    function parseTags(text) {
        return String(text || '').split(',')
            .map((t) => t.replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 30))
            .filter(Boolean);
    }

    const tagKey = (t) => t.toLowerCase();

    function allTags() {
        const map = new Map();
        for (const i of state.items) for (const t of i.tags || []) {
            const k = tagKey(t);
            const e = map.get(k) || { key: k, name: t, n: 0 };
            e.n++;
            map.set(k, e);
        }
        return [...map.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    }

    function addTags(item, text) {
        const known = new Map(allTags().map((t) => [t.key, t.name]));
        item.tags = item.tags || [];
        let added = 0;
        for (const t of parseTags(text)) {
            if (item.tags.length >= MAX_TAGS) { toast(`A model can have up to ${MAX_TAGS} tags.`); break; }
            if (item.tags.some((x) => tagKey(x) === tagKey(t))) continue;
            item.tags.push(known.get(tagKey(t)) || t); // reuse the existing spelling of a tag
            added++;
        }
        if (added) save();
        return added;
    }

    function removeTag(item, tag) {
        const before = (item.tags || []).length;
        item.tags = (item.tags || []).filter((x) => tagKey(x) !== tagKey(tag));
        if (item.tags.length !== before) {
            save();
            render();
        }
    }

    async function removeTagEverywhere(tag) {
        const users = state.items.filter((i) => (i.tags || []).some((x) => tagKey(x) === tagKey(tag)));
        if (!users.length) return;
        const res = await remote.dialog.showMessageBox(remote.getCurrentWindow(), {
            type: 'question',
            buttons: ['Remove Tag', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
            message: `Remove the tag “${tag}” from ${users.length} model${users.length === 1 ? '' : 's'}?`,
            detail: 'The models stay saved; only the tag is removed.',
        });
        if (res.response !== 0) return;
        for (const i of users) i.tags = i.tags.filter((x) => tagKey(x) !== tagKey(tag));
        if (state.tag && tagKey(state.tag) === tagKey(tag)) state.tag = null;
        save();
        render();
        toast(`Removed the tag “${tag}”.`);
    }

    // Small inline box on a card for typing tags; stays open so you can add several
    function openTagInput(item) {
        const card = document.querySelector(`.saved-card[data-id="${item.id}"]`);
        if (!card) return;
        const addBtn = card.querySelector('.tag-add');
        if (!addBtn) return;
        const input = document.createElement('input');
        input.className = 'tag-input';
        input.type = 'text';
        input.placeholder = 'Add tag…';
        input.setAttribute('list', 'saved-tag-options');
        input.setAttribute('aria-label', 'New tag');
        addBtn.replaceWith(input);
        input.focus();
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            render();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const value = input.value;
                if (!value.trim()) { close(); return; }
                addTags(item, value);
                closed = true;
                render();
                openTagInput(item);
            } else if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            } else if (e.key === 'Backspace' && !input.value && (item.tags || []).length) {
                e.preventDefault();
                item.tags.pop();
                save();
                closed = true;
                render();
                openTagInput(item);
            }
        });
        input.addEventListener('blur', () => {
            if (closed) return;
            if (input.value.trim()) addTags(item, input.value);
            close();
        });
    }

    async function addLink(raw, { quiet = false } = {}) {
        const url = normalizeUrl(raw);
        if (!url) {
            if (!quiet) toast('That doesn’t look like a web link.');
            return null;
        }
        const existing = state.items.find((i) => sameLink(i.url, url));
        if (existing) {
            setView('saved');
            state.site = 'all'; state.query = ''; $('saved-search').value = '';
            render();
            flashCard(existing.id);
            toast('Already saved.');
            return existing;
        }
        const site = siteOf(url);
        const item = { id: newId(), url, title: titleFromUrl(url), author: '', site: site.key, siteName: site.name, image: null, savedAt: Date.now(), status: 'loading', tags: [] };
        state.items.unshift(item);
        save();
        setView('saved');
        state.site = 'all';
        render();
        await refreshPreview(item);
        return item;
    }

    async function refreshPreview(item) {
        item.status = 'loading';
        renderCard(item);
        try {
            const meta = await ipcRenderer.invoke('link-preview', item.url);
            const site = siteOf(meta.finalUrl || item.url, meta.siteName);
            const cleaned = cleanTitle(meta.title, site);
            if (!item.userTitle && cleaned.title) item.title = cleaned.title;
            item.author = meta.author || cleaned.author || item.author || '';
            item.site = site.key;
            item.siteName = site.name;
            if (meta.image && !item.userImage) {
                try {
                    const img = await ipcRenderer.invoke('link-image', meta.image, meta.finalUrl || item.url);
                    const file = await storeImage(item.id, img.data, img.type);
                    deleteImage(item.image);
                    item.image = file;
                } catch {}
            }
            item.status = 'ok';
        } catch (e) {
            item.status = 'failed';
            item.error = String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        }
        if (!state.items.includes(item)) return; // removed while loading
        save();
        render();
    }

    function removeItem(item) {
        const index = state.items.indexOf(item);
        if (index < 0) return;
        state.items.splice(index, 1);
        save();
        if (state.undo) clearTimeout(state.undo.timer);
        const timer = setTimeout(() => { deleteImage(item.image); state.undo = null; }, 8000);
        state.undo = { item, index, timer };
        render();
        toast(`Removed “${item.title}”.`, { action: 'Undo', onAction: undoRemove, duration: 8000 });
    }

    function undoRemove() {
        if (!state.undo) return;
        const { item, index, timer } = state.undo;
        clearTimeout(timer);
        state.items.splice(Math.min(index, state.items.length), 0, item);
        state.undo = null;
        save();
        render();
        hideToast();
        flashCard(item.id);
    }

    async function choosePicture(item) {
        const res = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), {
            title: 'Choose a picture for this model',
            properties: ['openFile'],
            filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'] }],
        });
        if (res.canceled || !res.filePaths.length) return;
        try {
            const bytes = await fs.promises.readFile(res.filePaths[0]);
            const file = await storeImage(item.id, bytes, '');
            deleteImage(item.image);
            item.image = file;
            item.userImage = true;
            save();
            render();
        } catch (e) {
            remote.dialog.showMessageBox(remote.getCurrentWindow(), { type: 'error', message: 'Couldn’t use that picture.', detail: e.message });
        }
    }

    function startRename(item) {
        const card = document.querySelector(`.saved-card[data-id="${item.id}"]`);
        if (!card) return;
        const title = card.querySelector('.saved-card-title');
        const input = document.createElement('input');
        input.className = 'saved-rename';
        input.value = item.title;
        title.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            const value = input.value.trim();
            if (commit && value && value !== item.title) {
                item.title = value.slice(0, 160);
                item.userTitle = true;
                save();
            }
            render();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') finish(true);
            if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
    }

    function openSource(item) {
        if (normalizeUrl(item.url)) shell.openExternal(item.url);
    }

    function showMenu(item) {
        const site = siteOf(item.url, item.siteName);
        remote.Menu.buildFromTemplate([
            { label: `Open on ${site.name}`, click: () => openSource(item) },
            { label: 'Copy Link', click: () => { copyText(item.url); toast('Link copied.'); } },
            { type: 'separator' },
            { label: 'Add Tag…', click: () => openTagInput(item) },
            { label: 'Rename…', click: () => startRename(item) },
            { label: 'Choose Picture…', click: () => choosePicture(item) },
            { label: 'Refresh from Site', click: () => { item.userTitle = false; item.userImage = false; refreshPreview(item); } },
            { type: 'separator' },
            { label: 'Remove', click: () => removeItem(item) },
        ]).popup({ window: remote.getCurrentWindow() });
    }

    // Rendering

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ICON_EXT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    const ICON_LINK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
    const ICON_MORE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';

    function relativeDate(ms) {
        const days = Math.floor((startOfDay(Date.now()) - startOfDay(ms)) / 86400000);
        if (days <= 0) return 'Saved today';
        if (days === 1) return 'Saved yesterday';
        if (days < 7) return `Saved ${days} days ago`;
        const d = new Date(ms);
        return 'Saved ' + d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function startOfDay(ms) {
        const d = new Date(ms);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }

    function cardHtml(item) {
        const site = siteOf(item.url, item.siteName);
        const img = imageUrl(item);
        const initial = esc(site.name.charAt(0).toUpperCase());
        const picture = img
            ? `<div class="saved-card-img" style="background-image:url('${img}')"></div>`
            : `<div class="saved-card-img placeholder" style="--site:${site.color}"><span>${initial}</span></div>`;
        let meta = esc(relativeDate(item.savedAt));
        if (item.author) meta = `by ${esc(item.author)} · ${meta}`;
        let status = '';
        if (item.status === 'loading') status = '<div class="saved-card-status">Getting title and picture…</div>';
        else if (item.status === 'failed') status = `<div class="saved-card-status warn" title="${esc(item.error || '')}">Couldn’t read this page. <button class="link-btn" data-act="retry">Try again</button></div>`;
        return `<article class="saved-card${item.status === 'loading' ? ' loading' : ''}" data-id="${item.id}" title="${esc(item.url)}">
            <div class="saved-card-media">
                ${picture}
                <span class="saved-site-badge" style="--site:${site.color}">${esc(site.name)}</span>
                <button class="saved-card-more" data-act="menu" title="More" aria-label="More options">${ICON_MORE}</button>
            </div>
            <div class="saved-card-body">
                <div class="saved-card-title">${esc(item.title)}</div>
                <div class="saved-card-meta">${meta}</div>
                ${status}
                <div class="saved-card-tags">${(item.tags || []).map((t) => `<span class="tag-chip${state.tag && tagKey(state.tag) === tagKey(t) ? ' active' : ''}" data-tag="${esc(t)}"><button class="tag-name" data-act="filter-tag" title="Show models tagged “${esc(t)}”">#${esc(t)}</button><button class="tag-remove" data-act="remove-tag" title="Remove tag" aria-label="Remove tag ${esc(t)}">×</button></span>`).join('')}<button class="tag-add" data-act="add-tag" title="Add a tag">+ Tag</button></div>
                <div class="saved-card-actions" style="--site:${site.color}">
                    <button class="saved-open" data-act="open">${ICON_EXT}<span>Open on ${esc(site.name)}</span></button>
                    <button class="saved-icon-btn" data-act="open" title="Open ${esc(item.url)}" aria-label="Open the original link">${ICON_LINK}</button>
                </div>
            </div>
        </article>`;
    }

    function renderCard(item) {
        const el = document.querySelector(`.saved-card[data-id="${item.id}"]`);
        if (el) el.outerHTML = cardHtml(item);
    }

    function visibleItems() {
        const q = state.query.trim().toLowerCase();
        return state.items.filter((i) => {
            if (state.site !== 'all' && i.site !== state.site) return false;
            if (state.tag && !(i.tags || []).some((t) => tagKey(t) === tagKey(state.tag))) return false;
            return !q || [i.title, i.author, i.siteName, i.url, ...(i.tags || [])].some((v) => String(v || '').toLowerCase().includes(q));
        });
    }

    function render() {
        const total = state.items.length;
        $('saved-count-badge').textContent = total;
        $('saved-total').textContent = total ? `${total} model${total === 1 ? '' : 's'}` : '';

        // Site filter chips, only for sites you have saved from
        const counts = new Map();
        for (const i of state.items) {
            const s = siteOf(i.url, i.siteName);
            const c = counts.get(s.key) || { ...s, n: 0 };
            c.n++;
            counts.set(s.key, c);
        }
        if (state.site !== 'all' && !counts.has(state.site)) state.site = 'all';
        const chips = [{ key: 'all', name: 'All', n: total }, ...[...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))];
        $('saved-sites').innerHTML = chips.map((c) => `<button class="saved-site-chip${state.site === c.key ? ' active' : ''}" data-site="${esc(c.key)}"${c.color ? ` style="--site:${c.color}"` : ''}>${c.color ? '<i></i>' : ''}${esc(c.name)} <span>${c.n}</span></button>`).join('');
        $('saved-filters').classList.toggle('hidden', total === 0);

        // Tag filter chips; right-click a tag to remove it from every model
        const tags = allTags();
        if (state.tag && !tags.some((t) => t.key === tagKey(state.tag))) state.tag = null;
        $('saved-tags').classList.toggle('hidden', !tags.length);
        $('saved-tags-list').innerHTML = tags.map((t) => `<button class="tag-filter${state.tag && tagKey(state.tag) === t.key ? ' active' : ''}" data-tag="${esc(t.name)}" title="Show models tagged “${esc(t.name)}” · right-click to remove this tag">#${esc(t.name)} <span>${t.n}</span></button>`).join('');
        $('saved-tag-options').innerHTML = tags.map((t) => `<option value="${esc(t.name)}">`).join('');

        const items = visibleItems();
        $('saved-grid').innerHTML = items.map(cardHtml).join('');
        $('saved-empty').classList.toggle('hidden', total > 0);
        if (total > 0 && !items.length) $('saved-grid').innerHTML = '<div class="saved-none">No saved models match.</div>';
    }

    function flashCard(id) {
        requestAnimationFrame(() => {
            const el = document.querySelector(`.saved-card[data-id="${id}"]`);
            if (!el) return;
            el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            el.classList.remove('flash');
            void el.offsetWidth;
            el.classList.add('flash');
        });
    }

    let toastTimer = null;
    function toast(text, { action, onAction, duration = 3000 } = {}) {
        const t = $('saved-toast');
        t.innerHTML = `<span>${esc(text)}</span>${action ? `<button class="link-btn">${esc(action)}</button>` : ''}`;
        if (action) t.querySelector('button').onclick = onAction;
        t.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(hideToast, duration);
    }

    function hideToast() {
        $('saved-toast').classList.add('hidden');
    }

    // Clicking the active tag again clears the filter
    function setTagFilter(tag, force = false) {
        state.tag = !force && state.tag && tagKey(state.tag) === tagKey(tag) ? null : tag;
        render();
    }

    // Library | Saved switch

    const VIEWS = ['library', 'saved', 'makerworld'];

    function setView(view) {
        if (!VIEWS.includes(view)) view = 'library';
        const ws = document.querySelector('.workspace');
        ws.classList.toggle('saved-view', view === 'saved');
        ws.classList.toggle('mw-view', view === 'makerworld');
        $('saved-pane').classList.toggle('hidden', view !== 'saved');
        const mw = $('mw-pane');
        if (mw) mw.classList.toggle('hidden', view !== 'makerworld');
        document.querySelectorAll('#view-switch button').forEach((b) => {
            const on = b.dataset.view === view;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        try { localStorage.setItem(VIEW_KEY, view); } catch {}
        if (view === 'saved') render();
        window.dispatchEvent(new CustomEvent('philament-view', { detail: view }));
    }

    function currentView() {
        const ws = document.querySelector('.workspace');
        return ws.classList.contains('saved-view') ? 'saved' : ws.classList.contains('mw-view') ? 'makerworld' : 'library';
    }

    function linkFromDrag(dt) {
        if (!dt || [...dt.types].includes('Files')) return null;
        const list = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
        const first = list.split(/\r?\n/).find((l) => l && !l.startsWith('#'));
        return normalizeUrl(first);
    }

    // Wiring

    function init() {
        document.querySelectorAll('#view-switch button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

        $('saved-add').addEventListener('submit', (e) => {
            e.preventDefault();
            const input = $('saved-url');
            const value = input.value;
            if (!value.trim()) { input.focus(); return; }
            input.value = '';
            addLink(value);
        });
        $('saved-search').addEventListener('input', (e) => { state.query = e.target.value; render(); });
        $('saved-tags-list').addEventListener('click', (e) => {
            const chip = e.target.closest('[data-tag]');
            if (chip) setTagFilter(chip.dataset.tag);
        });
        $('saved-tags-list').addEventListener('contextmenu', (e) => {
            const chip = e.target.closest('[data-tag]');
            if (!chip) return;
            e.preventDefault();
            const tag = chip.dataset.tag;
            remote.Menu.buildFromTemplate([
                { label: `Show “${tag}”`, click: () => setTagFilter(tag, true) },
                { type: 'separator' },
                { label: 'Remove Tag from All Models…', click: () => removeTagEverywhere(tag) },
            ]).popup({ window: remote.getCurrentWindow() });
        });
        $('saved-sites').addEventListener('click', (e) => {
            const chip = e.target.closest('[data-site]');
            if (chip) { state.site = chip.dataset.site; render(); }
        });

        $('saved-grid').addEventListener('click', (e) => {
            const card = e.target.closest('.saved-card');
            if (!card) return;
            const item = state.items.find((i) => i.id === card.dataset.id);
            if (!item) return;
            const act = e.target.closest('[data-act]');
            const what = act ? act.dataset.act : (e.target.closest('.saved-card-media') ? 'open' : null);
            if (what === 'open') openSource(item);
            else if (what === 'copy') { copyText(item.url); toast('Link copied.'); }
            else if (what === 'menu') showMenu(item);
            else if (what === 'retry') refreshPreview(item);
            else if (what === 'add-tag') openTagInput(item);
            else if (what === 'remove-tag') removeTag(item, act.closest('[data-tag]').dataset.tag);
            else if (what === 'filter-tag') setTagFilter(act.closest('[data-tag]').dataset.tag);
        });
        $('saved-grid').addEventListener('dblclick', (e) => {
            const title = e.target.closest('.saved-card-title');
            const card = e.target.closest('.saved-card');
            if (title && card) startRename(state.items.find((i) => i.id === card.dataset.id));
        });
        $('saved-grid').addEventListener('contextmenu', (e) => {
            const card = e.target.closest('.saved-card');
            if (!card) return;
            e.preventDefault();
            const item = state.items.find((i) => i.id === card.dataset.id);
            if (item) showMenu(item);
        });

        // Drag a link from the browser anywhere onto the window
        let dragDepth = 0;
        document.addEventListener('dragenter', (e) => {
            if (![...e.dataTransfer.types].includes('Files') && [...e.dataTransfer.types].some((t) => t === 'text/uri-list' || t === 'text/plain')) {
                dragDepth++;
                setView('saved');
                $('saved-drop').classList.remove('hidden');
            }
        });
        document.addEventListener('dragleave', () => {
            if (dragDepth > 0 && --dragDepth === 0) $('saved-drop').classList.add('hidden');
        });
        document.addEventListener('drop', (e) => {
            dragDepth = 0;
            $('saved-drop').classList.add('hidden');
            const url = linkFromDrag(e.dataTransfer);
            if (url) { e.preventDefault(); addLink(url); }
        });

        // ⌘V on the Saved tab (outside a text field) saves the copied link
        document.addEventListener('paste', (e) => {
            if (currentView() !== 'saved') return;
            if (e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
            const text = e.clipboardData.getData('text/plain');
            if (normalizeUrl(text)) { e.preventDefault(); addLink(text); }
        });

        // ⌘1 / ⌘2 / ⌘3 switch views (Library, Uploads, Saved)
        document.addEventListener('keydown', (e) => {
            if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
            if (e.key === '1') { e.preventDefault(); setView('library'); }
            if (e.key === '2') { e.preventDefault(); setView('makerworld'); }
            if (e.key === '3') { e.preventDefault(); setView('saved'); $('saved-url').focus(); }
        });

        // Pages that never finished loading (app was closed mid-save) get another try
        for (const item of state.items) if (item.status === 'loading') refreshPreview(item);

        render();
        setView(localStorage.getItem(VIEW_KEY) || 'library');
    }

    // Used by backup and restore in renderer.js
    window.philamentSaved = {
        exportItems: () => state.items.map(({ id, url, title, author, site, siteName, savedAt, userTitle, tags }) => ({ id, url, title, author, site, siteName, savedAt, userTitle, tags: tags || [] })),
        importItems: (items) => {
            if (!Array.isArray(items)) return;
            const clean = items.filter((i) => i && normalizeUrl(i.url)).map((i) => ({
                id: String(i.id || newId()).replace(/[^\w-]/g, '').slice(0, 40) || newId(),
                url: normalizeUrl(i.url),
                title: String(i.title || titleFromUrl(i.url)).slice(0, 160),
                author: String(i.author || '').slice(0, 80),
                site: String(i.site || ''),
                siteName: String(i.siteName || ''),
                savedAt: Number(i.savedAt) || Date.now(),
                userTitle: !!i.userTitle,
                tags: Array.isArray(i.tags) ? [...new Map(parseTags(i.tags.filter((t) => typeof t === 'string').join(',')).map((t) => [tagKey(t), t])).values()].slice(0, MAX_TAGS) : [],
                image: null,
                status: 'loading', // pictures are fetched again after a restore
            }));
            localStorage.setItem(STORE_KEY, JSON.stringify(clean));
        },
    };

    // Exposed for tests
    window.philamentSavedInternals = { normalizeUrl, titleFromUrl, cleanTitle, siteOf, addLink, setView, parseTags };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
