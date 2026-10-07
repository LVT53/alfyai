/**
 * Why a board's vocabulary refuses an op (ruling 14), and the message key of
 * each. Its own module, and not part of `board-ops.ts`, for the same reason
 * `canvas-limits.ts` is not part of `canvas-blocks.ts`: the editor (which says
 * a refusal in the reader's language, `review-controller.svelte.ts`) needs only
 * these few lines, and importing them from the vocabulary would load the op
 * schemas, the judge and the placer into the editor's first paint (ruling 68's
 * size gate counted it: 2.8 KiB gzip over the ceiling).
 */

export const BOARD_REFUSAL_REASONS = [
	"unknown_id",
	"duplicate_id",
	"unknown_kind",
	"kind_mismatch",
	"missing_parent",
	"self_parent",
	"cycle",
	"invalid_data",
	"limit_exceeded",
	"stale",
] as const;

export type BoardRefusalReason = (typeof BOARD_REFUSAL_REASONS)[number];

/** Every refusal reason has a message key; the switch is exhaustive so a new reason cannot ship without one. */
export function refusalLabelKey(reason: BoardRefusalReason): string {
	switch (reason) {
		case "unknown_id":
			return "artifacts.canvas.refusal.unknown_id";
		case "duplicate_id":
			return "artifacts.canvas.refusal.duplicate_id";
		case "unknown_kind":
			return "artifacts.canvas.refusal.unknown_kind";
		case "kind_mismatch":
			return "artifacts.canvas.refusal.kind_mismatch";
		case "missing_parent":
			return "artifacts.canvas.refusal.missing_parent";
		case "self_parent":
			return "artifacts.canvas.refusal.self_parent";
		case "cycle":
			return "artifacts.canvas.refusal.cycle";
		case "invalid_data":
			return "artifacts.canvas.refusal.invalid_data";
		case "limit_exceeded":
			return "artifacts.canvas.refusal.limit_exceeded";
		case "stale":
			return "artifacts.canvas.refusal.stale";
		default: {
			const unreachable: never = reason;
			return unreachable;
		}
	}
}
