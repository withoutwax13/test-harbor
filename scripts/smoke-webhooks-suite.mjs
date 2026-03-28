import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const outDir = path.resolve(process.env.WEBHOOK_ARTIFACT_DIR || 'artifacts/webhooks');
const includeClearSecret = process.env.WEBHOOK_INCLUDE_CLEAR_SECRET !== '0';

function runNode(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [script], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      process.stdout.write(d);
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      process.stderr.write(d);
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${script} exited ${code}\n${stderr}`));
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        reject(new Error(`${script} returned non-JSON output`));
      }
    });
  });
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
await fs.mkdir(outDir, { recursive: true });

const delivered = await runNode('scripts/smoke-webhooks.mjs');
const dead = await runNode('scripts/smoke-webhooks-dead.mjs');
const clearSecret = includeClearSecret ? await runNode('scripts/smoke-webhooks-clear-secret.mjs') : null;

const combined = {
  ok: true,
  generatedAt: new Date().toISOString(),
  delivered,
  dead,
  ...(includeClearSecret ? { clearSecret } : {})
};
const suitePath = path.join(outDir, `webhook-smoke-suite-${stamp}.json`);
await fs.writeFile(suitePath, JSON.stringify(combined, null, 2));
console.log(JSON.stringify({ ok: true, artifactPath: suitePath, includeClearSecret }, null, 2));
