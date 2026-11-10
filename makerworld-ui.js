// Uploads tab. Data comes from makerworld.js; weekly changes and sparklines are worked
// out from the local daily snapshots.
(() => {
    const { ipcRenderer, shell } = require('electron');

    const KEYS = {
        account: 'philament_mw_account',
        last: 'philament_mw_last',
        seen: 'philament_mw_seen_comments',
        sort: 'philament_mw_sort',
        filter: 'philament_mw_filter',
        selected: 'philament_mw_selected',
    };
    const SITE = 'https://makerworld.com';
    const STALE_MS = 30 * 60 * 1000; // refresh on opening the tab after 30 minutes
    const BACKGROUND_MS = 3 * 60 * 60 * 1000; // keep daily snapshots going while the app is open

    const $ = (id) => document.getElementById(id);
    const read = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
    const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
    const cleanError = (e) => String((e && e.message) || e || 'Something went wrong.').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());

    const state = {
        account: read(KEYS.account, null), // { uid, handle, name }
        data: read(KEYS.last, null), // { profile, uploads, history, fetchedAt }
        seen: read(KEYS.seen, {}), // model id → comment count when last looked at
        sort: read(KEYS.sort, 'downloads'),
        filter: read(KEYS.filter, 'all'),
        query: '',
        selected: read(KEYS.selected, null),
        loading: false,
        error: '',
        images: new Map(), // key → data URL (or null while loading)
        comments: new Map(), // model id → { available, items } | 'loading'
    };

    function h(tag, attrs = {}, children = []) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else if (k === 'html') e.innerHTML = v;
            else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
            else e.setAttribute(k, v === true ? '' : v);
        }
        for (const c of [].concat(children)) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
        return e;
    }

    const ICON_EXT = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    const ICON_REFRESH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';

    // History → trends

    function dayKey(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function dayLabel(key) {
        const [y, m, d] = key.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function sortedDays() {
        const days = (state.data && state.data.history) || {};
        return Object.keys(days).sort();
    }

    // The snapshot to compare against for "this week": 7+ days old if there is one,
    // otherwise the first snapshot (labelled "since <date>")
    function baseline() {
        const keys = sortedDays();
        if (keys.length < 2) return null;
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        const target = dayKey(weekAgo);
        const older = keys.filter((k) => k <= target);
        const key = older.length ? older[older.length - 1] : keys[0];
        if (key === keys[keys.length - 1]) return null;
        return { key, snap: state.data.history[key], label: older.length ? 'this week' : `since ${dayLabel(key)}` };
    }

    // Daily gains of one number over the last `n` days (downloads by default), from snapshots.
    // Days when Philament wasn't opened share the gain evenly with the days around them.
    function dailySeries(n, pick) {
        const days = (state.data && state.data.history) || {};
        const points = Object.keys(days).sort()
            .map((k) => [toDate(k).getTime(), pick(days[k])])
            .filter(([, v]) => v != null);
        if (points.length < 2) return null;
        const valueOn = (t) => {
            if (t < points[0][0] || t > points[points.length - 1][0]) return null;
            for (let i = 1; i < points.length; i++) {
                const [t0, v0] = points[i - 1];
                const [t1, v1] = points[i];
                if (t <= t1) return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
            }
            return points[points.length - 1][1];
        };
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - n);
        const values = [];
        for (let step = 0; step <= n; step++) {
            const d = new Date(start);
            d.setDate(start.getDate() + step);
            values.push(valueOn(d.getTime()));
        }
        const gains = [];
        for (let k = 1; k < values.length; k++) {
            gains.push(values[k] == null || values[k - 1] == null ? null : Math.max(0, Math.round(values[k] - values[k - 1])));
        }
        return gains;
    }

    function toDate(key) {
        const [y, m, d] = key.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    const modelPick = (id, idx) => (snap) => (snap && snap.m && snap.m[id] ? snap.m[id][idx] : null);

    function weekDelta(id, idx, current) {
        const b = baseline();
        if (!b) return null;
        const old = b.snap.m && b.snap.m[id];
        if (!old) return null;
        return current - old[idx];
    }

    // Derived lists

    function newComments(u) {
        const seen = state.seen[u.id];
        return seen == null ? 0 : Math.max(0, u.comments - seen);
    }

    function visibleUploads() {
        const uploads = (state.data && state.data.uploads) || [];
        const q = state.query.trim().toLowerCase();
        let list = uploads.filter((u) => !q || u.title.toLowerCase().includes(q));
        if (state.filter === 'comments') list = list.filter((u) => newComments(u) > 0);
        if (state.filter === 'boosted') list = list.filter((u) => u.boosts > 0);
        const trend = (u) => weekDelta(u.id, 0, u.downloads) || 0;
        const sorters = {
            downloads: (a, b) => b.downloads - a.downloads,
            prints: (a, b) => b.prints - a.prints,
            likes: (a, b) => b.likes - a.likes,
            trending: (a, b) => trend(b) - trend(a) || b.downloads - a.downloads,
            newest: (a, b) => String(b.published).localeCompare(String(a.published)),
            title: (a, b) => a.title.localeCompare(b.title),
        };
        return list.sort(sorters[state.sort] || sorters.downloads);
    }

    // Pictures

    function imageFor(key, url, width, img) {
        const cacheKey = `${key}-${width}`;
        const cached = state.images.get(cacheKey);
        if (cached) { img.src = cached; img.classList.add('loaded'); return; }
        if (!url) return;
        img.dataset.wants = cacheKey;
        if (state.images.has(cacheKey)) return; // already loading
        state.images.set(cacheKey, null);
        ipcRenderer.invoke('mw-image', key, url, width).then((dataUrl) => {
            if (!dataUrl) { state.images.delete(cacheKey); return; }
            state.images.set(cacheKey, dataUrl);
            document.querySelectorAll(`img[data-wants="${cacheKey}"]`).forEach((el) => { el.src = dataUrl; el.classList.add('loaded'); });
        }).catch(() => state.images.delete(cacheKey));
    }

    function picture(key, url, width, cls) {
        const img = h('img', { class: cls, alt: '', draggable: 'false' });
        imageFor(key, url, width, img);
        return img;
    }

    // Small charts

    function sparkline(values, w = 84, hgt = 24) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', w);
        svg.setAttribute('height', hgt);
        svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
        svg.classList.add('mw-spark');
        const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
        if (pts.length < 2) return null;
        const max = Math.max(1, ...pts.map(([, v]) => v));
        const step = w / (values.length - 1);
        const line = document.createElementNS(ns, 'polyline');
        line.setAttribute('points', pts.map(([i, v]) => `${(i * step).toFixed(1)},${(hgt - 3 - (v / max) * (hgt - 6)).toFixed(1)}`).join(' '));
        svg.append(line);
        return svg;
    }

    function bars(values, w = 300, hgt = 72) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.classList.add('mw-bars');
        const max = Math.max(1, ...values.filter((v) => v != null));
        const slot = w / values.length;
        values.forEach((v, i) => {
            const r = document.createElementNS(ns, 'rect');
            const bh = v == null ? 2 : Math.max(2, (v / max) * (hgt - 4));
            r.setAttribute('x', (i * slot + slot * 0.15).toFixed(1));
            r.setAttribute('width', (slot * 0.7).toFixed(1));
            r.setAttribute('y', (hgt - bh).toFixed(1));
            r.setAttribute('height', bh.toFixed(1));
            r.setAttribute('rx', 1.5);
            if (v == null) r.classList.add('none');
            const t = document.createElementNS(ns, 'title');
            const d = new Date();
            d.setDate(d.getDate() - (values.length - 1 - i));
            t.textContent = `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}: ${v == null ? 'no data' : `${v} download${v === 1 ? '' : 's'}`}`;
            r.append(t);
            svg.append(r);
        });
        return svg;
    }

    // Rendering

    function ago(ms) {
        const s = Math.round((Date.now() - ms) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return `${Math.round(s / 60)} min ago`;
        if (s < 86400) return `${Math.round(s / 3600)} h ago`;
        return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function publishedLabel(u) {
        const d = u.published ? new Date(u.published) : null;
        return d && !isNaN(d) ? `Published ${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })}` : 'Published';
    }

    function openSite(pathname) {
        shell.openExternal(`${SITE}${pathname}`);
    }

    function render() {
        const connected = !!(state.account && state.account.uid);
        $('mw-connect').classList.toggle('hidden', connected);
        $('mw-main').classList.toggle('hidden', !connected);
        renderBadge();
        renderSettings();
        if (!connected) return;
        renderAccount();
        renderStats();
        renderFilters();
        renderList();
        renderDetail();
    }

    function renderAccount() {
        const p = (state.data && state.data.profile) || {};
        const acc = state.account;
        const initials = (p.name || acc.name || acc.handle || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
        const avatar = h('div', { class: 'mw-avatar' }, [h('span', { text: initials })]);
        if (p.avatar) avatar.append(picture('avatar', p.avatar, 96, 'mw-avatar-img'));

        let status;
        if (state.loading) status = h('span', { class: 'mw-status' }, [h('span', { class: 'mw-spinner' }), 'Updating…']);
        else if (state.error) status = h('span', { class: 'mw-status error', title: state.error }, [h('span', { class: 'mw-dot error' }), state.error]);
        else if (state.data) status = h('span', { class: 'mw-status' }, [h('span', { class: 'mw-dot' }), `Public profile · updated ${ago(state.data.fetchedAt)}`]);
        else status = h('span', { class: 'mw-status' }, 'Not loaded yet');

        $('mw-account').replaceChildren(
            avatar,
            h('div', { class: 'mw-account-text' }, [
                h('div', { class: 'mw-account-name' }, [p.name || acc.name || acc.handle, h('span', { class: 'mw-handle', text: ` @${p.handle || acc.handle}` })]),
                h('div', { class: 'mw-account-sub' }, [p.level != null ? h('span', { class: 'mw-level', text: `Level ${p.level}` }) : null, status]),
            ]),
            h('div', { class: 'mw-spacer' }),
            h('button', {
                type: 'button', class: 'models-icon-btn mw-refresh' + (state.loading ? ' spinning' : ''), title: 'Refresh now', 'aria-label': 'Refresh now',
                html: ICON_REFRESH, disabled: state.loading, onclick: () => refresh({ manual: true }),
            }),
            h('button', { type: 'button', class: 'btn-secondary mw-account-btn', html: `${ICON_EXT}<span>Open Profile</span>`, onclick: () => openSite(`/en/@${encodeURIComponent(acc.handle)}`) }),
            h('button', { type: 'button', class: 'btn-primary mw-account-btn', html: `${ICON_EXT}<span>Upload New Model</span>`, onclick: () => openSite('/en/my/models/publish') }),
        );
    }

    function updateAgo() {
        const el = $('mw-account').querySelector('.mw-status:not(.error)');
        if (el && state.data && !state.loading) el.lastChild.textContent = `Public profile · updated ${ago(state.data.fetchedAt)}`;
    }

    function renderStats() {
        const p = (state.data && state.data.profile) || {};
        const uploads = (state.data && state.data.uploads) || [];
        const sum = (k) => uploads.reduce((n, u) => n + u[k], 0);
        const b = baseline();
        const totals = { downloads: sum('downloads'), prints: sum('prints'), likes: p.likes, collections: p.collections, followers: p.followers, boosts: p.boosts };
        const tiles = [
            ['Downloads', 'downloads'], ['Prints', 'prints'], ['Likes', 'likes'],
            ['Collections', 'collections'], ['Followers', 'followers'], ['Boosts', 'boosts'],
        ].map(([label, key]) => {
            let delta = null;
            if (b && b.snap.t && b.snap.t[key] != null && totals[key] != null) {
                const d = totals[key] - b.snap.t[key];
                delta = h('div', { class: 'mw-stat-delta' + (d < 0 ? ' down' : d === 0 ? ' flat' : ''), text: `${d > 0 ? '+' : ''}${fmt(d)} ${b.label}` });
            }
            return h('div', { class: 'mw-stat' }, [
                h('div', { class: 'mw-stat-label', text: label }),
                h('div', { class: 'mw-stat-value', text: state.data ? fmt(totals[key]) : '—' }),
                delta || h('div', { class: 'mw-stat-delta flat', text: state.data ? (sortedDays().length < 2 ? 'Tracking from today' : '') : '' }),
            ]);
        });
        $('mw-stats').replaceChildren(...tiles);
    }

    function renderFilters() {
        const uploads = (state.data && state.data.uploads) || [];
        const withNew = uploads.filter((u) => newComments(u) > 0).length;
        const boosted = uploads.filter((u) => u.boosts > 0).length;
        if (state.filter === 'comments' && !withNew) state.filter = 'all';
        if (state.filter === 'boosted' && !boosted) state.filter = 'all';
        const chip = (key, label, count) => h('button', {
            type: 'button', class: 'mw-chip' + (state.filter === key ? ' active' : ''), 'aria-pressed': state.filter === key ? 'true' : 'false',
            onclick: () => { state.filter = key; write(KEYS.filter, key); renderFilters(); renderList(); },
        }, [label, h('span', { class: 'mw-chip-count', text: String(count) })]);
        $('mw-filters').replaceChildren(...[
            chip('all', 'All', uploads.length),
            withNew ? chip('comments', 'New comments', withNew) : null,
            boosted ? chip('boosted', 'Boosted', boosted) : null,
        ].filter(Boolean));
        $('mw-sort').value = state.sort;
    }

    function renderList() {
        const list = visibleUploads();
        const total = ((state.data && state.data.uploads) || []).length;
        const empty = $('mw-empty');
        if (!state.data) {
            empty.textContent = state.loading ? 'Loading your uploads…' : state.error || 'Not loaded yet.';
        } else if (!total) {
            empty.textContent = 'No published models yet. Models you publish on MakerWorld will show up here.';
        } else {
            empty.textContent = 'No uploads match.';
        }
        empty.classList.toggle('hidden', list.length > 0);
        // The selected model was filtered out: select the first one shown (and show its details)
        let moved = false;
        if (list.length && !list.some((u) => u.id === state.selected)) {
            state.selected = list[0].id;
            moved = true;
        }

        const rows = list.map((u) => {
            const fresh = newComments(u);
            const spark = dailySeries(14, modelPick(u.id, 0));
            const delta = weekDelta(u.id, 0, u.downloads);
            const sparkEl = spark ? sparkline(spark) : null;
            return h('div', {
                class: 'mw-row' + (u.id === state.selected ? ' selected' : ''), role: 'option', 'aria-selected': u.id === state.selected ? 'true' : 'false',
                'data-id': u.id, onclick: () => select(u.id),
                ondblclick: () => openSite(`/en/models/${u.id}`),
            }, [
                picture(`cover-${u.id}`, u.cover, 160, 'mw-thumb'),
                h('div', { class: 'mw-title' }, [
                    h('div', { class: 'mw-name', title: u.title }, [u.title, u.exclusive ? h('span', { class: 'mw-pill', text: 'Exclusive' }) : null]),
                    h('div', { class: 'mw-sub' }, [publishedLabel(u), u.rating != null ? ` · ★ ${u.rating.toFixed(1)} (${fmt(u.ratingCount)})` : '']),
                ]),
                h('div', { class: 'mw-num', text: fmt(u.downloads) }),
                h('div', { class: 'mw-num', text: fmt(u.prints) }),
                h('div', { class: 'mw-num', text: fmt(u.likes) }),
                h('div', { class: 'mw-num' }, [fmt(u.comments), fresh ? h('span', { class: 'mw-new', text: `${fresh} new` }) : null]),
                h('div', { class: 'mw-trend', title: spark ? 'Downloads per day, last 14 days' : 'Trends appear after Philament has checked on a couple of different days' }, [
                    sparkEl || h('span', { class: 'mw-dim', text: '—' }),
                    h('span', { class: 'mw-delta' + (delta > 0 ? '' : ' flat'), text: delta == null ? '' : `${delta > 0 ? '+' : ''}${fmt(delta)}` }),
                ]),
            ]);
        });
        $('mw-list').replaceChildren(...rows);
        // Totals of what's listed, next to each column heading
        for (const key of ['downloads', 'prints', 'likes', 'comments']) {
            $(`mw-total-${key}`).textContent = list.length ? `(${fmt(list.reduce((n, u) => n + u[key], 0))})` : '';
        }
        fitColumns();
        if (moved) renderDetail();
    }

    // Number columns grow to fit their heading and total, e.g. DOWNLOADS (12,345), so it never spills over
    function fitColumns() {
        const pane = document.querySelector('.mw-list-pane');
        const cells = [...document.querySelectorAll('.mw-head > div')].slice(2, 6);
        if (!pane || !cells.length || !cells[0].getClientRects().length) return;
        const w = window.innerWidth;
        const narrow = w <= 999;
        const mins = narrow ? [104, 86, 76, 98] : w <= 1199 ? [112, 92, 82, 104] : [118, 98, 88, 112];
        const widths = cells.map((cell, i) => {
            const r = document.createRange();
            r.selectNodeContents(cell);
            return Math.max(mins[i], Math.ceil(r.getBoundingClientRect().width) + 4);
        });
        const cols = narrow
            ? `40px minmax(0, 1fr) ${widths.map((x) => `${x}px`).join(' ')}`
            : `46px minmax(0, 1fr) ${widths.map((x) => `${x}px`).join(' ')} ${w <= 1199 ? 118 : 128}px`;
        pane.style.setProperty('--mw-cols', cols);
    }

    function statRow(label, value, delta) {
        return h('div', { class: 'mw-dstat' }, [
            h('div', { class: 'mw-stat-label', text: label }),
            h('div', { class: 'mw-dstat-value', text: fmt(value) }),
            delta == null ? null : h('div', { class: 'mw-stat-delta' + (delta > 0 ? '' : ' flat'), text: `${delta > 0 ? '+' : ''}${fmt(delta)}` }),
        ]);
    }

    function renderDetail() {
        const pane = $('mw-detail');
        const u = ((state.data && state.data.uploads) || []).find((x) => x.id === state.selected);
        if (!u) {
            pane.replaceChildren(h('div', { class: 'mw-detail-empty', text: state.data ? 'Select a model to see its details.' : '' }));
            return;
        }
        const b = baseline();
        const series = dailySeries(30, modelPick(u.id, 0));
        const meta = [publishedLabel(u)];
        if (u.profiles) meta.push(`${u.profiles} print profile${u.profiles === 1 ? '' : 's'}`);
        if (u.rating != null) meta.push(`★ ${u.rating.toFixed(1)} from ${fmt(u.ratingCount)} rating${u.ratingCount === 1 ? '' : 's'}`);

        const commentsBox = h('div', { class: 'mw-comments' });
        renderComments(u, commentsBox);

        pane.replaceChildren(
            h('div', { class: 'mw-detail-scroll' }, [
                picture(`cover-${u.id}`, u.cover, 640, 'mw-detail-img'),
                h('div', {}, [h('div', { class: 'mw-detail-title', text: u.title }), h('div', { class: 'mw-sub', text: meta.join(' · ') })]),
                h('div', { class: 'mw-dstats' }, [
                    statRow('Downloads', u.downloads, weekDelta(u.id, 0, u.downloads)),
                    statRow('Prints', u.prints, weekDelta(u.id, 1, u.prints)),
                    statRow('Likes', u.likes, weekDelta(u.id, 2, u.likes)),
                    statRow('Collections', u.collections, null),
                    statRow('Comments', u.comments, weekDelta(u.id, 3, u.comments)),
                    statRow('Boosts', u.boosts, weekDelta(u.id, 4, u.boosts)),
                ]),
                b ? h('div', { class: 'mw-dnote', text: `Changes shown are ${b.label}.` }) : null,
                h('div', {}, [
                    h('div', { class: 'mw-section', text: 'Downloads per day, last 30 days' }),
                    series && series.some((v) => v != null)
                        ? bars(series)
                        : h('div', { class: 'mw-chart-empty', text: 'Philament saves your numbers once a day. This chart fills in as days go by.' }),
                ]),
                commentsBox,
            ]),
            h('div', { class: 'mw-detail-actions' }, [
                h('button', { type: 'button', class: 'btn-primary', html: `${ICON_EXT}<span>Edit on MakerWorld</span>`, onclick: () => openSite(`/en/my/models/${u.id}/edit`) }),
            ]),
        );
        markSeen(u);
    }

    function renderComments(u, box) {
        const c = state.comments.get(u.id);
        if (c === 'loading') {
            box.replaceChildren(h('div', { class: 'mw-section', text: 'Latest comments' }), h('div', { class: 'mw-chart-empty', text: 'Loading…' }));
            return;
        }
        if (!c) {
            if (!u.comments) return box.replaceChildren();
            state.comments.set(u.id, 'loading');
            renderComments(u, box);
            ipcRenderer.invoke('mw-comments', u.id).then((res) => {
                state.comments.set(u.id, res || { available: false, items: [] });
            }).catch(() => state.comments.set(u.id, { available: false, items: [] })).finally(() => {
                // The panel may have been redrawn meanwhile: fill in whichever one is showing now
                const current = document.querySelector('#mw-detail .mw-comments');
                if (state.selected === u.id && current) renderComments(u, current);
            });
            return;
        }
        if (!c.available || !c.items.length) {
            box.replaceChildren(
                h('div', { class: 'mw-section', text: 'Comments' }),
                h('div', { class: 'mw-chart-empty' }, [`${fmt(u.comments)} comment${u.comments === 1 ? '' : 's'}. `,
                    h('button', { type: 'button', class: 'link-btn', text: 'Read them on MakerWorld', onclick: () => openSite(`/en/models/${u.id}#comments`) })]),
            );
            return;
        }
        box.replaceChildren(
            h('div', { class: 'mw-section', text: 'Latest comments' }),
            ...c.items.slice(0, 3).map((x) => h('div', { class: 'mw-comment' }, [
                h('div', { class: 'mw-comment-head' }, [h('b', { text: x.user }), x.time ? h('span', { class: 'mw-dim', text: ` · ${ago(new Date(x.time).getTime())}` }) : null]),
                h('div', { text: x.text }),
            ])),
        );
    }

    // Looking at a model clears its "new comments" badge
    function markSeen(u) {
        if (state.seen[u.id] === u.comments) return;
        clearTimeout(markSeen.timer);
        markSeen.timer = setTimeout(() => {
            if (state.selected !== u.id || currentView() !== 'makerworld') return;
            state.seen[u.id] = u.comments;
            write(KEYS.seen, state.seen);
            renderFilters();
            renderList();
            renderBadge();
        }, 1500);
    }

    function renderBadge() {
        const uploads = (state.data && state.data.uploads) || [];
        const total = state.account ? uploads.reduce((n, u) => n + newComments(u), 0) : 0;
        const badge = $('mw-badge');
        badge.textContent = total ? String(total) : '';
        badge.classList.toggle('hidden', !total);
        badge.title = total ? `${total} new comment${total === 1 ? '' : 's'}` : '';
    }

    function renderSettings() {
        const acc = state.account;
        $('mw-settings-label').textContent = acc ? `Connected as @${acc.handle}` : 'Not connected';
        $('mw-settings-sub').textContent = acc
            ? 'Public profile, no sign-in. Disconnecting removes the saved history from this Mac.'
            : 'Show your MakerWorld uploads and their stats in the Uploads tab';
        $('mw-settings-btn').textContent = acc ? 'Disconnect' : 'Connect';
    }

    function select(id) {
        if (state.selected === id) return;
        state.selected = id;
        write(KEYS.selected, id);
        document.querySelectorAll('#mw-list .mw-row').forEach((r) => {
            const on = r.dataset.id === id;
            r.classList.toggle('selected', on);
            r.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        renderDetail();
    }

    function currentView() {
        return document.querySelector('.workspace').classList.contains('mw-view') ? 'makerworld' : 'other';
    }

    // Actions

    async function connect(input) {
        const btn = $('mw-connect-btn');
        const err = $('mw-connect-error');
        err.classList.add('hidden');
        btn.disabled = true;
        btn.textContent = 'Connecting…';
        try {
            const account = await ipcRenderer.invoke('mw-connect', input);
            state.account = account;
            write(KEYS.account, account);
            state.data = null;
            state.seen = {};
            state.selected = null;
            render();
            await refresh({ first: true });
        } catch (e) {
            err.textContent = cleanError(e);
            err.classList.remove('hidden');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Connect';
        }
    }

    async function disconnect() {
        if (!confirm(`Disconnect @${state.account.handle}? The history Philament saved on this Mac will be removed.`)) return;
        await ipcRenderer.invoke('mw-forget').catch(() => {});
        for (const k of Object.values(KEYS)) { try { localStorage.removeItem(k); } catch {} }
        Object.assign(state, { account: null, data: null, seen: {}, selected: null, error: '', filter: 'all', sort: 'downloads' });
        state.images.clear();
        state.comments.clear();
        $('mw-handle').value = '';
        render();
    }

    async function refresh({ manual = false, first = false } = {}) {
        if (!state.account || state.loading) return;
        state.loading = true;
        state.error = '';
        renderAccount();
        if (!state.data) renderList();
        try {
            const data = await ipcRenderer.invoke('mw-refresh', state.account.uid);
            // First load: count existing comments as already seen, so only new ones get a badge
            if (first || !state.data) {
                for (const u of data.uploads) if (state.seen[u.id] == null) state.seen[u.id] = u.comments;
                write(KEYS.seen, state.seen);
            } else {
                for (const u of data.uploads) if (state.seen[u.id] == null) state.seen[u.id] = 0;
            }
            state.data = data;
            state.comments.clear();
            if (data.profile.handle && data.profile.handle !== state.account.handle) {
                state.account = { ...state.account, handle: data.profile.handle, name: data.profile.name || state.account.name };
                write(KEYS.account, state.account);
            }
            write(KEYS.last, data);
        } catch (e) {
            state.error = cleanError(e);
            if (manual && !state.data) $('mw-empty').textContent = state.error;
        } finally {
            state.loading = false;
            render();
        }
    }

    function refreshIfStale() {
        if (!state.account) return;
        if (!state.data || Date.now() - state.data.fetchedAt > STALE_MS) refresh();
    }

    // Wiring

    function init() {
        $('mw-connect-form').addEventListener('submit', (e) => {
            e.preventDefault();
            connect($('mw-handle').value);
        });
        $('mw-search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
        $('mw-sort').addEventListener('change', (e) => { state.sort = e.target.value; write(KEYS.sort, state.sort); renderList(); });
        $('mw-settings-btn').addEventListener('click', () => {
            if (state.account) disconnect();
            else {
                closeSettingsModal();
                document.querySelector('#view-switch [data-view="makerworld"]').click();
                $('mw-handle').focus();
            }
        });

        // Arrow keys move through the list; Enter opens the model on MakerWorld
        $('mw-list').addEventListener('keydown', (e) => {
            const list = visibleUploads();
            const i = list.findIndex((u) => u.id === state.selected);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const next = list[Math.min(list.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
                if (next) {
                    select(next.id);
                    const row = document.querySelector(`#mw-list .mw-row[data-id="${next.id}"]`);
                    if (row) row.scrollIntoView({ block: 'nearest' });
                }
            }
            if (e.key === 'Enter' && list[i]) openSite(`/en/models/${list[i].id}`);
        });

        let fitTimer = null;
        window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitColumns, 80); });

        window.addEventListener('philament-view', (e) => {
            if (e.detail !== 'makerworld') return;
            render();
            requestAnimationFrame(fitColumns);
            if (state.account) refreshIfStale();
            else setTimeout(() => $('mw-handle').focus(), 50);
        });

        // Keep the daily snapshots going while Philament is open
        setTimeout(() => { if (state.account && (!state.data || Date.now() - state.data.fetchedAt > BACKGROUND_MS)) refresh(); }, 8000);
        setInterval(() => { if (state.account) refresh(); }, BACKGROUND_MS);
        // keep "updated 5 min ago" current
        setInterval(() => { if (currentView() === 'makerworld') updateAgo(); }, 60000);

        render();
        if (currentView() === 'makerworld') refreshIfStale();
    }

    window.philamentMakerWorld = { refresh, state, dailySeries, baseline };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
