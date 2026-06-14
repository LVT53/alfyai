export interface DecayParams {
	importance: number;
	ageSeconds: number;
	staleSeconds: number;
	queryOverlap: number;
	queryLength: number;
	decayRate?: number;
}

export function computeDecayScore(params: DecayParams): number {
	const {
		importance,
		ageSeconds,
		staleSeconds,
		queryOverlap,
		queryLength,
		decayRate = 0.001,
	} = params;

	const ageDecay = Math.exp(-decayRate * ageSeconds);
	const stalePenalty = Math.exp(-0.01 * staleSeconds);
	const baseScore = importance * ageDecay * stalePenalty;

	let relevanceBoost = 0;
	if (queryLength > 0) {
		relevanceBoost = (queryOverlap / queryLength) * 0.35;
	}

	return baseScore + relevanceBoost;
}

export interface CrossDecayParams {
	baseScore: number;
	daysSinceLastAccess: number;
	isSameConversation: boolean;
}

export function computeCrossConversationDecay(
	params: CrossDecayParams,
): number {
	const { baseScore, daysSinceLastAccess, isSameConversation } = params;

	if (isSameConversation) {
		return baseScore;
	}

	const decayMultiplier = Math.exp(-0.05 * daysSinceLastAccess);
	return Math.max(0, baseScore * decayMultiplier);
}
