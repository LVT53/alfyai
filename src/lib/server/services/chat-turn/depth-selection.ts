import { performance } from "node:perf_hooks";
import type { ModelId } from "$lib/model-types";
import type { ReasoningDepth } from "$lib/reasoning-depth-types";
import type {
	DepthAppliedProfile,
	DepthMetadata,
	DepthSelectionTimingMetadata,
} from "$lib/server/services/chat-turn/depth-metadata-types";
import type { LinkedContextSource } from "$lib/server/services/linked-context-sources";
import type { PendingSkillSelection } from "$lib/server/services/skills/types";

// Depth selection used to run a deterministic-rules/keyword classifier over
// the "auto" ladder (off / auto / max -> standard / extended / maximum), plus
// an "explicit max" path that reused the previous turn's signals. The 2026-09
// thinking-toggle redesign (ADR-0061) replaced that ladder with a single
// user-facing on/off toggle: this module is now a direct, synchronous
// mapping from the toggle to an applied profile. The metadata/timing shape
// is kept as-is (rather than collapsed) because preflight.ts's
// clarification carry-forward, finalize.ts, retry.ts, and messages
// persistence all read fields off it.
type DepthSelectionTurnInput = {
	normalizedMessage: string;
	reasoningDepth: ReasoningDepth;
	modelId?: ModelId;
	modelDisplayName?: string | null;
	providerDisplayName?: string | null;
	attachmentIds?: string[];
	linkedSources?: LinkedContextSource[];
	pendingSkill?: PendingSkillSelection | null;
	activeDocumentArtifactId?: string;
	personalityProfileId?: string;
	forceWebSearch?: boolean;
};

export type DepthRecentMessage = {
	role: "user" | "assistant";
	content: string;
};

type ListRecentMessages = (params: {
	userId: string;
	conversationId: string;
}) => Promise<DepthRecentMessage[]>;

export type ResolveReasoningDepthSelectionParams = {
	userId: string;
	conversationId: string;
	request: DepthSelectionTurnInput;
	// No longer consulted (no classifier reads recent turns any more) — kept
	// so callers built for the old signature keep type-checking.
	listRecentMessages?: ListRecentMessages;
};

export type ResolveReasoningDepthSelectionResult = {
	metadata: DepthMetadata;
};

const REASONING_DEPTH_APPLIED_PROFILE: Record<
	ReasoningDepth,
	DepthAppliedProfile
> = {
	quick: "off",
	thorough: "standard",
};

const REASONING_DEPTH_CONSTRAINT_NOTE: Record<ReasoningDepth, string> = {
	quick: "explicit_quick",
	thorough: "explicit_thorough",
};

export async function resolveReasoningDepthSelection(
	params: ResolveReasoningDepthSelectionParams,
): Promise<ResolveReasoningDepthSelectionResult> {
	const selectionStartedAt = nowDepthSelectionMs();
	const { request } = params;
	const appliedProfile =
		REASONING_DEPTH_APPLIED_PROFILE[request.reasoningDepth];
	logThinkingToggleResult(request.reasoningDepth);
	return {
		metadata: buildDepthMetadata({
			request,
			appliedProfile,
			classifierSource: "deterministic_bypass",
			constraintNote: REASONING_DEPTH_CONSTRAINT_NOTE[request.reasoningDepth],
			timing: buildDepthSelectionTiming({
				selectionStartedAt,
				classifierSource: "deterministic_bypass",
				appliedProfile,
			}),
		}),
	};
}

function buildDepthMetadata(params: {
	request: DepthSelectionTurnInput;
	appliedProfile: DepthAppliedProfile;
	classifierSource: string;
	constraintNote?: string;
	timing?: DepthSelectionTimingMetadata;
}): DepthMetadata {
	const metadata: DepthMetadata = {
		requested: params.request.reasoningDepth,
		appliedProfile: params.appliedProfile,
		fallback: false,
		classifierSource: params.classifierSource,
	};
	if (params.constraintNote) metadata.constraintNote = params.constraintNote;
	if (params.timing) metadata.timing = params.timing;
	if (params.request.modelId) metadata.modelId = params.request.modelId;
	if (params.request.modelDisplayName) {
		metadata.modelDisplayName = params.request.modelDisplayName;
	}
	if (params.request.providerDisplayName) {
		metadata.providerDisplayName = params.request.providerDisplayName;
	}
	return metadata;
}

function buildDepthSelectionTiming(params: {
	selectionStartedAt: number;
	classifierSource: string;
	appliedProfile: DepthAppliedProfile;
}): DepthSelectionTimingMetadata {
	return {
		totalMs: elapsedDepthSelectionMs(params.selectionStartedAt),
		classifierAttempts: 0,
		classifierSource: params.classifierSource,
		appliedProfile: params.appliedProfile,
	};
}

function nowDepthSelectionMs(): number {
	return performance.now();
}

function elapsedDepthSelectionMs(startedAt: number): number {
	const elapsedMs = nowDepthSelectionMs() - startedAt;
	return Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
}

function logThinkingToggleResult(mode: ReasoningDepth): void {
	console.log(`[THINKING] source=toggle mode=${mode}`);
}
