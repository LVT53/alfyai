import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, within } from '@testing-library/svelte';
import MessageInputWrapper from './MessageInputWrapper.test.svelte';
import MessageInput from './MessageInput.svelte';

const fetchKnowledgeLibraryMock = vi.hoisted(() => vi.fn());
const discoverSkillsMock = vi.hoisted(() => vi.fn());

vi.mock('$lib/client/api/knowledge', () => ({
	fetchKnowledgeLibrary: fetchKnowledgeLibraryMock,
}));

vi.mock('$lib/client/api/skills', () => ({
	discoverSkills: discoverSkillsMock,
}));

describe('MessageInput', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fetchKnowledgeLibraryMock.mockResolvedValue({
			documents: [],
			results: [],
			workflows: [],
		});
		discoverSkillsMock.mockResolvedValue([]);
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

	it('opens the command tray for a slash command when the registry flag is enabled', async () => {
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});

		await fireEvent.input(getByPlaceholderText('Type a message...'), {
			target: { value: '/' },
		});

		expect(getByRole('listbox', { name: 'Composer commands' })).toBeInTheDocument();
		expect(getByRole('option', { name: /\/model/i })).toBeInTheDocument();
	});

	it('keeps the command tray mounted in a closing state on Escape', async () => {
		const { getByPlaceholderText, getByRole, queryByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: '/' } });
		expect(getByRole('listbox', { name: 'Composer commands' })).toHaveAttribute(
			'data-state',
			'open'
		);

		await fireEvent.keyDown(input, { key: 'Escape' });

		expect(getByRole('listbox', { name: 'Composer commands' })).toHaveAttribute(
			'data-state',
			'closing'
		);

		await fireEvent.animationEnd(getByRole('listbox', { name: 'Composer commands' }));

		expect(queryByRole('listbox', { name: 'Composer commands' })).toBeNull();
	});

	it('does not select a stale command when Enter follows Escape during tray close', async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			deepResearchEnabled: true,
			onSend: sendSpy,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: '/research' } });
		await fireEvent.keyDown(input, { key: 'Escape' });
		expect(getByRole('listbox', { name: 'Composer commands' })).toHaveAttribute(
			'data-state',
			'closing'
		);

		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: '/research',
				deepResearchDepth: null,
			})
		);
		expect(getByRole('button', { name: 'Deep Research' })).not.toHaveClass(
			'composer-icon--active'
		);
	});

	it('selects a highlighted command with Enter before sending', async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			deepResearchEnabled: true,
			onSend: sendSpy,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: '/research' } });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

		expect(sendSpy).not.toHaveBeenCalled();
		expect(input.value).toBe('');
		expect(getByRole('button', { name: 'Deep Research' })).toHaveClass('composer-icon--active');

		await fireEvent.input(input, { target: { value: 'Check latest policy' } });
		await fireEvent.click(getByRole('button', { name: 'Send message' }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Check latest policy',
				deepResearchDepth: 'standard',
			})
		);
	});

	it('announces the active command row while navigating the tray', async () => {
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: '/' } });

		expect(getByRole('status')).toHaveTextContent('Active command: /model Model');
		await fireEvent.keyDown(input, { key: 'ArrowDown' });

		expect(getByRole('status')).toHaveTextContent('Active command: /style Style');
	});

	it('keeps Shift+Enter and IME composition from selecting command rows', async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, queryByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			deepResearchEnabled: true,
			onSend: sendSpy,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: '/research' } });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

		expect(sendSpy).not.toHaveBeenCalled();
		expect(queryByRole('listbox', { name: 'Composer commands' })).toBeInTheDocument();
		expect(input.value).toBe('/research');

		await fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

		expect(sendSpy).not.toHaveBeenCalled();
		expect(queryByRole('listbox', { name: 'Composer commands' })).toBeInTheDocument();
	});

	it('opens /document picker, renders linked source chips, removes them, and sends structured sources', async () => {
		fetchKnowledgeLibraryMock.mockResolvedValue({
			documents: [
				{
					id: 'display-1',
					displayArtifactId: 'display-1',
					promptArtifactId: 'prompt-1',
					familyArtifactIds: ['display-1', 'prompt-1'],
					name: 'Budget notes.md',
					mimeType: 'text/markdown',
					sizeBytes: 100,
					conversationId: null,
					summary: null,
					normalizedAvailable: true,
					documentOrigin: 'uploaded',
					createdAt: 1,
					updatedAt: 2,
				},
			],
			results: [],
			workflows: [],
		});
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole, findByRole, findByText, queryByText } = render(
			MessageInput,
			{
				composerCommandRegistryEnabled: true,
				onSend: sendSpy,
			}
		);
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: '/document' } });
		await fireEvent.click(getByRole('option', { name: /\/document/i }));
		await findByRole('dialog', { name: 'Link Library documents' });
		await fireEvent.click(await findByRole('checkbox', { name: 'Budget notes.md' }));
		await fireEvent.click(getByRole('button', { name: 'Link selected documents' }));

		expect(await findByText('Budget notes.md')).toBeInTheDocument();

		await fireEvent.click(getByRole('button', { name: 'Remove Budget notes.md' }));
		expect(queryByText('Budget notes.md')).toBeNull();

		await fireEvent.input(input, { target: { value: '/document' } });
		await fireEvent.click(getByRole('option', { name: /\/document/i }));
		await fireEvent.click(await findByRole('checkbox', { name: 'Budget notes.md' }));
		await fireEvent.click(getByRole('button', { name: 'Link selected documents' }));
		await fireEvent.input(input, { target: { value: 'Use this source' } });
		await fireEvent.click(getByRole('button', { name: 'Send message' }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Use this source',
				linkedSources: [
					expect.objectContaining({
						displayArtifactId: 'display-1',
						promptArtifactId: 'prompt-1',
						name: 'Budget notes.md',
						type: 'document',
					}),
				],
			})
		);
	});

	it('uses the typed /document query as the initial picker search', async () => {
		fetchKnowledgeLibraryMock.mockResolvedValue({
			documents: [
				{
					id: 'display-report',
					displayArtifactId: 'display-report',
					promptArtifactId: 'prompt-report',
					familyArtifactIds: ['display-report', 'prompt-report'],
					name: 'Annual report.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 100,
					conversationId: null,
					summary: null,
					normalizedAvailable: true,
					documentOrigin: 'uploaded',
					createdAt: 1,
					updatedAt: 2,
				},
				{
					id: 'display-budget',
					displayArtifactId: 'display-budget',
					promptArtifactId: 'prompt-budget',
					familyArtifactIds: ['display-budget', 'prompt-budget'],
					name: 'Budget notes.md',
					mimeType: 'text/markdown',
					sizeBytes: 100,
					conversationId: null,
					summary: null,
					normalizedAvailable: true,
					documentOrigin: 'uploaded',
					createdAt: 1,
					updatedAt: 2,
				},
			],
			results: [],
			workflows: [],
		});
		const { getByPlaceholderText, getByRole, findByRole, queryByText } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: '/document report' } });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

		await findByRole('dialog', { name: 'Link Library documents' });
		expect(getByRole('searchbox', { name: 'Search documents' })).toHaveValue('report');
		expect(getByRole('checkbox', { name: 'Annual report.pdf' })).toBeInTheDocument();
		expect(queryByText('Budget notes.md')).toBeNull();
	});

	it('restores focus to the composer when the document picker is cancelled', async () => {
		const { getByPlaceholderText, getByRole, findByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: '/document' } });
		await fireEvent.click(getByRole('option', { name: /\/document/i }));
		await findByRole('dialog', { name: 'Link Library documents' });
		await fireEvent.click(getByRole('button', { name: 'Close document picker' }));

		await waitFor(() => expect(input).toHaveFocus());
	});

	it('restores linked source draft chips without reopening transient picker or tray state', () => {
		const { getByText, queryByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			draftLinkedSources: [
				{
					displayArtifactId: 'display-1',
					promptArtifactId: 'prompt-1',
					familyArtifactIds: ['display-1', 'prompt-1'],
					name: 'Restored report.pdf',
					type: 'document',
				},
			],
			draftVersion: 1,
		});

		expect(getByText('Restored report.pdf')).toBeInTheDocument();
		expect(queryByRole('dialog', { name: 'Link Library documents' })).toBeNull();
		expect(queryByRole('listbox', { name: 'Composer commands' })).toBeNull();
	});

	it('opens the /source manager and removes a linked source', async () => {
		const draftSpy = vi.fn();
		const { getByPlaceholderText, getByRole, getByText, queryByText } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			draftLinkedSources: [
				{
					displayArtifactId: 'display-1',
					promptArtifactId: 'prompt-1',
					familyArtifactIds: ['display-1', 'prompt-1'],
					name: 'Restored report.pdf',
					type: 'document',
					documentOrigin: 'uploaded',
				},
			],
			draftVersion: 1,
			onDraftChange: draftSpy,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: '/source' } });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

		const manager = getByRole('dialog', { name: 'Sources' });
		expect(manager).toBeInTheDocument();
		expect(within(manager).getByText('Restored report.pdf')).toBeInTheDocument();
		expect(within(manager).getByText('Uploaded document')).toBeInTheDocument();

		await fireEvent.click(
			within(manager).getByRole('button', { name: 'Remove Restored report.pdf' })
		);

		expect(queryByText('Restored report.pdf')).toBeNull();
		expect(draftSpy).toHaveBeenLastCalledWith(
			expect.objectContaining({
				selectedLinkedSources: [],
			})
		);
	});

	it('clears linked sources and opens the document picker from the source manager', async () => {
		fetchKnowledgeLibraryMock.mockResolvedValue({
			documents: [
				{
					id: 'display-2',
					displayArtifactId: 'display-2',
					promptArtifactId: 'prompt-2',
					familyArtifactIds: ['display-2', 'prompt-2'],
					name: 'New source.docx',
					mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
					sizeBytes: 100,
					conversationId: null,
					summary: null,
					normalizedAvailable: true,
					documentOrigin: 'uploaded',
					createdAt: 1,
					updatedAt: 2,
				},
			],
			results: [],
			workflows: [],
		});
		const { getByPlaceholderText, getByRole, findByRole, findByText } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			draftLinkedSources: [
				{
					displayArtifactId: 'display-1',
					promptArtifactId: 'prompt-1',
					familyArtifactIds: ['display-1', 'prompt-1'],
					name: 'Restored report.pdf',
					type: 'document',
					documentOrigin: 'uploaded',
				},
			],
			draftVersion: 1,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: '/source' } });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
		const manager = getByRole('dialog', { name: 'Sources' });

		await fireEvent.click(within(manager).getByRole('button', { name: 'Clear all' }));
		expect(within(manager).getByText('No linked sources selected.')).toBeInTheDocument();

		await fireEvent.click(within(manager).getByRole('button', { name: 'Add document' }));
		await findByRole('dialog', { name: 'Link Library documents' });
		await fireEvent.click(await findByRole('checkbox', { name: 'New source.docx' }));
		await fireEvent.click(getByRole('button', { name: 'Link selected documents' }));

		expect(await findByText('New source.docx')).toBeInTheDocument();
	});

	it('closes the source manager on Escape and outside pointer down with focus restored', async () => {
		const { getByPlaceholderText, getByRole, queryByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: '/source' } });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
		expect(getByRole('dialog', { name: 'Sources' })).toBeInTheDocument();

		await fireEvent.keyDown(document, { key: 'Escape' });
		await waitFor(() => expect(queryByRole('dialog', { name: 'Sources' })).toBeNull());
		await waitFor(() => expect(input).toHaveFocus());

		await fireEvent.input(input, { target: { value: '/source' } });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
		expect(getByRole('dialog', { name: 'Sources' })).toBeInTheDocument();

		await fireEvent.pointerDown(document.body);
		await waitFor(() => expect(queryByRole('dialog', { name: 'Sources' })).toBeNull());
		await waitFor(() => expect(input).toHaveFocus());
	});

	it('consumes only the active command token and preserves surrounding text', async () => {
		const { getByPlaceholderText } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			deepResearchEnabled: true,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, {
			target: { value: 'Please /research now' },
		});
		input.setSelectionRange(11, 11);
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

		expect(input.value).toBe('Please  now');
	});

	it('opens dollar skill discovery without triggering on prices', async () => {
		discoverSkillsMock.mockResolvedValue([
			{
				id: 'skill-1',
				ownership: 'user',
				displayName: 'Interview coach',
				description: 'Practice interview answers.',
				activationExamples: ['interview me'],
				enabled: true,
			},
		]);
		const { getByPlaceholderText, queryByRole, findByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: 'It costs $12' } });
		expect(queryByRole('listbox', { name: 'Composer commands' })).toBeNull();

		await fireEvent.input(input, { target: { value: '$interview' } });
		expect(await findByRole('option', { name: /Interview coach/i })).toBeInTheDocument();
		expect(discoverSkillsMock).toHaveBeenCalledWith('interview');
	});

	it('selects a discovered skill into pending state and preserves surrounding text', async () => {
		discoverSkillsMock.mockResolvedValue([
			{
				id: 'skill-1',
				ownership: 'user',
				displayName: 'Interview coach',
				description: 'Practice interview answers.',
				activationExamples: ['interview me'],
				enabled: true,
			},
		]);
		const sendSpy = vi.fn();
		const draftSpy = vi.fn();
		const { getByPlaceholderText, findByRole, getByRole, getByText } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			onSend: sendSpy,
			onDraftChange: draftSpy,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: 'Please $interview this answer' } });
		input.setSelectionRange(17, 17);
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.click(await findByRole('option', { name: /Interview coach/i }));

		expect(input.value).toBe('Please  this answer');
		expect(getByText('Interview coach')).toBeInTheDocument();
		expect(draftSpy).toHaveBeenLastCalledWith(
			expect.objectContaining({
				pendingSkill: expect.objectContaining({
					id: 'skill-1',
					ownership: 'user',
					displayName: 'Interview coach',
				}),
			})
		);

		await fireEvent.click(getByRole('button', { name: 'Send message' }));
		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Please  this answer',
				pendingSkill: expect.objectContaining({ id: 'skill-1', ownership: 'user' }),
			})
		);
	});

	it('replaces the existing pending skill when another skill is selected', async () => {
		discoverSkillsMock
			.mockResolvedValueOnce([
				{
					id: 'skill-1',
					ownership: 'user',
					displayName: 'Interview coach',
					description: 'Practice interview answers.',
					activationExamples: [],
					enabled: true,
				},
			])
			.mockResolvedValueOnce([
				{
					id: 'system:code-review',
					ownership: 'system',
					displayName: 'Code Review',
					description: 'Review code.',
					activationExamples: [],
					enabled: true,
					published: true,
				},
			]);
		const { getByPlaceholderText, findByRole, queryByText, getByText } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: '$interview First' } });
		input.setSelectionRange(10, 10);
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.click(await findByRole('option', { name: /Interview coach/i }));
		expect(getByText('Interview coach')).toBeInTheDocument();

		await fireEvent.input(input, { target: { value: '$review First' } });
		input.setSelectionRange(7, 7);
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.click(await findByRole('option', { name: /Code Review/i }));

		expect(queryByText('Interview coach')).toBeNull();
		expect(getByText('Code Review')).toBeInTheDocument();
	});

	it('restores a pending skill draft chip without reopening discovery', () => {
		const { getByText, getByRole, queryByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			draftPendingSkill: {
				id: 'skill-1',
				ownership: 'user',
				displayName: 'Interview coach',
			},
			draftVersion: 1,
		});

		expect(getByText('Interview coach')).toBeInTheDocument();
		expect(
			getByRole('button', { name: 'Remove pending skill Interview coach' })
		).toBeInTheDocument();
		expect(queryByRole('listbox', { name: 'Composer commands' })).toBeNull();
	});

	it('ignores linked source and pending skill drafts when the registry flag is disabled', async () => {
		const sendSpy = vi.fn();
		const draftSpy = vi.fn();
		const { getByPlaceholderText, getByRole, queryByText } = render(MessageInput, {
			composerCommandRegistryEnabled: false,
			draftLinkedSources: [
				{
					displayArtifactId: 'display-disabled',
					promptArtifactId: 'prompt-disabled',
					familyArtifactIds: ['display-disabled', 'prompt-disabled'],
					name: 'Disabled source.pdf',
					type: 'document',
				},
			],
			draftPendingSkill: {
				id: 'skill-disabled',
				ownership: 'user',
				displayName: 'Disabled Skill',
			},
			draftVersion: 1,
			onDraftChange: draftSpy,
			onSend: sendSpy,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		expect(queryByText('Disabled source.pdf')).toBeNull();
		expect(queryByText('Disabled Skill')).toBeNull();
		await waitFor(() =>
			expect(draftSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					selectedLinkedSources: [],
					pendingSkill: null,
				})
			)
		);

		await fireEvent.input(input, { target: { value: 'Send without disabled draft state' } });
		await fireEvent.click(getByRole('button', { name: 'Send message' }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Send without disabled draft state',
				linkedSources: [],
				pendingSkill: null,
			})
		);
	});

	it('keeps pending composer state when /clear confirmation is cancelled', async () => {
		const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
		const draftSpy = vi.fn();
		const { getByPlaceholderText, getByText, getByRole, findByText } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			draftText: 'Keep this draft',
			draftAttachments: [
				{
					artifact: {
						id: 'artifact-draft-clear',
						type: 'source_document',
						retrievalClass: 'durable',
						name: 'clear-attachment.pdf',
						mimeType: 'application/pdf',
						sizeBytes: 7,
						conversationId: 'conv-1',
						summary: null,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
					promptReady: true,
					promptArtifactId: 'normalized-clear-attachment',
					readinessError: null,
				},
			],
			draftLinkedSources: [
				{
					displayArtifactId: 'display-clear',
					promptArtifactId: 'prompt-clear',
					familyArtifactIds: ['display-clear', 'prompt-clear'],
					name: 'Clear source.md',
					type: 'document',
				},
			],
			draftPendingSkill: {
				id: 'skill-clear',
				ownership: 'user',
				displayName: 'Clear Skill',
			},
			draftVersion: 1,
			onDraftChange: draftSpy,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		expect(await findByText('clear-attachment.pdf')).toBeInTheDocument();
		await fireEvent.input(input, { target: { value: 'Keep this draft /clear' } });
		input.setSelectionRange(input.value.length, input.value.length);
		await fireEvent.click(getByRole('option', { name: /\/clear/i }));

		expect(confirmSpy).toHaveBeenCalledWith('Clear the current draft and pending composer selections?');
		expect(input.value).toBe('Keep this draft /clear');
		expect(getByText('clear-attachment.pdf')).toBeInTheDocument();
		expect(getByText('Clear source.md')).toBeInTheDocument();
		expect(getByText('Clear Skill')).toBeInTheDocument();
		expect(getByRole('button', { name: 'Remove pending skill Clear Skill' })).toBeInTheDocument();
		expect(draftSpy).not.toHaveBeenLastCalledWith(
			expect.objectContaining({
				draftText: '',
				selectedAttachmentIds: [],
				selectedLinkedSources: [],
				pendingSkill: null,
			})
		);

		confirmSpy.mockRestore();
	});

	it('clears pending composer state after /clear confirmation', async () => {
		const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
		const draftSpy = vi.fn();
		const { getByPlaceholderText, getByRole, queryByText } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			draftText: 'Remove this draft',
			draftLinkedSources: [
				{
					displayArtifactId: 'display-remove',
					promptArtifactId: 'prompt-remove',
					familyArtifactIds: ['display-remove', 'prompt-remove'],
					name: 'Remove source.md',
					type: 'document',
				},
			],
			draftPendingSkill: {
				id: 'skill-remove',
				ownership: 'system',
				displayName: 'Remove Skill',
			},
			draftVersion: 1,
			onDraftChange: draftSpy,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: 'Remove this draft /clear' } });
		input.setSelectionRange(input.value.length, input.value.length);
		await fireEvent.click(getByRole('option', { name: /\/clear/i }));

		expect(confirmSpy).toHaveBeenCalledWith('Clear the current draft and pending composer selections?');
		expect(input.value).toBe('');
		expect(queryByText('Remove source.md')).toBeNull();
		expect(queryByText('Remove Skill')).toBeNull();
		expect(draftSpy).toHaveBeenLastCalledWith(
			expect.objectContaining({
				draftText: '',
				selectedAttachmentIds: [],
				selectedLinkedSources: [],
				pendingSkill: null,
			})
		);

		confirmSpy.mockRestore();
	});

	it('opens existing thinking controls from the slash command', async () => {
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: '/thinking' } });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

		expect(input.value).toBe('');
		expect(getByRole('listbox', { name: 'Thinking' })).toBeInTheDocument();
		expect(getByRole('option', { name: 'Off' })).toBeInTheDocument();
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
