// MakerWorld profile and uploads (main process).
// There's no official API; these are the public endpoints MakerWorld's own pages call:
//   user-service/user/profile/{uid}          profile totals
//   design-service/published/{uid}/design    uploads and their stats
// The user ID comes from the public profile page. MakerWorld keeps no history, so a daily
// snapshot is stored locally for the weekly numbers and trends.

const fs = require('fs');
const path = require('path');
const { app, ipcMain, net } = require('electron');
const linkPreview = require('./link-preview');

const API = process.env.PHILAMENT_MW_API || 'https://api.bambulab.com';
const SITE = process.env.PHILAMENT_MW_SITE || 'https://makerworld.com';
const TIMEOUT_MS = 20000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const KEEP_DAYS = 120;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const dataDir = () => path.join(app.getPath('userData'), 'makerworld');
const historyFile = () => path.join(dataDir(), 'history.json');
const coverDir = () => path.join(dataDir(), 'covers');

// Helpers

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// "@philecker", "philecker" or a profile link → "philecker"
function cleanHandle(input) {
    let s = String(input || '').trim();
    const m = /makerworld\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?@([^/?#\s]+)/i.exec(s);
    if (m) s = m[1];
    s = s.replace(/^@/, '').trim();
    try { s = decodeURIComponent(s); } catch {}
    return /^[\w.\-]{1,64}$/u.test(s) ? s : '';
}

function validUid(uid) {
    const s = String(uid || '');
    return /^\d{1,20}$/.test(s) ? s : '';
}

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await net.fetch(url, {
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'User-Agent': linkPreview.USER_AGENT,
            },
        });
        if (res.status === 404) throw new Error('MakerWorld couldn’t find that profile.');
        if (res.status === 429) throw new Error('MakerWorld is limiting requests right now. Try again in a little while.');
        if (!res.ok) throw new Error(`MakerWorld answered with HTTP ${res.status}.`);
        const text = await res.text();
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error('MakerWorld sent something unexpected. Try again in a little while.');
        }
    } catch (e) {
        if (e.name === 'AbortError') throw new Error('MakerWorld didn’t answer in time.');
        if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION/i.test(e.message)) throw new Error('You appear to be offline.');
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

// Connecting: handle → user ID

// Read from the profile page's built-in data (Next.js puts it in a script tag)
const READ_PROFILE = `(() => {
    let n = null;
    try { n = JSON.parse((document.getElementById('__NEXT_DATA__') || {}).textContent || 'null'); } catch (e) {}
    const u = n && n.props && n.props.pageProps && n.props.pageProps.userInfo;
    return {
        hasData: !!n,
        user: u ? { uid: u.uid, handle: u.handle, name: u.name, avatar: u.avatar } : null,
        notFound: /404|not found|page doesn.t exist/i.test(document.title || ''),
    };
})()`;

async function connect(input) {
    const handle = cleanHandle(input);
    if (!handle) throw new Error('Enter your MakerWorld username, for example @philecker.');
    const user = await linkPreview.browsePage(`${SITE}/en/@${encodeURIComponent(handle)}`, {
        read: READ_PROFILE,
        decide(page, { started, ready }) {
            if (page.user && validUid(page.user.uid)) return { value: page.user };
            if (page.notFound) return { error: `There’s no MakerWorld profile called @${handle}.` };
            if (ready && Date.now() - started > 8000) {
                return { error: page.hasData ? `There’s no MakerWorld profile called @${handle}.` : 'MakerWorld’s profile page didn’t load as expected. Try again in a little while.' };
            }
            return null;
        },
        onTimeout(best, shown) {
            throw new Error(shown ? 'The MakerWorld check wasn’t finished in time.' : 'MakerWorld took too long to answer.');
        },
    });
    return {
        uid: validUid(user.uid),
        handle: cleanHandle(user.handle) || handle,
        name: String(user.name || handle),
    };
}

// Profile and uploads

function shapeProfile(p, uid) {
    const mw = p.MWCount || {};
    const level = p.personal && p.personal.userLevel ? p.personal.userLevel.level : null;
    return {
        uid,
        handle: cleanHandle(p.handle) || '',
        name: String(p.name || ''),
        avatar: typeof p.avatar === 'string' ? p.avatar : '',
        level: level == null ? null : num(level),
        followers: num(p.fanCount),
        likes: num(p.likeCount),
        collections: num(p.collectionCount),
        boosts: num(p.boostGained),
        designCount: num(mw.designCount),
        designDownloads: num(mw.myDesignDownloadCount),
        designPrints: num(mw.myDesignPrintCount),
        profileDownloads: num(mw.myInstanceDownloadCount),
        profilePrints: num(mw.myInstancePrintCount),
    };
}

function shapeUpload(h) {
    const instances = Array.isArray(h.instances) ? h.instances : [];
    const ratingCount = instances.reduce((n, i) => n + num(i.ratingCount), 0);
    const ratingTotal = instances.reduce((n, i) => n + num(i.ratingScoreTotal), 0);
    return {
        id: String(h.id),
        title: String(h.titleTranslated || h.title || `Model ${h.id}`),
        cover: typeof h.coverUrl === 'string' ? h.coverUrl : typeof h.cover === 'string' ? h.cover : '',
        published: String(h.publishTime || h.createTime || ''),
        downloads: num(h.downloadCount),
        prints: num(h.printCount),
        likes: num(h.likeCount),
        collections: num(h.collectionCount),
        comments: num(h.commentCount),
        boosts: num(h.boostCnt),
        profiles: instances.length,
        rating: ratingCount ? Math.round((ratingTotal / ratingCount) * 10) / 10 : null,
        ratingCount,
        exclusive: !!h.isExclusive,
    };
}

async function fetchUploads(uid) {
    const hits = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
        const body = await getJson(`${API}/v1/design-service/published/${uid}/design?offset=${offset}&limit=${PAGE_SIZE}`);
        const list = Array.isArray(body.hits) ? body.hits : [];
        hits.push(...list);
        offset += list.length;
        if (!list.length || offset >= num(body.total)) break;
    }
    const seen = new Set();
    return hits.filter((h) => h && h.id != null && !seen.has(String(h.id)) && seen.add(String(h.id))).map(shapeUpload);
}

// Daily snapshots (kept on this Mac)

function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readHistory(uid) {
    try {
        const h = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
        if (h && h.uid === uid && h.days && typeof h.days === 'object') return h;
    } catch {}
    return { uid, days: {} };
}

// One snapshot per day (the latest of the day wins): totals plus [downloads, prints, likes, comments, boosts] per model
function recordSnapshot(uid, profile, uploads) {
    const history = readHistory(uid);
    const models = {};
    for (const u of uploads) models[u.id] = [u.downloads, u.prints, u.likes, u.comments, u.boosts];
    history.days[today()] = {
        t: {
            downloads: uploads.reduce((n, u) => n + u.downloads, 0),
            prints: uploads.reduce((n, u) => n + u.prints, 0),
            likes: profile.likes,
            followers: profile.followers,
            boosts: profile.boosts,
            collections: profile.collections,
        },
        m: models,
    };
    const keys = Object.keys(history.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete history.days[k];
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(historyFile() + '.tmp', JSON.stringify(history));
    fs.renameSync(historyFile() + '.tmp', historyFile());
    return history;
}

async function refresh(uidInput) {
    const uid = validUid(uidInput);
    if (!uid) throw new Error('Connect your MakerWorld profile first.');
    const [rawProfile, uploads] = await Promise.all([
        getJson(`${API}/v1/user-service/user/profile/${uid}`),
        fetchUploads(uid),
    ]);
    const profile = shapeProfile(rawProfile || {}, uid);
    const history = recordSnapshot(uid, profile, uploads);
    return { profile, uploads, history: history.days, fetchedAt: Date.now() };
}

// Pictures
// The app window only shows local images, so covers are downloaded here and cached on disk.

function sizedUrl(url, width) {
    // MakerWorld's image host can resize on the fly
    if (/bblmw\.com/i.test(url) && !url.includes('?')) return `${url}?x-oss-process=image/resize,w_${width}/format,jpg`;
    return url;
}

async function image(key, url, width) {
    if (!/^https?:\/\//i.test(String(url || ''))) return null;
    const safeKey = String(key).replace(/[^\w-]/g, '_').slice(0, 80);
    const file = path.join(coverDir(), `${safeKey}-${width}.img`);
    try {
        const cached = fs.readFileSync(file);
        const sep = cached.indexOf(0x0a);
        return `data:${cached.slice(0, sep).toString()};base64,${cached.slice(sep + 1).toString('base64')}`;
    } catch {}
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await net.fetch(sizedUrl(url, width), { signal: controller.signal, headers: { 'User-Agent': linkPreview.USER_AGENT, Accept: 'image/*' } });
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        if (!res.ok || !/^image\/(jpeg|png|webp|gif|avif)$/i.test(type)) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_IMAGE_BYTES) return null;
        fs.mkdirSync(coverDir(), { recursive: true });
        fs.writeFileSync(file, Buffer.concat([Buffer.from(type + '\n'), buf]));
        return `data:${type};base64,${buf.toString('base64')}`;
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Comments (shown when MakerWorld serves them without a sign-in)

// Comments can contain HTML: keep the words, drop the tags.
// Line breaks and paragraphs become new lines; codes like &amp; become the characters they stand for.
function plainText(html) {
    let s = String(html || '');
    s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' '); // drop scripts/styles with their contents
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|li|h[1-6]|blockquote)\s*>/gi, '\n');
    s = s.replace(/<li\b[^>]*>/gi, '• ');
    s = s.replace(/<[^>]*>/g, ''); // every other tag
    s = s.replace(/<[^>]*$/, ''); // a cut-off tag at the end
    s = linkPreview.decodeEntities(s);
    s = s.replace(/<[^>]*>/g, ''); // tags that were written as &lt;b&gt;
    s = s.replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
    return s.trim();
}

async function comments(designId) {
    const id = validUid(designId);
    if (!id) return { available: false, items: [] };
    try {
        const body = await getJson(`${API}/v1/comment-service/comment?designId=${id}&offset=0&limit=5`);
        const list = Array.isArray(body.comments) ? body.comments : Array.isArray(body.hits) ? body.hits : null;
        if (!list) return { available: false, items: [] };
        return {
            available: true,
            items: list.slice(0, 5).map((c) => {
                const u = c.user || c.creator || {};
                return {
                    user: String(u.name || cleanHandle(u.handle) || 'Someone'),
                    text: plainText(c.content || c.comment).slice(0, 600),
                    time: String(c.createTime || ''),
                };
            }).filter((c) => c.text),
        };
    } catch (e) {
        return { available: false, items: [] };
    }
}

function forget() {
    fs.rmSync(dataDir(), { recursive: true, force: true });
}

function registerIpc() {
    ipcMain.handle('mw-connect', (event, handle) => connect(handle));
    ipcMain.handle('mw-refresh', (event, uid) => refresh(uid));
    ipcMain.handle('mw-image', (event, key, url, width) => image(key, url, Math.min(1200, Math.max(64, num(width) || 200))));
    ipcMain.handle('mw-comments', (event, designId) => comments(designId));
    ipcMain.handle('mw-forget', () => forget());
}

module.exports = { registerIpc, cleanHandle, shapeProfile, shapeUpload, plainText, SITE };
