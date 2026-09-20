import { config } from '../config.ts';
import { db, driver, closeDb } from './client.ts';

// 迁移随驱动走：两个 migrator 读同一组 SQL（apps/api/drizzle，打包后由 QUILT_MIGRATIONS_DIR 指到 dist/drizzle）
export async function runMigrations(): Promise<void> {
  const opts = { migrationsFolder: config.migrationsDir };
  if (driver.kind === 'pglite') {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(db as unknown as Parameters<typeof migrate>[0], opts);
  } else {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(db as unknown as Parameters<typeof migrate>[0], opts);
  }
}

// `pnpm db:migrate` 直接跑；服务启动时由 main.ts 调用
if (process.argv[1] && /migrate\.(ts|mjs|js)$/.test(process.argv[1])) {
  await runMigrations();
  await closeDb();
  console.log('migrations applied');
}
