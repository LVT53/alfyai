import { describe, expect, it, vi } from 'vitest';
import {
	archiveAdminCampaign,
	completeCampaign,
	createAdminCampaign,
	deleteAdminCampaignDraft,
	duplicateAdminCampaign,
	fetchAdminCampaign,
	fetchAdminCampaigns,
	fetchEligibleCampaign,
	fetchLatestCampaign,
	publishAdminCampaign,
	recordCampaignEvent,
	seedFirstRunCampaign,
	updateAdminCampaign,
} from './campaigns';

describe('campaign client API', () => {
	it('wraps the admin campaign authoring contract', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ campaigns: [{ id: 'campaign-1', name: 'Welcome' }] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ campaign: { id: 'campaign-2', type: 'first_run' } }), {
					status: 201,
					headers: { 'Content-Type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ campaign: { id: 'campaign-1', slides: [] } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ campaign: { id: 'campaign-1', name: 'Updated' } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ campaign: { id: 'campaign-1', status: 'published' } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ campaign: { id: 'campaign-1', status: 'archived' } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ campaign: { id: 'campaign-copy' } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ campaign: { id: 'first-run' }, created: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			);

		await expect(fetchAdminCampaigns(fetchImpl)).resolves.toEqual([{ id: 'campaign-1', name: 'Welcome' }]);
		await expect(createAdminCampaign({ type: 'first_run', releaseVersion: '1.0.0' }, fetchImpl)).resolves.toEqual({
			id: 'campaign-2',
			type: 'first_run',
		});
		await expect(fetchAdminCampaign('campaign-1', fetchImpl)).resolves.toEqual({ id: 'campaign-1', slides: [] });
		await expect(updateAdminCampaign('campaign-1', { name: 'Updated' }, fetchImpl)).resolves.toEqual({
			id: 'campaign-1',
			name: 'Updated',
		});
		await expect(publishAdminCampaign('campaign-1', fetchImpl)).resolves.toEqual({
			id: 'campaign-1',
			status: 'published',
		});
		await expect(archiveAdminCampaign('campaign-1', fetchImpl)).resolves.toEqual({
			id: 'campaign-1',
			status: 'archived',
		});
		await expect(deleteAdminCampaignDraft('campaign-1', fetchImpl)).resolves.toBeUndefined();
		await expect(duplicateAdminCampaign('campaign-1', fetchImpl)).resolves.toEqual({ id: 'campaign-copy' });
		await expect(seedFirstRunCampaign(fetchImpl)).resolves.toEqual({
			campaign: { id: 'first-run' },
			created: true,
		});

		expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
			'/api/admin/campaigns',
			'/api/admin/campaigns',
			'/api/admin/campaigns/campaign-1',
			'/api/admin/campaigns/campaign-1',
			'/api/admin/campaigns/campaign-1/publish',
			'/api/admin/campaigns/campaign-1/archive',
			'/api/admin/campaigns/campaign-1',
			'/api/admin/campaigns/campaign-1/duplicate',
			'/api/admin/campaigns/seed-first-run',
		]);
		expect(fetchImpl.mock.calls[1][1]).toEqual(
			expect.objectContaining({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type: 'first_run', releaseVersion: '1.0.0' }),
			}),
		);
		expect(fetchImpl.mock.calls[3][1]).toEqual(
			expect.objectContaining({
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'Updated' }),
			}),
		);
		expect(fetchImpl.mock.calls[4][1]).toEqual(expect.objectContaining({ method: 'POST' }));
		expect(fetchImpl.mock.calls[6][1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
	});

	it('wraps the user campaign delivery contract', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ campaign: { id: 'eligible', type: 'first_run_onboarding' } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ campaign: null }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ event: { id: 'event-1', eventType: 'slide_viewed' } }), {
					status: 201,
					headers: { 'Content-Type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ state: { id: 'state-1', status: 'completed' } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			);

		await expect(fetchEligibleCampaign(fetchImpl)).resolves.toEqual({
			id: 'eligible',
			type: 'first_run_onboarding',
		});
		await expect(fetchLatestCampaign(fetchImpl)).resolves.toBeNull();
		await expect(
			recordCampaignEvent(
				'eligible',
				{ eventType: 'slide_viewed', slideId: 'slide-1', metadata: { index: 0 } },
				fetchImpl,
			),
		).resolves.toEqual({ id: 'event-1', eventType: 'slide_viewed' });
		await expect(completeCampaign('eligible', 'completed', fetchImpl)).resolves.toEqual({
			id: 'state-1',
			status: 'completed',
		});

		expect(fetchImpl.mock.calls).toEqual([
			['/api/campaigns/eligible'],
			['/api/campaigns/latest'],
			[
				'/api/campaigns/eligible/events',
				expect.objectContaining({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						eventType: 'slide_viewed',
						slideId: 'slide-1',
						metadata: { index: 0 },
					}),
				}),
			],
			[
				'/api/campaigns/eligible/complete',
				expect.objectContaining({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ reason: 'completed' }),
				}),
			],
		]);
	});
});
