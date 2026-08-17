const elements = {
  overwrite: document.querySelector('#overwriteCheck'),
  backup: document.querySelector('#backupCheck'),
  outputPath: document.querySelector('#outputPath'),
  browse: document.querySelector('#browseButton'),
  list: document.querySelector('#fileList'),
  empty: document.querySelector('#emptyState'),
  remove: document.querySelector('#removeButton'),
  addFolder: document.querySelector('#addFolderButton'),
  addFiles: document.querySelector('#addFilesButton'),
  go: document.querySelector('#goButton'),
  summary: document.querySelector('#summaryText'),
  progress: document.querySelector('#progressBar'),
  toast: document.querySelector('#toast')
};

let items = [];
const selected = new Set();
let running = false;
let cancelling = false;
let outputDirectory = null;
let toastTimer = null;

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
  elements.outputPath.disabled = overwrite || running;
  elements.browse.disabled = overwrite || running;
  elements.backup.disabled = true;
  elements.addFiles.disabled = running;
  elements.addFolder.disabled = running;
  elements.remove.disabled = running || selected.size === 0;
  elements.go.disabled = cancelling || (!running && (items.length === 0 || (!overwrite && !outputDirectory)));
  elements.go.textContent = cancelling ? 'Stopping…' : running ? 'Cancel' : 'Go!';
}

function statusClass(status) {
  if (status === 'Optimised') return 'good';
  if (status === 'Failed' || status === 'Recovered' || status === 'Invalid PNG') return 'bad';
  if (status === 'Working…') return 'working';
  return 'muted';
}

function renderList() {
  elements.list.querySelectorAll('.file-row').forEach(row => row.remove());
  elements.empty.classList.toggle('hidden', items.length > 0);
  for (const item of items) {
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
    elements.list.appendChild(row);
  }
  const total = items.reduce((sum, item) => sum + item.size, 0);
  elements.summary.textContent = `${items.length.toLocaleString()} file${items.length === 1 ? '' : 's'} · ${formatBytes(total)}`;
  updateControls();
}

function addItems(newItems) {
  const known = new Set(items.map(item => item.path.toLowerCase()));
  let added = 0;
  for (const item of newItems) {
    if (known.has(item.path.toLowerCase())) continue;
    known.add(item.path.toLowerCase());
    items.push({ ...item, outputBytes: null, status: item.valid ? 'Ready' : 'Invalid PNG', error: null });
    added += 1;
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  renderList();
  if (added === 0 && newItems.length) showToast('Those files are already in the list.');
}

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
  renderList();
});

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
  const item = items.find(entry => entry.path === progress.result.path);
  if (item) {
    item.outputBytes = progress.result.outputBytes;
    item.status = progress.result.status;
    item.error = progress.result.error;
  }
  elements.progress.style.width = `${Math.round((progress.current / progress.total) * 100)}%`;
  renderList();
});

renderList();
