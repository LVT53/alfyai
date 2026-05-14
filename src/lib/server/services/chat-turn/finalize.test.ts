import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	mockMirrorMessage,
	mockMirrorWorkCapsuleConclusion,
	mockRefreshConversationSummary,
	mockRunUserMemoryMaintenance,
} = vi.hoisted(() => ({
	mockMirrorMessage: vi.fn(async () => undefined),
	mockMirrorWorkCapsuleConclusion: vi.fn(async () => undefined),
	mockRefreshConversationSummary: vi.fn(async () => undefined),
	mockRunUserMemoryMaintenance: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/services/active-state', () => ({
	hasRecentUserCorrectionSignal: vi.fn(() => false),
}));

vi.mock('$lib/server/services/analytics', () => ({
	recordMessageAnalytics: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/services/conversation-drafts', () => ({
	clearConversationDraft: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/services/conversation-summaries', () => ({
	refreshConversationSummary: mockRefreshConversationSummary,
}));

vi.mock('$lib/server/services/honcho', () => ({
	mirrorMessage: mockMirrorMessage,
	mirrorWorkCapsuleConclusion: mockMirrorWorkCapsuleConclusion,
}));

vi.mock('$lib/server/services/knowledge', () => ({
	attachArtifactsToMessage: vi.fn(async () => undefined),
	createGeneratedOutputArtifact: vi.fn(async () => null),
	getArtifactsForUser: vi.fn(async () => []),
	getConversationWorkingSet: vi.fn(async () => []),
	listConversationSourceArtifactIds: vi.fn(async () => []),
	refreshConversationWorkingSet: vi.fn(async () => []),
	upsertWorkCapsule: vi.fn(async () => null),
}));

vi.mock('$lib/server/services/knowledge/store', () => ({
	parseWorkingDocumentMetadata: vi.fn(() => ({})),
}));

vi.mock('$lib/server/services/memory-events', () => ({
	recordMemoryEvent: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/services/memory-maintenance', () => ({
	runUserMemoryMaintenance: mockRunUserMemoryMaintenance,
}));

vi.mock('$lib/server/services/message-evidence', () => ({
	buildAssistantEvidenceSummary: vi.fn(async () => null),
}));

vi.mock('$lib/server/services/messages', () => ({
	updateMessageEvidence: vi.fn(async () => undefined),
	updateMessageHonchoMetadata: vi.fn(async () => undefined),
	updateMessageWebCitationAudit: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/services/task-state', () => ({
	applyProjectContinuitySignalFromMessage: vi.fn(async () => undefined),
	attachContinuityToTaskState: vi.fn(async (_userId, taskState) => taskState),
	getContextDebugState: vi.fn(async () => null),
	getConversationTaskState: vi.fn(async () => null),
	syncTaskContinuityFromTaskState: vi.fn(async () => undefined),
	updateTaskStateCheckpoint: vi.fn(async () => null),
}));

vi.mock('$lib/server/services/web-citation-audit', () => ({
	buildWebCitationAudit: vi.fn(() => null),
}));

describe('runPostTurnTasks', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('logs summary refresh failures without rejecting post-turn tasks', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		mockRefreshConversationSummary.mockRejectedValueOnce(new Error('summary offline'));
		const { runPostTurnTasks } = await import('./finalize');

		await expect(
			runPostTurnTasks({
				logPrefix: '[SEND]',
				userId: 'user-1',
				conversationId: 'conv-1',
				upstreamMessage: 'upstream prompt payload',
				userMessage: 'normalized user message',
				assistantResponse: 'visible assistant response',
				assistantMirrorContent: 'assistant mirror text',
				maintenanceReason: 'chat_send',
			})
		).resolves.toBeUndefined();

		expect(mockRefreshConversationSummary).toHaveBeenCalledWith({
			userId: 'user-1',
			conversationId: 'conv-1',
			userMessage: 'normalized user message',
			assistantResponse: 'visible assistant response',
		});
		expect(mockRunUserMemoryMaintenance).toHaveBeenCalledWith('user-1', 'chat_send');
		expect(errorSpy).toHaveBeenCalledWith(
			'[SEND] Conversation summary refresh failed:',
			expect.any(Error)
		);

		errorSpy.mockRestore();
	});
});
