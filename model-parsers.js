// Parsers for STL, 3MF, sliced .gcode / .gcode.3mf and Fusion .f3d files.
// Bytes in, geometry or thumbnail out. No fs or DOM, so it also runs under Node.

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';

export const MAX_TRIANGLES = 6_000_000;

// File classification

export function fileKind(name) {
    const n = name.toLowerCase();
    if (n.endsWith('.gcode.3mf') || n.endsWith('.gcode') || n.endsWith('.bgcode')) return 'sliced';
    if (n.endsWith('.3mf')) return '3mf';
    if (n.endsWith('.stl')) return 'stl';
    if (n.endsWith('.f3d')) return 'f3d';
    return null;
}

export function kindLabel(kind) {
    return { stl: 'STL', '3mf': '3MF', sliced: 'SLICED', f3d: 'F3D' }[kind] || '';
}

// Entry point

/**
 * Parse a model file.
 * @param {string} name   file name (used to pick the parser)
 * @param {Uint8Array} bytes  file contents (for .gcode, the first few MB is enough)
 * @returns {{ geometry: THREE.BufferGeometry|null, thumbnail: {bytes:Uint8Array, mime:string}|null,
 *            triangles: number, size: {x:number,y:number,z:number}|null, truncated: boolean }}
 */
export function parseModel(name, bytes) {
    const n = name.toLowerCase();
    if (n.endsWith('.stl')) return finish(parseSTL(bytes), null, false);
    if (n.endsWith('.3mf')) return parse3MF(bytes);
    if (n.endsWith('.gcode') || n.endsWith('.bgcode')) return finish(null, gcodeThumbnail(bytes), false);
    if (n.endsWith('.f3d')) return finish(null, f3dThumbnail(bytes), false);
    throw new Error('Unsupported file type');
}

function finish(geometry, thumbnail, truncated) {
    let size = null;
    let triangles = 0;
    if (geometry) {
        geometry.computeBoundingBox();
        const b = geometry.boundingBox;
        size = { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z };
        triangles = geometry.getAttribute('position').count / 3;
        if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    }
    return { geometry, thumbnail, triangles, size, truncated };
}

// STL

function parseSTL(bytes) {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const geo = new STLLoader().parse(buf);
    if (geo.index) return geo.toNonIndexed();
    return geo;
}

// 3MF

const THUMB_PREFERENCE = [
    /^metadata\/plate_1\.png$/i,
    /^metadata\/thumbnail\.png$/i,
    /^thumbnails\/thumbnail\.png$/i,
    /^metadata\/top_1\.png$/i,
    /^metadata\/plate_\d+\.png$/i,
    /^(metadata|thumbnails)\/(?!pick_)(?!.*_small)[^/]+\.(png|jpe?g)$/i,
];

function parse3MF(bytes) {
    const entries = unzipSync(bytes, {
        filter: (f) => /\.model$/i.test(f.name) || /\.rels$/i.test(f.name) ||
                       /^(metadata|thumbnails)\/[^/]+\.(png|jpe?g)$/i.test(f.name),
    });

    // Case-insensitive lookup of zip entries, paths without leading slash
    const lookup = new Map();
    for (const key of Object.keys(entries)) lookup.set(key.replace(/^\/+/, '').toLowerCase(), key);
    const getEntry = (p) => {
        const k = lookup.get(String(p).replace(/^\/+/, '').toLowerCase());
        return k ? entries[k] : null;
    };

    // Thumbnail
    let thumbnail = null;
    const names = [...lookup.keys()];
    for (const re of THUMB_PREFERENCE) {
        const hit = names.find((n) => re.test(n));
        if (hit) {
            thumbnail = { bytes: entries[lookup.get(hit)], mime: /\.png$/i.test(hit) ? 'image/png' : 'image/jpeg' };
            break;
        }
    }

    // Root model part (from _rels/.rels, else the conventional path, else any .model)
    let rootPath = null;
    const rels = getEntry('_rels/.rels');
    if (rels) {
        const text = strFromU8(rels);
        const relRe = /<(?:\w+:)?Relationship\b([^>]*)\/?>/g;
        let m;
        while ((m = relRe.exec(text))) {
            const a = attrs(m[1]);
            if (a.Target && /3dmodel$/i.test(a.Type || '')) { rootPath = a.Target; break; }
        }
    }
    if (!rootPath || !getEntry(rootPath)) {
        rootPath = getEntry('3D/3dmodel.model') ? '3D/3dmodel.model' : names.find((n) => n.endsWith('.model'));
    }
    if (!rootPath) return finish(null, thumbnail, false);

    // Parse model parts lazily (Bambu/Orca projects keep meshes in 3D/Objects/*.model)
    const parsed = new Map();
    const getPart = (p) => {
        const key = String(p).replace(/^\/+/, '').toLowerCase();
        if (!parsed.has(key)) {
            const data = getEntry(key);
            parsed.set(key, data ? parseModelXML(strFromU8(data)) : null);
        }
        return parsed.get(key);
    };

    const out = { chunks: [], triangles: 0, truncated: false };
    const root = getPart(rootPath);
    const rootKey = String(rootPath).replace(/^\/+/, '').toLowerCase();

    if (root.items.length) {
        for (const item of root.items) {
            collect(getPart, rootKey, item.objectid, toMatrix(item.transform), out, 0);
        }
    } else {
        for (const id of root.objects.keys()) collect(getPart, rootKey, id, new THREE.Matrix4(), out, 0);
    }

    if (!out.triangles) return finish(null, thumbnail, false);

    const positions = new Float32Array(out.triangles * 9);
    let offset = 0;
    for (const c of out.chunks) { positions.set(c, offset); offset += c.length; }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return finish(geometry, thumbnail, out.truncated);
}

function collect(getPart, partKey, objectId, matrix, out, depth) {
    if (depth > 16 || out.truncated) return;
    const part = getPart(partKey);
    const obj = part && part.objects.get(String(objectId));
    if (!obj) return;

    if (obj.vertices && obj.triangles && obj.triangles.length) {
        const v = obj.vertices;
        const t = obj.triangles;
        let count = t.length / 3;
        if (out.triangles + count > MAX_TRIANGLES) {
            count = MAX_TRIANGLES - out.triangles;
            out.truncated = true;
        }
        const e = matrix.elements;
        const chunk = new Float32Array(count * 9);
        for (let i = 0, o = 0; i < count * 3; i++) {
            const vi = t[i] * 3;
            const x = v[vi], y = v[vi + 1], z = v[vi + 2];
            chunk[o++] = e[0] * x + e[4] * y + e[8] * z + e[12];
            chunk[o++] = e[1] * x + e[5] * y + e[9] * z + e[13];
            chunk[o++] = e[2] * x + e[6] * y + e[10] * z + e[14];
        }
        out.chunks.push(chunk);
        out.triangles += count;
    }

    for (const comp of obj.components) {
        const key = comp.path ? comp.path.replace(/^\/+/, '').toLowerCase() : partKey;
        const m = matrix.clone().multiply(toMatrix(comp.transform));
        collect(getPart, key, comp.objectid, m, out, depth + 1);
    }
}

// Regex-based model XML parsing: much faster than DOMParser on large meshes
function parseModelXML(xml) {
    const objects = new Map();
    const objRe = /<(?:\w+:)?object\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?object>/g;
    let m;
    while ((m = objRe.exec(xml))) {
        const a = attrs(m[1]);
        const body = m[2];
        const obj = { vertices: null, triangles: null, components: [] };

        if (/<(?:\w+:)?vertex\b/.test(body)) {
            obj.vertices = parseVertices(body);
            obj.triangles = parseTriangles(body, obj.vertices.length / 3);
        }

        const compRe = /<(?:\w+:)?component\b([^>]*?)\/?>/g;
        let c;
        while ((c = compRe.exec(body))) {
            const ca = attrs(c[1]);
            if (ca.objectid) obj.components.push({ objectid: ca.objectid, path: ca.path || null, transform: ca.transform });
        }
        objects.set(String(a.id), obj);
    }

    const items = [];
    const build = /<(?:\w+:)?build\b[^>]*>([\s\S]*?)<\/(?:\w+:)?build>/.exec(xml);
    if (build) {
        const itemRe = /<(?:\w+:)?item\b([^>]*?)\/?>/g;
        let it;
        while ((it = itemRe.exec(build[1]))) {
            const ia = attrs(it[1]);
            if (ia.objectid && ia.printable !== '0') items.push({ objectid: ia.objectid, transform: ia.transform });
        }
    }
    return { objects, items };
}

function parseVertices(body) {
    const values = [];
    const fast = /<(?:\w+:)?vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/g;
    let m;
    while ((m = fast.exec(body))) values.push(+m[1], +m[2], +m[3]);
    if (!values.length) {
        const slow = /<(?:\w+:)?vertex\b([^>]*?)\/?>/g;
        while ((m = slow.exec(body))) {
            const a = attrs(m[1]);
            values.push(+a.x, +a.y, +a.z);
        }
    }
    return Float64Array.from(values);
}

function parseTriangles(body, vertexCount) {
    const values = [];
    const fast = /<(?:\w+:)?triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/g;
    let m;
    while ((m = fast.exec(body))) values.push(+m[1], +m[2], +m[3]);
    if (!values.length) {
        const slow = /<(?:\w+:)?triangle\b([^>]*?)\/?>/g;
        while ((m = slow.exec(body))) {
            const a = attrs(m[1]);
            values.push(+a.v1, +a.v2, +a.v3);
        }
    }
    // Drop triangles that reference missing vertices
    const clean = [];
    for (let i = 0; i + 2 < values.length; i += 3) {
        const a = values[i], b = values[i + 1], c = values[i + 2];
        if (a < vertexCount && b < vertexCount && c < vertexCount) clean.push(a, b, c);
    }
    return Uint32Array.from(clean);
}

function attrs(s) {
    const o = {};
    const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(s))) {
        o[m[1]] = m[2];
        const i = m[1].indexOf(':');
        if (i >= 0 && !(m[1].slice(i + 1) in o)) o[m[1].slice(i + 1)] = m[2];
    }
    return o;
}

// 3MF transforms are "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" (row-vector convention)
function toMatrix(t) {
    const m = new THREE.Matrix4();
    if (!t) return m;
    const v = t.trim().split(/\s+/).map(Number);
    if (v.length !== 12 || v.some((n) => !Number.isFinite(n))) return m;
    m.set(
        v[0], v[3], v[6], v[9],
        v[1], v[4], v[7], v[10],
        v[2], v[5], v[8], v[11],
        0, 0, 0, 1
    );
    return m;
}

// G-code thumbnails

function gcodeThumbnail(bytes) {
    const text = strFromU8(bytes.subarray(0, Math.min(bytes.length, 4 * 1024 * 1024)), true);
    const re = /;\s*thumbnail(?:_(PNG|JPG|QOI))?\s+begin\s+(\d+)\s*x\s*(\d+)[^\n]*\n([\s\S]*?);\s*thumbnail(?:_\w+)?\s+end/gi;
    let best = null;
    let m;
    while ((m = re.exec(text))) {
        const type = (m[1] || 'PNG').toUpperCase();
        if (type === 'QOI') continue;
        const w = +m[2];
        if (!best || w > best.w) best = { w, type, data: m[4] };
    }
    if (!best) return null;
    const b64 = best.data.replace(/^;\s?/gm, '').replace(/\s+/g, '');
    try {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return { bytes: out, mime: best.type === 'JPG' ? 'image/jpeg' : 'image/png' };
    } catch {
        return null;
    }
}

// Fusion .f3d
// The design itself is in Autodesk's closed format, so only a saved picture can be shown.
// An .f3d is a zip archive; use the largest image in it. Failing that, look for a PNG
// stored directly in the bytes.

export function f3dThumbnail(bytes) {
    try {
        const entries = unzipSync(bytes, { filter: (f) => /\.(png|jpe?g)$/i.test(f.name) });
        const names = Object.keys(entries).filter((k) => entries[k].length > 0);
        if (names.length) {
            const pick = (list) => list.sort((a, b) => entries[b].length - entries[a].length)[0];
            const named = names.filter((k) => /thumb|preview|snapshot/i.test(k));
            const hit = pick(named.length ? named : names);
            return { bytes: entries[hit], mime: /\.png$/i.test(hit) ? 'image/png' : 'image/jpeg' };
        }
    } catch {}
    return embeddedPng(bytes);
}

function embeddedPng(bytes) {
    const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const IEND = [0x49, 0x45, 0x4e, 0x44];
    const limit = Math.min(bytes.length, 32 * 1024 * 1024);
    const find = (pattern, from) => {
        outer: for (let i = from; i <= limit - pattern.length; i++) {
            for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
            return i;
        }
        return -1;
    };
    const start = find(SIG, 0);
    if (start < 0) return null;
    const end = find(IEND, start + 8);
    if (end < 0) return null;
    return { bytes: bytes.slice(start, end + 8), mime: 'image/png' }; // IEND + its CRC
}
