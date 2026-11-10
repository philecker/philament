// Update checks against GitHub Releases (main process).
// The app isn't signed, so it can't replace itself: it downloads the right .dmg to
// Downloads, opens it and quits.

const fs = require('fs');
const path = require('path');
const { app, ipcMain, net, shell } = require('electron');

const pkg = require('./package.json');
const publish = (pkg.build && [].concat(pkg.build.publish || [])[0]) || {};
const OWNER = publish.owner || 'philecker';
const REPO = publish.repo || 'philament';

// Overridable for testing against a stand-in server
const API_BASE = process.env.PHILAMENT_UPDATE_API || 'https://api.github.com';
const TESTING = !!process.env.PHILAMENT_UPDATE_API;
const TIMEOUT_MS = 15000;

// Versions

// "v1.2.3", "1.2.3-beta.1" → { nums: [1,2,3], pre: 'beta.1' }
function parseVersion(v) {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
    if (!m) return null;
    return { nums: [+m[1], +(m[2] || 0), +(m[3] || 0)], pre: m[4] || '' };
}

// > 0 when a is newer than b
function compareVersions(a, b) {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) return 0;
    for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
    if (x.pre === y.pre) return 0;
    if (!x.pre) return 1; // 1.0.0 is newer than 1.0.0-beta
    if (!y.pre) return -1;
    return x.pre < y.pre ? -1 : 1;
}

// Release lookup

// The .dmg built for this Mac, falling back to a universal one
function pickAsset(assets, arch = process.arch) {
    const dmgs = (assets || []).filter((a) => /\.dmg$/i.test(a.name || ''));
    const mine = arch === 'arm64' ? /arm64|aarch64/i : /x64|x86_64|intel/i;
    return dmgs.find((a) => mine.test(a.name))
        || dmgs.find((a) => /universal/i.test(a.name))
        || dmgs.find((a) => !/arm64|aarch64|x64|x86_64|intel/i.test(a.name))
        || null;
}

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await net.fetch(url, {
            signal: controller.signal,
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': `Philament/${app.getVersion()}`,
            },
        });
        if (res.status === 404) return { notFound: true };
        if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting update checks right now. Try again in a little while.');
        if (!res.ok) throw new Error(`GitHub answered with HTTP ${res.status}.`);
        return { json: await res.json() };
    } catch (e) {
        if (e.name === 'AbortError') throw new Error('GitHub didn’t answer in time. Check your internet connection.');
        if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK/i.test(e.message)) throw new Error('You appear to be offline.');
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

let latest = null; // the newest release found, for downloading

async function checkForUpdates() {
    const current = app.getVersion();
    const { json, notFound } = await fetchJson(`${API_BASE}/repos/${OWNER}/${REPO}/releases/latest`);
    if (notFound || !json) return { current, available: false, none: true };
    const version = String(json.tag_name || json.name || '').replace(/^v/i, '');
    const asset = pickAsset(json.assets);
    latest = {
        version,
        name: json.name || `Philament ${version}`,
        notes: String(json.body || '').slice(0, 20000),
        url: json.html_url || `https://github.com/${OWNER}/${REPO}/releases/latest`,
        publishedAt: json.published_at || '',
        asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size || 0 } : null,
    };
    return { current, available: compareVersions(version, current) > 0, ...latest };
}

// Download

const ALLOWED_HOSTS = /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/i;
let download = null; // { controller, file }

function safeName(name) {
    return path.basename(String(name || 'Philament.dmg')).replace(/[^\w.\- ]/g, '_') || 'Philament.dmg';
}

async function downloadUpdate(sender) {
    if (!latest || !latest.asset) throw new Error('There’s no Mac download in this release. Open the release page instead.');
    if (download) throw new Error('The update is already downloading.');
    const { url, size, name } = latest.asset;
    const host = new URL(url).hostname;
    if (!TESTING && !ALLOWED_HOSTS.test(host)) throw new Error('The download link doesn’t point to GitHub.');

    const dir = app.getPath('downloads');
    const file = path.join(dir, safeName(name));
    // Already downloaded earlier (same size): reuse it
    try {
        if (size && fs.statSync(file).size === size) return { file, reused: true };
    } catch {}

    const part = file + '.download';
    const controller = new AbortController();
    download = { controller, file };
    const progress = (received, total) => {
        if (!sender.isDestroyed()) sender.send('update-progress', { received, total });
    };
    try {
        const res = await net.fetch(url, { signal: controller.signal, headers: { 'User-Agent': `Philament/${app.getVersion()}` } });
        if (!res.ok) throw new Error(`The download failed (HTTP ${res.status}).`);
        const total = Number(res.headers.get('content-length')) || size || 0;
        const out = fs.createWriteStream(part);
        const reader = res.body.getReader();
        let received = 0;
        let last = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
            if (Date.now() - last > 120) { progress(received, total); last = Date.now(); }
        }
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
        progress(received, total);
        if (size && received !== size) throw new Error('The download was incomplete. Please try again.');
        fs.renameSync(part, file);
        return { file };
    } catch (e) {
        try { fs.unlinkSync(part); } catch {}
        if (e.name === 'AbortError') throw new Error('Download canceled.');
        throw e;
    } finally {
        download = null;
    }
}

// IPC

function registerIpc() {
    ipcMain.handle('update-check', () => checkForUpdates());
    ipcMain.handle('update-download', (event) => downloadUpdate(event.sender));
    ipcMain.handle('update-cancel', () => { if (download) download.controller.abort(); });
    // Open the downloaded installer, then quit so the app can be replaced
    ipcMain.handle('update-install', async (event, file) => {
        const dir = app.getPath('downloads');
        if (!file || path.dirname(file) !== dir || !/\.dmg$/i.test(file) || !fs.existsSync(file)) {
            throw new Error('The downloaded installer is missing. Please download it again.');
        }
        const err = await shell.openPath(file);
        if (err) throw new Error(err);
        if (!TESTING) setTimeout(() => app.quit(), 800);
        return true;
    });
    ipcMain.handle('update-release-page', () => shell.openExternal(latest ? latest.url : `https://github.com/${OWNER}/${REPO}/releases`));
}

module.exports = { registerIpc, checkForUpdates, compareVersions, parseVersion, pickAsset, OWNER, REPO };
