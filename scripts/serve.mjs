import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAppServer } from '../server/app.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT) || 4173;
const host = process.env.HOST || '127.0.0.1';
const dataDir = process.env.AUTH_DATA_DIR
  ? resolve(process.env.AUTH_DATA_DIR)
  : resolve(root, '.data');

const server = createAppServer({ root, dataDir });

server.listen(port, host, () => {
  console.log(`连连看 running at http://${host}:${port}`);
  console.log(`账号数据保存在 ${dataDir}`);
});
