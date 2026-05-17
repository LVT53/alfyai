import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';

function clearCampaignState(dbPath: string) {
  const db = new Database(dbPath);
  try {
    db.transaction(() => {
      for (const table of [
        'announcement_campaign_events',
        'announcement_campaign_user_states',
        'announcement_campaign_snapshot_slides',
        'announcement_campaign_snapshots',
        'announcement_campaign_slides',
        'announcement_campaigns',
        'campaign_assets',
      ]) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
    })();
  } finally {
    db.close();
  }
}

export default async function globalSetup() {
  const dbDir = join(process.cwd(), 'data');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = process.env.DATABASE_PATH || join(process.cwd(), 'data', 'chat.db');

  try {
    execSync(
      'npm run db:prepare',
      {
        stdio: 'pipe',
        env: {
          ...process.env,
          DATABASE_PATH: dbPath,
          SESSION_SECRET: process.env.SESSION_SECRET || 'e2e-test-session-secret-long-enough-1234567890',
          LANGFLOW_API_KEY: process.env.LANGFLOW_API_KEY || 'test-key',
          LANGFLOW_API_URL: process.env.LANGFLOW_API_URL || 'http://localhost:7860',
          LANGFLOW_FLOW_ID: process.env.LANGFLOW_FLOW_ID || 'test-flow-id',
        }
      }
    );
  } catch (err) {
    console.warn('[globalSetup] db:prepare failed:', (err as Error).message?.slice(0, 200));
  }

  try {
    clearCampaignState(dbPath);
  } catch (err) {
    console.warn('[globalSetup] Campaign cleanup failed:', (err as Error).message?.slice(0, 200));
  }

  try {
    execSync(
      `npx tsx scripts/seed-admin.ts --email=admin@local --password=admin123 --name="Admin User" --admin`,
      {
        stdio: 'pipe',
        env: {
          ...process.env,
          DATABASE_PATH: dbPath,
          SESSION_SECRET: process.env.SESSION_SECRET || 'e2e-test-session-secret-long-enough-1234567890',
          LANGFLOW_API_KEY: process.env.LANGFLOW_API_KEY || 'test-key',
          LANGFLOW_API_URL: process.env.LANGFLOW_API_URL || 'http://localhost:7860',
          LANGFLOW_FLOW_ID: process.env.LANGFLOW_FLOW_ID || 'test-flow-id',
        }
      }
    );
    console.log('[globalSetup] Test admin seeded: admin@local');
  } catch (err) {
    console.warn('[globalSetup] Seed admin failed:', (err as Error).message?.slice(0, 200));
  }
}
