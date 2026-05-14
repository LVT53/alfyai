import { describe, expect, it, vi } from 'vitest';
import { buildAssistantEvidenceSummary } from './message-evidence';

vi.mock('./knowledge', () => ({
	getArtifactsForUser: vi.fn(async () => []),
}));

vi.mock('./tei-reranker', () => ({
	canUseTeiReranker: vi.fn(() => false),
	rerankItems: vi.fn(async () => null),
}));

vi.mock('./evidence-family', () => ({
	resolveArtifactFamilyKeys: vi.fn(async () => new Map()),
}));

describe('buildAssistantEvidenceSummary', () => {
	it('references promoted sibling context only when its trace section entered prompt context', async () => {
		const included = await buildAssistantEvidenceSummary({
			userId: 'user-1',
			message: 'what font options did we discuss in this project?',
			taskState: null,
			contextTraceSections: [
				{
					name: 'Project Folder Sibling Context',
					source: 'memory',
					body: 'Title: "Font options"',
					inclusionLevel: 'legacy_full',
					itemIds: ['conversation:conv-fonts'],
					itemTitles: ['Font options'],
					signalReasons: [
						'project_folder_sibling:query_match',
						'project_folder_sibling_score:24',
					],
				},
			],
		});

		expect(included?.groups).toEqual([
			expect.objectContaining({
				sourceType: 'memory',
				items: [
					expect.objectContaining({
						id: 'conversation:conv-fonts',
						title: 'Font options',
						sourceType: 'memory',
						status: 'reference',
						description: 'Promoted from the same Project Folder for this query.',
						channels: ['memory'],
					}),
				],
			}),
		]);

		const omitted = await buildAssistantEvidenceSummary({
			userId: 'user-1',
			message: 'what font options did we discuss in this project?',
			taskState: null,
			contextTraceSections: [
				{
					name: 'Project Folder Sibling Context',
					source: 'memory',
					body: 'Title: "Font options"',
					inclusionLevel: 'omitted',
					itemIds: ['conversation:conv-fonts'],
					itemTitles: ['Font options'],
					signalReasons: ['project_folder_sibling:query_match'],
				},
			],
		});

		expect(omitted).toBeNull();
	});
});
