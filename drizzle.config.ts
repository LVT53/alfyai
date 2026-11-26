import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/lib/server/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: './data/chat.db' },
  // Workspace Search's full-text indexes and their shadow tables are made by
  // hand in migration 145; schema.ts cannot describe a virtual table, so push
  // and pull must never see them (push would drop them).
  tablesFilter: ['*', '!messages_fts*', '!artifacts_fts*']
});