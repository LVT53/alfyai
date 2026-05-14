import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import MessageBubble from './MessageBubble.svelte';
import type { ChatMessage, DocumentWorkspaceItem } from '$lib/types';

vi.mock('$lib/utils/markdown-loader', () => ({
	prepareCodeHighlighting: async () => undefined,
	renderCodeBlock: async (content: string) => `<pre><code>${content}</code></pre>`,
	renderHighlightedText: async (content: string) => content,
	renderMarkdown: async (content: string) => content.replace(/\*\*(.*?)\*\*/g, '$1'),
}));

describe('MessageBubble', () => {
	beforeEach(() => {
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
		await fireEvent.click(screen.getByRole('button', { name: 'Publish system skill' }));

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
});
