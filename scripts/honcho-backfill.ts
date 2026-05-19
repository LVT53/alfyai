#!/usr/bin/env tsx

// Backfill existing messages to Honcho for long-term memory reasoning.
// Run: npx tsx scripts/honcho-backfill.ts

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

// Set required env vars if not set
if (!process.env.LANGFLOW_API_KEY) process.env.LANGFLOW_API_KEY = 'placeholder';
if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = 'placeholder-secret-32-chars-long!!';

import { db } from '../src/lib/server/db';
import { users, conversations, messages } from '../src/lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getOrCreateSession, mirrorMessage } from '../src/lib/server/services/honcho';
import { messageOrderAsc } from '../src/lib/server/services/message-ordering';
import { repairConversationMessageSequences } from '../src/lib/server/services/message-sequences';

const RATE_LIMIT_MS = 100; // 10 msgs/sec

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const apiKey = process.env.HONCHO_API_KEY;
  const baseUrl = process.env.HONCHO_BASE_URL || 'http://localhost:8000';
  const workspaceName = process.env.HONCHO_WORKSPACE || 'alfyai-prod';
  const identityNamespace = process.env.HONCHO_IDENTITY_NAMESPACE || 'database-path-derived';

  console.log('[BACKFILL] Connecting to Honcho at', baseUrl);
  console.log('[BACKFILL] Workspace:', workspaceName);
  console.log('[BACKFILL] Identity namespace:', identityNamespace);
  if (!apiKey) {
    console.log('[BACKFILL] HONCHO_API_KEY is not set; using local no-auth client mode.');
  }
  if (process.env.HONCHO_ENABLED !== 'true') {
    throw new Error('HONCHO_ENABLED=true is required so the central Honcho adapter mirrors messages.');
  }

  // Get all users
  const allUsers = await db.select().from(users);
  console.log(`[BACKFILL] Found ${allUsers.length} users`);

  let totalMessages = 0;

  for (const user of allUsers) {
    console.log(`\n[BACKFILL] Processing user: ${user.email} (${user.id})`);

    // Get all conversations for this user
    const userConversations = await db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, user.id));

    console.log(`  Conversations: ${userConversations.length}`);

    for (const conv of userConversations) {
      // Route through the central Honcho adapter so backfills use the same
      // namespaced peer/session identities as live traffic.
      const honchoSessionId = await getOrCreateSession(user.id, conv.id);

      // Get all messages in chronological order
      repairConversationMessageSequences(conv.id);
      const convMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conv.id))
        .orderBy(...messageOrderAsc());

      if (convMessages.length === 0) continue;

      console.log(
        `  Conversation "${conv.title}" (${honchoSessionId}): ${convMessages.length} messages`
      );

      for (const message of convMessages) {
        if (!message.content.trim()) continue;
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        await mirrorMessage(user.id, conv.id, message.role, message.content);
        totalMessages += 1;
        await sleep(RATE_LIMIT_MS);
      }
    }
  }

  console.log(`\n[BACKFILL] Done! Mirrored ${totalMessages} messages to Honcho.`);
  console.log('[BACKFILL] Honcho will process these asynchronously for reasoning.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[BACKFILL] Fatal error:', err);
  process.exit(1);
});
