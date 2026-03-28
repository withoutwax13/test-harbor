process.env.WEBHOOK_EXPECT_DEAD = process.env.WEBHOOK_EXPECT_DEAD || '1';
process.env.WEBHOOK_MOCK_FAILS = process.env.WEBHOOK_MOCK_FAILS || '5';
process.env.WEBHOOK_MAX_ATTEMPTS = process.env.WEBHOOK_MAX_ATTEMPTS || '5';

await import('./smoke-webhooks.mjs');
