import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeDocumentItem } from '$lib/types';
import LinkedDocumentPicker from './LinkedDocumentPicker.svelte';

function makeDocument(overrides: Partial<KnowledgeDocumentItem> = {}): KnowledgeDocumentItem {
	return {
		id: overrides.id ?? 'display-1',
		displayArtifactId: overrides.displayArtifactId ?? 'display-1',
		promptArtifactId: overrides.promptArtifactId ?? 'prompt-1',
		familyArtifactIds: overrides.familyArtifactIds ?? ['display-1', 'prompt-1'],
		name: overrides.name ?? 'Annual report.pdf',
		mimeType: overrides.mimeType ?? 'application/pdf',
		sizeBytes: overrides.sizeBytes ?? 100,
		conversationId: overrides.conversationId ?? null,
		summary: overrides.summary ?? null,
		normalizedAvailable: overrides.normalizedAvailable ?? true,
		documentOrigin: overrides.documentOrigin ?? 'uploaded',
		createdAt: overrides.createdAt ?? 1,
		updatedAt: overrides.updatedAt ?? 2,
	};
}

describe('LinkedDocumentPicker', () => {
	it('filters logical documents and returns canonical linked-source identity', async () => {
		const apply = vi.fn();
		render(LinkedDocumentPicker, {
			documents: [
				makeDocument(),
				makeDocument({
					id: 'display-2',
					displayArtifactId: 'display-2',
					promptArtifactId: 'prompt-2',
					familyArtifactIds: ['display-2', 'prompt-2'],
					name: 'Budget notes.md',
					mimeType: 'text/markdown',
				}),
			],
			selectedSources: [],
			initialQuery: 'budget',
			onApply: apply,
			onCancel: vi.fn(),
		});

		expect(screen.queryByText('Annual report.pdf')).toBeNull();
		const option = screen.getByRole('checkbox', { name: /Budget notes.md/i });
		await fireEvent.click(option);
		expect(option.closest('label')).toHaveClass('selected');
		await fireEvent.click(screen.getByRole('button', { name: 'Link selected documents' }));

		expect(apply).toHaveBeenCalledWith([
			expect.objectContaining({
				displayArtifactId: 'display-2',
				promptArtifactId: 'prompt-2',
				familyArtifactIds: ['display-2', 'prompt-2'],
				name: 'Budget notes.md',
				type: 'document',
			}),
		]);
	});

	it('only offers prompt-ready documents and drops stale selections', () => {
		render(LinkedDocumentPicker, {
			documents: [
				makeDocument(),
				makeDocument({
					id: 'display-unready',
					displayArtifactId: 'display-unready',
					promptArtifactId: null,
					familyArtifactIds: ['display-unready'],
					name: 'Still processing.pdf',
					normalizedAvailable: false,
				}),
			],
			selectedSources: [
				{
					displayArtifactId: 'display-stale',
					promptArtifactId: null,
					familyArtifactIds: ['display-stale'],
					name: 'Stale source.pdf',
					type: 'document',
				},
			],
			onApply: vi.fn(),
			onCancel: vi.fn(),
		});

		expect(screen.getByRole('checkbox', { name: /Annual report.pdf/i })).toBeInTheDocument();
		expect(screen.queryByText('Still processing.pdf')).toBeNull();
		expect(screen.queryByText('Stale source.pdf')).toBeNull();
	});

	it('shows selected documents and allows removal before applying', async () => {
		const apply = vi.fn();
		render(LinkedDocumentPicker, {
			documents: [makeDocument()],
			selectedSources: [
				{
					displayArtifactId: 'display-1',
					promptArtifactId: 'prompt-1',
					familyArtifactIds: ['display-1', 'prompt-1'],
					name: 'Annual report.pdf',
					type: 'document',
				},
			],
			onApply: apply,
			onCancel: vi.fn(),
		});

		const selectedRegion = screen.getByRole('list', { name: 'Selected linked documents' });
		expect(selectedRegion.querySelector('.linked-document-picker__selected-chip')).not.toBeNull();
		await fireEvent.click(
			within(selectedRegion).getByRole('button', { name: 'Remove Annual report.pdf' })
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Link selected documents' }));

		expect(apply).toHaveBeenCalledWith([]);
	});

	it('cancels from Escape and backdrop clicks', async () => {
		const cancel = vi.fn();
		const { unmount } = render(LinkedDocumentPicker, {
			documents: [makeDocument()],
			selectedSources: [],
			onApply: vi.fn(),
			onCancel: cancel,
		});

		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(cancel).toHaveBeenCalledTimes(1);

		unmount();
		cancel.mockClear();
		render(LinkedDocumentPicker, {
			documents: [makeDocument()],
			selectedSources: [],
			onApply: vi.fn(),
			onCancel: cancel,
		});

		await fireEvent.pointerDown(screen.getByRole('presentation'));

		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it('traps Tab navigation inside the modal dialog', async () => {
		render(LinkedDocumentPicker, {
			documents: [makeDocument()],
			selectedSources: [],
			onApply: vi.fn(),
			onCancel: vi.fn(),
		});

		const closeButton = screen.getByRole('button', { name: 'Close document picker' });
		const applyButton = screen.getByRole('button', { name: 'Link selected documents' });

		applyButton.focus();
		await fireEvent.keyDown(window, { key: 'Tab' });
		expect(closeButton).toHaveFocus();

		closeButton.focus();
		await fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
		expect(applyButton).toHaveFocus();
	});
});
