import Fastify from 'fastify';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 4000);

app.get('/healthz', async () => ({ ok: true, service: process.env.npm_package_name || 'service' }));

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
