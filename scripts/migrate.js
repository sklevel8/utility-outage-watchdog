import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/env.js';
import { createDatabase } from '../src/config/database.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, '..', 'src', 'db', 'migrations');

async function main() {
  const config = loadConfig({ requireSecrets: false });
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');

  const db = createDatabase(config.databaseUrl);

  try {
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      process.stdout.write(`applying ${file} ... `);
      await db.raw(sql);
      console.log('ok');
    }

    for (const zone of config.zones) {
      await db('zones')
        .insert({ zone_id: zone.id, suburb_name: zone.name, provider: config.esp.provider })
        .onConflict('zone_id')
        .merge({ suburb_name: zone.name, provider: config.esp.provider });
      console.log(`zone seeded: ${zone.id} (${zone.name})`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error('migration failed:', error.message);
  process.exitCode = 1;
});
