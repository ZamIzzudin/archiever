import fs from 'node:fs/promises';
import path from 'node:path';

export const STORAGE_ROOT = path.resolve(process.env.STORAGE_DIR || 'storage');
export const ALLOWED_EXTS = new Set(['.md', '.markdown', '.html', '.htm']);

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export async function initStorage() {
  try {
    await fs.mkdir(STORAGE_ROOT, { recursive: true });
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw new Error(
        `Cannot create storage at "${STORAGE_ROOT}": permission denied. ` +
          'Set STORAGE_DIR to a writable path (e.g. /data/storage in Docker) ' +
          'instead of a path owned by root, such as a relative path under /app.',
      );
    }
    throw err;
  }
}

export function isAllowedFile(name) {
  return ALLOWED_EXTS.has(path.extname(name).toLowerCase());
}

export function isMarkdown(name) {
  const ext = path.extname(name).toLowerCase();
  return ext === '.md' || ext === '.markdown';
}

export function isHtml(name) {
  const ext = path.extname(name).toLowerCase();
  return ext === '.html' || ext === '.htm';
}

export function kindOf(name) {
  if (isMarkdown(name)) return 'markdown';
  if (isHtml(name)) return 'html';
  return null;
}

// Normalizes a client supplied relative path and rejects traversal attempts.
export function normalizeRel(rel) {
  const raw = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!raw) return '';
  const parts = raw.split('/').filter(Boolean);
  for (const part of parts) {
    if (part === '.' || part === '..') throw fail('Invalid path');
    if (part.includes('\0')) throw fail('Invalid path');
  }
  return parts.join('/');
}

export function resolveSafe(rel) {
  const clean = normalizeRel(rel);
  const target = path.resolve(STORAGE_ROOT, clean);
  if (target !== STORAGE_ROOT && !target.startsWith(STORAGE_ROOT + path.sep)) {
    throw fail('Path outside storage');
  }
  return target;
}

export function relFromAbs(abs) {
  return path.relative(STORAGE_ROOT, abs).split(path.sep).join('/');
}

// Guards a single entry name (no separators allowed).
export function assertSafeName(name) {
  const clean = String(name ?? '').trim();
  if (!clean) throw fail('Name is required');
  if (clean === '.' || clean === '..') throw fail('Invalid name');
  if (/[\\/]/.test(clean)) throw fail('Name cannot contain slashes');
  if (clean.includes('\0')) throw fail('Invalid name');
  if (clean.length > 120) throw fail('Name is too long');
  return clean;
}

export async function pathExists(abs) {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

// Produces a non-colliding name inside dirAbs, e.g. "notes (1).md".
async function uniqueName(dirAbs, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let counter = 1;
  while (await pathExists(path.join(dirAbs, candidate))) {
    candidate = `${base} (${counter})${ext}`;
    counter += 1;
  }
  return candidate;
}

function entryFrom(dirent, rel) {
  const name = dirent.name;
  if (dirent.isDirectory()) {
    return { type: 'dir', name, path: rel };
  }
  if (!dirent.isFile() || !isAllowedFile(name)) return null;
  return {
    type: 'file',
    name,
    path: rel,
    kind: kindOf(name),
    ext: path.extname(name).toLowerCase(),
  };
}

async function withStat(entry) {
  try {
    const stat = await fs.stat(resolveSafe(entry.path));
    entry.size = stat.size;
    entry.mtime = stat.mtime.toISOString();
  } catch {
    entry.size = 0;
    entry.mtime = null;
  }
  return entry;
}

export async function listDir(rel = '') {
  const abs = resolveSafe(rel);
  let dirents;
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') throw fail('Folder not found', 404);
    throw err;
  }

  const entries = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    const entry = entryFrom(dirent, childRel);
    if (entry) entries.push(entry);
  }

  await Promise.all(entries.map(withStat));

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  return { path: normalizeRel(rel), entries };
}

export async function buildTree(rel = '') {
  const abs = resolveSafe(rel);
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const folders = [];
  let fileCount = 0;

  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      const child = await buildTree(childRel);
      folders.push(child);
      fileCount += child.fileCount;
    } else if (dirent.isFile() && isAllowedFile(dirent.name)) {
      fileCount += 1;
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  return {
    type: 'dir',
    name: rel ? path.basename(abs) : 'Archive',
    path: normalizeRel(rel),
    fileCount,
    children: folders,
  };
}

export async function createFolder(parentRel, name) {
  const safeName = assertSafeName(name);
  const parentAbs = resolveSafe(parentRel);
  const targetAbs = path.join(parentAbs, safeName);
  if (await pathExists(targetAbs)) throw fail('A file or folder with that name already exists', 409);
  await fs.mkdir(targetAbs, { recursive: true });
  return relFromAbs(targetAbs);
}

export async function moveEntry(fromRel, toRel) {
  const fromClean = normalizeRel(fromRel);
  const toClean = normalizeRel(toRel);
  if (!fromClean) throw fail('Source path is required');
  if (!toClean) throw fail('Destination path is required');
  if (fromClean === toClean) return toClean;

  const fromAbs = resolveSafe(fromClean);
  const toAbs = resolveSafe(toClean);

  if (!(await pathExists(fromAbs))) throw fail('Source not found', 404);

  const fromStat = await fs.stat(fromAbs);
  if (fromStat.isDirectory()) {
    if (toAbs === fromAbs || toAbs.startsWith(fromAbs + path.sep)) {
      throw fail('Cannot move a folder into itself');
    }
  }

  if (await pathExists(toAbs)) throw fail('Destination already exists', 409);

  const parent = path.dirname(toAbs);
  await fs.mkdir(parent, { recursive: true });
  await fs.rename(fromAbs, toAbs);
  return relFromAbs(toAbs);
}

export async function deleteEntry(rel) {
  const clean = normalizeRel(rel);
  if (!clean) throw fail('Cannot delete the archive root');
  const abs = resolveSafe(clean);
  if (!(await pathExists(abs))) throw fail('Entry not found', 404);
  await fs.rm(abs, { recursive: true, force: true });
  return clean;
}

export async function readTextFile(rel) {
  const abs = resolveSafe(rel);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw fail('Not a file');
  if (!isAllowedFile(path.basename(abs))) throw fail('Unsupported file type', 415);
  return fs.readFile(abs, 'utf8');
}

export async function fileStat(rel) {
  const abs = resolveSafe(rel);
  const stat = await fs.stat(abs);
  return { abs, stat };
}

// Restores UTF-8 names that multer decodes as latin1.
function decodeName(name) {
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? name : decoded;
  } catch {
    return name;
  }
}

export async function saveUploads(targetRel, files, relativePaths = []) {
  const targetAbs = resolveSafe(targetRel);
  await fs.mkdir(targetAbs, { recursive: true });

  const saved = [];
  const skipped = [];

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const original = decodeName(file.originalname || '');

    // Folder uploads provide a relative path; otherwise fall back to the name.
    const rawRel = (relativePaths[i] || original).replace(/\\/g, '/');
    let parts;
    try {
      parts = normalizeRel(rawRel).split('/').filter(Boolean);
    } catch {
      skipped.push({ name: original, reason: 'invalid path' });
      continue;
    }
    if (!parts.length) parts = [original];

    const fileName = parts.pop();
    if (!isAllowedFile(fileName)) {
      skipped.push({ name: original, reason: 'only .md, .markdown, .html, .htm are allowed' });
      continue;
    }

    const dirAbs = path.join(targetAbs, ...parts.map((p) => assertSafeName(p)));
    await fs.mkdir(dirAbs, { recursive: true });

    const finalName = await uniqueName(dirAbs, assertSafeName(fileName));
    await fs.writeFile(path.join(dirAbs, finalName), file.buffer);
    saved.push(relFromAbs(path.join(dirAbs, finalName)));
  }

  return { saved, skipped };
}
