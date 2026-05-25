import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import MessageArea from './MessageArea.svelte';
import type {
	ChatMessage,
	DeepResearchJob,
	DocumentWorkspaceItem,
	FileProductionJob,
} from '$lib/types';

vi.mock('$lib/utils/markdown-loader', () => ({
	prepareCodeHighlighting: async () => undefined,
	renderCodeBlock: async (content: string) => `<pre><code>${content}</code></pre>`,
	renderHighlightedText: async (content: string) => content,
	renderMarkdown: async (content: string) => content.replace(/\*\*(.*?)\*\*/g, '$1'),
}));

Object.defineProperty(window, 'matchMedia', {
	writable: true,
	value: (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => undefined,
		removeListener: () => undefined,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		dispatchEvent: () => false,
	}),
});

Object.defineProperty(HTMLElement.prototype, 'animate', {
	writable: true,
	value: () => ({
		finished: Promise.resolve(),
		cancel: () => undefined,
		finish: () => undefined,
	}),
});

describe('MessageArea', () => {
	beforeEach(() => {
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makeFileProductionJob(
		assistantMessageId: string | null,
		overrides: Partial<FileProductionJob> = {}
	): FileProductionJob {
		const now = Date.now();
		return {
			id: overrides.id ?? `job-${assistantMessageId}`,
			conversationId: 'conv-1',
			assistantMessageId,
			title: overrides.title ?? 'Report',
			status: overrides.status ?? 'succeeded',
			stage: overrides.stage ?? null,
			createdAt: overrides.createdAt ?? now,
			updatedAt: overrides.updatedAt ?? now,
			warnings: overrides.warnings ?? [],
			error: overrides.error ?? null,
			files: overrides.files ?? [
				{
					id: 'file-1',
					filename: 'report.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 2048,
					downloadUrl: '/api/chat/files/file-1/download',
					previewUrl: '/api/chat/files/file-1/preview',
				},
			],
		};
	}

	function makeDeepResearchJob(overrides: Partial<DeepResearchJob> = {}): DeepResearchJob {
		const now = Date.now();
		return {
			id: overrides.id ?? 'research-job-1',
			conversationId: overrides.conversationId ?? 'conv-1',
			triggerMessageId: overrides.triggerMessageId ?? 'user-1',
			depth: overrides.depth ?? 'standard',
			status: overrides.status ?? 'awaiting_plan',
			stage: overrides.stage ?? 'job_shell_created',
			title: overrides.title ?? 'Research battery recycling policy',
			userRequest: overrides.userRequest ?? 'Research battery recycling policy',
			createdAt: overrides.createdAt ?? now,
			updatedAt: overrides.updatedAt ?? now,
			completedAt: overrides.completedAt ?? null,
			cancelledAt: overrides.cancelledAt ?? null,
			...overrides,
		};
	}

	it('preserves the expanded thinking block when a streaming placeholder id is replaced', async () => {
		const initialMessage: ChatMessage = {
			id: 'temp-assistant-id',
			renderKey: 'temp-assistant-id',
			role: 'assistant',
			content: 'Final answer',
			timestamp: Date.now(),
			thinking: 'step one\nstep two',
			thinkingSegments: [{ type: 'text', content: 'step one\nstep two' }],
			isStreaming: true,
			isThinkingStreaming: false,
		};

		const { getByRole, getByText, rerender } = render(MessageArea, {
			messages: [initialMessage],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
		});

		await fireEvent.click(getByRole('button', { name: 'Thought' }));
		expect(getByText(/step one\s+step two/)).toBeTruthy();

		await rerender({
			messages: [
				{
					...initialMessage,
					id: 'persisted-assistant-id',
					renderKey: 'temp-assistant-id',
					isStreaming: false,
				},
			],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
		});

		expect(getByText(/step one\s+step two/)).toBeTruthy();
	});

	it('shows a ready state for empty conversations', () => {
		const { getByText } = render(MessageArea, {
			messages: [],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
		});

		expect(getByText('Conversation Ready')).toBeInTheDocument();
		expect(
			getByText('Your messages and generated files will appear here.')
		).toBeInTheDocument();
	});

	it('adds the measured active skill session height to scroll clearance', () => {
		const message: ChatMessage = {
			id: 'assistant-1',
			role: 'assistant',
			content: 'Ready.',
			timestamp: Date.now(),
		};

		const { container } = render(MessageArea, {
			messages: [message],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			hasActiveSkillSession: true,
			activeSkillSessionHeight: 84,
		});

		const clearance = container.querySelector('.scroll-clearance');
		expect(clearance).toHaveClass('scroll-clearance-active-skill');
		expect(clearance).toHaveStyle({
			'--active-skill-session-height': '84px',
		});
	});

	it('forwards assistant Skill Draft card actions with message and draft ids', async () => {
		const onSaveSkillDraft = vi.fn();
		const onDismissSkillDraft = vi.fn();
		const onPublishSkillDraft = vi.fn();
		const message: ChatMessage = {
			id: 'assistant-1',
			role: 'assistant',
			content: 'I can make this reusable.',
			timestamp: Date.now(),
			skillDrafts: [
				{
					id: 'draft-1',
					status: 'proposed',
					displayName: 'Meeting critic',
					description: 'Review meeting notes.',
					instructions: 'Find missing owners.',
					activationExamples: [],
					durationPolicy: 'next_message',
					questionPolicy: 'none',
					notesPolicy: 'none',
					sourceScope: 'selected_sources_only',
				},
			],
		};

		const { getByRole } = render(MessageArea, {
			messages: [message],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			canPublishSkillDrafts: true,
			onSaveSkillDraft,
			onDismissSkillDraft,
			onPublishSkillDraft,
		});

		await fireEvent.click(getByRole('button', { name: 'Save private skill' }));
		await fireEvent.click(getByRole('button', { name: 'Dismiss draft' }));
		await fireEvent.click(getByRole('button', { name: 'Publish skill' }));

		expect(onSaveSkillDraft).toHaveBeenCalledWith({
			messageId: 'assistant-1',
			draftId: 'draft-1',
		});
		expect(onDismissSkillDraft).toHaveBeenCalledWith({
			messageId: 'assistant-1',
			draftId: 'draft-1',
		});
		expect(onPublishSkillDraft).toHaveBeenCalledWith({
			messageId: 'assistant-1',
			draftId: 'draft-1',
		});
	});

	it('renders a fork boundary marker after the copied fork point message', () => {
		const messages: ChatMessage[] = [
			{
				id: 'fork-user-1',
				role: 'user',
				content: 'Original question',
				timestamp: Date.now(),
			},
			{
				id: 'fork-assistant-1',
				role: 'assistant',
				content: 'Copied answer',
				timestamp: Date.now(),
			},
		];

		const { getByLabelText, getByTestId, getByText } = render(MessageArea, {
			messages,
			conversationId: 'fork-conv',
			isThinkingActive: false,
			contextDebug: null,
			forkOrigin: {
				forkConversationId: 'fork-conv',
				sourceConversationId: 'source-conv',
				sourceAssistantMessageId: 'source-assistant-1',
				sourceConversationIdAvailable: true,
				sourceAssistantMessageIdAvailable: true,
				copiedForkPointMessageId: 'fork-assistant-1',
				sourceTitle: 'Source title',
				forkSequence: 1,
				createdAt: Date.now(),
			},
		});

		expect(getByTestId('fork-boundary-marker')).toBe(getByLabelText('Conversation fork boundary'));
		expect(getByText('Fork starts here')).toBeInTheDocument();
		expect(getByText('Copied from Source title')).toBeInTheDocument();
		expect(getByText('Copied from Source title')).toHaveAttribute(
			'href',
			'/chat/source-conv#message-source-assistant-1',
		);
	});

	it('renders a degraded fork boundary source when the source conversation is unavailable', () => {
		const messages: ChatMessage[] = [
			{
				id: 'fork-assistant-1',
				role: 'assistant',
				content: 'Copied answer',
				timestamp: Date.now(),
			},
		];

		const { getByText, queryByRole } = render(MessageArea, {
			messages,
			conversationId: 'fork-conv',
			isThinkingActive: false,
			contextDebug: null,
			forkOrigin: {
				forkConversationId: 'fork-conv',
				sourceConversationId: 'source-conv',
				sourceAssistantMessageId: 'source-assistant-1',
				sourceConversationIdAvailable: false,
				sourceAssistantMessageIdAvailable: false,
				copiedForkPointMessageId: 'fork-assistant-1',
				sourceTitle: 'Deleted source title',
				forkSequence: 1,
				createdAt: Date.now(),
			},
		});

		expect(getByText('Copied from Deleted source title')).toBeInTheDocument();
		expect(getByText('Source conversation unavailable')).toBeInTheDocument();
		expect(queryByRole('link', { name: /Deleted source title/ })).not.toBeInTheDocument();
	});

	it('renders fork boundary and origin markers with the same lineage row treatment', () => {
		const messages: ChatMessage[] = [
			{
				id: 'fork-assistant-1',
				role: 'assistant',
				content: 'Copied answer',
				timestamp: Date.now(),
				sourceForks: {
					count: 1,
					forks: [
						{
							conversationId: 'child-fork-1',
							title: 'Child fork',
							forkSequence: 1,
							createdAt: Date.now(),
						},
					],
				},
			},
		];

		const { getByTestId } = render(MessageArea, {
			messages,
			conversationId: 'fork-conv',
			isThinkingActive: false,
			contextDebug: null,
			forkOrigin: {
				forkConversationId: 'fork-conv',
				sourceConversationId: 'source-conv',
				sourceAssistantMessageId: 'source-assistant-1',
				sourceConversationIdAvailable: true,
				sourceAssistantMessageIdAvailable: true,
				copiedForkPointMessageId: 'fork-assistant-1',
				sourceTitle: 'Source title',
				forkSequence: 1,
				createdAt: Date.now(),
			},
		});

		const boundaryMarker = getByTestId('fork-boundary-marker');
		const originMarker = getByTestId('fork-origin-marker');
		expect(boundaryMarker).toHaveClass('fork-lineage-marker');
		expect(originMarker).toHaveClass('fork-lineage-marker');
		expect(boundaryMarker.querySelector('.fork-boundary-line')).not.toBeInTheDocument();
		expect(boundaryMarker.querySelector('circle')).not.toBeInTheDocument();
		expect(originMarker.querySelector('circle')).not.toBeInTheDocument();
	});

	it('renders context compression markers as compact timeline events', () => {
		const messages: ChatMessage[] = [
			{
				id: 'message-1',
				role: 'assistant',
				content: 'Earlier answer',
				timestamp: Date.now(),
			},
		];

		const { getByLabelText, getByTestId, getByText } = render(MessageArea, {
			messages,
			conversationId: 'conv-1',
			contextCompressionMarkers: [
				{
					id: 'snapshot-1',
					trigger: 'manual',
					status: 'valid',
					sourceEndMessageId: 'message-1',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			],
		});

		expect(getByTestId('context-compression-marker-snapshot-1')).toBe(
			getByLabelText('Compacted context'),
		);
		expect(getByText('Compacted context')).toBeInTheDocument();
	});

	it('renders persisted Deep Research jobs as cards without an assistant message', () => {
		const { getByRole, getByText, queryByText } = render(MessageArea, {
			messages: [],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			deepResearchJobs: [makeDeepResearchJob()],
		});

		expect(getByRole('article', { name: 'Deep Research: Research battery recycling policy' })).toBeInTheDocument();
		expect(getByText('Standard')).toBeInTheDocument();
		expect(getByText('Awaiting plan')).toBeInTheDocument();
		expect(getByText('Drafting research plan...')).toBeInTheDocument();
		expect(getByText('Drafting plan')).toBeInTheDocument();
		expect(getByRole('button', { name: 'Cancel Deep Research' })).toBeInTheDocument();
		expect(queryByText('Conversation Ready')).not.toBeInTheDocument();
	});

	it('renders a Deep Research card after the user message that triggered it', () => {
		const triggerMessage: ChatMessage = {
			id: 'user-1',
			role: 'user',
			content: 'Please research battery recycling policy.',
			timestamp: Date.now(),
		};
		const { container, getByRole } = render(MessageArea, {
			messages: [triggerMessage],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			deepResearchJobs: [
				makeDeepResearchJob({
					triggerMessageId: 'user-1',
					status: 'awaiting_approval',
					stage: 'plan_drafted',
					title: 'Draft battery recycling research plan',
					plan: {
						version: 1,
						renderedPlan: 'Goal: Compare battery recycling policy.',
						contextDisclosure: null,
						effortEstimate: {
							selectedDepth: 'standard',
							expectedTimeBand: '10-25 minutes',
							sourceReviewCeiling: 40,
							relativeCostWarning:
								'Moderate relative cost; use for serious multi-source synthesis.',
						},
					},
				}),
			],
		});

		expect(getByRole('article', { name: 'Deep Research: Draft battery recycling research plan' })).toBeInTheDocument();
		const renderedText = container.textContent ?? '';
		expect(renderedText.indexOf('Please research battery recycling policy.')).toBeLessThan(
			renderedText.indexOf('Research Plan')
		);
	});

	it('keeps a pre-draft Deep Research card below the user message during trigger id handoff', () => {
		const triggerMessage: ChatMessage = {
			id: 'client-user-1',
			renderKey: 'client-user-1',
			role: 'user',
			content: 'Please research battery recycling policy.',
			timestamp: Date.now(),
		};
		const { container, getByRole } = render(MessageArea, {
			messages: [triggerMessage],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			deepResearchJobs: [
				makeDeepResearchJob({
					id: 'server-research-job-1',
					triggerMessageId: 'server-user-1',
					status: 'awaiting_plan',
					stage: 'plan_generation',
					title: 'Please research battery recycling policy.',
					userRequest: 'Please research battery recycling policy.',
				}),
			],
		});

		expect(
			getByRole('article', {
				name: 'Deep Research: Please research battery recycling policy.',
			}),
		).toBeInTheDocument();
		const renderedText = container.textContent ?? '';
		expect(renderedText.indexOf('Please research battery recycling policy.')).toBeLessThan(
			renderedText.indexOf('Awaiting plan'),
		);
	});

	it('routes Deep Research cancellation through the card callback', async () => {
		const onCancelDeepResearchJob = vi.fn();
		const { getByRole } = render(MessageArea, {
			messages: [],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			deepResearchJobs: [makeDeepResearchJob()],
			onCancelDeepResearchJob,
		});

		await fireEvent.click(getByRole('button', { name: 'Cancel Deep Research' }));

		expect(onCancelDeepResearchJob).toHaveBeenCalledWith('research-job-1');
	});

	it('routes Deep Research Plan Edit and approval through card callbacks', async () => {
		const onEditDeepResearchPlan = vi.fn(async () => {});
		const onApproveDeepResearchPlan = vi.fn(async () => {});
		const { getByRole, getByLabelText } = render(MessageArea, {
			messages: [],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			deepResearchJobs: [
				makeDeepResearchJob({
					status: 'awaiting_approval',
					stage: 'plan_drafted',
					plan: {
						version: 1,
						renderedPlan: 'Research Plan\n\nGoal: Compare battery recycling policy.',
						contextDisclosure: null,
						effortEstimate: {
							selectedDepth: 'standard',
							expectedTimeBand: '10-25 minutes',
							sourceReviewCeiling: 40,
							relativeCostWarning:
								'Moderate relative cost; use for serious multi-source synthesis.',
						},
					},
				}),
			],
			onEditDeepResearchPlan,
			onApproveDeepResearchPlan,
		});

		await fireEvent.click(getByRole('button', { name: 'Edit Research Plan' }));
		await fireEvent.input(getByLabelText('Edit plan instructions'), {
			target: { value: 'Include more primary sources.' },
		});
		await fireEvent.click(getByRole('button', { name: 'Submit Plan Edit' }));
		await fireEvent.click(getByRole('button', { name: 'Approve Research Plan' }));

		expect(onEditDeepResearchPlan).toHaveBeenCalledWith(
			'research-job-1',
			'Include more primary sources.'
		);
		expect(onApproveDeepResearchPlan).toHaveBeenCalledWith('research-job-1');
	});

	it('routes completed Deep Research reports through the workspace open callback', async () => {
		const onOpenDocument = vi.fn<(document: DocumentWorkspaceItem) => void>();
		const { getByRole } = render(MessageArea, {
			messages: [],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			deepResearchJobs: [
				makeDeepResearchJob({
					status: 'completed',
					stage: 'report_ready',
					reportArtifactId: 'artifact-report-1',
					completedAt: Date.now(),
				}),
			],
			onOpenDocument,
		});

		await fireEvent.click(getByRole('button', { name: 'Open Report' }));

		expect(onOpenDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'artifact:artifact-report-1',
				source: 'knowledge_artifact',
				artifactId: 'artifact-report-1',
				previewUrl: '/api/knowledge/artifact-report-1/preview',
			})
		);
	});

	it('routes completed Deep Research Report Actions through card callbacks', async () => {
		const onDiscussDeepResearchReport = vi.fn();
		const onResearchFurtherFromDeepResearchReport = vi.fn();
		const { getByRole } = render(MessageArea, {
			messages: [],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			deepResearchJobs: [
				makeDeepResearchJob({
					status: 'completed',
					stage: 'report_ready',
					reportArtifactId: 'artifact-report-1',
					completedAt: Date.now(),
				}),
			],
			onDiscussDeepResearchReport,
			onResearchFurtherFromDeepResearchReport,
		});

		await fireEvent.click(getByRole('button', { name: 'Discuss Report' }));
		await fireEvent.click(getByRole('button', { name: 'Research Further' }));

		expect(onDiscussDeepResearchReport).toHaveBeenCalledWith('research-job-1');
		expect(onResearchFurtherFromDeepResearchReport).toHaveBeenCalledWith('research-job-1');
	});

	it('routes Evidence Limitation Memo recovery buttons through card callbacks', async () => {
		const onDiscussDeepResearchReport = vi.fn();
		const onResearchFurtherFromDeepResearchReport = vi.fn();
		const { getByRole } = render(MessageArea, {
			messages: [],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			deepResearchJobs: [
				makeDeepResearchJob({
					status: 'completed',
					stage: 'evidence_limitation_memo_ready',
					depth: 'focused',
					reportArtifactId: 'artifact-memo-1',
					completedAt: Date.now(),
					evidenceLimitationMemo: {
						title: 'Evidence Limitation Memo',
						reviewedScope: {
							discoveredCount: 2,
							reviewedCount: 1,
							topicRelevantCount: 0,
							rejectedOrOffTopicCount: 1,
						},
						limitations: ['No credible supported claim remained.'],
						nextResearchDirection: 'Revise the plan.',
						recoveryActions: [
							{
								kind: 'add_sources',
								label: 'Add sources',
								description: 'Attach stronger primary sources.',
							},
							{
								kind: 'choose_deeper_depth',
								label: 'Choose deeper depth',
								description: 'Run a deeper follow-up.',
							},
						],
					},
				}),
			],
			onDiscussDeepResearchReport,
			onResearchFurtherFromDeepResearchReport,
		});

		await fireEvent.click(getByRole('button', { name: 'Add sources' }));
		await fireEvent.click(getByRole('button', { name: 'Choose deeper depth' }));

		expect(onDiscussDeepResearchReport).toHaveBeenCalledWith('research-job-1');
		expect(onResearchFurtherFromDeepResearchReport).toHaveBeenCalledWith('research-job-1', {
			depth: 'standard',
		});
	});

	it('routes manual Deep Research workflow advancement through the card callback', async () => {
		const onAdvanceDeepResearchWorkflow = vi.fn();
		const { getByRole } = render(MessageArea, {
			messages: [],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			deepResearchJobs: [
				makeDeepResearchJob({
					status: 'approved',
					stage: 'plan_approved',
				}),
			],
			onAdvanceDeepResearchWorkflow,
		});

		await fireEvent.click(getByRole('button', { name: 'Advance research' }));

		expect(onAdvanceDeepResearchWorkflow).toHaveBeenCalledWith('research-job-1');
	});

	it('keeps completed Research Cards usable while read-only chat actions are hidden', async () => {
		const onOpenDocument = vi.fn<(document: DocumentWorkspaceItem) => void>();
		const { getByRole, queryByRole } = render(MessageArea, {
			readOnly: true,
			messages: [
				{
					id: 'user-1',
					renderKey: 'user-1',
					role: 'user',
					content: 'Research battery recycling policy',
					timestamp: Date.now(),
				},
				{
					id: 'assistant-1',
					renderKey: 'assistant-1',
					role: 'assistant',
					content: 'The report is ready.',
					timestamp: Date.now() + 1,
					isStreaming: false,
					isThinkingStreaming: false,
				},
			],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			deepResearchJobs: [
				makeDeepResearchJob({
					status: 'completed',
					stage: 'report_ready',
					reportArtifactId: 'artifact-report-1',
					completedAt: Date.now(),
				}),
			],
			onOpenDocument,
			onEdit: vi.fn(),
			onRegenerate: vi.fn(),
		});

		await fireEvent.click(getByRole('button', { name: 'Open Report' }));

		expect(onOpenDocument).toHaveBeenCalledOnce();
		expect(queryByRole('button', { name: 'Edit message' })).not.toBeInTheDocument();
		expect(queryByRole('button', { name: 'Regenerate response' })).not.toBeInTheDocument();
	});

	it('scrolls to reveal file-production cards when they appear at the end of the chat', async () => {
		const initialMessage: ChatMessage = {
			id: 'assistant-1',
			renderKey: 'assistant-1',
			role: 'assistant',
			content: 'Here is the report.',
			timestamp: Date.now(),
			isStreaming: false,
			isThinkingStreaming: false,
		};
		const job = makeFileProductionJob('assistant-1', { title: 'Report' });

		const { container, getByText, rerender } = render(MessageArea, {
			messages: [initialMessage],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [],
		});

		const scrollContainer = container.querySelector('[aria-live="polite"]') as HTMLDivElement;
		expect(scrollContainer).toBeTruthy();

		let scrollHeight = 640;
		Object.defineProperty(scrollContainer, 'clientHeight', {
			configurable: true,
			value: 640,
		});
		Object.defineProperty(scrollContainer, 'scrollHeight', {
			configurable: true,
			get: () => scrollHeight,
		});

		scrollContainer.scrollTop = 0;
		await fireEvent.scroll(scrollContainer);

		scrollHeight = 960;
		await rerender({
			messages: [initialMessage],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [job],
		});

		await waitFor(() => {
			expect(getByText('report.pdf')).toBeInTheDocument();
			expect(scrollContainer.scrollTop).toBe(960);
		});
	});

	it('renders a running file-production card instead of a temporary generated-file row', async () => {
		const runningJob = makeFileProductionJob('assistant-1', {
			id: 'job-running',
			title: 'Draft report',
			status: 'running',
			files: [],
		});

		const { container, queryByText } = render(MessageArea, {
			messages: [
				{
					id: 'assistant-1',
					renderKey: 'assistant-1',
					role: 'assistant',
					content: 'I am generating the file now.',
					timestamp: Date.now(),
					isStreaming: true,
					isThinkingStreaming: false,
				},
			],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [runningJob],
		});

		expect(container.querySelector('[data-testid="file-production-card"]')).toBeInTheDocument();
		expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
		expect(queryByText('Draft report')).toBeNull();
		expect(queryByText('In-progress')).toBeNull();
		expect(queryByText('Generating...')).toBeNull();
	});

	it('attaches an unassigned active file-production job to the latest streaming assistant response', () => {
		const runningJob = makeFileProductionJob(null, {
			id: 'job-unassigned-running',
			title: 'Immediate report',
			status: 'running',
			files: [],
		});

		const { container } = render(MessageArea, {
			messages: [
				{
					id: 'assistant-earlier',
					renderKey: 'assistant-earlier',
					role: 'assistant',
					content: 'Earlier response',
					timestamp: Date.now(),
					isStreaming: false,
					isThinkingStreaming: false,
				},
				{
					id: 'assistant-streaming',
					renderKey: 'assistant-streaming',
					role: 'assistant',
					content: 'I am generating the file now.',
					timestamp: Date.now() + 1,
					isStreaming: true,
					isThinkingStreaming: false,
				},
			],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [runningJob],
		});

		const assistantMessages = container.querySelectorAll('[data-testid="assistant-message"]');
		const card = container.querySelector('[data-testid="file-production-card"]');

		expect(card).toBeInTheDocument();
		expect(assistantMessages[0].contains(card)).toBe(false);
		expect(assistantMessages[1].contains(card)).toBe(true);
	});

	it('renders file-production cards above the evidence toggle inside the latest assistant response', () => {
		const messageTimestamp = Date.now();
		const evidenceItem = {
			id: 'evidence-1',
			title: 'Research note',
			sourceType: 'document' as const,
			status: 'selected' as const,
		};
		const job = makeFileProductionJob('assistant-inline-1', {
			id: 'job-inline-1',
			title: 'Summary',
			files: [
				{
					id: 'file-inline-1',
					filename: 'summary.txt',
					mimeType: 'text/plain',
					sizeBytes: 128,
					downloadUrl: '/api/chat/files/file-inline-1/download',
					previewUrl: '/api/chat/files/file-inline-1/preview',
				},
			],
		});

		const { getByText, getByRole } = render(MessageArea, {
			messages: [
				{
					id: 'assistant-inline-1',
					renderKey: 'assistant-inline-1',
					role: 'assistant',
					content: 'Here is the finished file.',
					timestamp: messageTimestamp,
					isStreaming: false,
					isThinkingStreaming: false,
					evidenceSummary: {
						structuredWebSearch: false,
						groups: [
							{
								sourceType: 'document',
								label: 'Documents',
								reranked: false,
								items: [evidenceItem],
							},
						],
					},
				},
			],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [job],
		});

		const producedFileName = getByText('summary.txt');
		const evidenceToggle = getByRole('button', { name: /Evidence/i });
		expect(
			producedFileName.compareDocumentPosition(evidenceToggle) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it('keeps file-production cards attached to the assistant response that created them', () => {
		const firstAssistantId = 'assistant-created-file';
		const secondAssistantId = 'assistant-follow-up';
		const job = makeFileProductionJob(firstAssistantId, {
			id: 'job-scoped-1',
			title: 'Scoped file',
			files: [
				{
					id: 'file-scoped-1',
					filename: 'scope.txt',
					mimeType: 'text/plain',
					sizeBytes: 32,
					downloadUrl: '/api/chat/files/file-scoped-1/download',
					previewUrl: '/api/chat/files/file-scoped-1/preview',
				},
			],
		});

		const { container, getByText, rerender } = render(MessageArea, {
			messages: [
				{
					id: firstAssistantId,
					renderKey: firstAssistantId,
					role: 'assistant',
					content: 'First response',
					timestamp: Date.now(),
					isStreaming: false,
					isThinkingStreaming: false,
				},
				{
					id: secondAssistantId,
					renderKey: secondAssistantId,
					role: 'assistant',
					content: 'Second response',
					timestamp: Date.now() + 1,
					isStreaming: false,
					isThinkingStreaming: false,
				},
			],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [job],
		});

		const assistantMessages = container.querySelectorAll('[data-testid="assistant-message"]');
		expect(getByText('scope.txt')).toBeInTheDocument();
		expect(assistantMessages[0]).toHaveTextContent('scope.txt');
		expect(assistantMessages[1]).not.toHaveTextContent('scope.txt');

		void rerender({
			messages: [
				{
					id: firstAssistantId,
					renderKey: firstAssistantId,
					role: 'assistant',
					content: 'First response',
					timestamp: Date.now(),
					isStreaming: false,
					isThinkingStreaming: false,
				},
				{
					id: secondAssistantId,
					renderKey: secondAssistantId,
					role: 'assistant',
					content: 'Second response',
					timestamp: Date.now() + 1,
					isStreaming: false,
					isThinkingStreaming: false,
				},
			],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [job],
		});

		expect(getByText('scope.txt')).toBeInTheDocument();
		expect(assistantMessages[0]).toHaveTextContent('scope.txt');
		expect(assistantMessages[1]).not.toHaveTextContent('scope.txt');
	});

	it('renders file-production jobs as grouped cards for the assistant response', () => {
		const messageTimestamp = Date.now();
		const fileProductionJob: FileProductionJob = {
			id: 'job-grouped-1',
			conversationId: 'conv-1',
			assistantMessageId: 'assistant-job-1',
			title: 'Quarterly report package',
			status: 'succeeded',
			stage: null,
			createdAt: messageTimestamp,
			updatedAt: messageTimestamp,
			warnings: [],
			error: null,
			files: [
				{
					id: 'file-pdf',
					filename: 'quarterly-report.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 2048,
					downloadUrl: '/api/chat/files/file-pdf/download',
					previewUrl: '/api/chat/files/file-pdf/preview',
				},
				{
					id: 'file-html',
					filename: 'quarterly-report.html',
					mimeType: 'text/html',
					sizeBytes: 4096,
					downloadUrl: '/api/chat/files/file-html/download',
					previewUrl: '/api/chat/files/file-html/preview',
				},
			],
		};

		const { container, getByText } = render(MessageArea, {
			messages: [
				{
					id: 'assistant-job-1',
					renderKey: 'assistant-job-1',
					role: 'assistant',
					content: 'I created the report package.',
					timestamp: messageTimestamp,
					isStreaming: false,
					isThinkingStreaming: false,
				},
			],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [fileProductionJob],
		});

		expect(container.querySelectorAll('[data-testid="file-production-card"]')).toHaveLength(1);
		expect(getByText('Quarterly report package')).toBeInTheDocument();
		expect(getByText('quarterly-report.pdf')).toBeInTheDocument();
		expect(getByText('quarterly-report.html')).toBeInTheDocument();
		expect(getByText('2 files')).toBeInTheDocument();
	});

	it('emits retry and cancel actions from file-production cards', async () => {
		const onRetryFileProductionJob = vi.fn();
		const onCancelFileProductionJob = vi.fn();
		const messageTimestamp = Date.now();
		const failedJob: FileProductionJob = {
			id: 'job-failed',
			conversationId: 'conv-1',
			assistantMessageId: 'assistant-job-actions',
			title: 'Failed report',
			status: 'failed',
			stage: null,
			createdAt: messageTimestamp,
			updatedAt: messageTimestamp,
			warnings: [],
			error: {
				code: 'renderer_timeout',
				message: 'Renderer timed out.',
				retryable: true,
			},
			files: [],
		};
		const runningJob: FileProductionJob = {
			...failedJob,
			id: 'job-running',
			title: 'Running report',
			status: 'running',
			error: null,
		};

		const { getByRole } = render(MessageArea, {
			messages: [
				{
					id: 'assistant-job-actions',
					renderKey: 'assistant-job-actions',
					role: 'assistant',
					content: 'Working on files.',
					timestamp: messageTimestamp,
					isStreaming: false,
					isThinkingStreaming: false,
				},
			],
			conversationId: 'conv-1',
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [failedJob, runningJob],
			onRetryFileProductionJob,
			onCancelFileProductionJob,
		});

		await fireEvent.click(getByRole('button', { name: 'Retry file production' }));
		await fireEvent.click(getByRole('button', { name: 'Cancel file production' }));

		expect(onRetryFileProductionJob).toHaveBeenCalledWith('job-failed');
		expect(onCancelFileProductionJob).toHaveBeenCalledWith('job-running');
	});
});
