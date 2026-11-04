import http from 'http';
import { createApp } from './app';
import { config } from './config';
import { syncCaddyOnStart } from './lib/caddy';
import { prisma } from './db';
import { backfillSlugs } from './lib/slug';
import { attachLogServer } from './ws/logs';

const server = http.createServer(createApp());
attachLogServer(server);
server.listen(config.port, () => console.log(`DevFlow API listening on :${config.port}`));

backfillSlugs()
  .catch((e) => console.error('Slug backfill failed:', e))
  .then(() => syncCaddyOnStart());

if (config.demo.enabled) {
  console.log('DEMO MODE is on: per-user quotas, rate limits and locked-down registration are enforced.');
  prisma.user
    .count({ where: { role: 'ADMIN' } })
    .then((n: number) => {
      if (n === 0) console.warn('WARNING: demo mode has no ADMIN account (sign-up never creates one). Run: docker compose exec -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... api node dist/scripts/createAdmin.js');
    })
    .catch(() => undefined);
}
