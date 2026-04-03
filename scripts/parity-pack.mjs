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

function parseJsonFromText(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
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
    '# verify:batch19-26:static',
    `# exitCode=${verifyResult.status ?? 1}`,
    verifyResult.stdout || '',
    verifyResult.stderr || ''
  ].join('\n')
);

const verifyJson = parseJsonFromText(verifyResult.stdout);

const captureBaseUrl = String(process.env.TH_PARITY_WEB_BASE_URL || process.env.PARITY_CAPTURE_BASE_URL || '').trim();
const authToken = String(process.env.TH_AUTH_TOKEN || '').trim();
const captureCookie = String(process.env.TH_PARITY_COOKIE || process.env.PARITY_CAPTURE_COOKIE || '').trim();
const capturePaths = String(process.env.TH_PARITY_CAPTURE_PATHS || process.env.PARITY_CAPTURE_PATHS || '/app/onboarding,/app/connect,/app/team,/app/runs,/app/admin')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const captures = [];

if (captureBaseUrl && (authToken || captureCookie)) {
  const htmlDir = path.join(outDir, 'html');
  await mkdir(htmlDir, { recursive: true });

  const sessionCookie = captureCookie || (authToken ? `th_session=${encodeURIComponent(authToken)}` : '');

  for (const routePath of capturePaths) {
    const url = `${captureBaseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'text/html,application/xhtml+xml',
          ...(sessionCookie ? { cookie: sessionCookie } : {}),
          ...(authToken ? { authorization: `Bearer ${authToken}` } : {})
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

const envSnapshotKeys = [
  'API_BASE_URL',
  'INGEST_BASE_URL',
  'INGEST_PUBLIC_BASE_URL',
  'INGEST_AUTH_TOKEN',
  'PROJECT_INGEST_TOKEN_DEFAULT_TTL_DAYS',
  'PROJECT_INGEST_TOKEN_MAX_TTL_DAYS',
  'TH_PARITY_WEB_BASE_URL',
  'TH_AUTH_TOKEN',
  'TH_PARITY_CAPTURE_PATHS',
  'PARITY_CAPTURE_BASE_URL',
  'PARITY_CAPTURE_PATHS'
];

const env = Object.fromEntries(
  envSnapshotKeys
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, ['INGEST_AUTH_TOKEN', 'TH_AUTH_TOKEN'].includes(key) ? '<redacted>' : process.env[key]])
);

const manifest = {
  generatedAt: now.toISOString(),
  branch,
  commit,
  verify: {
    command: 'npm run -s verify:batch19-26:static',
    status: verifyResult.status ?? 1,
    signal: verifyResult.signal || null,
    log: path.relative(root, verifyLogPath),
    staticVerifierArtifactPath: verifyJson?.artifactPath || null
  },
  captures,
  env
};

const manifestPath = path.join(outDir, `manifest-${stamp}.json`);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({
  ok: (verifyResult.status ?? 1) === 0,
  manifest: path.relative(root, manifestPath),
  verifyLog: path.relative(root, verifyLogPath),
  staticVerifierArtifactPath: verifyJson?.artifactPath || null,
  captures: captures.length
})}\n`);

if ((verifyResult.status ?? 1) !== 0) {
  process.stderr.write(verifyResult.stdout || '');
  process.stderr.write(verifyResult.stderr || '');
  process.exit(verifyResult.status ?? 1);
}
