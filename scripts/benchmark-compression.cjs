const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

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

function makePng(width, height, seed) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 4;
      row[offset] = (x * 13 + y * 3 + seed * 17) % 256;
      row[offset + 1] = (x * 5 + y * 11 + seed * 29) % 256;
      row[offset + 2] = (x * 7 + y * 17 + seed * 41) % 256;
      row[offset + 3] = (x * 19 + y * 23 + seed * 7) % 256;
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

function run(engine, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(engine, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `Exit ${code}`)));
  });
}

async function benchmark(engine, inputs, root, variant) {
  const outputRoot = path.join(root, variant.name);
  await fsp.mkdir(outputRoot);
  let next = 0;
  const started = performance.now();
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= inputs.length) return;
      const args = ['-o', String(variant.level), '--nx', '--quiet'];
      if (variant.threads) args.push('--threads', String(variant.threads));
      args.push('--out', path.join(outputRoot, `${index}.png`), '--', inputs[index]);
      await run(engine, args);
    }
  }
  await Promise.all(Array.from({ length: variant.workers }, worker));
  const elapsedMs = Math.round(performance.now() - started);
  const files = await fsp.readdir(outputRoot);
  let outputBytes = 0;
  for (const file of files) outputBytes += (await fsp.stat(path.join(outputRoot, file))).size;
  return { ...variant, elapsedMs, outputBytes };
}

async function main() {
  const engine = path.join(__dirname, '..', 'resources', 'bin', 'oxipng', 'oxipng.exe');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pngoo-benchmark-'));
  try {
    const inputs = [];
    for (let index = 0; index < 12; index += 1) {
      const file = path.join(root, `input-${index}.png`);
      await fsp.writeFile(file, makePng(1024, 768, index));
      inputs.push(file);
    }
    const variants = [
      { name: 'baseline-o4-sequential', level: 4, workers: 1, threads: null },
      { name: 'o4-parallel-2', level: 4, workers: 2, threads: 10 },
      { name: 'o4-parallel-4', level: 4, workers: 4, threads: 5 },
      { name: 'o4-parallel-5', level: 4, workers: 5, threads: 4 },
      { name: 'o3-parallel-4', level: 3, workers: 4, threads: 5 },
      { name: 'o2-parallel-4', level: 2, workers: 4, threads: 5 }
    ];
    const results = [];
    for (const variant of variants) results.push(await benchmark(engine, inputs, root, variant));
    process.stdout.write(JSON.stringify(results, null, 2));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(error.stack || error.message);
  process.exitCode = 1;
});
