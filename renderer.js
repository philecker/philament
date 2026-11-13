// Converter, filament guide, settings, backup and window controls.

const { ipcRenderer, shell } = require('electron');

// Electron 44+ only allows the clipboard in the main process
const copyText = (text) => ipcRenderer.invoke('copy-text', String(text));
const remote = require('@electron/remote');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_VERSION = remote.app.getVersion();
const IS_MAC = process.platform === 'darwin';
// Keyboard shortcut text: "⌘1" on a Mac, "Ctrl+1" elsewhere
const shortcut = (key) => (IS_MAC ? '⌘' : 'Ctrl+') + key;
document.documentElement.classList.add(IS_MAC ? 'platform-mac' : 'platform-other');

const STORAGE = {
    filaments: 'philament_filaments',
    selected: 'philament_selected_filament',
    fontSize: 'fontSize',
    accent: 'philament_accent',
    accentBrightness: 'philament_accent_brightness',
    modelFolders: 'philament_model_folders',
    hiddenModels: 'philament_hidden_models',
    slicer: 'philament_slicer',
    customTypes: 'philament_custom_types',
};

// The 10 most common filament types, offered when adding a filament, with typical settings
const FILAMENT_TYPES = [
    { name: 'PLA',         nozzle: '190-220°C', bed: '20-60°C',   dryingTemp: '50°C', dryingTime: '4h' },
    { name: 'PETG',        nozzle: '220-250°C', bed: '70-80°C',   dryingTemp: '65°C', dryingTime: '4h' },
    { name: 'ABS',         nozzle: '220-250°C', bed: '90-110°C',  dryingTemp: '80°C', dryingTime: '2h' },
    { name: 'TPU',         nozzle: '210-230°C', bed: '30-60°C',   dryingTemp: '50°C', dryingTime: '4h' },
    { name: 'ASA',         nozzle: '230-260°C', bed: '90-110°C',  dryingTemp: '80°C', dryingTime: '4h' },
    { name: 'PLA-CF',      nozzle: '190-220°C', bed: '50-70°C',   dryingTemp: '50°C', dryingTime: '4h' },
    { name: 'PETG-CF',     nozzle: '220-250°C', bed: '70-80°C',   dryingTemp: '65°C', dryingTime: '4h' },
    { name: 'PA (Nylon)',  nozzle: '260-290°C', bed: '80-100°C',  dryingTemp: '80°C', dryingTime: '8h' },
    { name: 'PC',          nozzle: '260-280°C', bed: '100-110°C', dryingTemp: '80°C', dryingTime: '8h' },
    { name: 'PVA',         nozzle: '210-230°C', bed: '45-60°C',   dryingTemp: '55°C', dryingTime: '8h' },
];

// Popular filament brands for autocomplete in the editor
const FILAMENT_BRANDS = [
    'Bambu Lab', 'eSUN', 'Overture', 'Hatchbox', 'Polymaker', 'Sunlu', 'Prusament', 'ColorFabb',
    'MatterHackers', 'Amazon Basics', 'Elegoo', '3D Solutech', 'Inland', 'Jessie', 'TTYT3D', 'CC3D',
    'Geeetech', 'Stronghero3D',
];

// Bambu Lab–oriented defaults
const DEFAULT_FILAMENTS = {
    pla:       { name: 'PLA',           nozzle: '190-220°C', bed: '20-60°C',  dryingTemp: '50°C', dryingTime: '4h' },
    petg:      { name: 'PETG',          nozzle: '220-250°C', bed: '70-80°C',  dryingTemp: '65°C', dryingTime: '4h' },
    abs:       { name: 'ABS',           nozzle: '220-250°C', bed: '90-110°C', dryingTemp: '80°C', dryingTime: '2h' },
    tpu:       { name: 'TPU (95A)',     nozzle: '210-230°C', bed: '30-60°C',  dryingTemp: '50°C', dryingTime: '4h' },
    'paht-cf': { name: 'PA-CF / PA-GF', nozzle: '260-300°C', bed: '90-110°C', dryingTemp: '80°C', dryingTime: '6h' },
    asa:       { name: 'ASA',           nozzle: '230-260°C', bed: '90-110°C', dryingTemp: '80°C', dryingTime: '4h' },
    'pla-cf':  { name: 'PLA-CF',        nozzle: '190-220°C', bed: '50-70°C',  dryingTemp: '50°C', dryingTime: '4h' },
    'petg-cf': { name: 'PETG-CF',       nozzle: '220-250°C', bed: '70-80°C',  dryingTemp: '65°C', dryingTime: '4h' },
};

// App accent colors. Emerald is the default; the rest are defined in styles.css under [data-accent].
const ACCENTS = [
    { id: 'emerald',  name: 'Emerald',  color: '#10b981', dark: '#059669', light: '#34d399' },
    { id: 'ocean',    name: 'Ocean',    color: '#3b82f6', dark: '#2563eb', light: '#60a5fa' },
    { id: 'violet',   name: 'Violet',   color: '#8b5cf6', dark: '#7c3aed', light: '#a78bfa' },
    { id: 'rose',     name: 'Rose',     color: '#f43f5e', dark: '#e11d48', light: '#fb7185' },
    { id: 'sunset',   name: 'Sunset',   color: '#f97316', dark: '#ea580c', light: '#fb923c' },
    { id: 'graphite', name: 'Graphite', color: '#64748b', dark: '#475569', light: '#94a3b8' },
];

// Brightness of the app color, in percent (100 = as designed)
const BRIGHTNESS_MIN = 50;
const BRIGHTNESS_MAX = 100;

// Common filament color names → swatch color; longer names win ("Ivory White" before "White")
const COLOR_NAMES = {
    'black': '#1c1c1e', 'charcoal': '#36454f', 'white': '#f7f7f5', 'jade white': '#f2f5ef', 'ivory white': '#f3ecd9', 'bone white': '#e8e1cc',
    'ivory': '#f3ecd9', 'gray': '#8e9196', 'grey': '#8e9196', 'light gray': '#c4c7cc', 'light grey': '#c4c7cc', 'dark gray': '#4b4f56', 'dark grey': '#4b4f56',
    'silver': '#b8bcc2', 'red': '#d7263d', 'scarlet red': '#d1172b', 'maroon': '#7a1f2b', 'orange': '#f37a1f', 'pumpkin orange': '#ff7518',
    'yellow': '#f6c90e', 'sunflower yellow': '#ffc72c', 'lemon yellow': '#f7e14b', 'gold': '#c9a227', 'bronze': '#8c6a3d', 'copper': '#b46b3f',
    'green': '#2fa84f', 'bambu green': '#00ae42', 'mint': '#98e2c6', 'mint green': '#98e2c6', 'lime': '#a4d65e', 'olive': '#6b7a3a', 'dark green': '#1f5a3a',
    'teal': '#138d90', 'cyan': '#00b8d4', 'turquoise': '#2ec4b6', 'sky blue': '#73b8e8', 'light blue': '#9cc9ef', 'blue': '#1f5fbf', 'cobalt blue': '#0047ab',
    'navy': '#1f2a5a', 'navy blue': '#1f2a5a', 'purple': '#7b4bb7', 'lilac': '#c8a2c8', 'lavender': '#b4a7d6', 'magenta': '#d0257c', 'pink': '#f4a6c0',
    'hot pink': '#ff4fa3', 'sakura pink': '#f6c1cf', 'brown': '#7a4b2a', 'cocoa brown': '#6b4632', 'beige': '#d9c8a9', 'desert tan': '#c9a978', 'tan': '#d2b48c',
    'wood': '#b98b5c', 'natural': '#e9dfc8', 'clear': '#dfe9f3', 'transparent': '#dfe9f3', 'glow': '#c8f7a5', 'rainbow': '#e86a92',
};

function colorFromName(name) {
    const n = String(name || '').toLowerCase();
    if (!n) return '';
    if (COLOR_NAMES[n]) return COLOR_NAMES[n];
    const hit = Object.keys(COLOR_NAMES).sort((a, b) => b.length - a.length).find((k) => new RegExp(`\\b${k}\\b`).test(n));
    return hit ? COLOR_NAMES[hit] : '';
}

const PRODUCT_LINES = ['Basic', 'Matte', 'Silk', 'Silk+', 'Tough', 'Translucent', 'Glow', 'Galaxy', 'Sparkle', 'Marble', 'Metal', 'Wood',
    'Gradient', 'Dual Color', 'High Flow', 'HF', 'CF', 'Lite', 'Pro', 'Support'];

const validHex = (h) => (/^#[0-9a-f]{6}$/i.test(String(h || '')) ? String(h).toLowerCase() : '');

let filamentData = {};
let editingFilaments = null;
let isMMtoInch = true;
let saeToDecimal = true;

const $ = (id) => document.getElementById(id);

function readStorage(key, fallback = null) {
    try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v;
    } catch (e) { return fallback; }
}

function writeStorage(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { console.error('Could not save', key, e); }
}

function currentWindow() {
    return remote.getCurrentWindow();
}

function showMessage(type, message, detail) {
    return remote.dialog.showMessageBox(currentWindow(), { type, message, detail, buttons: ['OK'] });
}

// Window controls

function minimizeWindow() {
    currentWindow().minimize();
}

function maximizeWindow() {
    const win = currentWindow();
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
}

function closeWindow() {
    currentWindow().close();
}

// Filament data

function defaultFilaments() {
    const out = {};
    for (const [key, f] of Object.entries(DEFAULT_FILAMENTS)) out[key] = { ...f, inventory: [], buyLink: '' };
    return out;
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, 200);

// Accepts saved data or an imported backup and returns clean, well-formed filament data
function normalizeFilaments(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const [key, f] of Object.entries(raw)) {
        if (!f || typeof f !== 'object' || !/^[\w-]{1,64}$/.test(key)) continue;
        const defaults = DEFAULT_FILAMENTS[key] || {};
        out[key] = {
            name: str(f.name) || defaults.name || key.toUpperCase(),
            nozzle: str(f.nozzle) || defaults.nozzle || '',
            bed: str(f.bed) || defaults.bed || '',
            dryingTemp: str(f.dryingTemp) || defaults.dryingTemp || '',
            dryingTime: str(f.dryingTime) || defaults.dryingTime || '',
            buyLink: str(f.buyLink),
            inventory: Array.isArray(f.inventory)
                ? f.inventory.filter((i) => i && typeof i === 'object')
                    .map((i) => ({
                        brand: str(i.brand),
                        line: str(i.line),
                        color: str(i.color),
                        colorHex: validHex(i.colorHex),
                        quantity: str(i.quantity),
                    }))
                : [],
        };
    }
    return Object.keys(out).length ? out : null;
}

function loadFilaments() {
    let saved = null;
    try { saved = JSON.parse(readStorage(STORAGE.filaments, 'null')); } catch (e) { saved = null; }
    filamentData = normalizeFilaments(saved) || defaultFilaments();
}

function saveFilamentsToStorage() {
    writeStorage(STORAGE.filaments, JSON.stringify(filamentData));
}

function selectedFilamentKey() {
    const key = $('filament-select').value;
    return filamentData[key] ? key : Object.keys(filamentData)[0];
}

function updateFilamentSelect() {
    const select = $('filament-select');
    const wanted = select.value || readStorage(STORAGE.selected);
    select.textContent = '';
    for (const [key, f] of Object.entries(filamentData)) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = f.name;
        select.appendChild(option);
    }
    if (filamentData[wanted]) select.value = wanted;
}

function updateFilamentInfo() {
    const key = selectedFilamentKey();
    const f = filamentData[key];
    writeStorage(STORAGE.selected, key);

    $('nozzle-temp').textContent = f.nozzle || '—';
    $('bed-temp').textContent = f.bed || '—';
    const drying = [f.dryingTemp, f.dryingTime].filter(Boolean).join(' / ');
    $('drying-info').textContent = drying || '—';

    updateInventoryDisplay(f, key);
}

function formatQuantity(n) {
    return Math.round(n * 10) / 10;
}

function safeUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch (e) { return null; }
}

// Which brands are expanded, per filament ("pla|bambu lab")
const OPEN_BRANDS_KEY = 'philament_open_brands';
let openBrands = new Set();
try { openBrands = new Set(JSON.parse(readStorage(OPEN_BRANDS_KEY, '[]'))); } catch (e) { openBrands = new Set(); }

function toggleBrand(key) {
    if (openBrands.has(key)) openBrands.delete(key);
    else openBrands.add(key);
    writeStorage(OPEN_BRANDS_KEY, JSON.stringify([...openBrands]));
    updateInventoryDisplay(filamentData[selectedFilamentKey()], selectedFilamentKey());
}

function swatch(hex, cls = 'spool-swatch') {
    const dot = document.createElement('span');
    dot.className = cls + (hex ? '' : ' unset');
    if (hex) dot.style.background = hex;
    return dot;
}

// Spools grouped by brand; click a brand to see its product lines and colors
function updateInventoryDisplay(f, filamentKey = selectedFilamentKey()) {
    const list = $('inventory-list');
    const total = $('inventory-total');
    const buy = $('inventory-buy');
    const items = f.inventory || [];

    const link = safeUrl(f.buyLink);
    buy.classList.toggle('hidden', !link);
    buy.onclick = link ? () => shell.openExternal(link) : null;

    list.textContent = '';
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'inventory-empty';
        empty.textContent = 'No inventory tracked';
        list.appendChild(empty);
        total.textContent = '0 spools';
        return;
    }

    const qty = formatQuantity(items.reduce((sum, i) => sum + (parseFloat(i.quantity) || 0), 0));
    total.textContent = `${qty} spool${qty === 1 ? '' : 's'}`;

    const brands = new Map();
    for (const i of items) {
        const name = (i.brand || '').trim() || 'Unknown brand';
        const k = name.toLowerCase();
        if (!brands.has(k)) brands.set(k, { name, spools: [] });
        brands.get(k).spools.push(i);
    }

    for (const [k, b] of brands) {
        const key = `${filamentKey}|${k}`;
        const open = openBrands.has(key);
        const brandQty = formatQuantity(b.spools.reduce((sum, i) => sum + (parseFloat(i.quantity) || 0), 0));

        const row = el('div', {
            class: 'inv-row inv-brand' + (open ? ' open' : ''),
            role: 'button', tabIndex: 0,
            title: open ? 'Hide spools' : 'Show spools',
            onclick: () => toggleBrand(key),
            onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBrand(key); } },
        });
        row.setAttribute('aria-expanded', open ? 'true' : 'false');
        const caret = el('span', { class: 'inv-caret' });
        caret.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="9 6 15 12 9 18"/></svg>';
        const dots = el('span', { class: 'inv-dots' });
        const colors = [...new Set(b.spools.map((i) => validHex(i.colorHex) || colorFromName(i.color)).filter(Boolean))];
        colors.slice(0, 6).forEach((c) => dots.appendChild(swatch(c, 'inv-dot')));
        if (colors.length > 6) dots.appendChild(el('span', { class: 'inv-more', textContent: `+${colors.length - 6}` }));
        row.append(caret, el('span', { class: 'inv-name', textContent: b.name }), dots, el('span', { class: 'inv-count', textContent: brandQty }));
        list.appendChild(row);

        if (!open) continue;
        for (const i of b.spools) {
            const hex = validHex(i.colorHex) || colorFromName(i.color);
            const label = [i.line, i.color].map((x) => (x || '').trim()).filter(Boolean).join(' · ');
            const spool = el('div', { class: 'inv-row inv-spool' });
            spool.append(
                swatch(hex),
                el('span', { class: 'inv-name' + (label ? '' : ' muted'), textContent: label || 'No color set' }),
                el('span', { class: 'inv-qty', textContent: `${formatQuantity(parseFloat(i.quantity) || 0)}` }),
            );
            list.appendChild(spool);
        }
    }
}

// Filament editor

function openFilamentModal() {
    editingFilaments = JSON.parse(JSON.stringify(filamentData));
    closeTypePicker();
    renderFilamentEditList();
    $('filament-modal').classList.add('active');
}

function closeFilamentModal() {
    $('filament-modal').classList.remove('active');
    editingFilaments = null;
}

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') node.className = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (k in node) node[k] = v;
        else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c != null) node.append(c);
    return node;
}

function trashIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    const a = document.createElementNS(ns, 'polyline');
    a.setAttribute('points', '3 6 5 6 21 6');
    const b = document.createElementNS(ns, 'path');
    b.setAttribute('d', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2');
    svg.append(a, b);
    return svg;
}

function editField(key, field, label, placeholder, opts = {}) {
    const f = editingFilaments[key];
    return el('label', { class: 'field-group' + (opts.full ? ' full-width' : '') }, [
        el('span', { class: 'field-label', textContent: label }),
        el('input', {
            type: opts.type || 'text',
            value: f[field] || '',
            placeholder,
            oninput: (e) => { f[field] = e.target.value; },
        }),
    ]);
}

function renderFilamentEditList() {
    const list = $('filament-list');
    list.textContent = '';

    if (!$('brand-list')) {
        document.body.append(
            el('datalist', { id: 'brand-list' }, FILAMENT_BRANDS.map((b) => el('option', { value: b }))),
            el('datalist', { id: 'line-list' }, PRODUCT_LINES.map((l) => el('option', { value: l }))),
            el('datalist', { id: 'color-list' }, Object.keys(COLOR_NAMES).map((c) => el('option', { value: c.replace(/\b\w/g, (m) => m.toUpperCase()) }))),
        );
    }

    const keys = Object.keys(editingFilaments);
    for (const key of keys) {
        const f = editingFilaments[key];

        const inventoryRows = (f.inventory || []).map((inv, idx) => {
            const colorInput = el('input', {
                type: 'color', class: 'inventory-color-input', title: 'Swatch color',
                value: validHex(inv.colorHex) || colorFromName(inv.color) || '#cccccc',
                oninput: (e) => { inv.colorHex = e.target.value; e.target.dataset.touched = '1'; },
            });
            if (validHex(inv.colorHex)) colorInput.dataset.touched = '1';
            return el('div', { class: 'inventory-edit-item' }, [
                el('div', { class: 'inv-edit-line' }, [
                    el('input', {
                        type: 'text', value: inv.brand || '', placeholder: 'Brand', class: 'inventory-brand-input',
                        oninput: (e) => { inv.brand = e.target.value; },
                    }),
                    el('input', {
                        type: 'text', value: inv.line || '', placeholder: 'Product line (Matte, Silk+…)', class: 'inventory-line-input',
                        oninput: (e) => { inv.line = e.target.value; },
                    }),
                    el('button', {
                        class: 'delete-inventory-btn', title: 'Remove', type: 'button',
                        onclick: () => { f.inventory.splice(idx, 1); renderFilamentEditList(); },
                    }, trashIcon()),
                ]),
                el('div', { class: 'inv-edit-line' }, [
                    colorInput,
                    el('input', {
                        type: 'text', value: inv.color || '', placeholder: 'Color (Black, Jade White…)', class: 'inventory-colorname-input',
                        oninput: (e) => {
                            inv.color = e.target.value;
                            // Fill the swatch from the name until a color is picked by hand
                            const hex = colorFromName(inv.color);
                            if (hex && !colorInput.dataset.touched) { colorInput.value = hex; inv.colorHex = hex; }
                        },
                    }),
                    el('input', {
                        type: 'number', value: inv.quantity || '', placeholder: 'Qty', class: 'inventory-qty-input', min: '0', step: '0.1', title: 'Spools',
                        oninput: (e) => { inv.quantity = e.target.value; },
                    }),
                ]),
            ]);
        });
        inventoryRows.forEach((row) => {
            row.querySelector('.inventory-brand-input').setAttribute('list', 'brand-list');
            row.querySelector('.inventory-line-input').setAttribute('list', 'line-list');
            row.querySelector('.inventory-colorname-input').setAttribute('list', 'color-list');
        });

        const item = el('div', { class: 'filament-edit-item' }, [
            el('div', { class: 'filament-edit-header' }, [
                el('input', {
                    type: 'text', value: f.name, placeholder: 'Filament name',
                    oninput: (e) => { f.name = e.target.value; },
                }),
                el('button', {
                    class: 'delete-filament-btn', type: 'button', textContent: '✕',
                    title: keys.length > 1 ? 'Delete filament' : 'You need at least one filament',
                    disabled: keys.length <= 1,
                    onclick: () => {
                        if (confirm(`Delete ${f.name || 'this filament'}?`)) {
                            delete editingFilaments[key];
                            renderFilamentEditList();
                        }
                    },
                }),
            ]),
            el('div', { class: 'filament-edit-fields' }, [
                editField(key, 'nozzle', 'Nozzle', '200-220°C'),
                editField(key, 'bed', 'Bed', '60°C'),
                editField(key, 'dryingTemp', 'Drying temp', '50°C'),
                editField(key, 'dryingTime', 'Drying time', '4h'),
                editField(key, 'buyLink', 'Buy link', 'https://…', { type: 'url', full: true }),
            ]),
            el('div', { class: 'inventory-edit-section' }, [
                el('div', { class: 'inventory-edit-header', textContent: 'Inventory' }),
                el('div', { class: 'inventory-edit-list' },
                    inventoryRows.length ? inventoryRows : el('div', { class: 'inventory-edit-empty', textContent: 'No inventory items' })),
                el('button', {
                    class: 'add-inventory-btn', type: 'button', textContent: '+ Add Inventory',
                    onclick: () => { (f.inventory = f.inventory || []).push({ brand: '', line: '', color: '', colorHex: '', quantity: '1' }); renderFilamentEditList(); },
                }),
            ]),
        ]);
        list.appendChild(item);
    }
}

// Adding a filament: pick a common type, or "Other" to type your own

const typeKey = (name) => String(name || '').trim().toLowerCase();

function customTypes() {
    try {
        const list = JSON.parse(readStorage(STORAGE.customTypes, '[]') || '[]');
        return Array.isArray(list) ? list.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().slice(0, 40)) : [];
    } catch (e) { return []; }
}

function saveCustomTypes(list) {
    writeStorage(STORAGE.customTypes, JSON.stringify(list));
}

// Remembers a typed-in type so it shows up with the others next time
function rememberCustomType(name) {
    const clean = name.trim().slice(0, 40);
    if (!clean || FILAMENT_TYPES.some((t) => typeKey(t.name) === typeKey(clean))) return;
    const list = customTypes();
    if (!list.some((n) => typeKey(n) === typeKey(clean))) saveCustomTypes([...list, clean]);
}

function forgetCustomType(name) {
    saveCustomTypes(customTypes().filter((n) => typeKey(n) !== typeKey(name)));
    renderTypePicker();
}

function addNewFilament() {
    const picker = $('filament-type-picker');
    const opening = picker.classList.contains('hidden');
    picker.classList.toggle('hidden', !opening);
    $('add-filament-btn').classList.toggle('open', opening);
    if (opening) {
        renderTypePicker();
        picker.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function closeTypePicker() {
    const picker = $('filament-type-picker');
    if (!picker) return;
    picker.classList.add('hidden');
    $('add-filament-btn').classList.remove('open');
}

function renderTypePicker(showOther = false) {
    const picker = $('filament-type-picker');
    const inList = new Set(Object.values(editingFilaments || {}).map((f) => typeKey(f.name)));
    const chip = (name, onPick, extra = []) => {
        const added = inList.has(typeKey(name));
        return el('span', { class: 'type-chip' + (added ? ' added' : '') }, [
            el('button', {
                type: 'button', class: 'type-chip-name', textContent: name, disabled: added,
                title: added ? 'Already in your list' : `Add ${name}`,
                onclick: onPick,
            }),
            ...extra,
        ]);
    };

    const chips = FILAMENT_TYPES.map((t) => chip(t.name, () => createFilament(t)));
    const custom = customTypes().map((name) => chip(name, () => createFilament({ name }), [
        el('button', {
            type: 'button', class: 'type-chip-remove', textContent: '×',
            title: `Remove “${name}” from this list`, 'aria-label': `Remove ${name} from this list`,
            onclick: () => forgetCustomType(name),
        }),
    ]));
    const other = el('span', { class: 'type-chip other' + (showOther ? ' active' : '') }, el('button', {
        type: 'button', class: 'type-chip-name', textContent: 'Other…',
        onclick: () => renderTypePicker(true),
    }));

    const children = [
        el('div', { class: 'type-picker-title', textContent: 'Choose a filament type' }),
        el('div', { class: 'type-chips' }, [...chips, ...custom, other]),
    ];

    if (showOther) {
        const input = el('input', {
            type: 'text', class: 'type-other-input', placeholder: 'Type a filament, e.g. PCTG, HIPS, Silk PLA', maxLength: 40,
        });
        const addBtn = el('button', { type: 'button', class: 'type-other-add', textContent: 'Add', disabled: true });
        const submit = () => {
            const name = input.value.trim();
            if (!name) return;
            const preset = FILAMENT_TYPES.find((t) => typeKey(t.name) === typeKey(name));
            if (!preset) rememberCustomType(name);
            createFilament(preset || { name });
        };
        input.addEventListener('input', () => { addBtn.disabled = !input.value.trim(); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renderTypePicker(false); }
        });
        addBtn.addEventListener('click', submit);
        children.push(el('div', { class: 'type-other-row' }, [input, addBtn]),
            el('div', { class: 'type-other-hint', textContent: 'It’s added to the list above for next time.' }));
        picker.replaceChildren(...children);
        input.focus();
        picker.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
    }
    picker.replaceChildren(...children);
}

function createFilament(preset) {
    const key = 'filament_' + Date.now();
    editingFilaments[key] = {
        name: preset.name,
        nozzle: preset.nozzle || '', bed: preset.bed || '', dryingTemp: preset.dryingTemp || '', dryingTime: preset.dryingTime || '',
        buyLink: '', inventory: [],
    };
    closeTypePicker();
    renderFilamentEditList();
    const items = $('filament-list').querySelectorAll('.filament-edit-item');
    const last = items[items.length - 1];
    if (last) {
        last.classList.add('just-added');
        last.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Custom types have no settings yet, so start in the first field to fill in
        const target = preset.nozzle ? null : last.querySelector('.filament-edit-fields input');
        if (target) target.focus();
    }
}

function saveFilaments() {
    const clean = normalizeFilaments(editingFilaments);
    if (!clean) return;
    filamentData = clean;
    saveFilamentsToStorage();
    updateFilamentSelect();
    updateFilamentInfo();
    closeFilamentModal();
}

// Unit converter

function setConverterMode(mode) {
    $('mode-mm-btn').classList.toggle('active', mode === 'mm');
    $('mode-sae-btn').classList.toggle('active', mode === 'sae');
    $('mm-converter').classList.toggle('hidden', mode !== 'mm');
    $('sae-converter').classList.toggle('hidden', mode !== 'sae');
}

function toggleDirection() {
    isMMtoInch = !$('direction-toggle').checked;
    $('toggle-label-left').classList.toggle('active', isMMtoInch);
    $('toggle-label-right').classList.toggle('active', !isMMtoInch);
    $('input-label').textContent = isMMtoInch ? 'millimeters' : 'inches';
    $('output-label').textContent = isMMtoInch ? 'inches' : 'millimeters';
    convert();
}

function convert() {
    const value = parseFloat($('input-value').value);
    const out = $('output-value');
    if (!Number.isFinite(value)) {
        out.textContent = '0.0000';
        return;
    }
    out.textContent = (isMMtoInch ? value / 25.4 : value * 25.4).toFixed(4);
}

function toggleSAEDirection() {
    saeToDecimal = !$('sae-direction-toggle').checked;
    const input = $('sae-input-value');
    $('sae-toggle-label-left').classList.toggle('active', saeToDecimal);
    $('sae-toggle-label-right').classList.toggle('active', !saeToDecimal);
    $('sae-input-label').textContent = saeToDecimal ? 'fraction' : 'decimal';
    $('sae-output-label').textContent = saeToDecimal ? 'decimal' : 'fraction';
    input.type = saeToDecimal ? 'text' : 'number';
    input.placeholder = saeToDecimal ? '1/4' : '0.0';
    input.value = '';
    $('sae-output-value').textContent = saeToDecimal ? '0.0000' : '0';
}

function convertSAE() {
    const input = $('sae-input-value').value.trim();
    const out = $('sae-output-value');
    if (!input) {
        out.textContent = saeToDecimal ? '0.0000' : '0';
        return;
    }
    if (saeToDecimal) {
        const value = parseFraction(input);
        out.textContent = value === null ? 'Invalid' : value.toFixed(4);
    } else {
        const value = parseFloat(input);
        out.textContent = Number.isFinite(value) ? decimalToFraction(value) : 'Invalid';
    }
}

// Accepts 1/4, 3/8, 1-1/2, 1 1/2, or a plain number
function parseFraction(text) {
    const s = text.trim();
    if (/^-?\d*\.?\d+$/.test(s)) return parseFloat(s);
    let m = s.match(/^(\d+)[\s-]+(\d+)\/(\d+)$/);
    if (m) return +m[3] === 0 ? null : +m[1] + +m[2] / +m[3];
    m = s.match(/^(\d+)\/(\d+)$/);
    if (m) return +m[2] === 0 ? null : +m[1] / +m[2];
    return null;
}

// Nearest fraction up to 1/64; falls back to the decimal when nothing matches
function decimalToFraction(value, tolerance = 0.0001) {
    const sign = value < 0 ? '-' : '';
    const abs = Math.abs(value);
    if (Math.abs(abs - Math.round(abs)) < tolerance) return sign + Math.round(abs);

    const whole = Math.floor(abs);
    const frac = abs - whole;
    for (const denom of [2, 4, 8, 16, 32, 64]) {
        const numer = Math.round(frac * denom);
        if (numer > 0 && Math.abs(frac - numer / denom) < tolerance) {
            const g = gcd(numer, denom);
            const f = `${numer / g}/${denom / g}`;
            return sign + (whole ? `${whole}-${f}` : f);
        }
    }
    return value.toFixed(4);
}

function gcd(a, b) {
    return b === 0 ? a : gcd(b, a % b);
}

function copyOutput(valueId, wrapper) {
    const text = $(valueId).textContent;
    if (!text || text === 'Invalid') return;
    copyText(text);
    wrapper.classList.add('copied');
    setTimeout(() => wrapper.classList.remove('copied'), 600);
}

function copyToClipboard() {
    copyOutput('output-value', document.querySelector('#mm-converter .output-wrapper'));
}

function copySAEToClipboard() {
    copyOutput('sae-output-value', document.querySelector('#sae-converter .output-wrapper'));
}

// Settings

function openSettingsModal() {
    $('settings-modal').classList.add('active');
}

function closeSettingsModal() {
    $('settings-modal').classList.remove('active');
}

function updateFontSize(value) {
    $('font-size-display').textContent = value + '%';
    document.documentElement.style.setProperty('--font-scale', value / 100);
}

function setFontSize(value) {
    const v = Math.min(150, Math.max(100, parseInt(value, 10) || 100));
    $('font-size-slider').value = v;
    updateFontSize(v);
    writeStorage(STORAGE.fontSize, String(v));
    document.querySelectorAll('.font-preset-btn').forEach((b) => b.classList.toggle('active', +b.dataset.size === v));
}

// App color

let currentAccent = ACCENTS[0];
let accentBrightness = BRIGHTNESS_MAX;

// Darken a #rrggbb color by a factor (1 = unchanged), keeping its hue
function dim(hex, factor) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (shift) => Math.round(((n >> shift) & 255) * factor);
    return [ch(16), ch(8), ch(0)];
}
const toHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

// Applies the chosen color at the chosen brightness everywhere it is used
function applyAccent() {
    const root = document.documentElement;
    const a = currentAccent;
    const f = accentBrightness / 100;
    if (a.id === 'emerald') root.removeAttribute('data-accent');
    else root.setAttribute('data-accent', a.id);

    const main = dim(a.color, f);
    root.style.setProperty('--accent', toHex(main));
    root.style.setProperty('--accent-dark', toHex(dim(a.dark, f)));
    root.style.setProperty('--accent-light', toHex(dim(a.light, f)));
    root.style.setProperty('--accent-rgb', main.join(', '));

    document.querySelectorAll('.accent-swatch').forEach((b) => {
        const on = b.dataset.accent === a.id;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        const sw = ACCENTS.find((x) => x.id === b.dataset.accent);
        b.style.setProperty('--swatch', toHex(dim(sw.color, f)));
        b.style.setProperty('--swatch-dark', toHex(dim(sw.dark, f)));
    });

    const slider = $('accent-brightness-slider');
    if (slider) {
        slider.value = accentBrightness;
        slider.style.setProperty('--range-from', toHex(dim(a.color, BRIGHTNESS_MIN / 100)));
        slider.style.setProperty('--range-to', a.color);
        $('accent-brightness-display').textContent = accentBrightness + '%';
    }
    // Lets the 3D preview recolor the model
    window.dispatchEvent(new CustomEvent('philament-accent', { detail: a }));
}

function setAccent(id) {
    currentAccent = ACCENTS.find((a) => a.id === id) || ACCENTS[0];
    writeStorage(STORAGE.accent, currentAccent.id);
    applyAccent();
}

// While dragging the preview updates live; the value is saved when released
function previewAccentBrightness(value) {
    accentBrightness = Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, parseInt(value, 10) || BRIGHTNESS_MAX));
    applyAccent();
}

function setAccentBrightness(value) {
    previewAccentBrightness(value);
    writeStorage(STORAGE.accentBrightness, String(accentBrightness));
}

function renderAccentPicker() {
    const picker = $('accent-picker');
    picker.textContent = '';
    for (const a of ACCENTS) {
        const btn = el('button', {
            type: 'button', class: 'accent-swatch', title: a.name, role: 'radio',
            onclick: () => setAccent(a.id),
        }, [el('span', { class: 'accent-dot' }), el('span', { textContent: a.name })]);
        btn.dataset.accent = a.id;
        picker.appendChild(btn);
    }
}

// Backup & restore

function iCloudDir() {
    const dir = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    return fs.existsSync(dir) ? dir : path.join(os.homedir(), 'Documents');
}

async function exportBackup() {
    closeSettingsModal();
    const backup = {
        app: 'Philament',
        version: APP_VERSION,
        exportDate: new Date().toISOString(),
        filamentData,
        settings: {
            lastSelectedFilament: selectedFilamentKey(),
            fontSize: readStorage(STORAGE.fontSize, '100'),
            accent: readStorage(STORAGE.accent, 'emerald'),
            accentBrightness: readStorage(STORAGE.accentBrightness, String(BRIGHTNESS_MAX)),
            modelFolders: JSON.parse(readStorage(STORAGE.modelFolders, '[]') || '[]'),
            hiddenModels: JSON.parse(readStorage(STORAGE.hiddenModels, '[]') || '[]'),
            savedLinks: window.philamentSaved ? window.philamentSaved.exportItems() : [],
            slicer: JSON.parse(readStorage(STORAGE.slicer, 'null') || 'null'),
            customTypes: customTypes(),
        },
    };
    const res = await remote.dialog.showSaveDialog(currentWindow(), {
        title: 'Export Philament Backup',
        defaultPath: path.join(iCloudDir(), 'Philament-Backup.json'),
        filters: [{ name: 'Philament Backup', extensions: ['json'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (res.canceled || !res.filePath) return;
    try {
        fs.writeFileSync(res.filePath, JSON.stringify(backup, null, 2), 'utf-8');
        showMessage('info', 'Backup saved', res.filePath);
    } catch (err) {
        showMessage('error', 'Couldn’t save the backup', err.message);
    }
}

async function importBackup() {
    closeSettingsModal();
    const res = await remote.dialog.showOpenDialog(currentWindow(), {
        title: 'Import Philament Backup',
        defaultPath: iCloudDir(),
        filters: [{ name: 'Philament Backup', extensions: ['json'] }],
        properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths.length) return;
    try {
        const backup = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf-8'));
        const clean = normalizeFilaments(backup && backup.filamentData);
        if (!clean) throw new Error('This file doesn’t contain any Philament filament data.');

        const confirm = await remote.dialog.showMessageBox(currentWindow(), {
            type: 'question',
            buttons: ['Restore', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
            message: 'Replace your current filaments and settings?',
            detail: `Backup from ${backup.exportDate ? new Date(backup.exportDate).toLocaleString() : 'an unknown date'}.`,
        });
        if (confirm.response !== 0) return;

        filamentData = clean;
        saveFilamentsToStorage();
        const s = backup.settings || {};
        if (s.lastSelectedFilament && clean[s.lastSelectedFilament]) writeStorage(STORAGE.selected, s.lastSelectedFilament);
        if (s.fontSize) writeStorage(STORAGE.fontSize, String(parseInt(s.fontSize, 10) || 100));
        if (ACCENTS.some((a) => a.id === s.accent)) writeStorage(STORAGE.accent, s.accent);
        const b = parseInt(s.accentBrightness, 10);
        if (b >= BRIGHTNESS_MIN && b <= BRIGHTNESS_MAX) writeStorage(STORAGE.accentBrightness, String(b));
        if (Array.isArray(s.modelFolders)) {
            writeStorage(STORAGE.modelFolders, JSON.stringify(s.modelFolders.filter((p) => typeof p === 'string')));
        }
        if (Array.isArray(s.hiddenModels)) {
            writeStorage(STORAGE.hiddenModels, JSON.stringify(s.hiddenModels.filter((p) => typeof p === 'string')));
        }
        if (Array.isArray(s.customTypes)) saveCustomTypes(s.customTypes.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().slice(0, 40)));
        if (Array.isArray(s.savedLinks) && window.philamentSaved) window.philamentSaved.importItems(s.savedLinks);
        if (s.slicer && typeof s.slicer.path === 'string') {
            writeStorage(STORAGE.slicer, JSON.stringify({ path: s.slicer.path, name: str(s.slicer.name) || path.basename(s.slicer.path) }));
        }
        location.reload();
    } catch (err) {
        showMessage('error', 'Couldn’t restore the backup', err.message);
    }
}

// Collapsible sections

function setSectionCollapsed(section, collapsed) {
    section.classList.toggle('collapsed', collapsed);
    writeStorage('philament_collapsed_' + section.dataset.collapse, collapsed ? '1' : '0');
}

function initCollapsibleSections() {
    document.querySelectorAll('.section[data-collapse]').forEach((section) => {
        if (readStorage('philament_collapsed_' + section.dataset.collapse) === '1') section.classList.add('collapsed');
        const header = section.querySelector('.section-header');
        header.classList.add('collapsible-header');
        header.setAttribute('role', 'button');
        header.setAttribute('tabindex', '0');
        const toggle = () => setSectionCollapsed(section, !section.classList.contains('collapsed'));
        header.addEventListener('click', (e) => {
            if (!e.target.closest('button, a, input, select')) toggle();
        });
        header.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target === header) {
                e.preventDefault();
                toggle();
            }
        });
    });
}

// Window

// Double-clicking the title bar maximizes or restores, like a normal window
function initTitleBar() {
    // Shortcut text in the page is written for the Mac
    if (!IS_MAC) document.querySelectorAll('[data-shortcut]').forEach((el) => { el.textContent = shortcut(el.dataset.shortcut); });
    // Ctrl+, opens Settings (the menu bar that has it is hidden in this window on Windows)
    if (!IS_MAC) document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === ',') { e.preventDefault(); openSettingsModal(); }
    });
    document.querySelector('.header').addEventListener('dblclick', (e) => {
        if (!e.target.closest('button, .logo')) maximizeWindow();
    });
}

// Startup

document.addEventListener('DOMContentLoaded', () => {
    $('app-version').textContent = `Philament v${APP_VERSION}`;

    loadFilaments();
    updateFilamentSelect();
    updateFilamentInfo();

    renderAccentPicker();
    accentBrightness = Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN,
        parseInt(readStorage(STORAGE.accentBrightness, String(BRIGHTNESS_MAX)), 10) || BRIGHTNESS_MAX));
    setAccent(readStorage(STORAGE.accent, 'emerald'));

    const savedFont = readStorage(STORAGE.fontSize, '100');
    setFontSize(savedFont);

    initCollapsibleSections();
    initTitleBar();

    // Close modals with Escape, and the settings modal by clicking outside it
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if ($('filament-modal').classList.contains('active')) closeFilamentModal();
        else if ($('settings-modal').classList.contains('active')) closeSettingsModal();
    });
    $('settings-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeSettingsModal();
    });

    // A file dropped outside the Models section must not replace the app page
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    // Only Library files can be dragged (to move them). Pictures, links and selected text
    // can't, so a stray drag never ends up as a link dropped on the Saved tab
    document.addEventListener('dragstart', (e) => {
        if (!(e.target.closest && e.target.closest('[draggable="true"]'))) e.preventDefault();
    });

});

// Used by models.js
window.setSectionCollapsed = setSectionCollapsed;
