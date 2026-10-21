import { resolve, join } from 'node:path';
import { createApp } from './app.mjs';

const dataDir = resolve(process.env.TERN_DATA_DIR || '.tern-data');
const host = process.env.HOST || (process.env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1');
const port = Number(process.env.PORT || 4310);
const publicUrl = (process.env.TERN_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL)?.replace(/\/$/, '');
const app = createApp({ dataDir, publicUrl, secureCookies: publicUrl?.startsWith('https://'), trustProxy: process.env.TERN_TRUST_PROXY === 'true' });
try {
  const address = await app.listen(port, host);
  const consoleUrl = publicUrl || address;
  console.log(`\n  Tern · Flutter code push\n\n  Console  ${consoleUrl}\n  API      ${consoleUrl}/api\n  Data     ${dataDir}\n  CLI key  ${process.env.TERN_ADMIN_TOKEN ? '(from environment)' : join(dataDir, 'admin-token')}\n\n  Sign in with your administrator email and password.\n  First setup: npm run admin:setup -- --email you@example.com --origin ${consoleUrl}\n  Run npm run demo to create a local demo application.\n`);
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Set PORT to another port.` : error.message);
  app.store.close();
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
