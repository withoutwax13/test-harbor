if (!process.env.API_AUTH_TOKEN || !process.env.INGEST_AUTH_TOKEN) {
  throw new Error('API_AUTH_TOKEN and INGEST_AUTH_TOKEN are required for smoke:webhooks:dead:auth');
}
process.env.WEBHOOK_EXPECT_DEAD = process.env.WEBHOOK_EXPECT_DEAD || '1';
process.env.WEBHOOK_MOCK_FAILS = process.env.WEBHOOK_MOCK_FAILS || '5';
process.env.WEBHOOK_MAX_ATTEMPTS = process.env.WEBHOOK_MAX_ATTEMPTS || '5';
await import('./smoke-webhooks.mjs');
