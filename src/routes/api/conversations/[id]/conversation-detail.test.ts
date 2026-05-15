import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth/hooks', () => ({
	requireAuth: vi.fn(),
}));

vi.mock('$lib/server/services/conversations', () => ({
	getConversation: vi.fn(),
	updateConversationTitle: vi.fn(),
	moveConversationToProject: vi.fn(),
}));

vi.mock('$lib/server/services/messages', () => ({
	listMessages: vi.fn(),
}));

vi.mock('$lib/server/services/conversation-forks', () => ({
	getConversationForkOrigin: vi.fn(),
	listChildForksBySourceMessages: vi.fn(),
}));

vi.mock('$lib/server/services/knowledge', () => ({
	getConversationWorkingSet: vi.fn(),
	getConversationContextStatus: vi.fn(),
	listConversationArtifacts: vi.fn(),
}));

vi.mock('$lib/server/services/task-state', () => ({
	attachContinuityToTaskState: vi.fn(async (_userId: string, taskState: unknown) => taskState),
	getContextDebugState: vi.fn(),
	getConversationTaskState: vi.fn(),
	getProjectReferenceContext: vi.fn(),
}));

vi.mock('$lib/server/services/chat-files', () => ({
	getChatFiles: vi.fn(),
}));

vi.mock('$lib/server/services/conversation-drafts', () => ({
	getConversationDraft: vi.fn(),
}));

vi.mock('$lib/server/services/analytics', () => ({
	getConversationCostSummary: vi.fn(),
}));

vi.mock('$lib/server/services/file-production', () => ({
	listConversationFileProductionJobs: vi.fn(),
}));

vi.mock('$lib/server/services/deep-research', () => ({
	listConversationDeepResearchJobs: vi.fn(),
}));

vi.mock('$lib/server/services/skills/sessions', () => ({
	getActiveSkillSession: vi.fn(),
	serializePublicSkillSession: (session: any) => {
		if (!session) return null;
		const { skillInstructions: _skillInstructions, ...publicSession } = session;
		return publicSession;
	},
}));

import { GET, PATCH } from './+server';
import { requireAuth } from '$lib/server/auth/hooks';
import { getConversation, moveConversationToProject } from '$lib/server/services/conversations';
import { listMessages } from '$lib/server/services/messages';
import {
	getConversationForkOrigin,
	listChildForksBySourceMessages,
} from '$lib/server/services/conversation-forks';
import {
	getConversationWorkingSet,
	getConversationContextStatus,
	listConversationArtifacts,
} from '$lib/server/services/knowledge';
import {
	attachContinuityToTaskState,
	getContextDebugState,
	getConversationTaskState,
	getProjectReferenceContext,
} from '$lib/server/services/task-state';
import { getChatFiles } from '$lib/server/services/chat-files';
import { getConversationDraft } from '$lib/server/services/conversation-drafts';
import { getConversationCostSummary } from '$lib/server/services/analytics';
import { listConversationFileProductionJobs } from '$lib/server/services/file-production';
import { listConversationDeepResearchJobs } from '$lib/server/services/deep-research';
import { getActiveSkillSession } from '$lib/server/services/skills/sessions';

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockMoveConversationToProject = moveConversationToProject as ReturnType<typeof vi.fn>;
const mockListMessages = listMessages as ReturnType<typeof vi.fn>;
const mockGetConversationForkOrigin = getConversationForkOrigin as ReturnType<typeof vi.fn>;
const mockListChildForksBySourceMessages =
	listChildForksBySourceMessages as ReturnType<typeof vi.fn>;
const mockListConversationArtifacts = listConversationArtifacts as ReturnType<typeof vi.fn>;
const mockGetConversationWorkingSet = getConversationWorkingSet as ReturnType<typeof vi.fn>;
const mockGetConversationContextStatus = getConversationContextStatus as ReturnType<typeof vi.fn>;
const mockGetConversationTaskState = getConversationTaskState as ReturnType<typeof vi.fn>;
const mockGetContextDebugState = getContextDebugState as ReturnType<typeof vi.fn>;
const mockAttachContinuityToTaskState = attachContinuityToTaskState as ReturnType<typeof vi.fn>;
const mockGetProjectReferenceContext = getProjectReferenceContext as ReturnType<typeof vi.fn>;
const mockGetChatFiles = getChatFiles as ReturnType<typeof vi.fn>;
const mockGetConversationDraft = getConversationDraft as ReturnType<typeof vi.fn>;
const mockGetConversationCostSummary = getConversationCostSummary as ReturnType<typeof vi.fn>;
const mockListConversationFileProductionJobs =
	listConversationFileProductionJobs as ReturnType<typeof vi.fn>;
const mockListConversationDeepResearchJobs =
	listConversationDeepResearchJobs as ReturnType<typeof vi.fn>;
const mockGetActiveSkillSession = getActiveSkillSession as ReturnType<typeof vi.fn>;

function makeEvent(user = { id: 'user-1' }, id = 'conv-1') {
	return {
		request: new Request(`http://localhost/api/conversations/${id}`),
		locals: { user },
		params: { id },
		url: new URL(`http://localhost/api/conversations/${id}`),
		route: { id: '/api/conversations/[id]' },
	} as any;
}

function makePatchEvent(body: unknown, user = { id: 'user-1' }, id = 'conv-1') {
	return {
		request: new Request(`http://localhost/api/conversations/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
		locals: { user },
		params: { id },
		url: new URL(`http://localhost/api/conversations/${id}`),
		route: { id: '/api/conversations/[id]' },
	} as any;
}

describe('GET /api/conversations/[id]', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConversation.mockResolvedValue({
			id: 'conv-1',
			title: 'Quarterly report',
			projectId: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		mockListMessages.mockResolvedValue([]);
		mockGetConversationForkOrigin.mockResolvedValue(null);
		mockListChildForksBySourceMessages.mockResolvedValue({});
		mockListConversationArtifacts.mockResolvedValue([]);
		mockGetConversationWorkingSet.mockResolvedValue([]);
		mockGetConversationContextStatus.mockResolvedValue(null);
		mockGetConversationTaskState.mockResolvedValue(null);
		mockGetContextDebugState.mockResolvedValue(null);
		mockGetProjectReferenceContext.mockResolvedValue(null);
		mockAttachContinuityToTaskState.mockImplementation(async (_userId: string, taskState: unknown) => taskState);
		mockGetConversationDraft.mockResolvedValue(null);
		mockGetChatFiles.mockResolvedValue([]);
		mockGetConversationCostSummary.mockResolvedValue({
			totalCostUsdMicros: 0,
			totalTokens: 0,
		});
		mockListConversationFileProductionJobs.mockResolvedValue([
			{
				id: 'job-file-1',
				conversationId: 'conv-1',
				assistantMessageId: 'assistant-1',
				title: 'report.pdf',
				status: 'succeeded',
				stage: null,
				createdAt: 1_777_140_001_000,
				updatedAt: 1_777_140_001_000,
				files: [
					{
						id: 'file-1',
						filename: 'report.pdf',
						mimeType: 'application/pdf',
						sizeBytes: 2048,
						downloadUrl: '/api/chat/files/file-1/download',
						previewUrl: '/api/chat/files/file-1/preview',
						artifactId: 'artifact-1',
						documentFamilyId: 'family-1',
						documentFamilyStatus: 'active',
						documentLabel: 'Quarterly report',
						documentRole: null,
						versionNumber: 1,
						originConversationId: 'conv-1',
						originAssistantMessageId: 'assistant-1',
						sourceChatFileId: 'file-1',
					},
				],
				warnings: [],
				error: null,
			},
		]);
		mockListConversationDeepResearchJobs.mockResolvedValue([]);
		mockGetActiveSkillSession.mockResolvedValue(null);
	});

	it('returns the active skill session with conversation detail', async () => {
		mockGetActiveSkillSession.mockResolvedValue({
			id: 'skill-session-1',
			conversationId: 'conv-1',
			userId: 'user-1',
			status: 'active',
			skillOwnership: 'system',
			skillDisplayName: 'Meeting critic',
			skillInstructions: 'SYSTEM_SENTINEL: hidden system skill instructions',
		});

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockGetActiveSkillSession).toHaveBeenCalledWith('user-1', 'conv-1');
		expect(data.activeSkillSession).toMatchObject({
			id: 'skill-session-1',
			status: 'active',
			skillDisplayName: 'Meeting critic',
		});
		expect(data.activeSkillSession).not.toHaveProperty('skillInstructions');
		expect(JSON.stringify(data)).not.toContain('SYSTEM_SENTINEL');
	});

	it('returns fork origin metadata with conversation detail', async () => {
		mockGetConversationForkOrigin.mockResolvedValue({
			forkConversationId: 'conv-1',
			sourceConversationId: 'source-conv',
			sourceAssistantMessageId: 'source-assistant-1',
			sourceConversationIdAvailable: true,
			sourceAssistantMessageIdAvailable: true,
			copiedForkPointMessageId: 'fork-assistant-1',
			sourceTitle: 'Source title',
			forkSequence: 1,
			createdAt: 1,
		});

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockGetConversationForkOrigin).toHaveBeenCalledWith('conv-1');
		expect(data.forkOrigin).toMatchObject({
			copiedForkPointMessageId: 'fork-assistant-1',
			sourceTitle: 'Source title',
		});
	});

	it('attaches compact child-fork metadata to source assistant messages', async () => {
		mockListMessages.mockResolvedValue([
			{
				id: 'user-1',
				role: 'user',
				content: 'Question',
				timestamp: 1,
			},
			{
				id: 'assistant-1',
				role: 'assistant',
				content: 'Answer',
				timestamp: 2,
			},
		]);
		mockListChildForksBySourceMessages.mockResolvedValue({
			'assistant-1': {
				count: 2,
				forks: [
					{
						conversationId: 'fork-1',
						title: 'Quarterly report (fork 1)',
						forkSequence: 1,
						createdAt: 1,
					},
					{
						conversationId: 'fork-2',
						title: 'Renamed fork',
						forkSequence: 2,
						createdAt: 2,
					},
				],
			},
		});

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockListChildForksBySourceMessages).toHaveBeenCalledWith('user-1', ['assistant-1']);
		expect(data.messages).toEqual([
			expect.objectContaining({ id: 'user-1' }),
			expect.objectContaining({
				id: 'assistant-1',
				sourceForks: {
					count: 2,
					forks: [
						expect.objectContaining({ conversationId: 'fork-1' }),
						expect.objectContaining({ conversationId: 'fork-2', title: 'Renamed fork' }),
					],
				},
			}),
		]);
	});

	it('returns file-production jobs with the conversation detail', async () => {
		mockListConversationArtifacts.mockResolvedValue([
			{
				id: 'artifact-attached-1',
				type: 'document',
				retrievalClass: 'durable',
				name: 'Attached source',
				mimeType: 'text/plain',
				sizeBytes: 1024,
				conversationId: 'conv-1',
				summary: null,
				createdAt: 1_777_140_000_000,
				updatedAt: 1_777_140_000_000,
			},
		]);
		mockGetConversationWorkingSet.mockResolvedValue([
			{
				id: 'artifact-working-1',
				type: 'document',
				retrievalClass: 'durable',
				name: 'Working source',
				mimeType: 'text/plain',
				sizeBytes: 2048,
				conversationId: 'conv-1',
				summary: null,
				createdAt: 1_777_140_000_000,
				updatedAt: 1_777_140_000_000,
			},
		]);
		mockGetConversationContextStatus.mockResolvedValue({
			conversationId: 'conv-1',
			userId: 'user-1',
			estimatedTokens: 70_000,
			maxContextTokens: 100_000,
			thresholdTokens: 80_000,
			targetTokens: 90_000,
			compactionApplied: true,
			compactionMode: 'deterministic',
			routingStage: 'semantic',
			routingConfidence: 0.82,
			verificationStatus: 'passed',
			layersUsed: ['working_set'],
			workingSetCount: 1,
			workingSetArtifactIds: ['artifact-working-1'],
			workingSetApplied: true,
			taskStateApplied: false,
			promptArtifactCount: 1,
			recentTurnCount: 2,
			summary: null,
			updatedAt: 1_777_140_000_000,
		});
		mockGetContextDebugState.mockResolvedValue({
			activeTaskId: null,
			activeTaskObjective: null,
			taskLocked: false,
			routingStage: 'semantic',
			routingConfidence: 0.82,
			verificationStatus: 'passed',
			selectedEvidence: [],
			selectedEvidenceBySource: [],
			pinnedEvidence: [
				{
					artifactId: 'artifact-pinned-1',
					name: 'Pinned source',
					artifactType: 'document',
					sourceType: 'document',
					role: 'pinned',
					origin: 'user',
					confidence: 1,
					reason: 'Pinned by user',
				},
			],
			excludedEvidence: [],
			honcho: null,
		});

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockListConversationFileProductionJobs).toHaveBeenCalledWith('user-1', 'conv-1');
		expect(data.contextSources).toMatchObject({
			conversationId: 'conv-1',
			userId: 'user-1',
			activeCount: 3,
			pinnedCount: 1,
			excludedCount: 0,
			reduced: true,
			compacted: true,
		});
		expect(data.contextSources.groups.map((group: { kind: string }) => group.kind)).toEqual([
			'attachments',
			'working_set',
			'pinned',
		]);
		expect(data.generatedFiles).toEqual([]);
		expect(data.fileProductionJobs).toEqual([
			expect.objectContaining({
				id: 'job-file-1',
				status: 'succeeded',
				files: [
					expect.objectContaining({
						id: 'file-1',
						filename: 'report.pdf',
						downloadUrl: '/api/chat/files/file-1/download',
					}),
				],
			}),
		]);
	});

	it('returns deep research jobs with the conversation detail', async () => {
		mockListConversationDeepResearchJobs.mockResolvedValue([
			{
				id: 'research-job-1',
				conversationId: 'conv-1',
				triggerMessageId: 'user-1',
				depth: 'standard',
				status: 'awaiting_plan',
				stage: 'job_shell_created',
				title: 'Research battery recycling policy',
				userRequest: 'Research battery recycling policy',
				createdAt: 1_777_140_002_000,
				updatedAt: 1_777_140_002_000,
				completedAt: null,
				cancelledAt: null,
				sourceCounts: {
					discovered: 3,
					reviewed: 2,
					cited: 1,
				},
				sources: [
					{
						id: 'source-reviewed',
						jobId: 'research-job-1',
						conversationId: 'conv-1',
						status: 'reviewed',
						url: 'https://example.com/reviewed',
						title: 'Reviewed source',
						provider: 'web_search',
						reviewedNote: 'Relevant background source.',
						citationNote: null,
						discoveredAt: '2026-05-05T10:10:00.000Z',
						reviewedAt: '2026-05-05T10:20:00.000Z',
						citedAt: null,
					},
				],
				timeline: [
					{
						id: 'timeline-1',
						jobId: 'research-job-1',
						conversationId: 'conv-1',
						taskId: null,
						stage: 'plan_generation',
						kind: 'plan_generated',
						occurredAt: '2026-05-05T10:01:00.000Z',
						messageKey: 'deepResearch.timeline.planGenerated',
						messageParams: {
							discoveredSources: 0,
							reviewedSources: 0,
							citedSources: 0,
						},
						sourceCounts: {
							discovered: 0,
							reviewed: 0,
							cited: 0,
						},
						assumptions: ['No source-heavy research has started before approval.'],
						warnings: [],
						summary: 'Research Plan drafted for approval.',
						createdAt: '2026-05-05T10:01:00.000Z',
					},
				],
			},
		]);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockListConversationDeepResearchJobs).toHaveBeenCalledWith('user-1', 'conv-1');
		expect(data.deepResearchJobs).toEqual([
			expect.objectContaining({
				id: 'research-job-1',
				title: 'Research battery recycling policy',
				depth: 'standard',
				status: 'awaiting_plan',
				stage: 'job_shell_created',
				timeline: [
					expect.objectContaining({
						stage: 'plan_generation',
						summary: 'Research Plan drafted for approval.',
					}),
				],
				sourceCounts: {
					discovered: 3,
					reviewed: 2,
					cited: 1,
				},
				sources: [
					expect.objectContaining({
						id: 'source-reviewed',
						status: 'reviewed',
						title: 'Reviewed source',
					}),
				],
			}),
		]);
	});

	it('returns compact project folder context sources without promoting siblings into message evidence', async () => {
		const messageEvidenceSummary = {
			status: 'completed',
			items: [
				{
					artifactId: 'artifact-message-evidence',
					title: 'Existing message evidence',
					sourceType: 'document',
				},
			],
		};
		mockListMessages.mockResolvedValue([
			{
				id: 'assistant-1',
				conversationId: 'conv-1',
				role: 'assistant',
				content: 'Here is the answer.',
				createdAt: 1_777_140_000_000,
				evidenceSummary: messageEvidenceSummary,
			},
		]);
		mockGetProjectReferenceContext.mockResolvedValue({
			source: 'project_folder',
			projectId: 'folder-1',
			projectName: 'Launch folder',
			entries: [
				{
					conversationId: 'conv-sibling-1',
					title: 'Pricing notes',
					objective: 'Compare pricing options',
					summary: 'Stable pricing brief.',
				},
				{
					conversationId: 'conv-sibling-2',
					title: 'Rollout plan',
					objective: null,
					summary: null,
				},
			],
			omittedSiblingCount: 1,
		});

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockGetProjectReferenceContext).toHaveBeenCalledWith({
			userId: 'user-1',
			conversationId: 'conv-1',
		});
		expect(data.contextSources.groups).toEqual([
			expect.objectContaining({
				kind: 'project_folder',
				state: 'inferred',
				totalCount: 3,
				items: [
					expect.objectContaining({
						title: 'Launch folder',
						sourceType: 'conversation',
						reason: '2 sibling conversations summarized, 1 more omitted',
						metadata: expect.objectContaining({
							siblingCount: 3,
							includedSiblingCount: 2,
							omittedSiblingCount: 1,
						}),
					}),
				],
			}),
		]);
		expect(data.messages[0].evidenceSummary).toEqual(messageEvidenceSummary);
		expect(data.messages[0].evidenceSummary.items).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceType: 'conversation',
				}),
			])
		);
	});

	it('keeps conversation detail available when project folder awareness lookup fails', async () => {
		mockGetProjectReferenceContext.mockRejectedValue(new Error('folder lookup failed'));

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.contextSources.groups).toEqual([]);
		expect(mockGetProjectReferenceContext).toHaveBeenCalledWith({
			userId: 'user-1',
			conversationId: 'conv-1',
		});
	});
});

describe('PATCH /api/conversations/[id]', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockMoveConversationToProject.mockResolvedValue({
			id: 'conv-1',
			title: 'Quarterly report',
			projectId: 'folder-1',
			createdAt: 1_777_140_000,
			updatedAt: 1_777_140_001,
		});
	});

	it('moves project assignment through the conversation move operation', async () => {
		const response = await PATCH(makePatchEvent({ projectId: 'folder-1' }));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockMoveConversationToProject).toHaveBeenCalledWith('user-1', 'conv-1', 'folder-1');
		expect(data).toMatchObject({
			id: 'conv-1',
			projectId: 'folder-1',
		});
	});
});
