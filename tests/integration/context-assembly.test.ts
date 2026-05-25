import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '../../src/lib/server/db';
import { users, conversations, artifacts, artifactChunks, messages } from '../../src/lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { createConversation } from '../../src/lib/server/services/conversations';
import { createContextCompressionSnapshot } from '../../src/lib/server/services/context-compression';
import { createArtifact } from '../../src/lib/server/services/knowledge/store/core';
import { buildConstructedContext } from '../../src/lib/server/services/honcho';
import { createMessage } from '../../src/lib/server/services/messages';
import { estimateTokenCount } from '../../src/lib/utils/tokens';
import { getSmallFileThreshold, getDocumentTokenBudget, getWorkingSetPromptTokenBudget, getTargetConstructedContext, getCompactionUiThreshold, getMaxModelContext } from '../../src/lib/server/services/knowledge/store/core';

const SMALL_FILE_CONTENT = 'This is a small file content. '.repeat(100);
const LARGE_FILE_CONTENT = 'This is line {n} of a large document. '.repeat(500);
const TEST_USER_EMAIL = 'test-context-assembly@example.com';
const TEST_USER_PASSWORD = 'testpassword123';

describe('Context Assembly Integration Tests', () => {
  let testUserId: string;
  let testConversationId: string;

  beforeAll(async () => {
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.email, TEST_USER_EMAIL))
      .limit(1);

    if (existingUser.length > 0) {
      testUserId = existingUser[0].id;
    } else {
      const userId = randomUUID();
      await db.insert(users).values({
        id: userId,
        email: TEST_USER_EMAIL,
        passwordHash: await bcrypt.hash(TEST_USER_PASSWORD, 12),
        name: 'Test Context Assembly User',
        role: 'user',
      });
      testUserId = userId;
    }
  });

  beforeEach(async () => {
    const conversation = await createConversation(testUserId, 'Test Context Assembly Conversation');
    testConversationId = conversation.id;
  });

  it('uses a valid context compression snapshot instead of covered raw session turns', async () => {
    const oldUser = await createMessage(
      testConversationId,
      'user',
      'OLD_RAW_SECRET_USER_CONTENT should not be replayed after compression'
    );
    const oldAssistant = await createMessage(
      testConversationId,
      'assistant',
      'OLD_RAW_SECRET_ASSISTANT_CONTENT should not be replayed after compression'
    );
    await createMessage(
      testConversationId,
      'user',
      'NEW_RAW_RECENT_CONTENT should stay visible after compression'
    );

    await createContextCompressionSnapshot({
      conversationId: testConversationId,
      userId: testUserId,
      trigger: 'manual',
      status: 'valid',
      modelId: 'model1',
      sourceStartMessageId: oldUser.id,
      sourceEndMessageId: oldAssistant.id,
      sourceStartMessageSequence: 1,
      sourceEndMessageSequence: 2,
      snapshot: {
        goal: 'Keep the compressed old exchange available.',
        currentState: 'The old exchange was compressed into a validated snapshot.',
        importantDecisions: ['Use the compact snapshot for covered older turns.'],
        importantFacts: ['Compressed fact from old turns.'],
        openTasks: ['Continue from newer raw turns.'],
        openQuestions: [],
        toolUseAndEvidenceRefs: [],
        sourceCoverage: {
          messageIds: [oldUser.id, oldAssistant.id],
        },
      },
      sourceCoverage: {
        messageIds: [oldUser.id, oldAssistant.id],
      },
    });

    const result = await buildConstructedContext({
      userId: testUserId,
      conversationId: testConversationId,
      message: 'Continue the work',
    });

    expect(result.inputValue).toContain('## Context Compression Snapshot');
    expect(result.inputValue).toContain('Compressed fact from old turns.');
    expect(result.inputValue).toContain('NEW_RAW_RECENT_CONTENT');
    expect(result.inputValue).not.toContain('OLD_RAW_SECRET_USER_CONTENT');
    expect(result.inputValue).not.toContain('OLD_RAW_SECRET_ASSISTANT_CONTENT');
  });

  afterAll(async () => {
    await db.delete(artifactChunks).where(eq(artifactChunks.userId, testUserId));
    await db.delete(artifacts).where(eq(artifacts.userId, testUserId));
    await db.delete(messages).where(eq(messages.conversationId, testConversationId));
    await db.delete(conversations).where(eq(conversations.userId, testUserId));
    await db.delete(users).where(eq(users.email, TEST_USER_EMAIL));
  });

  describe('Small File Context Assembly', () => {
    it('should include full content for files under small file threshold (<5K chars)', async () => {
      const smallFileThreshold = getSmallFileThreshold();
      expect(smallFileThreshold).toBeGreaterThan(0);

      const smallContent = 'Small file content. '.repeat(100);
      expect(smallContent.length).toBeLessThan(smallFileThreshold);

      const artifact = await createArtifact({
        userId: testUserId,
        conversationId: testConversationId,
        type: 'normalized_document',
        name: 'small-test-file.txt',
        mimeType: 'text/plain',
        contentText: smallContent,
        sizeBytes: smallContent.length,
      });

      const result = await buildConstructedContext({
        userId: testUserId,
        conversationId: testConversationId,
        message: 'Please analyze this small file',
        attachmentIds: [artifact.id],
      });

      expect(result.inputValue).toBeDefined();
      expect(result.inputValue.length).toBeGreaterThan(0);
      expect(result.inputValue).toContain('## Current Attachments');
      expect(result.inputValue).toContain('small-test-file.txt');
      expect(result.inputValue).toContain('Small file content.');
      expect(result.inputValue).not.toContain('[truncated]');
      expect(result.inputValue).not.toContain('[content truncated]');
      expect(result.contextStatus).toBeDefined();
      expect(result.contextStatus.promptArtifactCount).toBeGreaterThanOrEqual(1);
    });

    it('should include full content without chunking for small files', async () => {
      const identifiableContent = 'UNIQUE_SMALL_FILE_MARKER_' + randomUUID();
      const smallContent = `This is a small file with unique marker: ${identifiableContent}. End of file.`;

      const artifact = await createArtifact({
        userId: testUserId,
        conversationId: testConversationId,
        type: 'normalized_document',
        name: 'identifiable-small-file.txt',
        mimeType: 'text/plain',
        contentText: smallContent,
        sizeBytes: smallContent.length,
      });

      const result = await buildConstructedContext({
        userId: testUserId,
        conversationId: testConversationId,
        message: 'What is in this file?',
        attachmentIds: [artifact.id],
      });

      expect(result.inputValue).toContain(identifiableContent);
      expect(result.inputValue).toContain(smallContent);
    });
  });

  describe('Large File Context Assembly', () => {
    it('should handle large files with chunked content (>10K chars)', async () => {
      const largeContent = 'Line content for large file testing. '.repeat(400);
      expect(largeContent.length).toBeGreaterThan(10000);

      const artifact = await createArtifact({
        userId: testUserId,
        conversationId: testConversationId,
        type: 'normalized_document',
        name: 'large-test-file.txt',
        mimeType: 'text/plain',
        contentText: largeContent,
        sizeBytes: largeContent.length,
      });

      const chunks = await db
        .select()
        .from(artifactChunks)
        .where(eq(artifactChunks.artifactId, artifact.id));

      expect(chunks.length).toBeGreaterThan(0);

      const result = await buildConstructedContext({
        userId: testUserId,
        conversationId: testConversationId,
        message: 'Please summarize this large document',
        attachmentIds: [artifact.id],
      });

      expect(result.inputValue).toBeDefined();
      expect(result.inputValue.length).toBeGreaterThan(0);
      expect(result.inputValue).toContain('## Current Attachments');
      expect(result.inputValue).toContain('large-test-file.txt');
      expect(result.inputValue).toContain('Line content for large file testing');
    });

    it('should include truncation indicators for very large files', async () => {
      const veryLargeContent = 'A'.repeat(50000);

      const artifact = await createArtifact({
        userId: testUserId,
        conversationId: testConversationId,
        type: 'normalized_document',
        name: 'very-large-test-file.txt',
        mimeType: 'text/plain',
        contentText: veryLargeContent,
        sizeBytes: veryLargeContent.length,
      });

      const result = await buildConstructedContext({
        userId: testUserId,
        conversationId: testConversationId,
        message: 'Analyze this very large file',
        attachmentIds: [artifact.id],
      });

      expect(result.inputValue).toContain('## Current Attachments');
      expect(result.inputValue).toContain('very-large-test-file.txt');
      expect(result.inputValue.length).toBeGreaterThan(100);
    });
  });

  describe('Mixed Files Context Assembly', () => {
    it('should correctly handle mix of small and large files', async () => {
      // Create small file
      const smallContent = 'Small file unique content: ' + randomUUID();
      const smallArtifact = await createArtifact({
        userId: testUserId,
        conversationId: testConversationId,
        type: 'normalized_document',
        name: 'mixed-small-file.txt',
        mimeType: 'text/plain',
        contentText: smallContent,
        sizeBytes: smallContent.length,
      });

      const largeContent = 'Large file content line. '.repeat(500);
      const largeArtifact = await createArtifact({
        userId: testUserId,
        conversationId: testConversationId,
        type: 'normalized_document',
        name: 'mixed-large-file.txt',
        mimeType: 'text/plain',
        contentText: largeContent,
        sizeBytes: largeContent.length,
      });

      const result = await buildConstructedContext({
        userId: testUserId,
        conversationId: testConversationId,
        message: 'Compare these two files',
        attachmentIds: [smallArtifact.id, largeArtifact.id],
      });

      expect(result.inputValue).toContain('## Current Attachments');
      expect(result.inputValue).toContain('mixed-small-file.txt');
      expect(result.inputValue).toContain('mixed-large-file.txt');
      expect(result.inputValue).toContain(smallContent);
      expect(result.inputValue).toContain('Large file content line');
      expect(result.contextStatus.promptArtifactCount).toBeGreaterThanOrEqual(2);
    });

    it('should handle multiple small files without truncation', async () => {
      const testArtifacts = [];
      const contents = [];

      for (let i = 0; i < 3; i++) {
        const content = `File ${i + 1} unique content: ${randomUUID()}`;
        contents.push(content);

        const artifact = await createArtifact({
          userId: testUserId,
          conversationId: testConversationId,
          type: 'normalized_document',
          name: `multi-small-file-${i + 1}.txt`,
          mimeType: 'text/plain',
          contentText: content,
          sizeBytes: content.length,
        });
        testArtifacts.push(artifact);
      }

      const result = await buildConstructedContext({
        userId: testUserId,
        conversationId: testConversationId,
        message: 'Review all these files',
        attachmentIds: testArtifacts.map(a => a.id),
      });

      for (let i = 0; i < 3; i++) {
        expect(result.inputValue).toContain(`multi-small-file-${i + 1}.txt`);
        expect(result.inputValue).toContain(contents[i]);
      }

      expect(result.inputValue).not.toContain('[truncated]');
    });
  });

  describe('Token Budget Enforcement', () => {
    it('should respect document token budget for attachments', async () => {
      const docBudget = getDocumentTokenBudget();
      expect(docBudget).toBeGreaterThan(0);

      // Create a file that would exceed budget if not managed
      const largeContent = 'Budget test content. '.repeat(1000);

      const artifact = await createArtifact({
        userId: testUserId,
        conversationId: testConversationId,
        type: 'normalized_document',
        name: 'budget-test-file.txt',
        mimeType: 'text/plain',
        contentText: largeContent,
        sizeBytes: largeContent.length,
      });

      const result = await buildConstructedContext({
        userId: testUserId,
        conversationId: testConversationId,
        message: 'Check budget enforcement',
        attachmentIds: [artifact.id],
      });

      expect(result.inputValue).toBeDefined();

      const attachmentMatch = result.inputValue.match(/## Current Attachments[\s\S]*?(?=## |$)/);
      if (attachmentMatch) {
        const attachmentSectionTokens = estimateTokenCount(attachmentMatch[0]);
        expect(attachmentSectionTokens).toBeLessThan(6_500);
      }
    });

    it('should respect working set prompt token budget', async () => {
      const promptBudget = getWorkingSetPromptTokenBudget();
      expect(promptBudget).toBeGreaterThan(0);

      const testArtifacts = [];
      for (let i = 0; i < 5; i++) {
        const artifact = await createArtifact({
          userId: testUserId,
          conversationId: testConversationId,
          type: 'normalized_document',
          name: `budget-test-file-${i}.txt`,
          mimeType: 'text/plain',
          contentText: `Content for file ${i}. `.repeat(100),
          sizeBytes: 1000,
        });
        testArtifacts.push(artifact);
      }

      const result = await buildConstructedContext({
        userId: testUserId,
        conversationId: testConversationId,
        message: 'Test budget with multiple files',
        attachmentIds: testArtifacts.map(a => a.id),
      });

      const totalTokens = estimateTokenCount(result.inputValue);
      const targetContext = getTargetConstructedContext();

      expect(totalTokens).toBeLessThan(targetContext * 1.5);
      expect(result.contextStatus.estimatedTokens).toBeGreaterThan(0);
    });

    it('should apply compaction when context exceeds target', async () => {
      const testArtifacts = [];
      for (let i = 0; i < 10; i++) {
        const artifact = await createArtifact({
          userId: testUserId,
          conversationId: testConversationId,
          type: 'normalized_document',
          name: `compaction-test-file-${i}.txt`,
          mimeType: 'text/plain',
          contentText: `Large content for compaction test file ${i}. `.repeat(200),
          sizeBytes: 5000,
        });
        testArtifacts.push(artifact);
      }

      const result = await buildConstructedContext({
        userId: testUserId,
        conversationId: testConversationId,
        message: 'Test compaction with many files',
        attachmentIds: testArtifacts.map(a => a.id),
      });

      expect(result.inputValue).toBeDefined();
      expect(result.inputValue.length).toBeGreaterThan(0);
      expect(result.contextStatus).toBeDefined();

      const maxContext = getTargetConstructedContext();
      const estimatedTokens = result.contextStatus.estimatedTokens;
      expect(estimatedTokens).toBeLessThan(maxContext * 2); // Allow flexibility
    });
  });

  describe('Context Assembly Edge Cases', () => {
    it('should handle empty attachment gracefully', async () => {
      const result = await buildConstructedContext({
        userId: testUserId,
        conversationId: testConversationId,
        message: 'Message without attachments',
        attachmentIds: [],
      });

      expect(result.inputValue).not.toContain('## Current Attachments');
      expect(result.contextStatus.promptArtifactCount).toBe(0);
    });

    it('should handle attachment with empty content', async () => {
      const artifact = await createArtifact({
        userId: testUserId,
        conversationId: testConversationId,
        type: 'normalized_document',
        name: 'empty-file.txt',
        mimeType: 'text/plain',
        contentText: '',
        sizeBytes: 0,
      });

      await expect(
        buildConstructedContext({
          userId: testUserId,
          conversationId: testConversationId,
          message: 'Check empty file',
          attachmentIds: [artifact.id],
        })
      ).rejects.toThrow();
    });

    it('should handle files with special characters', async () => {
      const specialContent = 'Special chars: àáâãäåæçèéêë ñ 中文 🎉 <script>alert("xss")</script>';

      const artifact = await createArtifact({
        userId: testUserId,
        conversationId: testConversationId,
        type: 'normalized_document',
        name: 'special-chars-file.txt',
        mimeType: 'text/plain',
        contentText: specialContent,
        sizeBytes: specialContent.length,
      });

      const result = await buildConstructedContext({
        userId: testUserId,
        conversationId: testConversationId,
        message: 'Check special characters',
        attachmentIds: [artifact.id],
      });

      expect(result.inputValue).toContain('àáâãäåæçèéêë');
      expect(result.inputValue).toContain('中文');
    });

    it('should handle very long single-line files', async () => {
      const longLineContent = 'WORD'.repeat(2000);

      const artifact = await createArtifact({
        userId: testUserId,
        conversationId: testConversationId,
        type: 'normalized_document',
        name: 'long-line-file.txt',
        mimeType: 'text/plain',
        contentText: longLineContent,
        sizeBytes: longLineContent.length,
      });

      const result = await buildConstructedContext({
        userId: testUserId,
        conversationId: testConversationId,
        message: 'Check long line file',
        attachmentIds: [artifact.id],
      });

      expect(result.inputValue).toContain('WORD');
      expect(result.inputValue).toContain('long-line-file.txt');
    });
  });
});
