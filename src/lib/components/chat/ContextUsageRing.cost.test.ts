import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ContextUsageRing from './ContextUsageRing.svelte';

vi.mock('$lib/i18n', () => ({
	t: {
		subscribe: vi.fn((cb: (v: (key: string) => string) => void) => {
			const fn = (key: string) => key;
			cb(fn);
			return vi.fn();
		}),
	},
}));

function renderRing(props: Record<string, unknown> = {}) {
	return render(ContextUsageRing, {
		props: {
			contextStatus: null,
			attachedArtifacts: [],
			taskState: null,
			contextDebug: null,
			onSteer: undefined,
			onManageEvidence: undefined,
			...props,
		},
	});
}

describe('ContextUsageRing cost display', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders cost row when totalCostUsd and totalTokens are provided', () => {
		renderRing({ totalCostUsd: 0.42, totalTokens: 12400 });

		expect(screen.getByText(/\$0\.42/)).toBeTruthy();
		expect(screen.getByText(/12[,.]?4K/)).toBeTruthy();
	});

	it('does not render cost section when totalCostUsd is 0', () => {
		renderRing({ totalCostUsd: 0, totalTokens: 0 });

		expect(screen.queryByText(/\$/)).toBeNull();
	});

	it('omits the unused focus section and task control buttons', () => {
		renderRing({
			taskState: {
				id: 'task-1',
				conversationId: 'conversation-1',
				userId: 'user-1',
				objective: 'Prepare launch brief',
				status: 'active',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
			contextDebug: {
				routingStage: 'deterministic',
				routingConfidence: 100,
				verificationStatus: 'skipped',
				activeTaskObjective: 'Prepare launch brief',
				taskLocked: true,
				selectedEvidence: [],
				pinnedEvidence: [],
				excludedEvidence: [],
			},
			onSteer: vi.fn(),
			onManageEvidence: vi.fn(),
		});

		expect(screen.queryByText('contextUsageRing.focus')).toBeNull();
		expect(screen.queryByText('Prepare launch brief')).toBeNull();
		expect(screen.queryByText('contextUsageRing.unlockTask')).toBeNull();
		expect(screen.queryByText('contextUsageRing.startNewTask')).toBeNull();
		expect(screen.queryByText('contextUsageRing.manageEvidence')).toBeNull();
	});

	it('removes across chats section even when continuity exists', () => {
		renderRing({
			taskState: {
				continuity: {
					name: 'Test Project',
					summary: 'A test',
					status: 'active',
					linkedTaskCount: 3,
				},
			},
			totalCostUsd: 0.42,
			totalTokens: 12400,
		});

		expect(screen.queryByText(/across chats/i)).toBeNull();
	});

	it('removes compaction and routing stat rows from context section', () => {
		renderRing({
			contextStatus: {
				estimatedTokens: 5000,
				targetTokens: 157286,
				thresholdTokens: 209715,
				compactionMode: 'none',
				routingStage: 'deterministic',
				routingConfidence: 100,
				verificationStatus: 'skipped',
				layersUsed: [],
				recentTurnCount: 5,
				workingSetCount: 3,
				workingSetArtifactIds: [],
				workingSetApplied: true,
				taskStateApplied: true,
				promptArtifactCount: 1,
				summary: null,
				updatedAt: Date.now(),
			},
			contextDebug: {
				routingStage: 'deterministic',
				routingConfidence: 100,
				verificationStatus: 'skipped',
				selectedEvidence: [],
				pinnedEvidence: [],
				excludedEvidence: [],
			},
			totalCostUsd: 0.42,
			totalTokens: 12400,
		});

		expect(screen.queryByText(/pressure threshold/i)).toBeNull();
		expect(screen.queryByText(/routing/i)).toBeNull();
		expect(screen.queryByText(/verification/i)).toBeNull();
	});

	it('uses contextSources for source counts and reduced state when available', () => {
		renderRing({
			contextStatus: {
				estimatedTokens: 5000,
				targetTokens: 157286,
				thresholdTokens: 209715,
				compactionMode: 'none',
				routingStage: 'deterministic',
				routingConfidence: 100,
				verificationStatus: 'skipped',
				layersUsed: [],
				recentTurnCount: 5,
				workingSetCount: 3,
				workingSetArtifactIds: [],
				workingSetApplied: true,
				taskStateApplied: true,
				promptArtifactCount: 1,
				summary: null,
				updatedAt: Date.now(),
			},
			contextDebug: {
				routingStage: 'deterministic',
				routingConfidence: 100,
				verificationStatus: 'skipped',
				selectedEvidence: [],
				pinnedEvidence: [],
				excludedEvidence: [],
			},
			contextSources: {
				conversationId: 'conversation-1',
				userId: 'user-1',
				activeCount: 2,
				inferredCount: 0,
				selectedCount: 2,
				pinnedCount: 1,
				excludedCount: 1,
				reduced: true,
				compacted: false,
				groups: [],
				updatedAt: Date.now(),
			},
		});

		expect(screen.getByText('contextSources.currentSelection')).toBeTruthy();
		expect(screen.getByText('contextSources.state')).toBeTruthy();
		expect(screen.getByText('contextSources.reduced')).toBeTruthy();
		expect(screen.getByText('contextSources.pinned')).toBeTruthy();
		expect(screen.getByText('contextSources.excluded')).toBeTruthy();
	});

	it('formats sub-dollar cost with 4 decimal places', () => {
		renderRing({ totalCostUsd: 0.0042, totalTokens: 500 });

		expect(screen.getByText(/\$0\.0042/)).toBeTruthy();
	});

	it('formats multi-dollar cost with 2 decimal places', () => {
		renderRing({ totalCostUsd: 2.36, totalTokens: 96400 });

		expect(screen.getByText(/\$2\.36/)).toBeTruthy();
	});

	it('formats millions of tokens as M', () => {
		renderRing({ totalCostUsd: 1, totalTokens: 1_240_000 });

		expect(screen.getByText(/1\.2M/)).toBeTruthy();
	});
});
