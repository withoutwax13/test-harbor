import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const root = process.cwd();
const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, '-');
const outDir = path.join(root, 'artifacts', 'parity');
await mkdir(outDir, { recursive: true });

function readGit(command) {
  return execSync(command, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

const branch = readGit('git rev-parse --abbrev-ref HEAD');
const commit = readGit('git rev-parse HEAD');

const verifyResult = spawnSync('npm', ['run', '-s', 'verify:batch19-26:static'], {
  cwd: root,
  encoding: 'utf8',
  env: process.env
});

const verifyLogPath = path.join(outDir, `verify-static-${stamp}.log`);
await writeFile(
  verifyLogPath,
  [
    `# verify:batch19-26:static`,
    `# exitCode=${verifyResult.status ?? 1}`,
    verifyResult.stdout || '',
    verifyResult.stderr || ''
  ].join('\n')
);

const captureBaseUrl = String(process.env.PARITY_CAPTURE_BASE_URL || '').trim();
const captureCookie = String(process.env.PARITY_CAPTURE_COOKIE || '').trim();
const capturePaths = String(process.env.PARITY_CAPTURE_PATHS || '/app/onboarding,/app/connect,/app/team,/app/runs,/app/admin')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const captures = [];

if (captureBaseUrl) {
  const htmlDir = path.join(outDir, 'html');
  await mkdir(htmlDir, { recursive: true });

  for (const routePath of capturePaths) {
    const url = `${captureBaseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'text/html,application/xhtml+xml',
          ...(captureCookie ? { cookie: captureCookie } : {})
        },
        redirect: 'follow'
      });
      const body = await response.text();
      const safeName = routePath.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'root';
      const targetPath = path.join(htmlDir, `${safeName}.html`);
      await writeFile(targetPath, body);
      captures.push({ path: routePath, url, status: response.status, file: path.relative(root, targetPath) });
    } catch (error) {
      captures.push({ path: routePath, url, error: String(error?.message || error) });
    }
  }
}

const envSubsetKeys = [
  'API_BASE_URL',
  'INGEST_BASE_URL',
  'INGEST_PUBLIC_BASE_URL',
  'INGEST_AUTH_TOKEN',
  'PROJECT_INGEST_TOKEN_DEFAULT_TTL_DAYS',
  'PROJECT_INGEST_TOKEN_MAX_TTL_DAYS',
  'PARITY_CAPTURE_BASE_URL',
  'PARITY_CAPTURE_PATHS'
];

const envSubset = Object.fromEntries(
  envSubsetKeys
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, key === 'INGEST_AUTH_TOKEN' ? '<redacted>' : process.env[key]])
);

const manifest = {
  generatedAt: now.toISOString(),
  branch,
  commit,
  verify: {
    command: 'npm run -s verify:batch19-26:static',
    status: verifyResult.status ?? 1,
    signal: verifyResult.signal || null,
    log: path.relative(root, verifyLogPath)
  },
  captures,
  env: envSubset
};

const manifestPath = path.join(outDir, `manifest-${stamp}.json`);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({
  ok: (verifyResult.status ?? 1) === 0,
  manifest: path.relative(root, manifestPath),
  verifyLog: path.relative(root, verifyLogPath),
  captures: captures.length
})}\n`);

if ((verifyResult.status ?? 1) !== 0) {
  process.stderr.write(verifyResult.stdout || '');
  process.stderr.write(verifyResult.stderr || '');
  process.exit(verifyResult.status ?? 1);
}
