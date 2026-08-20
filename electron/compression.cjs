const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BATCH_MODE_MINIMUM = 32;
const MAXIMUM_BATCH_FILES = 256;
const MAXIMUM_BATCH_CHARACTERS = 24000;
const MAXIMUM_STAGED_BYTES = 256 * 1024 * 1024;

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listPngFiles(root) {
  const results = [];

  async function visit(folder) {
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.includes(' - PNGoo Backup ') && !entry.name.startsWith('.pngoo-batch-')) await visit(fullPath);
      } else if (
        entry.isFile() &&
        path.extname(entry.name).toLowerCase() === '.png' &&
        !entry.name.toLowerCase().includes('.pngoo-temp-') &&
        !entry.name.toLowerCase().includes('.pngoo-swap-')
      ) {
        results.push(fullPath);
      }
    }
  }

  await visit(root);
  return results;
}

async function readPngMetadata(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 24 || !header.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    if (header.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

async function describeFiles(files, root) {
  const unique = [...new Set(files.map(file => path.resolve(file)))];
  const items = new Array(unique.length);
  const concurrency = Math.min(32, Math.max(4, (os.availableParallelism?.() || os.cpus().length || 1) * 2));
  await mapWithConcurrency(unique, concurrency, async (file, index) => {
    try {
      const [stat, metadata] = await Promise.all([fsp.stat(file), readPngMetadata(file)]);
      if (!stat.isFile()) return;
      items[index] = {
        id: crypto.createHash('sha1').update(file.toLowerCase()).digest('hex'),
        path: file,
        root: path.resolve(root || path.dirname(file)),
        name: path.basename(file),
        size: stat.size,
        valid: Boolean(metadata),
        width: metadata?.width || null,
        height: metadata?.height || null
      };
    } catch {
      // A file may disappear while a large folder is being scanned.
    }
  });
  return items.filter(Boolean);
}

async function describePaths(droppedPaths) {
  const results = [];
  const seen = new Set();
  for (const droppedPath of droppedPaths) {
    if (typeof droppedPath !== 'string' || !droppedPath.trim()) continue;
    const resolved = path.resolve(droppedPath);
    let stat;
    try {
      stat = await fsp.stat(resolved);
    } catch {
      continue;
    }

    let described = [];
    if (stat.isDirectory()) {
      described = await describeFiles(await listPngFiles(resolved), resolved);
    } else if (stat.isFile() && path.extname(resolved).toLowerCase() === '.png') {
      described = await describeFiles([resolved], path.dirname(resolved));
    }

    for (const item of described) {
      const key = item.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(item);
    }
  }
  return results;
}

function runEngine(enginePath, args, state) {
  return new Promise((resolve, reject) => {
    const child = spawn(enginePath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (!(state.children instanceof Set)) state.children = new Set();
    state.children.add(child);
    state.child = child;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const cleanup = () => {
      state.children.delete(child);
      if (state.child === child) state.child = null;
    };
    child.on('error', error => {
      cleanup();
      reject(error);
    });
    child.on('close', code => {
      cleanup();
      resolve({ code, stdout, stderr, output: `${stdout} ${stderr}`.trim() });
    });
  });
}

function createCompressionPlan(itemCount, logicalProcessors = os.availableParallelism?.() || os.cpus().length || 1) {
  const processors = Math.max(1, Math.floor(logicalProcessors));
  const workers = Math.max(1, Math.min(itemCount, 4, Math.floor(processors / 4) || 1));
  return {
    workers,
    threadsPerWorker: Math.max(1, Math.floor(processors / workers))
  };
}

function cancelActiveEngines(state) {
  state.cancelled = true;
  const children = new Set(state.children instanceof Set ? state.children : []);
  if (state.child) children.add(state.child);
  for (const child of children) {
    if (child && !child.killed) child.kill();
  }
}

function timestamp() {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
    + '-'
    + [String(now.getHours()).padStart(2, '0'), String(now.getMinutes()).padStart(2, '0'), String(now.getSeconds()).padStart(2, '0')].join('-');
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function uniqueRecoveryPath(original) {
  const parsed = path.parse(original);
  const base = path.join(parsed.dir, `${parsed.name}.PNGoo-Recovery-${timestamp()}`);
  let candidate = `${base}${parsed.ext}`;
  let index = 2;
  while (await exists(candidate)) {
    candidate = `${base}-${index}${parsed.ext}`;
    index += 1;
  }
  return candidate;
}

async function replaceSafely(original, output, token, originalStat, expected, originalHash) {
  const rollback = `${original}.pngoo-rollback-${token}`;
  let originalMoved = false;
  let corruptionDetected = false;
  try {
    await fsp.rename(original, rollback);
    originalMoved = true;
    await fsp.rename(output, original);
    if (!expected.fast) await fsp.utimes(original, originalStat.atime, originalStat.mtime);
    const [installedStat, installedMetadata, installedHash] = await Promise.all([
      fsp.stat(original),
      expected.fast ? Promise.resolve({ width: expected.width, height: expected.height }) : readPngMetadata(original),
      expected.hash ? sha256File(original) : Promise.resolve(null)
    ]);
    if (
      installedStat.size !== expected.size ||
      !installedMetadata ||
      installedMetadata.width !== expected.width ||
      installedMetadata.height !== expected.height ||
      (expected.ino && installedStat.ino && installedStat.ino !== expected.ino) ||
      (expected.hash && installedHash !== expected.hash)
    ) {
      corruptionDetected = true;
      throw new Error('Post-write verification detected a corrupted compressed file.');
    }
    await fsp.unlink(rollback);
  } catch (error) {
    let recoveryPath = null;
    let restored = false;
    let restoreError = null;
    let recoveryCopyError = null;
    if (originalMoved && await exists(rollback)) {
      let rollbackHash = originalHash;
      if (!rollbackHash) rollbackHash = await sha256File(rollback).catch(() => null);
      if (corruptionDetected) {
        try {
          const candidate = await uniqueRecoveryPath(original);
          await fsp.copyFile(rollback, candidate, fs.constants.COPYFILE_EXCL);
          recoveryPath = candidate;
          await fsp.utimes(recoveryPath, originalStat.atime, originalStat.mtime).catch(() => {});
        } catch (copyError) {
          recoveryCopyError = copyError;
        }
      }
      try {
        if (await exists(original)) await fsp.unlink(original);
        await fsp.rename(rollback, original);
        if (rollbackHash && await sha256File(original) !== rollbackHash) {
          throw new Error('The restored original did not match its pre-compression hash.');
        }
        if ((await fsp.stat(original)).size !== originalStat.size) throw new Error('The restored original size did not match.');
        restored = true;
      } catch (recoveryError) {
        restoreError = recoveryError;
      }
    }
    const message = restored && recoveryPath
      ? `${error.message} The original was restored, and a recovery copy was kept at: ${recoveryPath}`
      : restored && recoveryCopyError
        ? `${error.message} The original was restored, but a recovery copy could not be kept: ${recoveryCopyError.message}`
        : restored
          ? `${error.message} The original was restored; no backup was retained.`
      : restoreError
        ? `${error.message} Automatic restoration failed: ${restoreError.message}${recoveryPath ? ` Recovery copy: ${recoveryPath}` : ''}`
        : error.message;
    const wrapped = new Error(message);
    wrapped.recoveryPath = recoveryPath;
    throw wrapped;
  }
}

async function uniqueOutputPath(outputDirectory, root, file, claimed) {
  const rootLabel = path.basename(path.resolve(root)) || path.parse(path.resolve(root)).root.replace(/[:\\/]/g, '');
  let relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) relative = path.basename(file);
  const desired = path.join(outputDirectory, rootLabel, relative);
  const parsed = path.parse(desired);
  let candidate = desired;
  let index = 2;
  while (true) {
    const key = candidate.toLowerCase();
    if (!claimed.has(key)) {
      claimed.add(key);
      if (!(await exists(candidate))) return candidate;
      claimed.delete(key);
    }
    candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
  }
}

async function mapWithConcurrency(items, concurrency, callback) {
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await callback(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

function createStagingBatches(
  tasks,
  maximumCharacters = MAXIMUM_BATCH_CHARACTERS,
  maximumFiles = MAXIMUM_BATCH_FILES,
  maximumBytes = MAXIMUM_STAGED_BYTES
) {
  const batches = [];
  let current = [];
  let characters = 0;
  let bytes = 0;
  for (const task of tasks) {
    const cost = task.tempPath.length + 3;
    const size = task.originalStat?.size || 0;
    if (
      current.length &&
      (current.length >= maximumFiles || characters + cost > maximumCharacters || bytes + size > maximumBytes)
    ) {
      batches.push(current);
      current = [];
      characters = 0;
      bytes = 0;
    }
    current.push(task);
    characters += cost;
    bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

function parseBatchResults(stdout) {
  const parsed = JSON.parse(stdout.trim());
  const entries = Array.isArray(parsed.results) ? parsed.results : [];
  return new Map(entries.map(entry => [path.resolve(entry.input).toLowerCase(), entry]));
}

function stagingParent(task, overwrite, outputDirectory) {
  if (!overwrite) return outputDirectory;
  const root = path.resolve(task.item.root);
  return path.parse(root).root.toLowerCase() === path.parse(task.item.path).root.toLowerCase()
    ? root
    : path.dirname(task.item.path);
}

async function createBatchDirectory(parent, token) {
  await fsp.mkdir(parent, { recursive: true });
  let index = 1;
  while (true) {
    const suffix = index === 1 ? '' : `-${index}`;
    const candidate = path.join(parent, `.pngoo-batch-${token}${suffix}`);
    try {
      await fsp.mkdir(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      index += 1;
    }
  }
}

async function compressFilesBatched(options) {
  const {
    items,
    overwrite,
    outputDirectory,
    enginePath,
    state,
    onProgress
  } = options;
  const processors = Math.max(1, os.availableParallelism?.() || os.cpus().length || 1);
  const preparationConcurrency = Math.min(32, processors * 2);
  const verificationConcurrency = Math.min(16, processors);
  const claimedOutputs = new Set();
  const results = new Array(items.length);
  const recoveryFiles = [];
  const pendingUpdates = [];
  let completed = 0;
  let beforeBytes = 0;
  let afterBytes = 0;
  let compressed = 0;
  let kept = 0;
  let failed = 0;
  let savedBytes = 0;
  let engineRuns = 0;

  function record(task, values) {
    const result = {
      path: task.item.path,
      originalBytes: task.originalStat?.size || 0,
      outputBytes: values.outputBytes ?? null,
      status: values.status,
      error: values.error || null,
      recoveryPath: values.recoveryPath || null,
      destination: values.status === 'Optimised' ? task.destination : null
    };
    results[task.index] = result;
    pendingUpdates.push(result);
    completed += 1;
    return result;
  }

  function recordFailure(task, error) {
    const recoveryPath = error?.recoveryPath || null;
    failed += 1;
    if (task.originalStat) afterBytes += task.originalStat.size;
    if (recoveryPath) recoveryFiles.push(recoveryPath);
    record(task, {
      status: recoveryPath ? 'Recovered' : 'Failed',
      error: error?.message || String(error),
      recoveryPath
    });
  }

  function flushProgress() {
    if (!pendingUpdates.length) return;
    const batchResults = pendingUpdates.splice(0, pendingUpdates.length);
    onProgress({
      current: completed,
      total: items.length,
      compressed,
      kept,
      failed,
      savedBytes,
      result: batchResults[batchResults.length - 1],
      results: batchResults
    });
  }

  async function prepare(index) {
    const item = items[index];
    const task = { index, item, originalStat: null, destination: item.path, tempPath: null };
    try {
      const [originalStat, inputMetadata] = await Promise.all([
        fsp.stat(item.path),
        readPngMetadata(item.path)
      ]);
      task.originalStat = originalStat;
      task.inputMetadata = inputMetadata;
      beforeBytes += originalStat.size;
      if (!originalStat.isFile() || !inputMetadata) throw new Error('File contents are not valid PNG data.');
      if (!overwrite) task.destination = await uniqueOutputPath(outputDirectory, item.root, item.path, claimedOutputs);
      await fsp.mkdir(path.dirname(task.destination), { recursive: true });
      return task;
    } catch (error) {
      recordFailure(task, error);
      return null;
    }
  }

  async function finalize(task, engineEntry) {
    if (state.cancelled) {
      if (await exists(task.tempPath)) await fsp.unlink(task.tempPath).catch(() => {});
      return;
    }
    if (!engineEntry || engineEntry.status !== 'success') {
      if (await exists(task.tempPath)) await fsp.unlink(task.tempPath).catch(() => {});
      const detail = engineEntry?.error || engineEntry?.message || 'The batch engine did not return a successful result for this file.';
      recordFailure(task, new Error(detail));
      return;
    }

    try {
      const [outputStat, outputMetadata] = await Promise.all([
        fsp.stat(task.tempPath),
        readPngMetadata(task.tempPath)
      ]);
      if (
        !outputMetadata ||
        outputMetadata.width !== task.inputMetadata.width ||
        outputMetadata.height !== task.inputMetadata.height
      ) {
        throw new Error('The lossless engine produced an invalid image or changed its dimensions.');
      }
      if (outputStat.size >= task.originalStat.size) {
        await fsp.unlink(task.tempPath);
        kept += 1;
        afterBytes += task.originalStat.size;
        record(task, { status: 'Already optimised' });
        return;
      }

      if (state.cancelled) {
        await fsp.unlink(task.tempPath).catch(() => {});
        return;
      }
      if (overwrite) {
        await replaceSafely(task.item.path, task.tempPath, `${process.pid}-${Date.now()}-${task.index}`, task.originalStat, {
          size: outputStat.size,
          width: outputMetadata.width,
          height: outputMetadata.height,
          ino: outputStat.ino,
          fast: true
        }, null);
      } else {
        await fsp.rename(task.tempPath, task.destination);
        const installedStat = await fsp.stat(task.destination);
        if (
          installedStat.size !== outputStat.size ||
          (outputStat.ino && installedStat.ino && installedStat.ino !== outputStat.ino)
        ) {
          await fsp.unlink(task.destination).catch(() => {});
          throw new Error('Post-write verification detected a corrupted output file. The source was not changed.');
        }
      }
      compressed += 1;
      afterBytes += outputStat.size;
      savedBytes += task.originalStat.size - outputStat.size;
      record(task, { status: 'Optimised', outputBytes: outputStat.size });
    } catch (error) {
      if (task.tempPath && await exists(task.tempPath)) await fsp.unlink(task.tempPath).catch(() => {});
      recordFailure(task, error);
    }
  }

  for (let start = 0; start < items.length && !state.cancelled; start += MAXIMUM_BATCH_FILES) {
    const indices = Array.from(
      { length: Math.min(MAXIMUM_BATCH_FILES, items.length - start) },
      (_, offset) => start + offset
    );
    const prepared = new Array(indices.length);
    await mapWithConcurrency(indices, preparationConcurrency, async (index, position) => {
      prepared[position] = await prepare(index);
    });

    const preparedTasks = prepared.filter(Boolean);
    const groups = new Map();
    for (const task of preparedTasks) {
      const parent = stagingParent(task, overwrite, outputDirectory);
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(task);
    }
    if (!groups.size) flushProgress();

    let groupIndex = 0;
    for (const [parent, group] of groups) {
      if (state.cancelled) break;
      const token = `${process.pid.toString(36)}-${Date.now().toString(36)}-${start.toString(36)}-${groupIndex.toString(36)}`;
      groupIndex += 1;
      const batchDirectory = await createBatchDirectory(parent, token);
      for (const task of group) task.tempPath = path.join(batchDirectory, `${task.index.toString(36)}.png`);
      const stagingBatches = createStagingBatches(group);
      try {
        for (const batch of stagingBatches) {
          if (state.cancelled) break;
          await mapWithConcurrency(batch, preparationConcurrency, async task => {
            try {
              await fsp.copyFile(task.item.path, task.tempPath, fs.constants.COPYFILE_EXCL);
              task.copied = true;
            } catch (error) {
              await fsp.unlink(task.tempPath).catch(() => {});
              recordFailure(task, error);
            }
          });
          const active = batch.filter(task => task.copied);
          if (!active.length) {
            flushProgress();
            continue;
          }

          const engineResult = await runEngine(
            enginePath,
            ['-o', '4', '--threads', String(processors), '--preserve', '--nx', '--json', '--', ...active.map(task => task.tempPath)],
            state
          );
          engineRuns += 1;
          if (state.cancelled) {
            await mapWithConcurrency(active, preparationConcurrency, task => fsp.unlink(task.tempPath).catch(() => {}));
            break;
          }

          let engineEntries;
          try {
            engineEntries = parseBatchResults(engineResult.stdout);
          } catch (error) {
            engineEntries = new Map();
            for (const task of active) task.batchError = new Error(
              `The batch engine returned unreadable results${engineResult.output ? `: ${engineResult.output}` : '.'}`
            );
          }
          await mapWithConcurrency(active, verificationConcurrency, async task => {
            if (task.batchError) {
              await fsp.unlink(task.tempPath).catch(() => {});
              recordFailure(task, task.batchError);
              return;
            }
            await finalize(task, engineEntries.get(path.resolve(task.tempPath).toLowerCase()));
          });
          flushProgress();
        }
      } finally {
        await fsp.rm(batchDirectory, { recursive: true, force: true });
      }
    }
  }

  flushProgress();
  const completedResults = results.filter(Boolean);
  return {
    cancelled: state.cancelled,
    total: items.length,
    completed: completedResults.length,
    compressed,
    kept,
    failed,
    savedBytes,
    beforeBytes,
    afterBytes,
    reductionPercent: beforeBytes > 0 ? Math.round((savedBytes / beforeBytes) * 10000) / 100 : 0,
    recoveryFiles,
    outputDirectory,
    mode: 'batched',
    workers: 1,
    threadsPerWorker: processors,
    engineRuns,
    results: completedResults
  };
}

async function compressFiles(options, enginePath, state, onProgress) {
  const rawItems = Array.isArray(options.items) ? options.items : [];
  const seen = new Set();
  const items = rawItems
    .map(item => ({ path: path.resolve(item.path), root: path.resolve(item.root || path.dirname(item.path)) }))
    .filter(item => {
      const key = item.path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (items.length === 0) throw new Error('Add at least one PNG file first.');

  const overwrite = options.overwrite === true;
  const outputDirectory = overwrite ? null : path.resolve(options.outputDirectory || '');
  if (!overwrite && !options.outputDirectory) throw new Error('Choose an output directory first.');
  if (outputDirectory) await fsp.mkdir(outputDirectory, { recursive: true });
  if (items.length >= BATCH_MODE_MINIMUM) {
    return compressFilesBatched({ items, overwrite, outputDirectory, enginePath, state, onProgress });
  }

  const plan = createCompressionPlan(items.length);
  const claimedOutputs = new Set();
  const results = new Array(items.length);
  const recoveryFiles = [];
  let nextIndex = 0;
  let completed = 0;
  let beforeBytes = 0;
  let afterBytes = 0;
  let compressed = 0;
  let kept = 0;
  let failed = 0;
  let savedBytes = 0;

  async function processItem(index) {
    if (state.cancelled) return;
    const item = items[index];
    let originalStat;
    let tempPath = null;
    let destination = item.path;
    let status = 'Optimised';
    let outputBytes = null;
    let errorMessage = null;
    let recoveryPath = null;

    try {
      originalStat = await fsp.stat(item.path);
      beforeBytes += originalStat.size;
      const [originalHash, inputMetadata] = await Promise.all([
        sha256File(item.path),
        readPngMetadata(item.path)
      ]);
      if (!inputMetadata) throw new Error('File contents are not valid PNG data.');

      if (!overwrite) {
        destination = await uniqueOutputPath(outputDirectory, item.root, item.path, claimedOutputs);
      }
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      const token = `${process.pid}-${Date.now()}-${index}`;
      tempPath = path.join(path.dirname(destination), `${path.basename(destination, path.extname(destination))}.pngoo-temp-${token}.png`);
      if (state.cancelled) return;

      // Strict lossless mode: recompress only. No colour, palette, bit-depth,
      // alpha, interlace, or metadata-stripping transformations are enabled.
      const engineResult = await runEngine(
        enginePath,
        ['-o', '4', '--threads', String(plan.threadsPerWorker), '--preserve', '--nx', '--quiet', '--out', tempPath, '--', item.path],
        state
      );
      if (state.cancelled) {
        if (await exists(tempPath)) await fsp.unlink(tempPath);
        return;
      }
      if (engineResult.code !== 0) {
        throw new Error(`Lossless engine returned code ${engineResult.code}${engineResult.output ? `: ${engineResult.output}` : ''}`);
      }
      if (!(await exists(tempPath))) {
        kept += 1;
        afterBytes += originalStat.size;
        status = 'Already optimised';
      } else {
        const [outputStat, outputMetadata, outputHash] = await Promise.all([
          fsp.stat(tempPath),
          readPngMetadata(tempPath),
          sha256File(tempPath)
        ]);
        if (!outputMetadata || outputMetadata.width !== inputMetadata.width || outputMetadata.height !== inputMetadata.height) {
          throw new Error('The lossless engine produced an invalid image or changed its dimensions.');
        }
        if (outputStat.size >= originalStat.size) {
          await fsp.unlink(tempPath);
          kept += 1;
          afterBytes += originalStat.size;
          status = 'Already optimised';
        } else {
          if (overwrite) {
            await replaceSafely(item.path, tempPath, token, originalStat, {
              size: outputStat.size,
              width: outputMetadata.width,
              height: outputMetadata.height,
              hash: outputHash
            }, originalHash);
          } else {
            await fsp.rename(tempPath, destination);
            const installedHash = await sha256File(destination);
            if (installedHash !== outputHash) {
              await fsp.unlink(destination).catch(() => {});
              throw new Error('Post-write verification detected a corrupted output file. The source was not changed.');
            }
          }
          compressed += 1;
          outputBytes = outputStat.size;
          afterBytes += outputStat.size;
          savedBytes += originalStat.size - outputStat.size;
        }
      }
    } catch (error) {
      if (tempPath && await exists(tempPath)) await fsp.unlink(tempPath).catch(() => {});
      failed += 1;
      recoveryPath = error.recoveryPath || null;
      if (recoveryPath) recoveryFiles.push(recoveryPath);
      status = recoveryPath ? 'Recovered' : 'Failed';
      errorMessage = error.message;
      if (originalStat) afterBytes += originalStat.size;
    }

    const result = {
      path: item.path,
      originalBytes: originalStat?.size || 0,
      outputBytes,
      status,
      error: errorMessage,
      recoveryPath,
      destination: status === 'Optimised' ? destination : null
    };
    results[index] = result;
    completed += 1;
    onProgress({
      current: completed,
      total: items.length,
      compressed,
      kept,
      failed,
      savedBytes,
      result
    });
  }

  async function worker() {
    while (!state.cancelled) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await processItem(index);
    }
  }

  await Promise.all(Array.from({ length: plan.workers }, worker));
  const completedResults = results.filter(Boolean);

  return {
    cancelled: state.cancelled,
    total: items.length,
    completed: completedResults.length,
    compressed,
    kept,
    failed,
    savedBytes,
    beforeBytes,
    afterBytes,
    reductionPercent: beforeBytes > 0 ? Math.round((savedBytes / beforeBytes) * 10000) / 100 : 0,
    recoveryFiles,
    outputDirectory,
    mode: 'parallel',
    engineRuns: completedResults.length,
    workers: plan.workers,
    threadsPerWorker: plan.threadsPerWorker,
    results: completedResults
  };
}

module.exports = {
  PNG_SIGNATURE,
  cancelActiveEngines,
  compressFiles,
  createStagingBatches,
  createCompressionPlan,
  describeFiles,
  describePaths,
  listPngFiles,
  readPngMetadata,
  replaceSafely,
  sha256File
};
