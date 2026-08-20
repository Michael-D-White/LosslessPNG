const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
        if (!entry.name.includes(' - PNGoo Backup ')) await visit(fullPath);
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
  const items = [];
  for (const file of unique) {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) continue;
    const metadata = await readPngMetadata(file);
    items.push({
      id: crypto.createHash('sha1').update(file.toLowerCase()).digest('hex'),
      path: file,
      root: path.resolve(root || path.dirname(file)),
      name: path.basename(file),
      size: stat.size,
      valid: Boolean(metadata),
      width: metadata?.width || null,
      height: metadata?.height || null
    });
  }
  return items;
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
      resolve({ code, output: `${stdout} ${stderr}`.trim() });
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
    await fsp.utimes(original, originalStat.atime, originalStat.mtime);
    const [installedStat, installedMetadata, installedHash] = await Promise.all([
      fsp.stat(original),
      readPngMetadata(original),
      sha256File(original)
    ]);
    if (
      installedStat.size !== expected.size ||
      !installedMetadata ||
      installedMetadata.width !== expected.width ||
      installedMetadata.height !== expected.height ||
      installedHash !== expected.hash
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
        if (await sha256File(original) !== originalHash) {
          throw new Error('The restored original did not match its pre-compression hash.');
        }
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
    workers: plan.workers,
    threadsPerWorker: plan.threadsPerWorker,
    results: completedResults
  };
}

module.exports = {
  PNG_SIGNATURE,
  cancelActiveEngines,
  compressFiles,
  createCompressionPlan,
  describeFiles,
  describePaths,
  listPngFiles,
  readPngMetadata,
  replaceSafely,
  sha256File
};
