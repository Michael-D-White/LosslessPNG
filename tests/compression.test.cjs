const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const {
  compressFiles,
  describeFiles,
  describePaths,
  listPngFiles,
  readPngMetadata,
  replaceSafely,
  sha256File
} = require('../electron/compression.cjs');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([size, typeBuffer, data, crc]);
}

function makePng(width, height) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 4;
      row[offset] = (x * 13 + y * 3) % 256;
      row[offset + 1] = (x * 5 + y * 11) % 256;
      row[offset + 2] = (x * 7 + y * 17) % 256;
      row[offset + 3] = (x * 19 + y * 23) % 256;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 0 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodeRgbaPng(buffer) {
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assert.equal(buffer[24], 8, 'test decoder expects 8-bit PNG');
  assert.equal(buffer[25], 6, 'strict --nx mode must retain RGBA colour type');
  assert.equal(buffer[28], 0, 'strict --nx mode must retain non-interlaced layout');
  const idats = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idats.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const filtered = zlib.inflateSync(Buffer.concat(idats));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[inputOffset++];
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[inputOffset++];
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
      const value = filter === 0 ? raw
        : filter === 1 ? raw + left
          : filter === 2 ? raw + up
            : filter === 3 ? raw + Math.floor((left + up) / 2)
              : raw + paeth(left, up, upperLeft);
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return pixels;
}

const engine = path.join(__dirname, '..', 'resources', 'bin', 'oxipng', 'oxipng.exe');

test('recursive discovery and file inspection reject disguised PNG files', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pngoo-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'nested'));
  await fsp.writeFile(path.join(root, 'one.png'), makePng(16, 12));
  await fsp.writeFile(path.join(root, 'nested', 'two.PNG'), makePng(8, 6));
  await fsp.writeFile(path.join(root, 'fake.png'), Buffer.from('not a png'));
  await fsp.writeFile(path.join(root, 'ignored.jpg'), makePng(4, 4));

  const files = await listPngFiles(root);
  const items = await describeFiles(files, root);
  assert.equal(files.length, 3);
  assert.equal(items.filter(item => item.valid).length, 2);
  assert.equal(items.filter(item => !item.valid).length, 1);
});

test('PNG metadata reader reports dimensions', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pngoo-meta-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'sample.png');
  await fsp.writeFile(file, makePng(37, 19));
  assert.deepEqual(await readPngMetadata(file), { width: 37, height: 19 });
});

test('dropped folders are scanned recursively and retain their folder root', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pngoo-drop-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, 'nested');
  await fsp.mkdir(nested);
  await fsp.writeFile(path.join(root, 'one.png'), makePng(12, 9));
  await fsp.writeFile(path.join(nested, 'two.PNG'), makePng(8, 6));
  await fsp.writeFile(path.join(root, 'ignored.jpg'), makePng(4, 4));

  const items = await describePaths([root]);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(item => item.path), [path.join(nested, 'two.PNG'), path.join(root, 'one.png')].sort((a, b) => a.localeCompare(b)));
  assert.equal(items.every(item => item.root === path.resolve(root)), true);
});

test('Oxipng strict mode produces byte-identical decoded pixels', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pngoo-engine-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'gradient.png');
  const output = path.join(root, 'gradient.lossless.png');
  await fsp.writeFile(source, makePng(256, 192));
  const before = await fsp.readFile(source);
  const result = spawnSync(engine, ['-o', '4', '--preserve', '--nx', '--quiet', '--out', output, '--', source], {
    windowsHide: true,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(output), true);
  const after = await fsp.readFile(output);
  assert.deepEqual(await readPngMetadata(output), { width: 256, height: 192 });
  assert.deepEqual(decodeRgbaPng(after), decodeRgbaPng(before));
  assert.ok(after.length < before.length);
});

test('successful overwrite deletes its temporary rollback copy', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pngoo-workflow-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'art.png');
  const original = makePng(256, 192);
  await fsp.writeFile(source, original);
  const result = await compressFiles({
    items: [{ path: source, root }],
    overwrite: true
  }, engine, { cancelled: false, child: null }, () => {});

  assert.equal(result.failed, 0);
  assert.equal(result.compressed, 1);
  assert.ok(result.savedBytes > 0);
  assert.deepEqual(result.recoveryFiles, []);
  assert.deepEqual(decodeRgbaPng(await fsp.readFile(source)), decodeRgbaPng(original));
  const remainingNames = await fsp.readdir(root);
  assert.equal(remainingNames.some(name => /pngoo-(?:rollback|recovery)|pngoo backup/i.test(name)), false);
});

test('failed post-write verification restores the original and retains one recovery copy', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pngoo-recovery-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'art.png');
  const candidate = path.join(root, 'candidate.png');
  const original = makePng(128, 96);
  await fsp.writeFile(source, original);
  const engineResult = spawnSync(engine, ['-o', '4', '--preserve', '--nx', '--quiet', '--out', candidate, '--', source], {
    windowsHide: true,
    encoding: 'utf8'
  });
  assert.equal(engineResult.status, 0, engineResult.stderr);
  const originalStat = await fsp.stat(source);
  const outputStat = await fsp.stat(candidate);
  const outputMetadata = await readPngMetadata(candidate);
  const originalHash = await sha256File(source);

  let caught = null;
  try {
    await replaceSafely(source, candidate, 'forced-corruption', originalStat, {
      size: outputStat.size,
      width: outputMetadata.width,
      height: outputMetadata.height,
      hash: '0'.repeat(64)
    }, originalHash);
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, 'forced verification mismatch must fail');
  assert.match(caught.message, /original was restored/i);
  assert.ok(caught.recoveryPath);
  assert.deepEqual(await fsp.readFile(source), original);
  assert.deepEqual(await fsp.readFile(caught.recoveryPath), original);
  const remainingNames = await fsp.readdir(root);
  assert.equal(remainingNames.filter(name => name.includes('.pngoo-rollback-')).length, 0);
  assert.equal(remainingNames.filter(name => name.includes('.PNGoo-Recovery-')).length, 1);
});

test('non-corruption replacement failure restores the original without retaining a backup', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pngoo-restore-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'art.png');
  const missingCandidate = path.join(root, 'missing.png');
  const original = makePng(64, 48);
  await fsp.writeFile(source, original);
  const originalStat = await fsp.stat(source);
  const originalHash = await sha256File(source);

  let caught = null;
  try {
    await replaceSafely(source, missingCandidate, 'forced-write-error', originalStat, {
      size: 1,
      width: 64,
      height: 48,
      hash: '0'.repeat(64)
    }, originalHash);
  } catch (error) {
    caught = error;
  }

  assert.ok(caught);
  assert.match(caught.message, /no backup was retained/i);
  assert.equal(caught.recoveryPath, null);
  assert.deepEqual(await fsp.readFile(source), original);
  const remainingNames = await fsp.readdir(root);
  assert.equal(remainingNames.some(name => /pngoo-(?:rollback|recovery)/i.test(name)), false);
});

test('separate-output workflow preserves the source and writes beneath the chosen folder', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pngoo-output-'));
  const outputRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pngoo-destination-'));
  t.after(() => Promise.all([
    fsp.rm(root, { recursive: true, force: true }),
    fsp.rm(outputRoot, { recursive: true, force: true })
  ]));
  const source = path.join(root, 'art.png');
  const original = makePng(128, 96);
  await fsp.writeFile(source, original);
  const result = await compressFiles({
    items: [{ path: source, root }],
    overwrite: false,
    outputDirectory: outputRoot
  }, engine, { cancelled: false, child: null }, () => {});

  assert.equal(result.failed, 0);
  assert.equal(result.compressed, 1);
  assert.deepEqual(await fsp.readFile(source), original);
  assert.equal(fs.existsSync(result.results[0].destination), true);
  assert.deepEqual(decodeRgbaPng(await fsp.readFile(result.results[0].destination)), decodeRgbaPng(original));
});
