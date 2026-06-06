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
