import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import MessageInputWrapper from './MessageInputWrapper.test.svelte';
import MessageInput from './MessageInput.svelte';

describe('MessageInput', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders correctly', () => {
		const { getByPlaceholderText } = render(MessageInput);
		expect(getByPlaceholderText('Type a message...')).toBeDefined();
	});

	it('disables send button when input is empty', () => {
		const { getByLabelText } = render(MessageInput);
		const button = getByLabelText('Send message') as HTMLButtonElement;
		
		expect(button.disabled).toBe(true);
	});

	it('enables send button when input has text', async () => {
		const { getByPlaceholderText, getByLabelText } = render(MessageInput);
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
		const button = getByLabelText('Send message') as HTMLButtonElement;
		
		await fireEvent.input(input, { target: { value: 'Hello' } });
		expect(button.disabled).toBe(false);
	});

	it('shows the Deep Research composer control only when enabled', () => {
		const { queryByRole, rerender } = render(MessageInput);

		expect(queryByRole('button', { name: /deep research/i })).toBeNull();

		rerender({ deepResearchEnabled: true });

		expect(queryByRole('button', { name: 'Deep Research' })).not.toBeNull();
	});

	it('opens Deep Research depth choices with no depth selected by default', async () => {
		const { getByRole } = render(MessageInput, { deepResearchEnabled: true });

		await fireEvent.click(getByRole('button', { name: 'Deep Research' }));

		expect(getByRole('button', { name: 'Focused Deep Research' })).toHaveAttribute(
			'aria-pressed',
			'false'
		);
		expect(getByRole('button', { name: 'Standard Deep Research' })).toHaveAttribute(
			'aria-pressed',
			'false'
		);
		expect(getByRole('button', { name: 'Max Deep Research' })).toHaveAttribute(
			'aria-pressed',
			'false'
		);
	});

	it('closes Deep Research depth choices on outside pointer down', async () => {
		const { getByPlaceholderText, getByRole, queryByRole } = render(MessageInput, {
			deepResearchEnabled: true,
		});

		await fireEvent.click(getByRole('button', { name: 'Deep Research' }));
		expect(getByRole('button', { name: 'Focused Deep Research' })).toBeInTheDocument();

		await fireEvent.pointerDown(getByPlaceholderText('Type a message...'));

		expect(queryByRole('button', { name: 'Focused Deep Research' })).toBeNull();
		expect(queryByRole('button', { name: 'Standard Deep Research' })).toBeNull();
		expect(queryByRole('button', { name: 'Max Deep Research' })).toBeNull();
	});

	it('closes Deep Research depth choices on Escape', async () => {
		const { getByRole, queryByRole } = render(MessageInput, {
			deepResearchEnabled: true,
		});

		await fireEvent.click(getByRole('button', { name: 'Deep Research' }));
		expect(getByRole('button', { name: 'Focused Deep Research' })).toBeInTheDocument();

		await fireEvent.keyDown(document, { key: 'Escape' });

		expect(queryByRole('button', { name: 'Focused Deep Research' })).toBeNull();
		expect(queryByRole('button', { name: 'Standard Deep Research' })).toBeNull();
		expect(queryByRole('button', { name: 'Max Deep Research' })).toBeNull();
	});

	it('sends the selected Deep Research depth with the next message', async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole, queryByRole } = render(MessageInput, {
			deepResearchEnabled: true,
			onSend: sendSpy,
		});

		await fireEvent.click(getByRole('button', { name: 'Deep Research' }));
		await fireEvent.click(getByRole('button', { name: 'Standard Deep Research' }));
		expect(queryByRole('button', { name: 'Standard Deep Research' })).toBeNull();
		await fireEvent.input(getByPlaceholderText('Type a message...'), {
			target: { value: 'Research EV battery recycling policy' },
		});
		await fireEvent.click(getByRole('button', { name: 'Send message' }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Research EV battery recycling policy',
				deepResearchDepth: 'standard',
			})
		);
	});

	it('turns off Deep Research when the active control is clicked before sending', async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			deepResearchEnabled: true,
			onSend: sendSpy,
		});

		await fireEvent.click(getByRole('button', { name: 'Deep Research' }));
		await fireEvent.click(getByRole('button', { name: 'Max Deep Research' }));
		await fireEvent.click(getByRole('button', { name: 'Deep Research' }));
		await fireEvent.input(getByPlaceholderText('Type a message...'), {
			target: { value: 'Use normal chat instead' },
		});
		await fireEvent.click(getByRole('button', { name: 'Send message' }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Use normal chat instead',
				deepResearchDepth: null,
			})
		);
	});

	it('sends the selected thinking mode with the next message', async () => {
		const sendSpy = vi.fn();
		const thinkingModeChangeSpy = vi.fn();
		const { getByPlaceholderText, getByRole, rerender } = render(MessageInput, {
			onSend: sendSpy,
			thinkingMode: 'auto',
			onThinkingModeChange: thinkingModeChangeSpy,
		});

		await fireEvent.click(getByRole('button', { name: 'Open composer tools' }));
		await fireEvent.click(getByRole('button', { name: 'Auto' }));
		await fireEvent.click(getByRole('option', { name: 'Off' }));

		expect(thinkingModeChangeSpy).toHaveBeenCalledWith('off');

		await rerender({
			onSend: sendSpy,
			thinkingMode: 'off',
			onThinkingModeChange: thinkingModeChangeSpy,
		});
		await fireEvent.input(getByPlaceholderText('Type a message...'), {
			target: { value: 'Answer directly' },
		});
		await fireEvent.click(getByRole('button', { name: 'Send message' }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Answer directly',
				thinkingMode: 'off',
			})
		);
	});

	it('clears stale conversation ids when the parent resets the prop to null', async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByLabelText, rerender } = render(MessageInput, {
			conversationId: 'conv-stale',
			onSend: sendSpy,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
		const button = getByLabelText('Send message') as HTMLButtonElement;

		await rerender({
			conversationId: null,
			onSend: sendSpy,
		});

		await fireEvent.input(input, { target: { value: 'Fresh message' } });
		await fireEvent.click(button);

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Fresh message',
				conversationId: null,
			})
		);
	});

	it('dispatches send event and clears input on enter key', async () => {
		const mockSend = vi.fn();
		const { getByPlaceholderText } = render(MessageInputWrapper, { onSend: mockSend });
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
		
		await fireEvent.input(input, { target: { value: 'Hello World' } });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
		
		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledWith('Hello World');
		expect(input.value).toBe('');
	});

	it('inserts newline but does not send on shift+enter', async () => {
		const mockSend = vi.fn();
		const { getByPlaceholderText } = render(MessageInputWrapper, { onSend: mockSend });
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
		
		await fireEvent.input(input, { target: { value: 'Line 1\nLine 2' } });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
		
		expect(mockSend).not.toHaveBeenCalled();
		expect(input.value).toBe('Line 1\nLine 2');
	});

	it('does not send if input is only whitespace', async () => {
		const mockSend = vi.fn();
		const { getByPlaceholderText, getByLabelText } = render(MessageInputWrapper, { onSend: mockSend });
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
		const button = getByLabelText('Send message') as HTMLButtonElement;
		
		await fireEvent.input(input, { target: { value: '   \n  ' } });
		
		expect(button.disabled).toBe(true);
		
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
		expect(mockSend).not.toHaveBeenCalled();
	});

	it('shows character count and blocks send when over limit', async () => {
		const maxLength = 10;
		const mockSend = vi.fn();
		const { getByPlaceholderText, getByLabelText, getByText } = render(MessageInputWrapper, { maxLength, onSend: mockSend });
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
		const button = getByLabelText('Send message') as HTMLButtonElement;
		
		await fireEvent.input(input, { target: { value: '123456789' } });
		expect(getByText('9/10')).toBeDefined();
		expect(button.disabled).toBe(false);

		await fireEvent.input(input, { target: { value: '12345678901' } });
		expect(getByText('11/10')).toBeDefined();
		expect(button.disabled).toBe(true);

		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
		expect(mockSend).not.toHaveBeenCalled();
	});

	it('dispatches optional task objective from the focus panel', async () => {
		const steerSpy = vi.fn();
		const { getByRole, getByPlaceholderText } = render(MessageInputWrapper, {
			onSteer: steerSpy,
			contextStatus: {
				conversationId: 'conv-1',
				userId: 'user-1',
				estimatedTokens: 1200,
				maxContextTokens: 262144,
				thresholdTokens: 209715,
				targetTokens: 157286,
				compactionApplied: false,
				compactionMode: 'none',
				routingStage: 'deterministic',
				routingConfidence: 0,
				verificationStatus: 'skipped',
				layersUsed: [],
				workingSetCount: 0,
				workingSetArtifactIds: [],
				workingSetApplied: false,
				taskStateApplied: false,
				promptArtifactCount: 0,
				recentTurnCount: 0,
				summary: null,
				updatedAt: Date.now(),
			},
			contextDebug: {
				activeTaskId: null,
				activeTaskObjective: 'Current task',
				taskLocked: false,
				routingStage: 'deterministic',
				routingConfidence: 0,
				verificationStatus: 'skipped',
				selectedEvidence: [],
				selectedEvidenceBySource: [],
				pinnedEvidence: [],
				excludedEvidence: [],
			},
		});

		await fireEvent.click(getByRole('button', { name: 'Start new task' }));
		const taskInput = getByPlaceholderText('Leave empty to infer from your next message') as HTMLInputElement;
		await fireEvent.input(taskInput, { target: { value: 'Prepare internship applications' } });
		await fireEvent.click(getByRole('button', { name: 'Start' }));

		expect(steerSpy).toHaveBeenCalledWith({
			action: 'start_new_task',
			artifactId: undefined,
			objective: 'Prepare internship applications',
		});
	});

	it('opens the evidence controls from the context ring on click', async () => {
		const manageEvidenceSpy = vi.fn();
		const { getByLabelText, getByRole } = render(MessageInputWrapper, {
			onManageEvidence: manageEvidenceSpy,
			contextStatus: {
				conversationId: 'conv-1',
				userId: 'user-1',
				estimatedTokens: 1200,
				maxContextTokens: 262144,
				thresholdTokens: 209715,
				targetTokens: 157286,
				compactionApplied: false,
				compactionMode: 'none',
				routingStage: 'deterministic',
				routingConfidence: 0,
				verificationStatus: 'skipped',
				layersUsed: [],
				workingSetCount: 0,
				workingSetArtifactIds: [],
				workingSetApplied: false,
				taskStateApplied: false,
				promptArtifactCount: 0,
				recentTurnCount: 0,
				summary: null,
				updatedAt: Date.now(),
			},
			contextDebug: {
				activeTaskId: null,
				activeTaskObjective: 'Current task',
				taskLocked: false,
				routingStage: 'deterministic',
				routingConfidence: 0,
				verificationStatus: 'skipped',
				selectedEvidence: [],
				selectedEvidenceBySource: [],
				pinnedEvidence: [],
				excludedEvidence: [],
			},
		});

		await fireEvent.click(getByLabelText(/prompt budget usage/i));
		await fireEvent.click(getByRole('button', { name: 'Manage context sources' }));

		expect(manageEvidenceSpy).toHaveBeenCalledTimes(1);
	});

	it('disables send while an attachment upload is still in progress', async () => {
		const sendSpy = vi.fn();
		let doneCallback: ((result: unknown) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: { done: (result: unknown) => void }) => {
			doneCallback = payload.done;
		});

		const { container, getByPlaceholderText, getByLabelText, getByText } = render(
			MessageInput,
			{
				conversationId: 'conv-1',
				attachmentsEnabled: true,
				onSend: sendSpy,
				onUploadFiles: uploadFilesHandler,
			}
		);

		const textarea = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
		const sendButton = getByLabelText('Send message') as HTMLButtonElement;
		const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

		await fireEvent.input(textarea, { target: { value: 'Use this file' } });
		expect(sendButton.disabled).toBe(false);

		const file = new File(['hello'], 'recipe.txt', { type: 'text/plain' });
		await fireEvent.change(fileInput, { target: { files: [file] } });

		await waitFor(() => {
			expect(getByText('Uploading file...')).toBeDefined();
			expect(sendButton.disabled).toBe(true);
		});

		// Simulate page completing the upload
		doneCallback!({
			success: true,
			attachment: {
				artifact: {
					id: 'artifact-1',
					type: 'source_document',
					retrievalClass: 'durable',
					name: 'recipe.txt',
					mimeType: 'text/plain',
					sizeBytes: 12,
					conversationId: 'conv-1',
					summary: 'Dinner recipe',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: 'normalized-1',
				readinessError: null,
			},
		});

		await waitFor(() => {
			expect(sendButton.disabled).toBe(false);
		});
		expect(sendSpy).not.toHaveBeenCalled();
	});

	it('queues send intent on Enter while attachment processing is running and auto-sends when ready', async () => {
		const sendSpy = vi.fn();
		let doneCallback: ((result: unknown) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: { done: (result: unknown) => void }) => {
			doneCallback = payload.done;
		});

		const { container, getByPlaceholderText, getByText } = render(MessageInput, {
			conversationId: 'conv-1',
			attachmentsEnabled: true,
			onSend: sendSpy,
			onUploadFiles: uploadFilesHandler,
		});

		const textarea = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
		const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

		await fireEvent.input(textarea, { target: { value: 'Send when ready' } });
		await fireEvent.change(fileInput, {
			target: { files: [new File(['scan'], 'notes.pdf', { type: 'application/pdf' })] },
		});

		await waitFor(() => {
			expect(getByText('Uploading file...')).toBeDefined();
		});

		await fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

		await waitFor(() => {
			expect(
				getByText('Message will send automatically when file processing finishes.')
			).toBeDefined();
		});

		doneCallback!({
			success: true,
			attachment: {
				artifact: {
					id: 'artifact-auto-send-1',
					type: 'source_document',
					retrievalClass: 'durable',
					name: 'notes.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 12,
					conversationId: 'conv-1',
					summary: 'OCR me',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: 'normalized-auto-send-1',
				readinessError: null,
			},
		});

		await waitFor(() => {
			expect(sendSpy).toHaveBeenCalledTimes(1);
		});
		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Send when ready' })
		);
	});

	it('blocks send when an uploaded attachment is not prompt-ready', async () => {
		const sendSpy = vi.fn();
		let doneCallback: ((result: unknown) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: { done: (result: unknown) => void }) => {
			doneCallback = payload.done;
		});

		const { container, getByPlaceholderText, getByLabelText, findByText } = render(
			MessageInput,
			{
				conversationId: 'conv-1',
				attachmentsEnabled: true,
				onSend: sendSpy,
				onUploadFiles: uploadFilesHandler,
			}
		);

		const textarea = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
		const sendButton = getByLabelText('Send message') as HTMLButtonElement;
		const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

		await fireEvent.input(textarea, { target: { value: 'Use this file' } });
		await fireEvent.change(fileInput, {
			target: { files: [new File(['scan'], 'scan.pdf', { type: 'application/pdf' })] },
		});

		doneCallback!({
			success: true,
			attachment: {
				artifact: {
					id: 'artifact-2',
					type: 'source_document',
					retrievalClass: 'durable',
					name: 'scan.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 128,
					conversationId: 'conv-1',
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: false,
				promptArtifactId: null,
				readinessError: 'This file could not be prepared for chat.',
			},
		});

		expect(await findByText(/scan\.pdf: This file could not be prepared for chat\./i)).toBeDefined();
		expect(sendButton.disabled).toBe(true);

		await fireEvent.click(sendButton);
		expect(sendSpy).not.toHaveBeenCalled();
	});

	it('emits onUploadFiles with all selected files from one picker action', async () => {
		const uploadFilesSpy = vi.fn();
		const { container, findByText } = render(MessageInput, {
			conversationId: 'conv-1',
			attachmentsEnabled: true,
			onUploadFiles: uploadFilesSpy,
		});

		const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
		const firstFile = new File(['first'], 'first.txt', { type: 'text/plain' });
		const secondFile = new File(['second'], 'second.txt', { type: 'text/plain' });

		await fireEvent.change(fileInput, {
			target: { files: [firstFile, secondFile] },
		});

		expect(uploadFilesSpy).toHaveBeenCalledTimes(1);
		const payload = uploadFilesSpy.mock.calls[0][0];
		expect(payload.files).toHaveLength(2);
		expect(payload.files[0].name).toBe('first.txt');
		expect(payload.files[1].name).toBe('second.txt');

		// Simulate both uploads completing via done callback
		payload.done({
			success: true,
			attachment: {
				artifact: {
					id: 'artifact-multi-1',
					type: 'source_document',
					retrievalClass: 'durable',
					name: 'first.txt',
					mimeType: 'text/plain',
					sizeBytes: 5,
					conversationId: 'conv-1',
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: 'normalized-multi-1',
				readinessError: null,
			},
		});
		payload.done({
			success: true,
			attachment: {
				artifact: {
					id: 'artifact-multi-2',
					type: 'source_document',
					retrievalClass: 'durable',
					name: 'second.txt',
					mimeType: 'text/plain',
					sizeBytes: 6,
					conversationId: 'conv-1',
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: 'normalized-multi-2',
				readinessError: null,
			},
		});

		expect(await findByText('first.txt')).toBeDefined();
		expect(await findByText('second.txt')).toBeDefined();
	});

	it('ignores stale async draft emissions after send clears the composer', async () => {
		let resolveConversation: ((id: string) => void) | null = null;
		const ensureConversation = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolveConversation = resolve;
				})
		);
		const sendSpy = vi.fn();
		const draftSpy = vi.fn();
		const { getByPlaceholderText } = render(MessageInputWrapper, {
			ensureConversation,
			onSend: (message: string) =>
				sendSpy({
					message,
					attachmentIds: [],
					attachments: [],
					conversationId: null,
				}),
			onDraftChange: draftSpy,
		});

		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
		await fireEvent.input(input, { target: { value: 'Race me' } });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

		expect(sendSpy).toHaveBeenCalledWith({
			message: 'Race me',
			attachmentIds: [],
			attachments: [],
			conversationId: null,
		});
		expect(draftSpy).toHaveBeenCalledTimes(1);
		expect(draftSpy).toHaveBeenCalledWith(expect.objectContaining({
			conversationId: null,
			draftText: '',
			selectedAttachmentIds: [],
		}));

		resolveConversation?.('conv-race');
		await waitFor(() => {
			expect(ensureConversation).toHaveBeenCalledTimes(1);
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(draftSpy).toHaveBeenCalledTimes(1);
	});

	it('queues the next message on Enter while generation is in progress', async () => {
		const queueSpy = vi.fn();
		const { getByPlaceholderText, queryByTestId } = render(MessageInputWrapper, {
			isGenerating: true,
			onQueue: queueSpy,
		});

		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
		await fireEvent.input(input, { target: { value: 'Queue this next' } });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

		expect(queueSpy).toHaveBeenCalledTimes(1);
		expect(queueSpy).toHaveBeenCalledWith('Queue this next');
		expect(input.value).toBe('');
		expect(queryByTestId('queue-button')).toBeNull();
	});

	it('does not clear the draft when the queue slot is already occupied', async () => {
		const queueSpy = vi.fn();
		const { getByPlaceholderText } = render(MessageInputWrapper, {
			isGenerating: true,
			hasQueuedMessage: true,
			queuedMessagePreview: 'Already queued',
			onQueue: queueSpy,
		});

		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;
		await fireEvent.input(input, { target: { value: 'Keep this draft' } });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

		expect(queueSpy).not.toHaveBeenCalled();
		expect(input.value).toBe('Keep this draft');
	});

	it('allows deleting the queued message from the banner', async () => {
		const deleteSpy = vi.fn();
		const { getByTestId } = render(MessageInputWrapper, {
			hasQueuedMessage: true,
			queuedMessagePreview: 'Already queued',
			onDeleteQueuedMessage: deleteSpy,
		});

		await fireEvent.click(getByTestId('delete-queued-button'));

		expect(deleteSpy).toHaveBeenCalledTimes(1);
	});

	it('emits onUploadFiles when files are picked via file picker', async () => {
		const uploadFilesSpy = vi.fn();
		const { container } = render(MessageInput, {
			conversationId: 'conv-1',
			attachmentsEnabled: true,
			onUploadFiles: uploadFilesSpy,
		});

		const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(['hello'], 'test.txt', { type: 'text/plain' });

		await fireEvent.change(fileInput, { target: { files: [file] } });

		expect(uploadFilesSpy).toHaveBeenCalledTimes(1);
		expect(uploadFilesSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				files: [file],
				conversationId: 'conv-1',
			})
		);
		expect(uploadFilesSpy.mock.calls[0][0].done).toBeInstanceOf(Function);
	});

	it('uses the registered upload handler to show progress for dropped files', async () => {
		let registeredUpload:
			| ((files: FileList | null) => Promise<void>)
			| null = null;
		let doneCallback: ((result: unknown) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: { done: (result: unknown) => void }) => {
			doneCallback = payload.done;
		});

		const { findByText, queryByText } = render(MessageInput, {
			conversationId: 'conv-1',
			attachmentsEnabled: true,
			onUploadReady: (uploadFn) => {
				registeredUpload = uploadFn;
			},
			onUploadFiles: uploadFilesHandler,
		});

		await waitFor(() => {
			expect(registeredUpload).toBeInstanceOf(Function);
		});
		const file = new File(['# dropped'], 'dropped.md', { type: 'text/markdown' });
		await registeredUpload!([file] as unknown as FileList);

		expect(uploadFilesHandler).toHaveBeenCalledTimes(1);
		expect(uploadFilesHandler).toHaveBeenCalledWith(
			expect.objectContaining({
				files: [file],
				conversationId: 'conv-1',
			})
		);
		expect(await findByText('Uploading file...')).toBeDefined();

		doneCallback!({
			success: true,
			attachment: {
				artifact: {
					id: 'artifact-dropped',
					type: 'source_document',
					retrievalClass: 'durable',
					name: 'dropped.md',
					mimeType: 'text/markdown',
					sizeBytes: 9,
					conversationId: 'conv-1',
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: 'artifact-dropped',
				readinessError: null,
			},
		});

		await waitFor(() => {
			expect(queryByText('Uploading file...')).toBeNull();
		});
		expect(await findByText('dropped.md')).toBeDefined();
	});

	it('adds attachment to list when done callback is called with success', async () => {
		let doneCallback: ((result: unknown) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: { done: (result: unknown) => void }) => {
			doneCallback = payload.done;
		});

		const { container, findByText } = render(MessageInput, {
			conversationId: 'conv-1',
			attachmentsEnabled: true,
			onUploadFiles: uploadFilesHandler,
		});

		const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(['content'], 'report.pdf', { type: 'application/pdf' });

		await fireEvent.change(fileInput, { target: { files: [file] } });

		doneCallback!({
			success: true,
			attachment: {
				artifact: {
					id: 'artifact-1',
					type: 'source_document',
					retrievalClass: 'durable',
					name: 'report.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 7,
					conversationId: 'conv-1',
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: 'normalized-1',
				readinessError: null,
			},
		});

		expect(await findByText('report.pdf')).toBeDefined();
	});

	it('does not reselect already attached conversation artifacts in the composer', async () => {
		const { queryByText } = render(MessageInput, {
			conversationId: 'conv-1',
			attachmentsEnabled: true,
			attachedArtifacts: [
				{
					id: 'artifact-sent',
					type: 'source_document',
					retrievalClass: 'durable',
					name: 'already-sent.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 7,
					conversationId: 'conv-1',
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			],
		});

		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(queryByText('already-sent.pdf')).toBeNull();
	});

	it('still restores explicitly saved draft attachments', async () => {
		const { findByText } = render(MessageInput, {
			conversationId: 'conv-1',
			attachmentsEnabled: true,
			draftVersion: 1,
			draftAttachments: [
				{
					artifact: {
						id: 'artifact-draft',
						type: 'source_document',
						retrievalClass: 'durable',
						name: 'draft-attachment.pdf',
						mimeType: 'application/pdf',
						sizeBytes: 7,
						conversationId: 'conv-1',
						summary: null,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
					promptReady: true,
					promptArtifactId: 'normalized-draft',
					readinessError: null,
				},
			],
		});

		expect(await findByText('draft-attachment.pdf')).toBeDefined();
	});

	it('shows error when done callback is called with failure', async () => {
		let doneCallback: ((result: unknown) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: { done: (result: unknown) => void }) => {
			doneCallback = payload.done;
		});

		const { container, findByText } = render(MessageInput, {
			conversationId: 'conv-1',
			attachmentsEnabled: true,
			onUploadFiles: uploadFilesHandler,
		});

		const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(['broken'], 'corrupt.pdf', { type: 'application/pdf' });

		await fireEvent.change(fileInput, { target: { files: [file] } });

		doneCallback!({
			success: false,
			fileName: 'corrupt.pdf',
			error: 'Server rejected the file',
		});

		expect(await findByText('corrupt.pdf: Server rejected the file')).toBeDefined();
	});

	it('rejects oversized file locally without emitting onUploadFiles', async () => {
		const uploadFilesSpy = vi.fn();
		const { container, findByText } = render(MessageInput, {
			conversationId: 'conv-1',
			attachmentsEnabled: true,
			onUploadFiles: uploadFilesSpy,
		});

		const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
		const largeFile = new File(['x'], 'huge.pdf', { type: 'application/pdf' });
		Object.defineProperty(largeFile, 'size', { value: 101 * 1024 * 1024 });

		await fireEvent.change(fileInput, { target: { files: [largeFile] } });

		expect(uploadFilesSpy).not.toHaveBeenCalled();
		expect(await findByText(/exceed.*100MB|exceed.*upload size/)).toBeDefined();
	});
});
