import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, DocumentWorkspaceItem, FileProductionJob } from '$lib/types';
import { renderMarkdown } from '$lib/utils/markdown-loader';
import MessageBubble from './MessageBubble.svelte';

const markdownLoaderMock = vi.hoisted(() => ({
	renderMarkdown: vi.fn(async (content: string) =>
		content.replace(/\*\*(.*?)\*\*/g, '$1'),
	),
}));

vi.mock('$lib/utils/markdown-loader', () => ({
	collectSourceReferenceCandidates: async () => [],
	prepareCodeHighlighting: async () => undefined,
	renderCodeBlock: async (content: string) => `<pre><code>${content}</code></pre>`,
	renderHighlightedText: async (content: string) => content,
	renderMarkdown: markdownLoaderMock.renderMarkdown,
}));

describe('MessageBubble', () => {
	beforeEach(() => {
		markdownLoaderMock.renderMarkdown.mockClear();
		Object.defineProperty(window, 'matchMedia', {
			writable: true,
			value: vi.fn().mockImplementation((query: string) => ({
				matches: false,
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				dispatchEvent: vi.fn(),
			})),
		});
	});

	it('shows a lightweight preparation status for an empty streaming assistant response', () => {
		const message: ChatMessage = {
			id: 'assistant-preparing',
			renderKey: 'assistant-preparing',
			role: 'assistant',
			content: '',
			timestamp: Date.now(),
			isStreaming: true,
			isThinkingStreaming: false,
		};

		render(MessageBubble, { message });

		expect(screen.getByText('Preparing response...')).toBeInTheDocument();
	});

	it('removes the preparation status once assistant output surfaces', async () => {
		const baseMessage: ChatMessage = {
			id: 'assistant-preparing',
			renderKey: 'assistant-preparing',
			role: 'assistant',
			content: '',
			timestamp: Date.now(),
			isStreaming: true,
			isThinkingStreaming: false,
		};
		const fileProductionJob: FileProductionJob = {
			id: 'job-1',
			conversationId: 'conv-1',
			assistantMessageId: 'assistant-preparing',
			title: 'Draft report',
			status: 'queued',
			stage: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			files: [],
			warnings: [],
			error: null,
		};

		const { rerender } = render(MessageBubble, { message: baseMessage });

		expect(screen.getByText('Preparing response...')).toBeInTheDocument();

		await rerender({ message: { ...baseMessage, content: 'First token' } });
		expect(screen.queryByText('Preparing response...')).not.toBeInTheDocument();

		await rerender({ message: { ...baseMessage, thinking: 'Checking context' } });
		expect(screen.queryByText('Preparing response...')).not.toBeInTheDocument();

		await rerender({
			message: {
				...baseMessage,
				thinkingSegments: [{ type: 'tool_call', name: 'web_search', input: {}, status: 'running' }],
			},
		});
		expect(screen.queryByText('Preparing response...')).not.toBeInTheDocument();

		await rerender({
			message: {
				...baseMessage,
				skillDrafts: [
					{
						id: 'draft-1',
						status: 'proposed',
						displayName: 'Meeting critic',
						description: 'Review meeting notes for weak follow-ups.',
						instructions: 'Find missing owners.',
						activationExamples: [],
						durationPolicy: 'next_message',
						questionPolicy: 'none',
						notesPolicy: 'none',
						sourceScope: 'selected_sources_only',
					},
				],
			},
		});
		expect(screen.queryByText('Preparing response...')).not.toBeInTheDocument();

		await rerender({
			message: baseMessage,
			conversationId: 'conv-1',
			fileProductionJobs: [fileProductionJob],
		});
		expect(screen.queryByText('Preparing response...')).not.toBeInTheDocument();
	});

	it('renders only a compact Max reasoning depth marker above the thinking disclosure', async () => {
		const activityRows = Array.from({ length: 12 }, (_, index) => ({
			id: `activity-${index}`,
			kind: 'context' as const,
			status: index === 11 ? ('running' as const) : ('done' as const),
			detail: `Context item ${index}`,
		}));
		const message: ChatMessage = {
			id: 'assistant-activity',
			renderKey: 'assistant-activity',
			role: 'assistant',
			content: '',
			timestamp: Date.now(),
			isStreaming: true,
			thinking: 'Checking the retrieved context.',
			isThinkingStreaming: true,
			responseActivity: [
				{
					id: 'depth-selected',
					kind: 'depth',
					status: 'done',
					detail: 'maximum',
				},
				...activityRows,
				{
					id: 'source-1',
					kind: 'source',
					status: 'done',
					title: 'SvelteKit Docs',
					url: 'https://svelte.dev/docs/kit',
					sourceType: 'web',
				},
				{
					id: 'drafting-answer',
					kind: 'drafting',
					status: 'running',
				},
			],
		};

		const { container, rerender } = render(MessageBubble, { message });
		const indicator = screen.getByTestId('reasoning-depth-indicator');
		const thinkingBlock = container.querySelector('.thinking-block');

		expect(indicator).toHaveTextContent('Max reasoning depth');
		expect(thinkingBlock).toBeInTheDocument();
		expect(
			indicator.compareDocumentPosition(thinkingBlock as Element) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(screen.queryByTestId('response-activity-timeline')).not.toBeInTheDocument();
		expect(screen.queryByText('Reasoning depth selected')).not.toBeInTheDocument();
		expect(screen.queryByText('Drafting answer')).not.toBeInTheDocument();
		expect(screen.queryByText('SvelteKit Docs')).not.toBeInTheDocument();
		for (let index = 0; index < 12; index += 1) {
			expect(screen.queryByText(`Context item ${index}`)).not.toBeInTheDocument();
		}

		await rerender({
			message: {
				...message,
				isStreaming: false,
				isThinkingStreaming: false,
				depthMetadata: {
					requested: 'max',
					appliedProfile: 'maximum',
					fallback: false,
				},
			},
		});
		expect(screen.getByText('Max reasoning depth')).toBeInTheDocument();
	});

	it('shows the compact depth marker for Extended but not Standard or Off', async () => {
		const message: ChatMessage = {
			id: 'assistant-depth-marker',
			renderKey: 'assistant-depth-marker',
			role: 'assistant',
			content: 'Detailed answer.',
			timestamp: Date.now(),
			isStreaming: false,
			isThinkingStreaming: false,
			thinking: 'Reasoned carefully.',
			depthMetadata: {
				requested: 'auto',
				appliedProfile: 'extended',
				fallback: false,
			},
		};

		const { rerender } = render(MessageBubble, { message });

		expect(screen.getByText('Extended reasoning depth')).toBeInTheDocument();

		await rerender({
			message: {
				...message,
				depthMetadata: {
					requested: 'auto',
					appliedProfile: 'standard',
					fallback: false,
				},
			},
		});
		expect(screen.queryByTestId('reasoning-depth-indicator')).not.toBeInTheDocument();

		await rerender({
			message: {
				...message,
				depthMetadata: {
					requested: 'off',
					appliedProfile: 'off',
					fallback: false,
				},
			},
		});
		expect(screen.queryByTestId('reasoning-depth-indicator')).not.toBeInTheDocument();
	});

	it('renders a single live deliberation status line above the thinking disclosure', async () => {
		const message: ChatMessage = {
			id: 'assistant-deliberation',
			renderKey: 'assistant-deliberation',
			role: 'assistant',
			content: '',
			timestamp: Date.now(),
			isStreaming: true,
			isThinkingStreaming: false,
			responseActivity: [
				{
					id: 'depth-selected',
					kind: 'depth',
					status: 'done',
					detail: 'maximum',
				},
				{
					id: 'context-preparing',
					kind: 'context',
					status: 'running',
					label: 'Preparing context',
				},
				{
					id: 'deliberation-pass-1',
					kind: 'deliberation',
					status: 'running',
					label: 'Reviewing context and sources',
				},
			],
			thinkingSegments: [
				{
					type: 'status',
					id: 'deliberation-pass-1',
					status: 'running',
					label: 'Reviewing context and sources',
				},
			],
		};

		const { rerender } = render(MessageBubble, { message });

		expect(screen.getByTestId('deliberation-status-line')).toHaveTextContent(
			'Reviewing context and sources',
		);
		expect(screen.getByTestId('reasoning-depth-indicator')).toHaveTextContent(
			'Max reasoning depth',
		);
		expect(screen.getByText('Thinking')).toBeInTheDocument();
		expect(screen.queryByText('Preparing response...')).not.toBeInTheDocument();
		expect(screen.queryByText('Preparing context')).not.toBeInTheDocument();
		expect(
			screen
				.getByTestId('deliberation-status-line')
				.querySelector('[data-deliberation-icon="search"]'),
		).not.toBeNull();
		const doneMessage: ChatMessage = {
			...message,
			isStreaming: false,
			isThinkingStreaming: false,
			responseActivity: undefined,
			thinkingSegments: [
				{
					type: 'status',
					id: 'deliberation-pass-1',
					status: 'done',
					label: 'Reviewed context and sources',
				},
			],
		};

		await rerender({ message: doneMessage });
		expect(screen.queryByTestId('deliberation-status-line')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Thought' })).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: 'Thought' }));
		expect(
			screen.getByText('Reviewed context and sources'),
		).toBeInTheDocument();

		await rerender({
			message: {
				...message,
				isStreaming: true,
				isThinkingStreaming: false,
				responseActivity: [
					{
						id: 'depth-selected',
						kind: 'depth',
						status: 'done',
						detail: 'maximum',
					},
					{
						id: 'deliberation-pass-2',
						kind: 'deliberation',
						status: 'running',
						label: 'Synthesizing an answer structure',
					},
				],
				thinkingSegments: [
					{
						type: 'status',
						id: 'deliberation-pass-2',
						status: 'running',
						label: 'Synthesizing an answer structure',
					},
				],
			},
		});
		expect(screen.getByTestId('deliberation-status-line')).toHaveTextContent(
			'Synthesizing an answer structure',
		);
		expect(
			screen
				.getByTestId('deliberation-status-line')
				.querySelector('[data-deliberation-icon="file"]'),
		).not.toBeNull();
	});

	it('marks completed tool-only thinking surfaces as Thought instead of active Thinking', () => {
		const message: ChatMessage = {
			id: 'assistant-completed-tool-only',
			renderKey: 'assistant-completed-tool-only',
			role: 'assistant',
			content: 'Done.',
			timestamp: Date.now(),
			isStreaming: false,
			isThinkingStreaming: false,
			depthMetadata: {
				requested: 'off',
				appliedProfile: 'off',
				fallback: false,
			},
			thinkingSegments: [
				{
					type: 'tool_call',
					name: 'research_web',
					input: { query: 'ignored provider thinking' },
					status: 'done',
					outputSummary: 'Reviewed 2 sources',
				},
			],
		};

		render(MessageBubble, { message });

		expect(screen.getByRole('button', { name: 'Thought' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument();
	});

	it('does not show a thinking surface for Off turns unless thinking or tool segments actually arrived', () => {
		const message: ChatMessage = {
			id: 'assistant-off-no-thinking',
			renderKey: 'assistant-off-no-thinking',
			role: 'assistant',
			content: 'Answer without provider reasoning.',
			timestamp: Date.now(),
			isStreaming: false,
			isThinkingStreaming: false,
			depthMetadata: {
				requested: 'off',
				appliedProfile: 'off',
				fallback: false,
			},
		};

		render(MessageBubble, { message });

		expect(screen.queryByRole('button', { name: /Thinking|Thought/ })).not.toBeInTheDocument();
	});

	it('copies assistant content without Thought text', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText },
		});
		const message: ChatMessage = {
			id: 'assistant-copy',
			renderKey: 'assistant-copy',
			role: 'assistant',
			content: '<thinking>Inline hidden thought.</thinking>Visible answer.',
			thinking: 'Persisted Thought trace.',
			timestamp: Date.now(),
			isStreaming: false,
			isThinkingStreaming: false,
		};

		render(MessageBubble, { message });

		await fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));

		expect(writeText).toHaveBeenCalledWith('Visible answer.');
	});

	it('renders plain URLs in sent user messages as highlighted links', () => {
		const message: ChatMessage = {
			id: 'user-link-message',
			renderKey: 'user-link-message',
			role: 'user',
			content: 'Read https://example.com/report and www.example.org.',
			timestamp: Date.now(),
		};

		render(MessageBubble, { message });

		const secureLink = screen.getByRole('link', {
			name: 'https://example.com/report',
		});
		expect(secureLink).toHaveAttribute('href', 'https://example.com/report');
		expect(secureLink).toHaveAttribute('target', '_blank');
		expect(secureLink.getAttribute('rel')).toContain('noopener');
		expect(secureLink.getAttribute('rel')).toContain('noreferrer');

		const bareLink = screen.getByRole('link', { name: 'www.example.org' });
		expect(bareLink).toHaveAttribute('href', 'https://www.example.org');
		expect(screen.getByTestId('user-message')).toHaveTextContent(
			'Read https://example.com/report and www.example.org.',
		);
	});

	it('opens attached artifacts through the shared document workspace callback', async () => {
		const onOpenDocument = vi.fn<(document: DocumentWorkspaceItem) => void>();
		const timestamp = Date.now();
		const message: ChatMessage = {
			id: 'user-message-1',
			renderKey: 'user-message-1',
			role: 'user',
			content: 'Please refine this attachment.',
			timestamp,
			attachments: [
				{
					id: 'artifact-123',
					type: 'source_document',
					retrievalClass: 'durable',
					name: 'brief.docx',
					mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
					sizeBytes: 1024,
					conversationId: 'conv-1',
					summary: null,
					createdAt: timestamp,
					updatedAt: timestamp,
				},
			],
			isStreaming: false,
			isThinkingStreaming: false,
		};

		render(MessageBubble, {
			message,
			conversationId: 'conv-1',
			onOpenDocument,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'View brief.docx' }));

		expect(onOpenDocument).toHaveBeenCalledWith({
			id: 'artifact:artifact-123',
			source: 'knowledge_artifact',
			filename: 'brief.docx',
			title: 'brief.docx',
			mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			artifactId: 'artifact-123',
			conversationId: 'conv-1',
		});
	});

	it('renders assistant Skill Draft Cards from message metadata', async () => {
		const onSaveSkillDraft = vi.fn();
		const onDismissSkillDraft = vi.fn();
		const onPublishSkillDraft = vi.fn();
		const message: ChatMessage = {
			id: 'assistant-1',
			renderKey: 'assistant-1',
			role: 'assistant',
			content: 'I can make that reusable.',
			timestamp: Date.now(),
			skillDrafts: [
				{
					id: 'draft-1',
					status: 'proposed',
					displayName: 'Meeting critic',
					description: 'Review meeting notes for weak follow-ups.',
					instructions: 'Find missing owners.',
					activationExamples: [],
					durationPolicy: 'next_message',
					questionPolicy: 'none',
					notesPolicy: 'none',
					sourceScope: 'selected_sources_only',
				},
			],
		};

		render(MessageBubble, {
			message,
			canPublishSkillDrafts: true,
			onSaveSkillDraft,
			onDismissSkillDraft,
			onPublishSkillDraft,
		});

		expect(screen.getByRole('article', { name: 'Skill draft: Meeting critic' })).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: 'Save private skill' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Dismiss draft' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Publish skill' }));

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

	it('renders assistant Skill Draft action state beside the affected draft', () => {
		const message: ChatMessage = {
			id: 'assistant-1',
			renderKey: 'assistant-1',
			role: 'assistant',
			content: 'I can make that reusable.',
			timestamp: Date.now(),
			skillDrafts: [
				{
					id: 'draft-1',
					status: 'proposed',
					displayName: 'Meeting critic',
					description: 'Review meeting notes for weak follow-ups.',
					instructions: 'Find missing owners.',
					activationExamples: [],
					durationPolicy: 'next_message',
					questionPolicy: 'none',
					notesPolicy: 'none',
					sourceScope: 'selected_sources_only',
				},
			],
		};

		render(MessageBubble, {
			message,
			skillDraftActionState: {
				'assistant-1:draft-1': {
					busy: true,
					error: 'Failed to save skill draft.',
				},
			},
		});

		expect(screen.getByRole('alert')).toHaveTextContent('Failed to save skill draft.');
		expect(screen.getByRole('button', { name: 'Save private skill' })).toBeDisabled();
	});

	it('asks the markdown renderer for compact source-link chips on assistant messages', async () => {
		const message: ChatMessage = {
			id: 'assistant-link-1',
			renderKey: 'assistant-link-1',
			role: 'assistant',
			content: 'Claim backed by [Example Source](https://example.com/report).',
			timestamp: Date.now(),
		};

		render(MessageBubble, { message });

		await waitFor(() => {
			expect(renderMarkdown).toHaveBeenCalledWith(
				message.content,
				false,
				expect.objectContaining({ compactExternalLinks: true }),
			);
		});
	});

	it('shows compact message info through cost without click-only expansion', () => {
		const message: ChatMessage = {
			id: 'assistant-audit-simple',
			renderKey: 'assistant-audit-simple',
			role: 'assistant',
			content: 'Completed answer.',
			timestamp: Date.now(),
			modelDisplayName: 'Model 1',
			providerDisplayName: 'Local Provider',
			responseTokenCount: 128,
			thinkingTokenCount: 12,
			totalTokenCount: 128,
			generationDurationMs: 1450,
			costUsd: 0.00042,
			depthMetadata: {
				requested: 'max',
				appliedProfile: 'maximum',
				fallback: false,
			},
		};

		render(MessageBubble, { message });

		const detailsButton = screen.getByRole('button', { name: 'Info' });
		expect(detailsButton).not.toHaveAttribute('aria-expanded');

		const tooltip = screen.getByRole('tooltip', { name: 'Info' });
		expect(within(tooltip).getByText('Provider')).toBeInTheDocument();
		expect(within(tooltip).getByText('Local Provider')).toBeInTheDocument();
		expect(within(tooltip).getByText('Model')).toBeInTheDocument();
		expect(within(tooltip).getByText('Model 1')).toBeInTheDocument();
		expect(within(tooltip).getByText('Reasoning depth')).toBeInTheDocument();
		expect(within(tooltip).getByText('Max / Maximum')).toBeInTheDocument();
		expect(within(tooltip).getByText('Response time')).toBeInTheDocument();
		expect(within(tooltip).getByText('1.4s')).toBeInTheDocument();
		expect(within(tooltip).getByText('Thinking tokens')).toBeInTheDocument();
		expect(within(tooltip).getByText('12')).toBeInTheDocument();
		expect(within(tooltip).getByText('Response tokens')).toBeInTheDocument();
		expect(within(tooltip).getAllByText('128')).not.toHaveLength(0);
		expect(within(tooltip).getByText('Cost')).toBeInTheDocument();
		expect(within(tooltip).getByText('$0.000420')).toBeInTheDocument();
	});

	it('omits secondary audit details from the info tooltip', () => {
		const message: ChatMessage = {
			id: 'assistant-audit-secondary-details',
			renderKey: 'assistant-audit-secondary-details',
			role: 'assistant',
			content: 'Answer with extra audit metadata.',
			timestamp: Date.now(),
			responseTokenCount: 88,
			totalTokenCount: 88,
			depthMetadata: {
				requested: 'max',
				appliedProfile: 'maximum',
				fallback: false,
				fallbackReason: 'invalid_classifier_response',
				classifierSource: 'deterministic_bypass',
				classifierModelFallbackReason: 'configured_model_unavailable',
				constraintNote: 'explicit_max',
				appliedEffort: {
					dimensions: [
						'provider_reasoning',
						'output_room',
						'context_room',
						'grounding_guidance',
						'tool_steps',
						'source_budget',
					],
					tools: {
						maxToolSteps: 7,
						maxWebSources: 12,
						sourceExpansion: true,
					},
				},
			},
			evidenceSummary: {
				structuredWebSearch: true,
				groups: [
					{
						sourceType: 'web',
						label: 'Web Search',
						reranked: true,
						items: [
							{
								id: 'source-1',
								title: 'Official source',
								sourceType: 'web',
								status: 'selected',
								url: 'https://example.com/source',
							},
						],
					},
				],
			},
			webCitationAudit: {
				status: 'passed',
				retrievedSourceCount: 1,
				citedUrlCount: 1,
				supportedCitationCount: 1,
				unsupportedCitationCount: 0,
				citations: [],
			},
			thinkingSegments: [
				{ type: 'text', content: 'SECRET_THOUGHT_TRACE' },
				{
					type: 'tool_call',
					name: 'research_web',
					input: { query: 'docs' },
					status: 'done',
					outputSummary: '2 sources reviewed',
				},
			],
		};

		render(MessageBubble, { message });

		const tooltip = screen.getByRole('tooltip', { name: 'Info' });
		expect(within(tooltip).getByText('Reasoning depth')).toBeInTheDocument();
		expect(within(tooltip).getByText('Max / Maximum')).toBeInTheDocument();
		expect(within(tooltip).getByText('Response tokens')).toBeInTheDocument();
		expect(within(tooltip).queryByText('Classifier')).not.toBeInTheDocument();
		expect(within(tooltip).queryByText('Applied effort')).not.toBeInTheDocument();
		expect(within(tooltip).queryByText('Max turns')).not.toBeInTheDocument();
		expect(within(tooltip).queryByText('Sources')).not.toBeInTheDocument();
		expect(within(tooltip).queryByText('Citation audit')).not.toBeInTheDocument();
		expect(within(tooltip).queryByText('Tool calls')).not.toBeInTheDocument();
		expect(within(tooltip).queryByText('Web search')).not.toBeInTheDocument();
		expect(within(tooltip).queryByText('2 sources reviewed')).not.toBeInTheDocument();
		expect(within(tooltip).queryByText('SECRET_THOUGHT_TRACE')).not.toBeInTheDocument();
	});

	it('shows the fork action only for completed persisted assistant messages', async () => {
		const onFork = vi.fn();
		const assistantMessage: ChatMessage = {
			id: 'assistant-1',
			role: 'assistant',
			content: 'Completed answer.',
			timestamp: Date.now(),
		};

		const { rerender } = render(MessageBubble, {
			message: assistantMessage,
			onFork,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Fork from here' }));
		expect(onFork).toHaveBeenCalledWith({ messageId: 'assistant-1' });

		await rerender({
			message: {
				...assistantMessage,
				renderKey: undefined,
			},
			onFork,
		});
		expect(screen.getByRole('button', { name: 'Fork from here' })).toBeInTheDocument();

		await rerender({
			message: {
				...assistantMessage,
				renderKey: 'client-only-stopped',
				id: 'client-only-stopped',
				wasStopped: true,
			},
			onFork,
		});
		expect(screen.queryByRole('button', { name: 'Fork from here' })).not.toBeInTheDocument();

		await rerender({
			message: {
				...assistantMessage,
				id: 'persisted-stopped',
				renderKey: 'client-placeholder',
				wasStopped: true,
			},
			onFork,
		});
		expect(screen.queryByRole('button', { name: 'Fork from here' })).not.toBeInTheDocument();

		await rerender({
			message: {
				...assistantMessage,
				id: 'streaming-assistant',
				isStreaming: true,
			},
			onFork,
		});
		expect(screen.queryByRole('button', { name: 'Fork from here' })).not.toBeInTheDocument();

		await rerender({
			message: {
				...assistantMessage,
				content: '   ',
			},
			onFork,
		});
		expect(screen.queryByRole('button', { name: 'Fork from here' })).not.toBeInTheDocument();
	});

	it('renders styled hover tooltip labels for message action icons', () => {
		const assistantMessage: ChatMessage = {
			id: 'assistant-tooltip-actions',
			role: 'assistant',
			content: 'Completed answer.',
			timestamp: Date.now(),
		};
		const userMessage: ChatMessage = {
			id: 'user-tooltip-actions',
			role: 'user',
			content: 'Can you revise this?',
			timestamp: Date.now(),
		};

		const { container: assistantContainer } = render(MessageBubble, {
			message: assistantMessage,
			onRegenerate: vi.fn(),
			onFork: vi.fn(),
		});

		expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Fork from here' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
		expect(within(assistantContainer).getByRole('tooltip', { name: 'Regenerate' })).toBeInTheDocument();
		expect(within(assistantContainer).getByRole('tooltip', { name: 'Fork' })).toBeInTheDocument();
		expect(within(assistantContainer).getByRole('tooltip', { name: 'Copy' })).toBeInTheDocument();

		const { container: userContainer } = render(MessageBubble, {
			message: userMessage,
			onEdit: vi.fn(),
		});

		expect(screen.getByRole('button', { name: 'Edit message' })).toBeInTheDocument();
		expect(within(userContainer).getByRole('tooltip', { name: 'Edit' })).toBeInTheDocument();
		expect(within(userContainer).getByRole('tooltip', { name: 'Copy' })).toBeInTheDocument();
	});

	it('shows a source fork marker with a direct link when one child fork exists', () => {
		const message: ChatMessage = {
			id: 'assistant-1',
			role: 'assistant',
			content: 'Completed answer.',
			timestamp: Date.now(),
			sourceForks: {
				count: 1,
				forks: [
					{
						conversationId: 'fork-1',
						title: 'Source title (fork 1)',
						forkSequence: 1,
						createdAt: 1,
					},
				],
			},
		};

		render(MessageBubble, { message });

		expect(screen.getByTestId('fork-origin-marker')).toBeInTheDocument();
		expect(screen.getByText('Forked from this response')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Open fork Source title (fork 1)' })).toHaveAttribute(
			'href',
			'/chat/fork-1',
		);
	});

	it('shows count-first fork awareness with on-demand links for multiple child forks', async () => {
		const message: ChatMessage = {
			id: 'assistant-1',
			role: 'assistant',
			content: 'Completed answer.',
			timestamp: Date.now(),
			sourceForks: {
				count: 2,
				forks: [
					{
						conversationId: 'fork-1',
						title: 'First fork',
						forkSequence: 1,
						createdAt: 1,
					},
					{
						conversationId: 'fork-2',
						title: 'Renamed second fork',
						forkSequence: 2,
						createdAt: 2,
					},
				],
			},
		};

		render(MessageBubble, { message });

		const detailsButton = screen.getByRole('button', { name: '2 forks from this response' });
		expect(detailsButton).toBeInTheDocument();
		expect(detailsButton).toHaveAttribute('aria-expanded', 'false');
		await fireEvent.click(detailsButton);
		expect(detailsButton).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getByRole('link', { name: 'Open fork First fork' })).toHaveAttribute(
			'href',
			'/chat/fork-1',
		);
		expect(screen.getByRole('link', { name: 'Open fork Renamed second fork' })).toHaveAttribute(
			'href',
			'/chat/fork-2',
		);
	});
});
