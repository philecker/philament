// Library tab: watched folders, 3D preview, open in slicer.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseModel, fileKind, kindLabel } from './model-parsers.js';

const fs = window.require('fs');
const path = window.require('path');
const os = window.require('os');
const { execFile, spawn } = window.require('child_process');
const { shell, webUtils } = window.require('electron');
const remote = window.require('@electron/remote');

const FOLDERS_KEY = 'philament_model_folders';
const HIDDEN_KEY = 'philament_hidden_models';
const EXPANDED_KEY = 'philament_expanded_folders';
const SLICER_KEY = 'philament_slicer';
const MAX_FILES = 10000;
const MAX_DEPTH = 12;
const MAX_3D_BYTES = 400 * 1024 * 1024;
const MAX_ROWS = 300;

const state = {
    folders: loadJSON(FOLDERS_KEY, []),
    slicer: loadJSON(SLICER_KEY, null),
    files: [],
    dirs: [], // every subfolder found, so folders without model files still show
    query: '',
    selected: null,
    previewToken: 0,
    current: null, // { thumbnailUrl }
    missing: new Set(),
    hidden: new Set(), // files or folders hidden from the list (files on disk are untouched)
    expanded: new Set(), // folders shown open in the tree
    showHidden: false,
    cursor: null, // keyboard position: 'f:<path>' or 'd:<path>'
};
state.hidden = new Set(loadJSON(HIDDEN_KEY, []));
state.expanded = new Set(loadJSON(EXPANDED_KEY, null) || state.folders);


// Helpers

function loadJSON(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
    } catch { return fallback; }
}
function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function formatDate(ms) {
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
function prettyFolder(p) {
    const home = os.homedir();
    return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}
function revealLabel() {
    return process.platform === 'darwin' ? 'Show in Finder' : 'Show in Folder';
}

// Folder scanning

async function scanFolder(root, results, dirs, depth = 0, base = root, seen = new Set()) {
    if (depth > MAX_DEPTH || results.length >= MAX_FILES) return;
    let entries;
    try {
        // a symlinked folder can point back up the tree, so each real folder is read once
        const real = await fs.promises.realpath(root);
        if (seen.has(real)) return;
        seen.add(real);
        entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch { return; }
    entries.sort((a, b) => byName(a.name, b.name));
    for (const e of entries) {
        if (results.length >= MAX_FILES) return;
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(root, e.name);
        let isDir = e.isDirectory();
        let isFile = e.isFile();
        if (e.isSymbolicLink()) {
            try {
                const st = await fs.promises.stat(full);
                isDir = st.isDirectory();
                isFile = st.isFile();
            } catch { continue; }
        }
        if (isDir) {
            if (/\.(app|bundle|photoslibrary)$/i.test(e.name)) continue;
            dirs.push({ path: full, base });
            await scanFolder(full, results, dirs, depth + 1, base, seen);
        } else if (isFile) {
            const kind = fileKind(e.name);
            if (!kind) continue;
            try {
                const st = await fs.promises.stat(full);
                results.push({ path: full, name: e.name, kind, size: st.size, mtime: st.mtimeMs, base });
            } catch {}
        }
    }
}

let scanning = null;
let rescanQueued = false;

// One scan at a time; a request during a scan runs once more afterwards
async function refreshFiles() {
    if (scanning) { rescanQueued = true; return scanning; }
    scanning = (async () => {
        do {
            rescanQueued = false;
            await scanAll();
        } while (rescanQueued);
    })();
    try { await scanning; } finally { scanning = null; }
}

async function scanAll() {
    const results = [];
    const dirs = [];
    state.missing = new Set();
    for (const f of state.folders) {
        if (!fs.existsSync(f)) { state.missing.add(f); continue; }
        await scanFolder(f, results, dirs);
    }
    results.sort((a, b) => b.mtime - a.mtime);
    state.files = results;
    state.dirs = dirs;
    if (state.selected && !results.some((f) => f.path === state.selected.path)) {
        state.selected = null;
        hidePreview();
    }
    render();
}

// Folders

async function addFolder() {
    const win = remote.getCurrentWindow();
    const res = await remote.dialog.showOpenDialog(win, {
        title: 'Add a folder of 3D models',
        buttonLabel: 'Add Folder',
        properties: ['openDirectory', 'multiSelections', 'createDirectory'],
    });
    if (res.canceled) return;
    addFolderPaths(res.filePaths);
}

function addFolderPaths(paths) {
    let changed = false;
    for (const p of paths) {
        if (!state.folders.includes(p)) {
            state.folders.push(p);
            state.expanded.add(p);
            changed = true;
        }
    }
    if (changed) {
        saveJSON(FOLDERS_KEY, state.folders);
        saveJSON(EXPANDED_KEY, [...state.expanded]);
        refreshFiles();
    }
}

function removeFolder(root) {
    state.folders = state.folders.filter((f) => f !== root);
    // Forget hide / open state for anything inside it
    for (const set of [state.hidden, state.expanded]) {
        for (const p of [...set]) if (isInside(p, root)) set.delete(p);
    }
    saveJSON(FOLDERS_KEY, state.folders);
    saveJSON(HIDDEN_KEY, [...state.hidden]);
    saveJSON(EXPANDED_KEY, [...state.expanded]);
    refreshFiles();
}

// Slicer

const SLICER_CANDIDATES = {
    darwin: ['BambuStudio.app', 'OrcaSlicer.app', 'PrusaSlicer.app', 'UltiMaker Cura.app', 'Ultimaker Cura.app',
             'Creality Print.app', 'ElegooSlicer.app', 'AnycubicSlicerNext.app', 'SuperSlicer.app'],
    win32: ['Bambu Studio\\bambu-studio.exe', 'OrcaSlicer\\orca-slicer.exe', 'Prusa3D\\PrusaSlicer\\prusa-slicer.exe',
            'UltiMaker Cura\\UltiMaker-Cura.exe', 'Creality Print\\CrealityPrint.exe'],
};

function slicerName(p) {
    const base = path.basename(p).replace(/\.(app|exe|AppImage)$/i, '');
    return base.replace(/^bambu-studio$/i, 'Bambu Studio').replace(/^BambuStudio$/, 'Bambu Studio').replace(/^orca-slicer$/i, 'OrcaSlicer');
}

function detectSlicer() {
    if (process.platform === 'darwin') {
        const dirs = ['/Applications', path.join(os.homedir(), 'Applications')];
        for (const app of SLICER_CANDIDATES.darwin) {
            for (const d of dirs) {
                const p = path.join(d, app);
                if (fs.existsSync(p)) return p;
            }
        }
    } else if (process.platform === 'win32') {
        const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean);
        for (const rel of SLICER_CANDIDATES.win32) {
            for (const r of roots) {
                const p = path.join(r, rel);
                if (fs.existsSync(p)) return p;
            }
        }
    }
    return null;
}

async function chooseSlicer() {
    const win = remote.getCurrentWindow();
    const isMac = process.platform === 'darwin';
    const res = await remote.dialog.showOpenDialog(win, {
        title: 'Choose your slicer',
        buttonLabel: 'Use This Slicer',
        defaultPath: isMac ? '/Applications' : (process.env['ProgramFiles'] || os.homedir()),
        properties: ['openFile'],
        filters: isMac ? [{ name: 'Applications', extensions: ['app'] }]
               : process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }]
               : [],
    });
    if (res.canceled || !res.filePaths.length) return false;
    state.slicer = { path: res.filePaths[0], name: slicerName(res.filePaths[0]) };
    saveJSON(SLICER_KEY, state.slicer);
    render();
    return true;
}

// Fusion designs open in Fusion, everything else in the slicer
const FUSION_APPS = ['Autodesk Fusion', 'Autodesk Fusion 360', 'Fusion 360'];

function openLabel(file) {
    if (file && file.kind === 'f3d') return 'Open in Fusion';
    return state.slicer ? `Open in ${state.slicer.name}` : 'Open in Slicer';
}

function openFile(file) {
    if (!file) return;
    if (file.kind === 'f3d') openInFusion(file);
    else openInSlicer(file);
}

function openInFusion(file) {
    const fail = (err) => remote.dialog.showMessageBox(remote.getCurrentWindow(), {
        type: 'error',
        message: 'Couldn’t open the design in Fusion.',
        detail: 'Make sure Autodesk Fusion is installed.' + (err ? `\n\n${err.message}` : ''),
    });
    if (process.platform === 'darwin') {
        // try Fusion by name, then whatever app this Mac uses for .f3d files
        const attempt = (i) => {
            const args = i < FUSION_APPS.length ? ['-a', FUSION_APPS[i], file.path] : [file.path];
            execFile('open', args, (err) => {
                if (!err) return;
                if (i < FUSION_APPS.length) attempt(i + 1);
                else fail(err);
            });
        };
        attempt(0);
    } else {
        shell.openPath(file.path).then((msg) => { if (msg) fail(new Error(msg)); });
    }
    flashButton($('models-open-btn'));
}

async function openInSlicer(file) {
    if (!file) return;
    if (!state.slicer || !fs.existsSync(state.slicer.path)) {
        const picked = await chooseSlicer();
        if (!picked) return;
    }
    const app = state.slicer.path;
    const onError = (err) => {
        if (err) {
            remote.dialog.showMessageBox(remote.getCurrentWindow(), {
                type: 'error',
                message: `Couldn't open the file in ${state.slicer.name}.`,
                detail: err.message,
            });
        }
    };
    if (process.platform === 'darwin') {
        execFile('open', ['-a', app, file.path], onError);
    } else {
        try {
            const child = spawn(app, [file.path], { detached: true, stdio: 'ignore' });
            child.on('error', onError);
            child.unref();
        } catch (err) { onError(err); }
    }
    flashButton($('models-open-btn'));
}

function flashButton(btn) {
    if (!btn) return;
    btn.classList.add('flash');
    setTimeout(() => btn.classList.remove('flash'), 600);
}

// 3D viewer

const viewer = { renderer: null, scene: null, camera: null, controls: null, mesh: null, grid: null, observer: null, unavailable: false };

// Returns false when this Mac can't draw 3D (WebGL off or no graphics acceleration)
function ensureViewer() {
    if (viewer.renderer) return true;
    if (viewer.unavailable) return false;
    const canvas = $('models-canvas');
    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (e) {
        viewer.unavailable = true;
        return false;
    }
    renderer.setPixelRatio(window.devicePixelRatio || 1);

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 2, 1.5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-1.5, 0.5, -1);
    scene.add(fill);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.addEventListener('change', draw);

    Object.assign(viewer, { renderer, scene, camera, controls });

    viewer.observer = new ResizeObserver(() => sizeViewer());
    viewer.observer.observe(canvas.parentElement);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { styleGrid(); styleModel(); draw(); });
    return true;
}

function sizeViewer() {
    const wrap = $('models-canvas').parentElement;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h || !viewer.renderer) return;
    viewer.renderer.setSize(w, h, false);
    viewer.camera.aspect = w / h;
    viewer.camera.updateProjectionMatrix();
    draw();
}

function draw() {
    if (viewer.renderer) viewer.renderer.render(viewer.scene, viewer.camera);
}

function styleGrid() {
    if (!viewer.grid) return;
    // Dark mode needs a much lighter line color to stand out against the dark preview
    viewer.grid.material.color.set(isDark() ? 0x94a3b8 : 0xd1d5db);
    viewer.grid.material.opacity = isDark() ? 0.85 : 0.9;
}

function showGeometry(geometry) {
    if (!ensureViewer()) return false;
    clearMesh();

    // Printing files are Z-up; three.js is Y-up
    geometry.rotateX(-Math.PI / 2);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const center = box.getCenter(new THREE.Vector3());
    geometry.translate(-center.x, -box.min.y, -center.z);
    geometry.computeBoundingSphere();

    const material = new THREE.MeshStandardMaterial({ color: modelColor(), metalness: 0.05, roughness: 0.55, flatShading: true });
    viewer.mesh = new THREE.Mesh(geometry, material);
    viewer.scene.add(viewer.mesh);

    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z) * 1.6 || 10;
    const divisions = Math.max(4, Math.min(40, Math.round(span / 10)));
    viewer.grid = new THREE.GridHelper(span, divisions);
    viewer.grid.material.transparent = true;
    styleGrid();
    viewer.scene.add(viewer.grid);

    const r = geometry.boundingSphere.radius || 10;
    const target = new THREE.Vector3(0, size.y / 2, 0);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(viewer.camera.fov / 2)) * 1.05;
    viewer.camera.near = dist / 100;
    viewer.camera.far = dist * 100;
    viewer.camera.position.copy(target).add(new THREE.Vector3(1, 0.75, 1.2).normalize().multiplyScalar(dist));
    viewer.controls.target.copy(target);
    viewer.camera.updateProjectionMatrix();
    viewer.controls.update();
    sizeViewer();
    return true;
}

function accentColor() {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#10b981';
}

function isDark() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

// The app color in light mode; grey reads better on the dark preview
const DARK_MODEL_COLOR = '#a9b2bf';
function modelColor() {
    return isDark() ? DARK_MODEL_COLOR : accentColor();
}

function styleModel() {
    if (viewer.mesh) viewer.mesh.material.color.set(modelColor());
}

window.addEventListener('philament-accent', () => {
    styleModel();
    draw();
});

function clearMesh() {
    if (viewer.mesh) {
        viewer.scene.remove(viewer.mesh);
        viewer.mesh.geometry.dispose();
        viewer.mesh.material.dispose();
        viewer.mesh = null;
    }
    if (viewer.grid) {
        viewer.scene.remove(viewer.grid);
        viewer.grid.geometry.dispose();
        viewer.grid.material.dispose();
        viewer.grid = null;
    }
}

// Preview

function setStage(mode, message) {
    $('models-canvas').classList.toggle('hidden', mode !== '3d');
    $('models-thumb').classList.toggle('hidden', mode !== 'image');
    const msg = $('models-stage-msg');
    msg.classList.toggle('hidden', !message);
    msg.textContent = message || '';
    const badge = $('models-view-badge');
    badge.classList.toggle('hidden', !mode);
    badge.textContent = mode === '3d' ? '3D' : 'Image';
}

function releaseCurrent() {
    if (state.current && state.current.thumbnailUrl) URL.revokeObjectURL(state.current.thumbnailUrl);
    state.current = null;
}

async function selectFile(file) {
    state.selected = file;
    render();
    const token = ++state.previewToken;

    $('models-preview').classList.remove('hidden');
    $('models-preview-name').textContent = file.name;
    $('models-preview-meta').textContent = `${kindLabel(file.kind)} · ${formatSize(file.size)}`;
    setStage(null, 'Loading preview…');

    releaseCurrent();
    try {
        let bytes;
        if (/\.(b?gcode)$/i.test(file.name)) {
            const fh = await fs.promises.open(file.path, 'r');
            const len = Math.min(file.size, 4 * 1024 * 1024);
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, 0);
            await fh.close();
            bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        } else if (file.size > MAX_3D_BYTES && (file.kind === 'stl' || file.kind === 'f3d')) {
            if (token === state.previewToken) setStage(null, 'File is too large to preview.');
            return;
        } else {
            const buf = await fs.promises.readFile(file.path);
            bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        // Let the "Loading" state paint before heavy parsing
        await new Promise((r) => setTimeout(r, 16));
        if (token !== state.previewToken) return;

        const result = parseModel(file.name, bytes);
        if (token !== state.previewToken) { result.geometry && result.geometry.dispose(); return; }

        const thumbnailUrl = result.thumbnail ? URL.createObjectURL(new Blob([result.thumbnail.bytes], { type: result.thumbnail.mime })) : null;
        state.current = { thumbnailUrl };

        const meta = [kindLabel(file.kind), formatSize(file.size)];
        if (result.size) meta.push(`${result.size.x.toFixed(1)} × ${result.size.y.toFixed(1)} × ${result.size.z.toFixed(1)} mm`);
        if (result.truncated) meta.push('partial preview');
        $('models-preview-meta').textContent = meta.join(' · ');

        if (thumbnailUrl) $('models-thumb').src = thumbnailUrl;
        // A model this Mac can't draw in 3D falls back to the file's own picture, if it has one
        const drawn = result.geometry ? showGeometry(result.geometry) : false;

        // 3D when it can be drawn, otherwise the file's picture
        const mode = drawn ? '3d' : thumbnailUrl ? 'image' : null;
        let message = 'No preview available for this file.';
        if (result.geometry && !drawn) message = '3D preview isn’t available on this Mac. Graphics acceleration may be turned off.';
        else if (file.kind === 'f3d') message = 'Fusion design. Open it in Fusion to see the model.';
        setStage(mode, mode ? null : message);
        if (mode === '3d') sizeViewer();
    } catch (err) {
        if (token === state.previewToken) setStage(null, `Couldn't read this file (${err.message}).`);
    }
}

function hidePreview() {
    state.previewToken++;
    releaseCurrent();
    clearMesh();
    $('models-preview').classList.add('hidden');
    state.selected = null;
    render();
}

// Hide, trash, tree state

function isInside(p, dir) {
    return p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

function isHidden(p) {
    for (const h of state.hidden) if (isInside(p, h)) return true;
    return false;
}

function hiddenCount() {
    return [...state.hidden].filter((h) => state.folders.some((root) => isInside(h, root))).length;
}

function setHidden(p, hide) {
    if (hide) state.hidden.add(p);
    else state.hidden.delete(p);
    saveJSON(HIDDEN_KEY, [...state.hidden]);
    if (hide && !state.showHidden && state.selected && isInside(state.selected.path, p)) hidePreview();
    if (!hiddenCount()) state.showHidden = false;
    render();
}

function toggleExpanded(dir, open = !state.expanded.has(dir)) {
    if (open) state.expanded.add(dir);
    else state.expanded.delete(dir);
    saveJSON(EXPANDED_KEY, [...state.expanded]);
    render();
}

async function trashFile(file) {
    const win = remote.getCurrentWindow();
    const res = await remote.dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Move to Trash', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `Move “${file.name}” to the Trash?`,
        detail: 'You can put it back from the Trash in Finder.',
    });
    if (res.response !== 0) return;
    try {
        await shell.trashItem(file.path);
    } catch (err) {
        remote.dialog.showMessageBox(win, { type: 'error', message: `Couldn’t move “${file.name}” to the Trash.`, detail: err.message });
        return;
    }
    state.files = state.files.filter((f) => f.path !== file.path);
    if (state.hidden.delete(file.path)) saveJSON(HIDDEN_KEY, [...state.hidden]);
    if (state.selected && state.selected.path === file.path) hidePreview();
    else render();
}

function showRowMenu(row) {
    const isFile = row.type === 'file';
    const hidden = isHidden(row.path);
    const directlyHidden = state.hidden.has(row.path);
    const template = [];
    if (isFile) {
        template.push(
            { label: openLabel(row.file), click: () => openFile(row.file) },
            { label: revealLabel(), click: () => shell.showItemInFolder(row.path) },
            { type: 'separator' },
        );
    } else {
        template.push(
            { label: row.open ? 'Collapse' : 'Expand', enabled: !row.forced, click: () => toggleExpanded(row.path) },
            { label: process.platform === 'darwin' ? 'Open in Finder' : 'Open Folder', enabled: !row.missing, click: () => shell.openPath(row.path) },
            { type: 'separator' },
        );
    }
    template.push({
        label: directlyHidden ? 'Unhide' : 'Hide from Philament',
        enabled: directlyHidden || !hidden,
        click: () => setHidden(row.path, !directlyHidden),
    });
    if (isFile) template.push({ label: 'Move to Trash…', click: () => trashFile(row.file) });
    if (row.root) template.push({ type: 'separator' }, { label: 'Remove Folder from Philament', click: () => removeFolder(row.path) });
    remote.Menu.buildFromTemplate(template).popup({ window: remote.getCurrentWindow() });
}

// Rendering

function matchesFilters(f) {
    const q = state.query.trim().toLowerCase();
    return !q || f.name.toLowerCase().includes(q);
}

const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Flatten the folder tree into the rows currently on screen
function buildRows() {
    const filtering = !!state.query.trim();
    const rows = [];

    for (const root of state.folders) {
        const rootName = path.basename(root) || root;
        if (isHidden(root) && !state.showHidden) continue;
        if (state.missing.has(root)) {
            rows.push({ type: 'dir', path: root, name: rootName, depth: 0, root: true, missing: true, count: 0, open: false });
            continue;
        }

        const tree = { dirs: new Map(), files: [] };
        const nodeFor = (dir) => {
            const rel = path.relative(root, dir);
            let node = tree;
            for (const part of rel ? rel.split(path.sep) : []) {
                if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
                node = node.dirs.get(part);
            }
            return node;
        };
        // while searching, only folders with matches are shown
        if (!filtering) {
            for (const d of state.dirs) {
                if (d.base === root && (state.showHidden || !isHidden(d.path))) nodeFor(d.path);
            }
        }
        for (const f of state.files) {
            if (f.base !== root || !matchesFilters(f)) continue;
            if (!state.showHidden && isHidden(f.path)) continue;
            nodeFor(path.dirname(f.path)).files.push(f);
        }
        const count = (n) => n.files.length + [...n.dirs.values()].reduce((sum, d) => sum + count(d), 0);
        if (filtering && !count(tree)) continue;

        const emit = (node, dir, name, depth, isRoot) => {
            const open = filtering || state.expanded.has(dir);
            rows.push({ type: 'dir', path: dir, name, depth, root: isRoot, count: count(node), open, forced: filtering });
            if (!open) return;
            for (const sub of [...node.dirs.keys()].sort(byName)) {
                emit(node.dirs.get(sub), path.join(dir, sub), sub, depth + 1, false);
            }
            for (const f of node.files.sort((a, b) => b.mtime - a.mtime)) {
                rows.push({ type: 'file', path: f.path, name: f.name, depth: depth + 1, file: f });
            }
        };
        emit(tree, root, rootName, 0, true);
    }
    return rows;
}

const ICONS = {
    caret: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="9 6 15 12 9 18"/></svg>',
    folder: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    hide: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
    show: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    remove: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

function actionButton(action, icon, title) {
    return `<button class="row-action" data-action="${action}" title="${esc(title)}" aria-label="${esc(title)}" tabindex="-1">${ICONS[icon]}</button>`;
}

function rowKey(row) {
    return (row.type === 'file' ? 'f:' : 'd:') + row.path;
}

function renderRow(row, i) {
    const hidden = isHidden(row.path);
    const directlyHidden = state.hidden.has(row.path);
    const key = rowKey(row);
    const classes = ['tree-row', row.type === 'file' ? 'model-row' : 'folder-row'];
    if (hidden) classes.push('is-hidden');
    if (state.cursor === key) classes.push('cursor');
    if (row.type === 'file' && state.selected && state.selected.path === row.path) classes.push('selected');

    const hideBtn = directlyHidden
        ? actionButton('unhide', 'show', 'Unhide')
        : hidden ? '' : actionButton('hide', 'hide', 'Hide from Philament (the file stays on disk)');

    if (row.type === 'dir') {
        if (row.open) classes.push('open');
        if (row.root) classes.push('root');
        if (row.missing) classes.push('missing');
        const meta = row.missing ? 'Not found' : String(row.count);
        return `<div class="${classes.join(' ')}" data-i="${i}" style="--depth:${row.depth}" title="${esc(prettyFolder(row.path))}">
            <span class="tree-caret">${row.missing ? '' : ICONS.caret}</span>
            <span class="tree-folder-icon">${ICONS.folder}</span>
            <span class="model-name">${esc(row.name)}</span>
            <span class="model-meta">${meta}</span>
            <span class="row-actions">${row.missing ? '' : hideBtn}${row.root ? actionButton('remove', 'remove', 'Remove folder from Philament') : ''}</span>
        </div>`;
    }
    const f = row.file;
    return `<div class="${classes.join(' ')}" data-i="${i}" style="--depth:${row.depth}" title="${esc(prettyFolder(f.path))}\nDouble-click to open in ${f.kind === 'f3d' ? 'Fusion' : 'slicer'} · Right-click for more">
        <span class="model-badge model-badge-${f.kind}">${kindLabel(f.kind)}</span>
        <span class="model-name">${esc(f.name)}</span>
        <span class="model-meta" title="${formatSize(f.size)}">${formatDate(f.mtime)}</span>
        <span class="row-actions">${hideBtn}${actionButton('trash', 'trash', 'Move to Trash')}</span>
    </div>`;
}

function render() {
    const hasFolders = state.folders.length > 0;
    $('models-empty').classList.toggle('hidden', hasFolders);
    $('models-body').classList.toggle('hidden', !hasFolders);
    const shownFiles = state.files.filter((f) => !isHidden(f.path)).length;
    $('models-count').textContent = hasFolders ? `${shownFiles} file${shownFiles === 1 ? '' : 's'}` : '';

    // Slicer chip
    $('models-slicer-name').textContent = state.slicer ? state.slicer.name : 'Set Slicer';
    $('models-slicer-btn').title = state.slicer ? `Slicer: ${state.slicer.path}\nClick to change` : 'Choose the slicer app to open files with';
    const settingsLabel = $('settings-slicer-name');
    if (settingsLabel) settingsLabel.textContent = state.slicer ? state.slicer.name : 'Not set';
    $('models-open-label').textContent = openLabel(state.selected);
    $('models-reveal-label').textContent = revealLabel();

    // Hidden items button
    const hiddenN = hiddenCount();
    const hiddenBtn = $('models-hidden-btn');
    hiddenBtn.classList.toggle('hidden', !hiddenN);
    hiddenBtn.classList.toggle('active', state.showHidden);
    $('models-hidden-label').textContent = state.showHidden ? `Showing ${hiddenN} hidden` : `${hiddenN} hidden`;
    hiddenBtn.title = state.showHidden ? 'Stop showing hidden items' : 'Show hidden items so you can unhide them';

    // Tree
    const rows = buildRows();
    const list = $('models-list');
    if (!rows.length) {
        const filtering = state.query.trim();
        list.innerHTML = `<div class="models-list-empty">${filtering ? 'No files match.' : 'Everything here is hidden.'}</div>`;
    } else {
        const shown = rows.slice(0, MAX_ROWS);
        list.innerHTML = shown.map(renderRow).join('') +
            (rows.length > MAX_ROWS ? `<div class="models-list-empty">Showing ${MAX_ROWS} of ${rows.length} rows. Search or collapse folders to see the rest.</div>` : '');
    }
    list._rows = rows.slice(0, MAX_ROWS);
}

// Wiring

function rowFromEvent(e) {
    const el = e.target.closest('.tree-row');
    return el ? $('models-list')._rows[+el.dataset.i] : null;
}

function activateRow(row) {
    state.cursor = rowKey(row);
    if (row.type === 'file') selectFile(row.file).catch(() => {});
    else render();
}

function init() {
    const section = $('models-section');
    if (!section) return;

    if (!state.slicer) {
        const found = detectSlicer();
        if (found) {
            state.slicer = { path: found, name: slicerName(found) };
            saveJSON(SLICER_KEY, state.slicer);
        }
    }

    $('models-add-btn').addEventListener('click', addFolder);
    $('models-empty-add').addEventListener('click', addFolder);
    $('models-slicer-btn').addEventListener('click', chooseSlicer);
    $('models-refresh-btn').addEventListener('click', refreshFiles);
    $('models-hidden-btn').addEventListener('click', () => { state.showHidden = !state.showHidden; render(); });
    $('models-close-preview').addEventListener('click', hidePreview);
    $('models-open-btn').addEventListener('click', () => openFile(state.selected));
    $('models-reveal-btn').addEventListener('click', () => state.selected && shell.showItemInFolder(state.selected.path));
    $('models-search').addEventListener('input', (e) => { state.query = e.target.value; render(); });

    const list = $('models-list');
    list.addEventListener('click', (e) => {
        const row = rowFromEvent(e);
        if (!row) return;
        const action = e.target.closest('[data-action]');
        if (action) {
            e.stopPropagation();
            const a = action.dataset.action;
            if (a === 'hide') setHidden(row.path, true);
            else if (a === 'unhide') setHidden(row.path, false);
            else if (a === 'trash') trashFile(row.file);
            else if (a === 'remove') removeFolder(row.path);
            return;
        }
        if (row.type === 'dir') {
            state.cursor = rowKey(row);
            if (!row.missing && !row.forced) toggleExpanded(row.path);
            else render();
        } else {
            activateRow(row);
        }
    });
    list.addEventListener('dblclick', (e) => {
        const row = rowFromEvent(e);
        if (row && row.type === 'file' && !e.target.closest('[data-action]')) openFile(row.file);
    });
    list.addEventListener('contextmenu', (e) => {
        const row = rowFromEvent(e);
        if (!row || row.missing && !row.root) return;
        e.preventDefault();
        state.cursor = rowKey(row);
        render();
        showRowMenu(row);
    });

    // Keyboard: ↑/↓ move, →/← open/close folders, Enter opens, ⌘⌫ moves to Trash
    list.addEventListener('keydown', (e) => {
        const rows = list._rows || [];
        if (!rows.length) return;
        let idx = rows.findIndex((r) => rowKey(r) === state.cursor);
        const row = rows[idx];
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            idx = Math.max(0, Math.min(rows.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
            activateRow(rows[idx]);
            const el = list.querySelector(`.tree-row[data-i="${idx}"]`);
            if (el) el.scrollIntoView({ block: 'nearest' });
        } else if (!row) {
            return;
        } else if (e.key === 'ArrowRight' && row.type === 'dir' && !row.open && !row.forced) {
            e.preventDefault();
            toggleExpanded(row.path, true);
        } else if (e.key === 'ArrowLeft' && row.type === 'dir' && row.open && !row.forced) {
            e.preventDefault();
            toggleExpanded(row.path, false);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (row.type === 'file') openFile(row.file);
            else if (!row.forced) toggleExpanded(row.path);
        } else if ((e.key === 'Backspace' || e.key === 'Delete') && (e.metaKey || e.ctrlKey) && row.type === 'file') {
            e.preventDefault();
            trashFile(row.file);
        }
    });

    // Drag a folder (or files) onto the section to add their folder
    section.addEventListener('dragover', (e) => { e.preventDefault(); section.classList.add('drag-over'); });
    section.addEventListener('dragleave', (e) => { if (!section.contains(e.relatedTarget)) section.classList.remove('drag-over'); });
    section.addEventListener('drop', (e) => {
        e.preventDefault();
        section.classList.remove('drag-over');
        const paths = [];
        for (const f of e.dataTransfer.files) {
            // Electron 32+ no longer puts the path on dropped files; webUtils gives it instead
            const p = (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(f) : f.path) || '';
            if (!p) continue;
            try {
                paths.push(fs.statSync(p).isDirectory() ? p : path.dirname(p));
            } catch {}
        }
        addFolderPaths([...new Set(paths)]);
    });

    // Pick up new slices when coming back to the app
    window.addEventListener('focus', () => { if (state.folders.length) refreshFiles(); });

    // called from the Settings dialog
    window.chooseSlicer = chooseSlicer;

    render();
    refreshFiles();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
