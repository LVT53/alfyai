import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsAdminCampaignsPane from './SettingsAdminCampaignsPane.svelte';

vi.mock('$lib/client/api/campaigns', () => ({
	archiveAdminCampaign: vi.fn(),
	createAdminCampaign: vi.fn(),
	deleteAdminCampaignDraft: vi.fn(),
	duplicateAdminCampaign: vi.fn(),
	fetchAdminCampaign: vi.fn(),
	fetchAdminCampaigns: vi.fn(),
	publishAdminCampaign: vi.fn(),
	seedFirstRunCampaign: vi.fn(),
	updateAdminCampaign: vi.fn(),
}));

vi.mock('$lib/client/api/campaign-assets', () => ({
	uploadCampaignAssetSource: vi.fn(),
	saveCampaignAssetCrop: vi.fn(),
}));

import {
	archiveAdminCampaign,
	deleteAdminCampaignDraft,
	fetchAdminCampaign,
	fetchAdminCampaigns,
	updateAdminCampaign,
} from '$lib/client/api/campaigns';
import { uploadCampaignAssetSource } from '$lib/client/api/campaign-assets';

const mockArchiveAdminCampaign = archiveAdminCampaign as ReturnType<typeof vi.fn>;
const mockDeleteAdminCampaignDraft = deleteAdminCampaignDraft as ReturnType<typeof vi.fn>;
const mockFetchAdminCampaigns = fetchAdminCampaigns as ReturnType<typeof vi.fn>;
const mockFetchAdminCampaign = fetchAdminCampaign as ReturnType<typeof vi.fn>;
const mockUpdateAdminCampaign = updateAdminCampaign as ReturnType<typeof vi.fn>;
const mockUploadCampaignAssetSource = uploadCampaignAssetSource as ReturnType<typeof vi.fn>;

describe('SettingsAdminCampaignsPane', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchAdminCampaigns.mockResolvedValue([
			{
				id: 'campaign-1',
				type: 'first_run',
				version: 3,
				name: 'Welcome tour',
				status: 'draft',
				slideCount: 2,
				updatedAt: '2026-05-17T08:00:00.000Z',
			},
		]);
		mockFetchAdminCampaign.mockResolvedValue({
			id: 'campaign-1',
			type: 'first_run',
			version: 3,
			name: 'Welcome tour',
			releaseVersion: '1.0.0',
			status: 'draft',
			analyticsSummary: {
				autoShown: 7,
				completed: 3,
				skipped: 1,
				replayOpened: 2,
				completionRate: 0.75,
			},
			slides: [
				{
					id: 'slide-setup',
					kind: 'setup',
					sortOrder: 1,
					semanticRole: 'feature',
					setupControls: ['ui_language', 'theme'],
					titleEn: 'Set up AlfyAI',
					titleHu: 'AlfyAI beállítása',
					bodyEn: 'Connect your tools.',
					bodyHu: 'Kapcsold össze az eszközeidet.',
				},
				{
					id: 'slide-standard',
					kind: 'standard',
					sortOrder: 2,
					semanticRole: 'data_disclosure',
					titleEn: 'Start chatting',
					titleHu: 'Kezdj beszélgetni',
					bodyEn: 'Ask a question.',
					bodyHu: 'Tegyél fel egy kérdést.',
					actionLabelEn: 'Open chat',
					actionLabelHu: 'Chat megnyitása',
				},
			],
			validationErrors: [{ path: 'slides.1.actionUrl', message: 'Action URL is required.' }],
		});
		mockUpdateAdminCampaign.mockImplementation(async (_id, payload) => ({
			id: 'campaign-1',
			type: payload.type ?? 'first_run',
			version: 3,
			name: payload.name ?? 'Welcome tour',
			status: 'draft',
			slides: payload.slides ?? [],
		}));
		mockDeleteAdminCampaignDraft.mockResolvedValue(undefined);
		mockArchiveAdminCampaign.mockResolvedValue({ id: 'campaign-1', status: 'archived' });
		vi.spyOn(window, 'confirm').mockReturnValue(true);
	});

	it('lets admins reorder localized campaign slides and save the draft payload', async () => {
		render(SettingsAdminCampaignsPane);

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /Welcome tour/ })).toBeInTheDocument();
		});

		await fireEvent.click(screen.getByRole('button', { name: /Move Set up AlfyAI down/ }));
		await fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

		await waitFor(() => {
			expect(mockUpdateAdminCampaign).toHaveBeenCalled();
		});

		const [, payload] = mockUpdateAdminCampaign.mock.calls[0];
		expect(payload).toEqual(
			expect.objectContaining({
				name: 'Welcome tour',
				type: 'first_run',
				releaseVersion: '1.0.0',
			}),
		);
		expect(payload.slides.map((slide: { id?: string }) => slide.id)).toEqual(['slide-standard', 'slide-setup']);
		expect(payload.slides[0]).toEqual(
			expect.objectContaining({
				id: 'slide-standard',
				kind: 'standard',
				sortOrder: 1,
				semanticRole: 'data_disclosure',
				titleEn: 'Start chatting',
				titleHu: 'Kezdj beszélgetni',
			}),
		);
		expect(payload.slides[1]).toEqual(
			expect.objectContaining({
				id: 'slide-setup',
				kind: 'setup',
				sortOrder: 2,
				semanticRole: 'feature',
				setupControls: ['ui_language', 'theme'],
				titleEn: 'Set up AlfyAI',
				titleHu: 'AlfyAI beállítása',
			}),
		);
		expect(screen.getByText('Action URL is required.')).toBeInTheDocument();
	});

	it('deletes draft campaigns through the draft DELETE route instead of archiving them', async () => {
		render(SettingsAdminCampaignsPane);

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /Welcome tour/ })).toBeInTheDocument();
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }));

		await waitFor(() => {
			expect(mockDeleteAdminCampaignDraft).toHaveBeenCalledWith('campaign-1');
		});
		expect(mockArchiveAdminCampaign).not.toHaveBeenCalled();
	});

	it('renders campaign analytics from the service summary fields', async () => {
		render(SettingsAdminCampaignsPane);

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /Welcome tour/ })).toBeInTheDocument();
		});

		expect(screen.getByText('7 / 3 / 1 / 2')).toBeInTheDocument();
	});

	it('keeps published campaign snapshots read-only and disables save/publish controls', async () => {
		mockFetchAdminCampaigns.mockResolvedValueOnce([
			{
				id: 'campaign-1',
				type: 'first_run_onboarding',
				name: 'Welcome tour',
				status: 'published',
				updatedAt: '2026-05-17T08:00:00.000Z',
			},
		]);
		mockFetchAdminCampaign.mockResolvedValueOnce({
			id: 'campaign-1',
			type: 'first_run_onboarding',
			name: 'Welcome tour',
			status: 'published',
			slides: [
				{
					id: 'slide-setup',
					layoutType: 'setup',
					sortOrder: 1,
					title: { en: 'Set up AlfyAI', hu: 'AlfyAI beállítása' },
					body: { en: 'Connect your tools.', hu: 'Kapcsold össze az eszközeidet.' },
					altText: { en: 'Setup', hu: 'Beállítás' },
				},
			],
		});

		render(SettingsAdminCampaignsPane);

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /Welcome tour/ })).toBeInTheDocument();
		});

		expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
		expect(screen.getByLabelText('Name')).toBeDisabled();

		await fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
		expect(mockUpdateAdminCampaign).not.toHaveBeenCalled();
	});

	it('opens the crop modal immediately while the screenshot source upload is still pending', async () => {
		mockUploadCampaignAssetSource.mockReturnValue(new Promise(() => {}));
		render(SettingsAdminCampaignsPane);

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /Welcome tour/ })).toBeInTheDocument();
		});

		const uploadLabel = screen.getAllByText('Upload mobile crop')[0].closest('label');
		const uploadInput = uploadLabel?.querySelector('input[type="file"]') as HTMLInputElement | null;
		expect(uploadInput).toBeTruthy();

		await fireEvent.change(uploadInput!, {
			target: {
				files: [new File(['fake image bytes'], 'mobile.png', { type: 'image/png' })],
			},
		});

		expect(mockUploadCampaignAssetSource).toHaveBeenCalled();
		expect(screen.getByRole('dialog', { name: 'Crop campaign screenshot' })).toBeInTheDocument();
	});
});
