import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/svelte';
import ConversationItemWrapper from './ConversationItemWrapper.test.svelte';

vi.mock('svelte/transition', () => ({
	fade: () => ({}),
	scale: () => ({}),
	slide: () => ({})
}));

if (typeof Element !== 'undefined') {
	Element.prototype.animate = vi.fn().mockImplementation(() => {
		const animation: any = {
			finished: Promise.resolve(),
			cancel: vi.fn(),
			play: vi.fn()
		};
		setTimeout(() => {
			if (animation.onfinish) animation.onfinish();
		}, 0);
		return animation;
	});
}

describe('ConversationItem Component', () => {
	const mockConversation = {
		id: 'conv-1',
		title: 'Test Conversation',
		updatedAt: new Date(),
		messages: []
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders conversation title without timestamp metadata', () => {
		render(ConversationItemWrapper, { conversation: mockConversation });
		expect(screen.getByText('Test Conversation')).toBeInTheDocument();
		expect(screen.queryByText('2 mins ago')).not.toBeInTheDocument();
	});

	it('renders a compact accessible fork indicator for fork conversations', async () => {
		render(ConversationItemWrapper, {
			conversation: {
				...mockConversation,
				forkSummary: {
					sourceTitle: 'Source title',
					forkSequence: 2,
					sourceConversationId: 'source-conv',
					sourceConversationIdAvailable: true,
				},
			},
		});

		const indicator = screen.getByLabelText('Fork of Source title, fork 2');
		expect(indicator).toBeInTheDocument();
		expect(indicator).toHaveAttribute('title', 'Fork of Source title, fork 2');
		expect(indicator).toHaveAttribute('type', 'button');
		indicator.focus();
		expect(indicator).toHaveFocus();
		expect(screen.queryByRole('tree')).not.toBeInTheDocument();
	});

	it('dispatches select event when clicked', async () => {
		const mockSelect = vi.fn();
		const { container } = render(ConversationItemWrapper, { 
			conversation: mockConversation,
			onSelect: mockSelect
		});

		const wrapper = container.querySelector('[role="button"]') as HTMLElement;
		await fireEvent.click(wrapper);

		expect(mockSelect).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'conv-1' })
		);
	});

	describe('Rename flow', () => {
		it('shows input when rename is clicked and dispatches rename on enter', async () => {
			const mockRename = vi.fn();
			render(ConversationItemWrapper, { 
				conversation: mockConversation,
				onRename: mockRename
			});

			const menuButton = screen.getByLabelText('Conversation options');
			await fireEvent.click(menuButton);

			const renameButton = screen.getByText('Rename');
			await fireEvent.click(renameButton);

			const input = screen.getByDisplayValue('Test Conversation') as HTMLInputElement;
			expect(input).toBeInTheDocument();

			await fireEvent.input(input, { target: { value: 'New Title' } });
			await fireEvent.keyDown(input, { key: 'Enter' });

			expect(mockRename).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'conv-1', title: 'New Title' })
			);
		});

		it('cancels rename on escape', async () => {
			const mockRename = vi.fn();
			render(ConversationItemWrapper, { 
				conversation: mockConversation,
				onRename: mockRename
			});

			await fireEvent.click(screen.getByLabelText('Conversation options'));
			await fireEvent.click(screen.getByText('Rename'));

			const input = screen.getByDisplayValue('Test Conversation');
			await fireEvent.input(input, { target: { value: 'New Title' } });
			await fireEvent.keyDown(input, { key: 'Escape' });

			expect(mockRename).not.toHaveBeenCalled();
			expect(screen.queryByDisplayValue('New Title')).not.toBeInTheDocument();
			expect(screen.getByText('Test Conversation')).toBeInTheDocument();
		});
	});

	describe('Delete flow with confirmation', () => {
		it('shows confirmation dialog when delete is clicked', async () => {
			render(ConversationItemWrapper, { conversation: mockConversation });

			await fireEvent.click(screen.getByLabelText('Conversation options'));

			await fireEvent.click(screen.getByText('Delete'));

			expect(screen.getByText('Delete this conversation?')).toBeInTheDocument();
			expect(
				screen.getByText('Are you sure you want to delete this conversation? This action cannot be undone.')
			).toBeInTheDocument();
		});

		it('dispatches delete event when confirmation is accepted', async () => {
			const mockDelete = vi.fn();
			render(ConversationItemWrapper, { 
				conversation: mockConversation,
				onDelete: mockDelete
			});

			await fireEvent.click(screen.getByLabelText('Conversation options'));
			await fireEvent.click(screen.getByText('Delete'));

			const confirmButton = screen.getByRole('button', { name: 'Delete' });
			await fireEvent.click(confirmButton);

			expect(mockDelete).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'conv-1' })
			);

			await waitFor(() => {
				expect(screen.queryByText('Delete this conversation?')).not.toBeInTheDocument();
			});
		});

		it('does not dispatch delete and closes dialog when cancelled', async () => {
			const mockDelete = vi.fn();
			render(ConversationItemWrapper, { 
				conversation: mockConversation,
				onDelete: mockDelete
			});

			await fireEvent.click(screen.getByLabelText('Conversation options'));
			await fireEvent.click(screen.getByText('Delete'));

			await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

			expect(mockDelete).not.toHaveBeenCalled();

			await waitFor(() => {
				expect(screen.queryByText('Delete this conversation?')).not.toBeInTheDocument();
			});
		});
	});
});
