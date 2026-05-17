export type CampaignDisplayMode = 'auto' | 'replay';

export function shouldPersistCampaignCompletion(mode: CampaignDisplayMode): boolean {
	return mode === 'auto';
}
