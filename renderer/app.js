const elements = {
  overwrite: document.querySelector('#overwriteCheck'),
  backup: document.querySelector('#backupCheck'),
  outputPath: document.querySelector('#outputPath'),
  browse: document.querySelector('#browseButton'),
  list: document.querySelector('#fileList'),
  panel: document.querySelector('.file-panel'),
  empty: document.querySelector('#emptyState'),
  dropOverlay: document.querySelector('#dropOverlay'),
  dropTitle: document.querySelector('#dropTitle'),
  remove: document.querySelector('#removeButton'),
  addFolder: document.querySelector('#addFolderButton'),
  addFiles: document.querySelector('#addFilesButton'),
  go: document.querySelector('#goButton'),
  summary: document.querySelector('#summaryText'),
  progress: document.querySelector('#progressBar'),
  toast: document.querySelector('#toast')
};

let items = [];
const itemsByPath = new Map();
const selected = new Set();
const ROW_HEIGHT = 27;
const ROW_OVERSCAN = 10;
let running = false;
let scanning = false;
let cancelling = false;
let outputDirectory = null;
let toastTimer = null;
let totalInputBytes = 0;
let renderQueued = false;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    value /= 1024;
    unit = next;
    if (value < 1024) break;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', error);
  elements.toast.classList.remove('hidden');
  toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), 6500);
}

function updateControls() {
  const overwrite = elements.overwrite.checked;
  const busy = running || scanning;
  elements.outputPath.disabled = overwrite || busy;
  elements.browse.disabled = overwrite || busy;
  elements.backup.disabled = true;
  elements.addFiles.disabled = busy;
  elements.addFolder.disabled = busy;
  elements.remove.disabled = busy || selected.size === 0;
  elements.go.disabled = scanning || cancelling || (!running && (items.length === 0 || (!overwrite && !outputDirectory)));
  elements.go.textContent = cancelling ? 'Stopping…' : running ? 'Cancel' : 'Go!';
}

function statusClass(status) {
  if (status === 'Optimised') return 'good';
  if (status === 'Failed' || status === 'Recovered' || status === 'Invalid PNG') return 'bad';
  if (status === 'Working…') return 'working';
  return 'muted';
}

function rebuildItemIndex() {
  itemsByPath.clear();
  for (const item of items) itemsByPath.set(item.path.toLowerCase(), item);
}

function createFileRow(item) {
  const row = document.createElement('div');
  row.className = `file-row${selected.has(item.path) ? ' selected' : ''}`;
  row.dataset.path = item.path;
  row.title = item.path;

  const file = document.createElement('span');
  file.textContent = item.path;
  const original = document.createElement('span');
  original.textContent = formatBytes(item.size);
  const optimised = document.createElement('span');
  optimised.textContent = item.outputBytes == null ? '—' : formatBytes(item.outputBytes);
  const status = document.createElement('span');
  status.textContent = item.status || (item.valid ? 'Ready' : 'Invalid PNG');
  status.className = statusClass(status.textContent);
  if (item.error) status.title = item.error;
  row.append(file, original, optimised, status);

  row.addEventListener('click', event => {
    if (running) return;
    if (event.ctrlKey) {
      if (selected.has(item.path)) selected.delete(item.path);
      else selected.add(item.path);
    } else {
      selected.clear();
      selected.add(item.path);
    }
    renderList();
    updateControls();
  });
  return row;
}

function renderVisibleRows() {
  elements.list.querySelectorAll('.file-row, .list-spacer').forEach(row => row.remove());
  if (!items.length) return;
  const viewportHeight = elements.list.clientHeight || 400;
  const start = Math.max(0, Math.floor(elements.list.scrollTop / ROW_HEIGHT) - ROW_OVERSCAN);
  const end = Math.min(items.length, Math.ceil((elements.list.scrollTop + viewportHeight) / ROW_HEIGHT) + ROW_OVERSCAN);
  const topSpacer = document.createElement('div');
  topSpacer.className = 'list-spacer';
  topSpacer.style.height = `${start * ROW_HEIGHT}px`;
  const bottomSpacer = document.createElement('div');
  bottomSpacer.className = 'list-spacer';
  bottomSpacer.style.height = `${(items.length - end) * ROW_HEIGHT}px`;
  elements.list.appendChild(topSpacer);
  for (let index = start; index < end; index += 1) elements.list.appendChild(createFileRow(items[index]));
  elements.list.appendChild(bottomSpacer);
}

function renderList() {
  elements.empty.classList.toggle('hidden', items.length > 0);
  renderVisibleRows();
  elements.summary.textContent = `${items.length.toLocaleString()} file${items.length === 1 ? '' : 's'} · ${formatBytes(totalInputBytes)}`;
  updateControls();
}

function scheduleRenderList() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderList();
  });
}

function addItems(newItems) {
  const known = new Set(items.map(item => item.path.toLowerCase()));
  let added = 0;
  for (const item of newItems) {
    if (known.has(item.path.toLowerCase())) continue;
    known.add(item.path.toLowerCase());
    const addedItem = { ...item, outputBytes: null, status: item.valid ? 'Ready' : 'Invalid PNG', error: null };
    items.push(addedItem);
    itemsByPath.set(addedItem.path.toLowerCase(), addedItem);
    totalInputBytes += addedItem.size;
    added += 1;
  }
  items.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  renderList();
  if (added === 0 && newItems.length) showToast('Those files are already in the list.');
}

function showDropOverlay(title, active = true) {
  elements.dropTitle.textContent = title;
  elements.dropOverlay.classList.toggle('hidden', !active);
  elements.panel.classList.toggle('drag-active', active);
}

let dragDepth = 0;

window.addEventListener('dragenter', event => {
  event.preventDefault();
  if (!event.dataTransfer?.types?.includes('Files') || running || scanning) return;
  dragDepth += 1;
  showDropOverlay('Drop folder or PNG files');
});

window.addEventListener('dragover', event => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = running || scanning ? 'none' : 'copy';
});

window.addEventListener('dragleave', event => {
  event.preventDefault();
  if (dragDepth > 0) dragDepth -= 1;
  if (dragDepth === 0 && !scanning) showDropOverlay('', false);
});

window.addEventListener('drop', async event => {
  event.preventDefault();
  dragDepth = 0;
  if (running || scanning) {
    showDropOverlay('', false);
    showToast('Wait for the current operation to finish before adding more images.', true);
    return;
  }

  const paths = Array.from(event.dataTransfer?.files || [])
    .map(file => {
      try { return window.pngoo.getPathForFile(file); }
      catch { return ''; }
    })
    .filter(Boolean);
  if (!paths.length) {
    showDropOverlay('', false);
    showToast('Windows did not provide a usable folder or file path.', true);
    return;
  }

  scanning = true;
  showDropOverlay('Scanning dropped folder…');
  updateControls();
  try {
    const found = await window.pngoo.describeDroppedPaths(paths);
    addItems(found);
    if (!found.length) showToast('No PNG files were found in the dropped items.');
    else showToast(`Added ${found.length.toLocaleString()} PNG file${found.length === 1 ? '' : 's'}.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    scanning = false;
    showDropOverlay('', false);
    updateControls();
  }
});

elements.addFiles.addEventListener('click', async () => {
  try { addItems(await window.pngoo.pickFiles()); }
  catch (error) { showToast(error.message, true); }
});

elements.addFolder.addEventListener('click', async () => {
  try {
    const found = await window.pngoo.pickFolder();
    addItems(found);
    if (!found.length) showToast('No PNG files were found in that folder.');
  } catch (error) { showToast(error.message, true); }
});

elements.browse.addEventListener('click', async () => {
  const folder = await window.pngoo.pickOutput();
  if (!folder) return;
  outputDirectory = folder;
  elements.outputPath.value = folder;
  updateControls();
});

elements.overwrite.addEventListener('change', updateControls);

elements.remove.addEventListener('click', () => {
  items = items.filter(item => !selected.has(item.path));
  selected.clear();
  rebuildItemIndex();
  totalInputBytes = items.reduce((sum, item) => sum + item.size, 0);
  renderList();
});

elements.list.addEventListener('scroll', scheduleRenderList);

elements.go.addEventListener('click', async () => {
  if (running) {
    cancelling = true;
    updateControls();
    window.pngoo.cancelCompression();
    return;
  }
  if (!items.length) return;

  running = true;
  cancelling = false;
  selected.clear();
  elements.progress.style.width = '0%';
  items = items.map(item => ({ ...item, outputBytes: null, status: item.valid ? 'Queued' : 'Invalid PNG', error: null }));
  rebuildItemIndex();
  renderList();
  updateControls();

  try {
    const result = await window.pngoo.startCompression({
      items: items.map(item => ({ path: item.path, root: item.root })),
      overwrite: elements.overwrite.checked,
      outputDirectory
    });
    elements.progress.style.width = result.cancelled ? `${Math.round((result.completed / result.total) * 100)}%` : '100%';
    const message = result.cancelled
      ? `Stopped safely after ${result.completed.toLocaleString()} files.`
      : `Complete — ${result.compressed.toLocaleString()} optimised, ${result.kept.toLocaleString()} already optimal, ${formatBytes(result.savedBytes)} saved.`;
    showToast(message, result.failed > 0);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    running = false;
    cancelling = false;
    renderList();
    updateControls();
  }
});

window.pngoo.onProgress(progress => {
  const updates = Array.isArray(progress.results) ? progress.results : [progress.result];
  for (const update of updates) {
    const item = itemsByPath.get(update.path.toLowerCase());
    if (!item) continue;
    item.outputBytes = update.outputBytes;
    item.status = update.status;
    item.error = update.error;
  }
  elements.progress.style.width = `${Math.round((progress.current / progress.total) * 100)}%`;
  scheduleRenderList();
});

renderList();
