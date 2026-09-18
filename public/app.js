const state = {
  current: '',
  tree: null,
  entries: [],
  config: null,
};

const el = {
  tree: document.getElementById('tree'),
  listing: document.getElementById('listing'),
  empty: document.getElementById('empty'),
  breadcrumb: document.getElementById('breadcrumb'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  upload: document.getElementById('upload'),
  newFolder: document.getElementById('new-folder'),
  search: document.getElementById('search'),
  viewer: document.getElementById('viewer'),
  viewerBody: document.getElementById('viewer-body'),
  viewerName: document.getElementById('viewer-name'),
  viewerPath: document.getElementById('viewer-path'),
  viewerKind: document.getElementById('viewer-kind'),
  viewerRaw: document.getElementById('viewer-raw'),
  viewerClose: document.getElementById('viewer-close'),
  toast: document.getElementById('toast'),
};

function toast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('error', isError);
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const type = res.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((body && body.error) || body || `Request failed (${res.status})`);
  return body;
}

// Builds a URL on the isolated preview origin so HTML scripts may run.
// Returns null when the origin is unknown; never a relative URL, which would
// silently hit the app origin and produce a confusing "Cannot GET" error.
function previewUrl(relPath) {
  const base = state.config?.previewOrigin;
  if (!base) return null;
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  return `${base}/${encoded}`;
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function icon(entry) {
  if (entry.type === 'dir') return '📁';
  return entry.kind === 'markdown' ? '📝' : '🌐';
}

// ---------- Tree ----------
function renderTree() {
  el.tree.innerHTML = '';
  if (!state.tree) return;
  el.tree.appendChild(treeFolder(state.tree, true));
}

function treeFolder(node, isRoot) {
  const wrap = document.createElement('div');
  const item = document.createElement('div');
  item.className = 'tree-item';
  if (state.current === node.path) item.classList.add('active');
  item.innerHTML = `<span class="tree-caret">${node.children.length ? '▾' : ''}</span>
    <span>${isRoot ? '🏛️' : '📁'}</span>
    <span class="tree-name"></span>
    <span class="count">${node.fileCount}</span>`;
  item.querySelector('.tree-name').textContent = isRoot ? 'Archive' : node.name;
  item.addEventListener('click', () => load(node.path));
  wrap.appendChild(item);

  if (node.children.length) {
    const kids = document.createElement('div');
    kids.className = 'tree-children';
    for (const child of node.children) kids.appendChild(treeFolder(child, false));
    wrap.appendChild(kids);
  }
  return wrap;
}

// ---------- Breadcrumb ----------
function renderBreadcrumb() {
  el.breadcrumb.innerHTML = '';
  const parts = state.current ? state.current.split('/') : [];

  const root = document.createElement('button');
  root.textContent = 'Archive';
  root.addEventListener('click', () => load(''));
  el.breadcrumb.appendChild(root);

  parts.forEach((part, i) => {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    el.breadcrumb.appendChild(sep);

    const btn = document.createElement('button');
    btn.textContent = part;
    btn.addEventListener('click', () => load(parts.slice(0, i + 1).join('/')));
    el.breadcrumb.appendChild(btn);
  });
}

// ---------- Listing ----------
function renderListing() {
  const query = el.search.value.trim().toLowerCase();
  el.listing.innerHTML = '';
  const visible = state.entries.filter((e) => e.name.toLowerCase().includes(query));

  if (!visible.length) {
    el.empty.hidden = false;
    el.empty.textContent = query
      ? 'Tidak ada yang cocok dengan pencarian.'
      : 'Belum ada file di folder ini.';
    return;
  }
  el.empty.hidden = true;

  for (const entry of visible) {
    const row = document.createElement('div');
    row.className = 'row';
    row.draggable = true;
    row.dataset.path = entry.path;

    const iconCell = document.createElement('span');
    iconCell.className = 'icon';
    iconCell.textContent = icon(entry);

    const nameCell = document.createElement('span');
    nameCell.className = 'name';
    nameCell.textContent = entry.name;
    if (entry.type === 'dir') {
      nameCell.addEventListener('click', () => load(entry.path));
    } else {
      nameCell.addEventListener('click', () => openViewer(entry));
    }

    const typeCell = document.createElement('span');
    typeCell.className = 'meta';
    typeCell.textContent = entry.type === 'dir'
      ? 'Folder'
      : formatSize(entry.size);

    const dateCell = document.createElement('span');
    dateCell.className = 'meta';
    dateCell.textContent = formatDate(entry.mtime);

    const btns = document.createElement('div');
    btns.className = 'btns';

    if (entry.type === 'file') {
      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-ghost';
      openBtn.textContent = 'Buka';
      openBtn.addEventListener('click', () => openViewer(entry));
      btns.appendChild(openBtn);
    }

    const moveBtn = document.createElement('button');
    moveBtn.className = 'btn btn-ghost';
    moveBtn.textContent = 'Pindah';
    moveBtn.addEventListener('click', () => moveEntry(entry));
    btns.appendChild(moveBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger';
    delBtn.textContent = 'Hapus';
    delBtn.addEventListener('click', () => removeEntry(entry));
    btns.appendChild(delBtn);

    row.append(iconCell, nameCell, typeCell, dateCell, btns);

    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', entry.path);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));

    el.listing.appendChild(row);
  }
}

// ---------- Actions ----------
async function refresh() {
  const [tree, listing] = await Promise.all([
    api('/api/tree'),
    api(`/api/entries?path=${encodeURIComponent(state.current)}`),
  ]);
  state.tree = tree;
  state.entries = listing.entries;
  renderTree();
  renderBreadcrumb();
  renderListing();
}

async function load(path) {
  state.current = path || '';
  closeViewer();
  await refresh();
}

async function createFolderAction() {
  const name = prompt('Nama folder baru:');
  if (!name) return;
  try {
    await api('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: state.current, name }),
    });
    toast('Folder dibuat.');
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

async function moveEntry(entry) {
  const to = prompt(`Pindahkan "${entry.name}" ke folder tujuan (path relatif, kosongkan untuk root):`, '');
  if (to === null) return;
  const cleanTo = to.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  const dest = cleanTo ? `${cleanTo}/${entry.name}` : entry.name;
  try {
    await api('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: entry.path, to: dest }),
    });
    toast('Berhasil dipindahkan.');
    if (state.current === entry.path) state.current = '';
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

async function removeEntry(entry) {
  const label = entry.type === 'dir' ? `folder "${entry.name}" beserta isinya` : `"${entry.name}"`;
  if (!confirm(`Hapus ${label}?`)) return;
  try {
    await api('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: entry.path }),
    });
    toast('Dihapus.');
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

async function uploadFiles(fileList, relativePaths = []) {
  const files = Array.from(fileList);
  if (!files.length) return;

  const form = new FormData();
  form.append('target', state.current);
  for (const file of files) form.append('files', file);
  for (let i = 0; i < files.length; i += 1) {
    form.append('paths', relativePaths[i] || files[i].name);
  }

  try {
    const result = await api('/api/upload', { method: 'POST', body: form });
    const skipped = result.skipped?.length || 0;
    toast(`${result.saved.length} file diunggah${skipped ? `, ${skipped} dilewati` : ''}.`, Boolean(skipped && !result.saved.length));
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- Viewer ----------
function openViewer(entry) {
  el.viewer.hidden = false;
  el.viewerKind.className = `badge ${entry.kind === 'markdown' ? 'md' : 'html'}`;
  el.viewerKind.textContent = entry.kind === 'markdown' ? 'Markdown' : 'HTML';
  el.viewerName.textContent = entry.name;
  el.viewerPath.textContent = entry.path;
  el.viewerRaw.href = previewUrl(entry.path) || '#';
  el.viewerBody.innerHTML = '<p class="empty">Memuat…</p>';

  if (!state.config?.previewOrigin) {
    el.viewerBody.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Origin preview tidak diketahui (gagal memuat /api/config). Muat ulang halaman; jika berulang, periksa PREVIEW_URL.';
    el.viewerBody.appendChild(p);
    return;
  }

  api(`/api/file?path=${encodeURIComponent(entry.path)}`)
    .then((data) => {
      if (data.kind === 'markdown') {
        el.viewerBody.innerHTML = '';
        const article = document.createElement('article');
        article.className = 'markdown-body';
        article.innerHTML = data.html;
        el.viewerBody.appendChild(article);
        if (data.truncated) toast('File besar: hanya sebagian ditampilkan.', true);
      } else {
        // HTML runs on a separate origin, so scripts work while the archive
        // API of the main app stays out of reach (cross-origin blocked).
        el.viewerBody.innerHTML = '';
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms allow-modals allow-downloads');
        frame.src = previewUrl(entry.path);
        el.viewerBody.appendChild(frame);
        if (data.truncated) toast('File besar: preview diambil dari file asli.', true);
      }
    })
    .catch((err) => {
      el.viewerBody.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = err.message;
      el.viewerBody.appendChild(p);
    });
}

function closeViewer() {
  el.viewer.hidden = true;
  el.viewerBody.innerHTML = '';
}

// ---------- Events ----------
el.upload.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  uploadFiles(el.fileInput.files);
  el.fileInput.value = '';
});
el.newFolder.addEventListener('click', createFolderAction);
el.search.addEventListener('input', renderListing);
el.viewerClose.addEventListener('click', closeViewer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.viewer.hidden) closeViewer();
});

const dropzone = el.dropzone;
['dragenter', 'dragover'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag');
  }));
['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, () => dropzone.classList.remove('drag')));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadFiles(e.dataTransfer.files);
});
dropzone.addEventListener('click', () => el.fileInput.click());

// Allow dropping onto a folder row to move a file inside it.
el.listing.addEventListener('dragover', (e) => {
  const row = e.target.closest('.row');
  if (row && row.dataset.path) e.preventDefault();
});
el.listing.addEventListener('drop', async (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  const from = e.dataTransfer.getData('text/plain');
  if (!from || from === row.dataset.path) return;
  const name = from.split('/').pop();
  try {
    await api('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: `${row.dataset.path}/${name}` }),
    });
    toast('Berhasil dipindahkan.');
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
});

async function boot() {
  try {
    state.config = await fetch('/api/config', { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`config ${r.status}`);
      return r.json();
    });
  } catch (err) {
    // Preview falls back to <host>:<port+1>; surface why if that is wrong.
    state.config = null;
    toast(`Gagal memuat /api/config: ${err.message}`, true);
  }
  await load('');
}

boot();
