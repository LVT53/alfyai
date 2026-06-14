import { cosineSimilarity } from "$lib/server/utils/math";

export interface DetectTopicShiftParams {
	currentMessageEmbedding: number[];
	previousMessageEmbedding: number[];
	threshold?: number;
}

export interface DetectTopicShiftResult {
	isShift: boolean;
	distance: number;
}

export function detectTopicShift(
	params: DetectTopicShiftParams,
): DetectTopicShiftResult {
	const {
		currentMessageEmbedding,
		previousMessageEmbedding,
		threshold = 0.3,
	} = params;

	const isEmptyOrZero = (v: number[]) =>
		v.length === 0 || v.every((x) => x === 0);

	if (
		isEmptyOrZero(currentMessageEmbedding) ||
		isEmptyOrZero(previousMessageEmbedding)
	) {
		return { isShift: false, distance: 0 };
	}

	const similarity = cosineSimilarity(
		currentMessageEmbedding,
		previousMessageEmbedding,
	);
	const distance = 1 - similarity;

	return {
		isShift: similarity < threshold,
		distance,
	};
}

export interface ShouldSuppressCarryoverParams {
	isShift: boolean;
	hasExplicitResetSignal: boolean;
	turnsSinceLastShift: number;
}

export function shouldSuppressCarryover(
	params: ShouldSuppressCarryoverParams,
): boolean {
	return params.isShift || params.hasExplicitResetSignal;
}
