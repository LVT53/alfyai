import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CampaignModal from './CampaignModal.svelte';
import type { Campaign } from '$lib/client/api/campaigns';

const campaign: Campaign = {
	id: 'campaign-1',
	type: 'first_run_onboarding',
	status: 'published',
	name: 'Welcome tour',
	slides: [
		{
			id: 'slide-setup',
			layoutType: 'setup',
			sortOrder: 1,
			title: { en: 'Set up AlfyAI', hu: 'AlfyAI beállítása' },
			body: { en: 'Choose your defaults.', hu: 'Válaszd ki az alapokat.' },
			altText: { en: 'Setup screenshot', hu: 'Beállítás képernyőkép' },
			desktopCropAssetId: 'asset-desktop-1',
			mobileCropAssetId: 'asset-mobile-1',
			setupControls: ['ui_language', 'theme', 'model_default', 'ai_style'],
		},
		{
			id: 'slide-feature',
			layoutType: 'standard',
			sortOrder: 2,
			title: { en: 'Start chatting', hu: 'Kezdj beszélgetni' },
			body: { en: 'Ask a question.', hu: 'Tegyél fel egy kérdést.' },
			altText: { en: 'Chat screenshot', hu: 'Chat képernyőkép' },
			desktopCropAssetId: 'asset-desktop-2',
			mobileCropAssetId: 'asset-mobile-2',
		},
	],
};

describe('CampaignModal', () => {
	it('lets users navigate, records viewed slides, skips, and finishes', async () => {
		const onSlideView = vi.fn();
		const onSkip = vi.fn();
		const onFinish = vi.fn();

		render(CampaignModal, {
			props: {
				campaign,
				locale: 'en',
				onSlideView,
				onSkip,
				onFinish,
			},
		});

		expect(screen.getByRole('img', { name: 'Setup screenshot' })).toHaveAttribute(
			'src',
			'/api/campaign-assets/asset-desktop-1/content',
		);
		expect(screen.getByRole('heading', { name: 'Set up AlfyAI' })).toBeInTheDocument();
		expect(screen.queryByText('Setup')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();

		await waitFor(() => {
			expect(onSlideView).toHaveBeenCalledWith(expect.objectContaining({ id: 'slide-setup' }), 0);
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Next' }));
		expect(screen.getByRole('heading', { name: 'Start chatting' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Finish' })).toBeInTheDocument();
		await waitFor(() => {
			expect(onSlideView).toHaveBeenCalledWith(expect.objectContaining({ id: 'slide-feature' }), 1);
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
		expect(onFinish).toHaveBeenCalledTimes(1);
		expect(onSkip).not.toHaveBeenCalled();
	});

	it('treats close as skip and renders setup controls through preference callbacks', async () => {
		const onSkip = vi.fn();
		const onChangeUiLanguage = vi.fn();
		const onChangeTheme = vi.fn();
		const onChangeModel = vi.fn();
		const onChangePersonality = vi.fn();

		render(CampaignModal, {
			props: {
				campaign,
				locale: 'en',
				onSkip,
				setupPreferences: {
					availableModels: [
						{ id: 'model1', displayName: 'Model 1' },
						{ id: 'model2', displayName: 'Model 2' },
					],
					effectiveModel: 'model2',
					systemDefaultModel: 'model2',
					selectedModel: null,
					selectedTheme: 'system',
					selectedUiLanguage: 'en',
					personalityProfiles: [{ id: 'concise', name: 'Concise', description: 'Short answers' }],
					selectedPersonalityId: null,
					onChangeUiLanguage,
					onChangeTheme,
					onChangeModel,
					onChangePersonality,
				},
			},
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Hungarian' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
		await fireEvent.change(screen.getByRole('combobox', { name: 'Default model' }), {
			target: { value: 'model1' },
		});
		await fireEvent.change(screen.getByRole('combobox', { name: 'Default style' }), {
			target: { value: 'concise' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));

		expect(onChangeUiLanguage).toHaveBeenCalledWith('hu');
		expect(onChangeTheme).toHaveBeenCalledWith('dark');
		expect(onChangeModel).toHaveBeenCalledWith('model1');
		expect(onChangePersonality).toHaveBeenCalledWith('concise');
		expect(onSkip).toHaveBeenCalledTimes(1);
	});

	it('keeps keyboard focus inside the dialog and restores focus when Escape skips it', async () => {
		const user = userEvent.setup();
		const onSkip = vi.fn();
		const opener = document.createElement('button');
		opener.textContent = 'Open campaign';
		document.body.append(opener);
		opener.focus();

		render(CampaignModal, {
			props: {
				campaign,
				locale: 'en',
				onSkip,
			},
		});

		const dialog = screen.getByRole('dialog', { name: 'Campaign announcement' });
		const closeButton = screen.getByRole('button', { name: 'Close' });

		await waitFor(() => {
			expect(closeButton).toHaveFocus();
		});

		closeButton.focus();
		await user.keyboard('{Shift>}{Tab}{/Shift}');
		expect(dialog).toContainElement(document.activeElement as HTMLElement);

		await user.keyboard('{Escape}');

		expect(onSkip).toHaveBeenCalledTimes(1);
		await waitFor(() => {
			expect(opener).toHaveFocus();
		});
		opener.remove();
	});
});
