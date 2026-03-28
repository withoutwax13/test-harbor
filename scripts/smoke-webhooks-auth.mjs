if (!process.env.API_AUTH_TOKEN || !process.env.INGEST_AUTH_TOKEN) {
  throw new Error('API_AUTH_TOKEN and INGEST_AUTH_TOKEN are required for smoke:webhooks:auth');
}
await import('./smoke-webhooks.mjs');
