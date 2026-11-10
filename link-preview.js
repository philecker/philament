// Reads a saved link's title, picture, site and author (main process).
// Tries a plain HTTP request first. Sites that block it, or fill the page in with JavaScript,
// are loaded in a hidden sandboxed window instead.

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const BROWSER_TIMEOUT_MS = 25000;
const MAX_BROWSER_WINDOWS = 2;

// The Chrome version Electron is built on, without the "Electron" marker some sites reject
const CHROME_VERSION = (process.versions && process.versions.chrome) || '120.0.0.0';
const USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

const PAGE_HEADERS = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
};

// Status codes that usually mean "bot protection said no" rather than "page not found"
const BLOCKED_STATUS = new Set([401, 403, 406, 429, 503]);

function isWebUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) {
        return false;
    }
}

function decodeEntities(s) {
    return String(s)
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

function attrs(tag) {
    const out = {};
    const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let m;
    while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
    return out;
}

// Turns a map of meta tag names → values into the details Philament uses
function fromMetaMap(meta, docTitle, pageUrl, imageSrcLink) {
    let image = meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || meta.image || imageSrcLink || '';
    if (image) {
        try { image = new URL(image, pageUrl).href; } catch (e) { image = ''; }
        if (!isWebUrl(image)) image = '';
    }
    return {
        title: (meta['og:title'] || meta['twitter:title'] || docTitle || '').replace(/\s+/g, ' ').trim(),
        siteName: (meta['og:site_name'] || meta['application-name'] || '').trim(),
        author: (meta.author || meta['article:author'] || meta['twitter:creator'] || '').replace(/^@/, '').trim(),
        description: (meta['og:description'] || meta.description || '').trim(),
        image,
    };
}

// Reads <meta>, <title> and <link rel=image_src> from a page's HTML
function parseMeta(html, pageUrl) {
    const head = html.slice(0, MAX_HTML_BYTES);
    const meta = {};
    const metaRe = /<meta\b[^>]*>/gi;
    let m;
    while ((m = metaRe.exec(head))) {
        const a = attrs(m[0]);
        const key = (a.property || a.name || a.itemprop || '').toLowerCase();
        if (key && a.content && !(key in meta)) meta[key] = a.content.trim();
    }
    const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
    const link = /<link\b[^>]*rel=["']?image_src["']?[^>]*>/i.exec(head);
    return fromMetaMap(meta, titleTag ? decodeEntities(titleTag[1]) : '', pageUrl, link ? attrs(link[0]).href || '' : '');
}

async function fetchWithTimeout(fetchFn, url, headers, extra = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        return await fetchFn(url, { signal: controller.signal, redirect: 'follow', headers, ...extra });
    } finally {
        clearTimeout(timer);
    }
}

async function readLimited(res, limit) {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total >= limit) { try { await reader.cancel(); } catch {} break; }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

class BlockedError extends Error {}

// 1. Quick request for the page's HTML
async function fetchPreviewHttp(fetchFn, url) {
    const res = await fetchWithTimeout(fetchFn, url, PAGE_HEADERS);
    if (BLOCKED_STATUS.has(res.status)) throw new BlockedError(`The site answered with HTTP ${res.status}.`);
    if (!res.ok) throw new Error(`The site answered with HTTP ${res.status}.`);
    const type = res.headers.get('content-type') || '';
    if (type && !/html|xml/i.test(type)) throw new Error('That link is not a web page.');
    const html = (await readLimited(res, MAX_HTML_BYTES)).toString('utf8');
    const finalUrl = res.url || url;
    return { ...parseMeta(html, finalUrl), finalUrl };
}

// 0. Sites with a public API their own pages use: ask it directly, no page scraping needed
const PRINTABLES_API = process.env.PHILAMENT_PRINTABLES_API || 'https://api.printables.com/graphql/';
const PRINTABLES_QUERY = 'query PrintPreview($id: ID!) { print(id: $id) { id name user { publicUsername handle } image { filePath } } }';

async function readPrintables(fetchFn, url) {
    const m = /\/model\/(\d+)/.exec(new URL(url).pathname);
    if (!m) return null;
    const res = await fetchWithTimeout(fetchFn, PRINTABLES_API, {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
    }, {
        method: 'POST',
        body: JSON.stringify({ operationName: 'PrintPreview', query: PRINTABLES_QUERY, variables: { id: m[1] } }),
    });
    if (!res.ok) return null;
    const json = JSON.parse((await readLimited(res, MAX_HTML_BYTES)).toString('utf8'));
    const print = json && json.data && json.data.print;
    if (!print || !print.name) return null;
    const file = print.image && print.image.filePath;
    return {
        title: String(print.name).trim(),
        siteName: 'Printables',
        author: (print.user && (print.user.publicUsername || print.user.handle)) || '',
        description: '',
        image: file ? (/^https?:/i.test(file) ? file : 'https://media.printables.com/' + String(file).replace(/^\/+/, '')) : '',
        finalUrl: url,
    };
}

const SITE_READERS = [
    { host: /(^|\.)printables\.com$/i, read: readPrintables },
];

async function fetchFromSiteApi(fetchFn, url) {
    const host = new URL(url).hostname;
    const reader = SITE_READERS.find((r) => r.host.test(host));
    if (!reader) return null;
    try { return await reader.read(fetchFn, url); } catch (e) { return null; }
}

// 2. Open the page in a hidden browser window and read the details from it
const READ_PAGE = `(() => {
    const meta = {};
    for (const m of document.querySelectorAll('meta')) {
        const key = (m.getAttribute('property') || m.getAttribute('name') || m.getAttribute('itemprop') || '').toLowerCase();
        const content = m.getAttribute('content');
        if (key && content && !(key in meta)) meta[key] = content.trim();
    }
    const link = document.querySelector('link[rel="image_src"]');
    const t = (document.title || '').trim();
    return { meta, title: t, url: location.href, imageSrcLink: link ? link.href : '' };
})()`;

let openWindows = 0;
const waiting = [];

async function withWindowSlot(task) {
    if (openWindows >= MAX_BROWSER_WINDOWS) await new Promise((resolve) => waiting.push(resolve));
    openWindows++;
    try {
        return await task();
    } finally {
        openWindows--;
        const next = waiting.shift();
        if (next) next();
    }
}

let checkWindowOpen = false;
const pageWindows = new Set();

function closeAll() {
    for (const w of pageWindows) if (!w.isDestroyed()) w.destroy();
    pageWindows.clear();
}

// Detects "confirm you're human" pages, wrapped around whatever a caller wants to read
const CHALLENGE_CHECK = `(/just a moment|attention required|verify(ing)? you are (a )?human|checking your browser|access denied|security check/i.test(document.title || '')
    || !!document.querySelector('#challenge-form, #cf-challenge-running, .cf-browser-verification'))`;

// Opens a web page in a hidden, locked-down window and polls it until `decide` is satisfied.
//   read:   JavaScript expression evaluated in the page every half second (returns plain data)
//   decide: (data, { started, shown }) => { value } to finish, { error } to fail, { best } to
//           remember a usable result, or nothing to keep waiting
//   onTimeout: (best, shown) => value (or throw) when the time runs out
// When a site shows a "confirm you're human" check that doesn't clear by itself, the window is
// shown so you can answer it once. The site remembers it, so later visits go through on their own.
function browsePage(url, { read, decide, onTimeout, allowShow = true }) {
    const { BrowserWindow } = require('electron');
    const script = `(() => { const data = (${read}); return { data, challenge: ${CHALLENGE_CHECK}, ready: document.readyState === 'complete' }; })()`;
    return withWindowSlot(() => new Promise((resolve, reject) => {
        const host = new URL(url).hostname.replace(/^www\./, '');
        const win = new BrowserWindow({
            show: false,
            width: 520,
            height: 700,
            title: `Confirm on ${host} — Philament`,
            autoHideMenuBar: true,
            webPreferences: {
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                javascript: true,
                backgroundThrottling: false,
                spellcheck: false,
            },
        });
        pageWindows.add(win);
        const wc = win.webContents;
        wc.setAudioMuted(true);
        wc.setUserAgent(USER_AGENT);
        wc.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.on('page-title-updated', (event) => event.preventDefault());
        const blockDownload = (event, item, contents) => { if (contents === wc) event.preventDefault(); };
        wc.session.on('will-download', blockDownload);
        // Only web pages: no file://, custom app links, or other schemes
        wc.on('will-navigate', (event, target) => { if (!isWebUrl(target)) event.preventDefault(); });

        let done = false;
        let best = null;
        let shown = false;
        let challengeSince = 0;
        const started = Date.now();
        let deadline = started + BROWSER_TIMEOUT_MS;
        const finish = (err, value) => {
            if (done) return;
            done = true;
            clearInterval(poll);
            if (shown) checkWindowOpen = false;
            wc.session.removeListener('will-download', blockDownload);
            if (!win.isDestroyed()) {
                win.hide();
                setImmediate(() => { if (!win.isDestroyed()) win.destroy(); });
            }
            if (err) reject(err);
            else resolve(value);
        };
        // Closing the check window by hand cancels the lookup
        win.on('close', (event) => {
            event.preventDefault();
            finish(new Error(`The check on ${host} was closed before it finished.`));
        });
        win.on('closed', () => pageWindows.delete(win));

        const poll = setInterval(async () => {
            if (done || win.isDestroyed()) return;
            if (Date.now() > deadline) {
                try { finish(null, onTimeout(best, shown)); } catch (e) { finish(e); }
                return;
            }
            let page;
            try { page = await wc.executeJavaScript(script, true); } catch (e) { return; }
            if (!page || done) return;
            if (page.challenge) {
                if (!challengeSince) challengeSince = Date.now();
                // Still stuck on the check after a few seconds: let the person answer it
                if (!shown && allowShow && !checkWindowOpen && Date.now() - challengeSince > 4000) {
                    shown = true;
                    checkWindowOpen = true;
                    wc.setAudioMuted(false);
                    win.center();
                    win.show();
                    deadline = Date.now() + 120000;
                }
                return;
            }
            const outcome = decide(page.data || {}, { started, shown, ready: page.ready, best }) || {};
            if (outcome.best) best = outcome.best;
            if ('value' in outcome) finish(null, outcome.value);
            else if (outcome.error) finish(new Error(outcome.error));
        }, 500);

        wc.on('did-fail-load', (event, code, description, failedUrl, isMainFrame) => {
            if (isMainFrame && code !== -3) finish(new Error(`The page didn't load (${description}).`));
        });
        win.loadURL(url, { userAgent: USER_AGENT }).catch(() => { /* reported by did-fail-load */ });
    }));
}

// Title, picture, site and author for a saved link
function fetchPreviewBrowser(url, { allowShow = true } = {}) {
    return browsePage(url, {
        read: READ_PAGE,
        allowShow,
        decide(page, { started, shown, ready, best }) {
            // Loaded but nothing to read (an error page): give up early
            if (ready && !page.title && !shown && Date.now() - started > 8000 && !best) {
                return { error: 'The page has no title or picture to read.' };
            }
            const details = { ...fromMetaMap(page.meta, page.title, page.url, page.imageSrcLink), finalUrl: page.url };
            const settled = ready && Date.now() - started > 1500;
            if (details.title && (details.image || settled)) return { value: details };
            return details.title ? { best: details } : null;
        },
        onTimeout(best, shown) {
            if (best && best.title) return best;
            throw new Error(shown ? 'The check wasn’t finished in time.' : 'The page took too long to load.');
        },
    });
}

// Quick request first; the hidden browser when the site blocks it or leaves details out
async function fetchPreview(fetchFn, url, { browser = fetchPreviewBrowser } = {}) {
    if (!isWebUrl(url)) throw new Error('Only http and https links can be saved.');
    const fromApi = await fetchFromSiteApi(fetchFn, url);
    if (fromApi && fromApi.title) return fromApi;
    let quick = null;
    let quickError = null;
    try {
        quick = await fetchPreviewHttp(fetchFn, url);
        if (quick.title && quick.image) return quick;
    } catch (e) {
        quickError = e;
        if (!(e instanceof BlockedError) && !/abort|timed? ?out|ERR_/i.test(String(e && e.message))) throw e;
    }
    try {
        const full = await browser(url);
        if (!quick) return full;
        return { ...quick, ...Object.fromEntries(Object.entries(full).filter(([, v]) => v)) };
    } catch (e) {
        if (quick) return quick;
        throw quickError && !(quickError instanceof BlockedError) ? quickError : e;
    }
}

async function fetchImageOnce(fetchFn, url, referer) {
    const headers = {
        'User-Agent': USER_AGENT,
        Accept: 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    };
    if (referer) headers.Referer = referer;
    const res = await fetchWithTimeout(fetchFn, url, headers);
    if (!res.ok) throw new Error(`Image request failed (HTTP ${res.status}).`);
    const type = res.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) throw new Error('That link is not an image.');
    const data = await readLimited(res, MAX_IMAGE_BYTES + 1);
    if (data.length > MAX_IMAGE_BYTES) throw new Error('Image is too large.');
    return { data: new Uint8Array(data), type };
}

// Plain request first; if refused, again saying which page it's for (some image servers
// only answer requests that come from their own pages)
async function fetchImage(fetchFn, url, pageUrl) {
    if (!isWebUrl(url)) throw new Error('Bad image link.');
    try {
        return await fetchImageOnce(fetchFn, url, null);
    } catch (first) {
        if (!pageUrl || !isWebUrl(pageUrl)) throw first;
        try { return await fetchImageOnce(fetchFn, url, pageUrl); } catch (e) { throw first; }
    }
}

module.exports = { browsePage, closeAll, parseMeta, fetchPreview, fetchPreviewHttp, fetchImage, isWebUrl, decodeEntities, USER_AGENT };
