import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const artifactDir = path.join(repoRoot, 'artifacts', 'verifier');
const mode = process.argv[2] || 'static';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function readFile(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function exists(relPath) {
  return fs.existsSync(path.join(repoRoot, relPath));
}

function listFiles(startRelPath) {
  const start = path.join(repoRoot, startRelPath);
  if (!fs.existsSync(start)) return [];
  const out = [];
  for (const entry of fs.readdirSync(start, { withFileTypes: true })) {
    const abs = path.join(start, entry.name);
    const rel = path.relative(repoRoot, abs);
    if (entry.isDirectory()) {
      out.push(...listFiles(rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function writeArtifact(name, payload) {
  ensureDir(artifactDir);
  const artifactPath = path.join(artifactDir, `${name}-${nowStamp()}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(payload, null, 2)}\n`);
  return path.relative(repoRoot, artifactPath);
}

function makeCheck(id, pass, detail, severity = 'error') {
  return { id, pass, severity, detail };
}

function summarize(checks) {
  const failed = checks.filter((check) => !check.pass && check.severity === 'error').length;
  const warnings = checks.filter((check) => !check.pass && check.severity !== 'error').length;
  return { failed, warnings, passed: checks.length - failed - warnings };
}

function scanRepoFor(regex, roots) {
  const hits = [];
  for (const root of roots) {
    for (const relPath of listFiles(root)) {
      if (relPath.startsWith('artifacts/')) continue;
      if (relPath.includes('TESTHARBOR_BATCH19_26_VERIFIER_2026-03-28.md')) continue;
      if (relPath.endsWith('verify-batch19-26.mjs')) continue;
      const text = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (regex.test(lines[index])) {
          hits.push({ path: relPath, line: index + 1, text: lines[index].trim() });
        }
      }
    }
  }
  return hits;
}

async function httpProbe({ url, method = 'GET', expectStatus = 200, expectText = '', bodyFile = '', authToken = '' }) {
  const headers = {};
  let body;

  if (authToken) headers.authorization = `Bearer ${authToken}`;
  if (bodyFile) {
    headers['content-type'] = 'application/json';
    body = fs.readFileSync(path.resolve(repoRoot, bodyFile), 'utf8');
  }

  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  return {
    url,
    method,
    status: res.status,
    ok: res.status === Number(expectStatus) && (!expectText || text.includes(expectText)),
    expectStatus: Number(expectStatus),
    expectText,
    bodyPreview: text.slice(0, 500)
  };
}

function runStatic() {
  const packageJson = JSON.parse(readFile('package.json'));
  const scripts = packageJson.scripts || {};
  const onboardingHits = scanRepoFor(/onboarding/i, ['apps', 'scripts', 'docs']);
  const cypressConnectHits = scanRepoFor(/cypress.*connect|connect.*cypress/i, ['apps', 'scripts', 'docs', 'packages']);
  const checks = [
    makeCheck(
      'plan-file-present',
      exists('docs/TESTHARBOR_REMAINING_BATCH_PLAN_2026-03-28.md'),
      exists('docs/TESTHARBOR_REMAINING_BATCH_PLAN_2026-03-28.md')
        ? 'source plan file present'
        : 'missing docs/TESTHARBOR_REMAINING_BATCH_PLAN_2026-03-28.md'
    ),
    makeCheck(
      'local-dev-doc-present',
      exists('LOCAL_DEV.md'),
      exists('LOCAL_DEV.md') ? 'LOCAL_DEV.md present' : 'LOCAL_DEV.md missing'
    ),
    makeCheck(
      'web-surface-present',
      exists('apps/web/src/server.js'),
      exists('apps/web/src/server.js') ? 'apps/web/src/server.js present' : 'web server missing'
    ),
    makeCheck(
      'onboarding-artifact-present',
      onboardingHits.length > 0,
      onboardingHits.length > 0
        ? `found onboarding references: ${onboardingHits.slice(0, 5).map((hit) => `${hit.path}:${hit.line}`).join(', ')}`
        : 'no onboarding references found in apps/, scripts/, or docs/'
    ),
    makeCheck(
      'cypress-connect-artifact-present',
      cypressConnectHits.length > 0,
      cypressConnectHits.length > 0
        ? `found Cypress connect references: ${cypressConnectHits.slice(0, 5).map((hit) => `${hit.path}:${hit.line}`).join(', ')}`
        : 'no Cypress connect references found in apps/, scripts/, docs/, or packages/'
    ),
    makeCheck(
      'cypress-reporter-present',
      exists('packages/cypress-reporter/src/index.js'),
      exists('packages/cypress-reporter/src/index.js')
        ? 'packages/cypress-reporter/src/index.js present'
        : 'cypress reporter package missing'
    ),
    makeCheck(
      'verifier-script-wired',
      Boolean(scripts['verify:batch19-26:static'] && scripts['verify:batch19-26:onboarding'] && scripts['verify:batch19-26:cypress']),
      scripts['verify:batch19-26:static']
        ? 'package.json verifier scripts present'
        : 'package.json verifier scripts missing'
    )
  ];

  const summary = summarize(checks);
  const payload = {
    mode: 'static',
    repoRoot,
    summary,
    checks,
    onboardingHits: onboardingHits.slice(0, 20),
    cypressConnectHits: cypressConnectHits.slice(0, 20)
  };
  const artifactPath = writeArtifact('batch19-26-static', payload);
  console.log(JSON.stringify({ ok: summary.failed === 0, artifactPath, ...summary }, null, 2));
  if (summary.failed > 0) process.exitCode = 1;
}

async function runOnboarding() {
  const url = process.env.TH_ONBOARDING_URL;
  if (!url) {
    console.error('TH_ONBOARDING_URL is required');
    process.exit(2);
  }
  const probe = await httpProbe({
    url,
    expectStatus: process.env.TH_ONBOARDING_EXPECT_STATUS || 200,
    expectText: process.env.TH_ONBOARDING_EXPECT_TEXT || '',
    authToken: process.env.TH_AUTH_TOKEN || ''
  });
  const artifactPath = writeArtifact('batch19-26-onboarding', {
    mode: 'onboarding',
    probe
  });
  console.log(JSON.stringify({ ok: probe.ok, artifactPath, probe }, null, 2));
  if (!probe.ok) process.exitCode = 1;
}

async function runCypressConnect() {
  const url = process.env.TH_CYPRESS_CONNECT_URL;
  if (!url) {
    console.error('TH_CYPRESS_CONNECT_URL is required');
    process.exit(2);
  }
  const probe = await httpProbe({
    url,
    method: process.env.TH_CYPRESS_METHOD || 'GET',
    expectStatus: process.env.TH_CYPRESS_EXPECT_STATUS || 200,
    expectText: process.env.TH_CYPRESS_EXPECT_TEXT || '',
    bodyFile: process.env.TH_CYPRESS_BODY_FILE || '',
    authToken: process.env.TH_AUTH_TOKEN || ''
  });
  const artifactPath = writeArtifact('batch19-26-cypress-connect', {
    mode: 'cypress-connect',
    probe
  });
  console.log(JSON.stringify({ ok: probe.ok, artifactPath, probe }, null, 2));
  if (!probe.ok) process.exitCode = 1;
}

if (mode === 'static') {
  runStatic();
} else if (mode === 'onboarding') {
  await runOnboarding();
} else if (mode === 'cypress') {
  await runCypressConnect();
} else {
  console.error(`Unknown mode: ${mode}`);
  process.exit(2);
}
