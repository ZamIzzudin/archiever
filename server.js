import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';

import { renderMarkdown } from './src/render.js';
import {
  STORAGE_ROOT,
  initStorage,
  listDir,
  buildTree,
  createFolder,
  moveEntry,
  deleteEntry,
  readTextFile,
  resolveSafe,
  saveUploads,
  kindOf,
  isAllowedFile,
} from './src/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
// Preview content is served from a separate origin so uploaded HTML can run
// scripts without ever sharing an origin with the archive API.
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT || PORT + 1);
// Public URLs behind a reverse proxy, e.g. https://archive.example.com and
// https://archive.example.com:3001. When unset they are derived from the request.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const PREVIEW_URL = (process.env.PREVIEW_URL || '').replace(/\/+$/, '');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 200 },
});

const MAX_PREVIEW = 2 * 1024 * 1024;

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// Host as seen by the client, honoring the reverse proxy's forwarded header.
function externalHost(req) {
  return req.get('x-forwarded-host') || req.get('host') || req.hostname;
}

function appOrigin(req) {
  if (PUBLIC_URL) return new URL(PUBLIC_URL).origin;
  return new URL(`${req.protocol}://${externalHost(req)}`).origin;
}

// Shared handler: resolves a storage-relative path and streams the file.
// Used by both the app (/raw/...) and the isolated preview origin (/,...).
function serveRaw(req, res, next) {
  let rel;
  try {
    rel = decodeURIComponent(req.path.replace(/^\/+/, ''));
  } catch {
    return res.status(400).end('Bad path');
  }
  if (!isAllowedFile(path.basename(rel))) return res.status(404).end('Not found');

  let abs;
  try {
    abs = resolveSafe(rel);
  } catch {
    return res.status(403).end('Forbidden');
  }

  res.sendFile(abs, { dotfiles: 'deny' }, (err) => {
    if (!err) return;
    if (res.headersSent) return next(err);
    res.status(err.status || 404).end('Not found');
  });
}

// ---------- App (management UI + API) ----------
const app = express();
app.disable('x-powered-by');
// Trust X-Forwarded-* from the reverse proxy so req.protocol/host stay correct.
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

// Uploaded HTML runs on the preview origin and must not be able to mutate the
// archive. Cookies aren't used, so this checks that state-changing requests come
// from the app's own origin (headerless clients like curl stay allowed).
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let expected;
  try {
    expected = appOrigin(req);
  } catch {
    return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  if (origin !== expected) return res.status(403).json({ error: 'Cross-origin request blocked' });
  next();
});

app.get('/api/config', (req, res) => {
  const derived = `${req.protocol}://${req.hostname}:${PREVIEW_PORT}`;
  res.json({
    extensions: ['.md', '.markdown', '.html', '.htm'],
    maxPreviewBytes: MAX_PREVIEW,
    previewOrigin: PREVIEW_URL || derived,
  });
});

app.get('/api/tree', wrap(async (req, res) => {
  res.json(await buildTree(''));
}));

app.get('/api/entries', wrap(async (req, res) => {
  res.json(await listDir(req.query.path || ''));
}));

app.get('/api/file', wrap(async (req, res) => {
  const rel = req.query.path || '';
  const name = path.basename(String(rel).replace(/\\/g, '/'));
  const kind = kindOf(name);
  if (!kind) return res.status(415).json({ error: 'Unsupported file type' });
  const content = await readTextFile(rel);
  const truncated = Buffer.byteLength(content, 'utf8') > MAX_PREVIEW;
  const body = truncated ? content.slice(0, MAX_PREVIEW) : content;
  res.json({
    path: String(rel),
    name,
    kind,
    truncated,
    raw: kind === 'markdown' ? null : body,
    html: kind === 'markdown' ? renderMarkdown(body) : null,
  });
}));

app.post('/api/folders', wrap(async (req, res) => {
  const { parent = '', name } = req.body || {};
  const created = await createFolder(parent, name);
  res.status(201).json({ path: created });
}));

app.post('/api/upload', upload.array('files'), wrap(async (req, res) => {
  const target = req.body?.target || '';
  const paths = asArray(req.body?.paths);
  if (!req.files?.length) return res.status(400).json({ error: 'No files received' });
  const result = await saveUploads(target, req.files, paths);
  res.status(201).json(result);
}));

app.post('/api/move', wrap(async (req, res) => {
  const { from, to } = req.body || {};
  const moved = await moveEntry(from, to);
  res.json({ path: moved });
}));

app.post('/api/delete', wrap(async (req, res) => {
  const removed = await deleteEntry(req.body?.path);
  res.json({ path: removed });
}));

app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || (err instanceof multer.MulterError ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// ---------- Preview origin ----------
// Serves archive files at the root so relative assets resolve, letting scripts
// in uploaded HTML run. No API, no management UI lives here.
const previewApp = express();
previewApp.disable('x-powered-by');
previewApp.use(wrap(serveRaw));
previewApp.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).end('Preview error');
});

// Startup diagnostics: makes misconfigured env obvious in the logs.
console.log('--- archiever config ---');
console.log(`cwd:           ${process.cwd()}`);
console.log(`uid/gid:       ${process.getuid?.() ?? 'n/a'}/${process.getgid?.() ?? 'n/a'}`);
console.log(`STORAGE_DIR:   ${process.env.STORAGE_DIR ?? '(unset, defaults to ./storage)'}`);
console.log(`resolved:      ${STORAGE_ROOT}`);
console.log(`PORT:          ${PORT}`);
console.log(`PREVIEW_PORT:  ${PREVIEW_PORT}`);
console.log(`PUBLIC_URL:    ${PUBLIC_URL || '(derived from request)'}`);
console.log(`PREVIEW_URL:   ${PREVIEW_URL || '(derived from request)'}`);
console.log('------------------------');

await initStorage();
console.log(`Archive storage: ${STORAGE_ROOT}`);

app.listen(PORT, () => {
  console.log(`Archiever running at http://localhost:${PORT}`);
});

previewApp.listen(PREVIEW_PORT, () => {
  console.log(`Preview origin at http://localhost:${PREVIEW_PORT}`);
});
