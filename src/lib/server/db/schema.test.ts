import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from './schema';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const TEST_DB_PATH = './test-data/schema-test.db';

describe('schema core tables', () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(() => {
    const dbDir = dirname(TEST_DB_PATH);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }

    sqlite = new Database(TEST_DB_PATH);
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite, { schema });

    migrate(db, { migrationsFolder: './drizzle' });
  });

  afterAll(() => {
    sqlite?.close();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  describe('users table', () => {
    it('can insert user and query by id', () => {
      const userId = 'test-user-1';
      db.insert(schema.users).values({
        id: userId,
        email: 'test@example.com',
        passwordHash: 'hash123',
        name: 'Test User',
      }).run();

      const user = db.select().from(schema.users)
        .where(eq(schema.users.id, userId))
        .get();

      expect(user).toBeTruthy();
      expect(user?.id).toBe(userId);
      expect(user?.email).toBe('test@example.com');
      expect(user?.name).toBe('Test User');
      expect(user?.honchoPeerVersion).toBe(0);
    });
  });

  describe('artifacts table', () => {
    it('can insert artifact with the minimal document fields', () => {
      const userId = 'test-user-artifact';
      db.insert(schema.users).values({
        id: userId,
        email: 'artifact@example.com',
        passwordHash: 'hash456',
        name: 'Artifact Test User',
      }).run();

      const artifactId = 'artifact-minimal-document';
      db.insert(schema.artifacts).values({
        id: artifactId,
        userId: userId,
        type: 'source_document',
        name: 'Test Document.pdf',
      }).run();

      const artifact = db.select().from(schema.artifacts)
        .where(eq(schema.artifacts.id, artifactId))
        .get();

      expect(artifact).toBeTruthy();
      expect(artifact?.id).toBe(artifactId);
    });

    it('keeps document ownership on the artifact row only', () => {
      const columns = sqlite
        .prepare("PRAGMA table_info(artifacts)")
        .all() as { name: string }[];

      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('user_id');
      expect(columnNames).toContain('conversation_id');
    });
  });

  describe('projects table', () => {
    it('links at most one project folder to a canonical memory project', () => {
      const columns = sqlite
        .prepare("PRAGMA table_info(projects)")
        .all() as { name: string }[];
      const columnNames = columns.map((column) => column.name);
      expect(columnNames).toContain('canonical_memory_project_id');

      const indexes = sqlite
        .prepare("PRAGMA index_list(projects)")
        .all() as { name: string; unique: number }[];
      expect(indexes).toContainEqual(
        expect.objectContaining({
          name: 'projects_canonical_memory_project_id_unique_idx',
          unique: 1,
        }),
      );

      const foreignKeys = sqlite
        .prepare("PRAGMA foreign_key_list(projects)")
        .all() as { from: string; table: string; to: string; on_delete: string }[];
      expect(foreignKeys).toContainEqual(
        expect.objectContaining({
          from: 'canonical_memory_project_id',
          table: 'memory_projects',
          to: 'project_id',
          on_delete: 'SET NULL',
        }),
      );

      const userId = 'test-user-project-folder-link';
      db.insert(schema.users).values({
        id: userId,
        email: 'project-folder@example.com',
        passwordHash: 'hash789',
        name: 'Project Folder Test User',
      }).run();

      db.insert(schema.memoryProjects).values({
        projectId: 'memory-project-1',
        userId,
        name: 'Canonical continuity',
      }).run();

      db.insert(schema.projects).values({
        id: 'folder-with-canonical',
        userId,
        name: 'Folder with canonical continuity',
        canonicalMemoryProjectId: 'memory-project-1',
      }).run();

      db.insert(schema.projects).values([
        {
          id: 'folder-without-canonical-1',
          userId,
          name: 'Unlinked folder one',
        },
        {
          id: 'folder-without-canonical-2',
          userId,
          name: 'Unlinked folder two',
        },
      ]).run();

      expect(() =>
        db.insert(schema.projects).values({
          id: 'duplicate-folder-canonical',
          userId,
          name: 'Duplicate canonical continuity',
          canonicalMemoryProjectId: 'memory-project-1',
        }).run(),
      ).toThrow();
    });
  });

  describe('conversation_summaries table', () => {
    it('stores one summary per conversation and cascades with conversation deletion', () => {
      const columns = sqlite
        .prepare("PRAGMA table_info(conversation_summaries)")
        .all() as { name: string; pk: number }[];
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          'conversation_id',
          'user_id',
          'summary',
          'source',
          'created_at',
          'updated_at',
        ]),
      );
      expect(columns.find((column) => column.name === 'conversation_id')?.pk).toBe(1);

      const foreignKeys = sqlite
        .prepare("PRAGMA foreign_key_list(conversation_summaries)")
        .all() as { from: string; table: string; to: string; on_delete: string }[];
      expect(foreignKeys).toContainEqual(
        expect.objectContaining({
          from: 'conversation_id',
          table: 'conversations',
          to: 'id',
          on_delete: 'CASCADE',
        }),
      );

      const userId = 'test-user-conversation-summary';
      db.insert(schema.users).values({
        id: userId,
        email: 'conversation-summary@example.com',
        passwordHash: 'hash-summary',
      }).run();
      db.insert(schema.conversations).values({
        id: 'conversation-summary-cascade',
        userId,
        title: 'Summary cascade test',
      }).run();
      db.insert(schema.conversationSummaries).values({
        conversationId: 'conversation-summary-cascade',
        userId,
        summary: 'Durable conversation summary.',
      }).run();

      db.delete(schema.conversations)
        .where(eq(schema.conversations.id, 'conversation-summary-cascade'))
        .run();

      const summary = db.select().from(schema.conversationSummaries)
        .where(eq(schema.conversationSummaries.conversationId, 'conversation-summary-cascade'))
        .get();
      expect(summary).toBeUndefined();
    });
  });
});
