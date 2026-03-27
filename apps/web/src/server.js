import Fastify from 'fastify';
const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3000);
app.get('/healthz', async () => ({ ok: true, service: '@testharbor/web' }));
app.get('/', async () => ({ app: 'TestHarbor Web', status: 'bootstrap-ready' }));
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
