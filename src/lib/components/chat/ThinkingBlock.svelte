<script lang="ts">
import { t, type I18nKey } from "$lib/i18n";
import type {
	InterimThoughtStep,
	ThoughtStepClassifierActivityClass,
} from "$lib/response-activity-types";
import type {
	MessageEvidenceStatus,
	ToolEvidenceCandidate,
} from "$lib/server/services/message-evidence";
import type { ThinkingSegment } from "$lib/server/services/messages-types";
import { isThoughtStepClassifierActivityClass } from "$lib/response-activity-types";
import {
	Check,
	ChevronDown,
	ChevronLeft,
	ClipboardCheck,
	Bot,
	HelpCircle,
	History,
	Languages,
	Layers,
	ListChecks,
	PenLine,
	Scale,
	Search,
	ShieldAlert,
	Workflow,
	XCircle,
} from "@lucide/svelte";
import {
	deriveReasoningSpineState,
	type ReasoningSpineLiveState,
} from "$lib/utils/reasoning-spine";
import { deriveDeliberationProgressState } from "$lib/utils/deliberation-progress";
import { prefersReducedMotion } from "$lib/utils/motion";
import { resolveThoughtStepAnchorSpan } from "$lib/utils/thought-step-anchor";
import {
	formatConnectionToolAction,
	getConnectionToolLabelKey,
	getHumanReadableToolNameKey,
	isConnectionToolName,
	isFileProductionToolName,
	isVisibleThinkingSegment,
	isVisibleThinkingToolCall,
} from "$lib/utils/tool-calls";

type DeliberationStatusSegment = {
	type: "status";
	id: string;
	label: string;
	status: "running" | "done" | "error";
	passIndex?: number;
	passTotal?: number;
	passKind?: string;
};

let {
	content = "",
	thinkingIsDone = false,
	segments = [],
	streaming = false,
	thinkingDurationSeconds = 0,
	// P1 (ADR-0056) — true once the assistant's visible answer text has
	// started streaming (MessageBubble's own `hasVisibleContent`). Distinct
	// from `thinkingIsDone`: the raw reasoning trace can still be arriving
	// after the visible answer has begun, but once it has begun that is
	// itself real progress, so the header's spine state moves on from
	// "reasoning" to "writing the answer" rather than reporting a stall.
	answerStarted = false,
	// P3c (ADR-0056) — the raw wire values of the latest live "thought_step"
	// data-response-activity entry (MessageBubble's reverse-scan-latest-match
	// over message.responseActivity). `liveThoughtStepClass` is the closed
	// ThoughtStepClassifierActivityClass id; `liveThoughtStepEntity` is the
	// optional verbatim entity. Enrichment on P1's spine, never a
	// replacement: when undefined, or when the class is not one of the six
	// recognized ones (honesty — never render a garbage/legacy class), the
	// header falls straight back to the spine label below.
	liveThoughtStepClass = undefined,
	liveThoughtStepEntity = undefined,
	// TS2-c (ADR-0056 amendment, 2026-08-16) — the constrained,
	// entity-grounded `summary` carried on the SAME latest live "thought_step"
	// data-response-activity entry `liveThoughtStepClass`/`liveThoughtStepEntity`
	// already come from (MessageBubble's `liveThoughtStepActivity?.summary`).
	// Precedence per the amendment: this summary, when present, IS the live
	// headline; `liveThoughtStepClass`'s phase label is the fallback (the
	// pre-amendment behavior) when the model's summary failed the runtime
	// verbatim-tether guard server-side and was dropped. See
	// `liveThoughtStepHeadline` below.
	liveThoughtStepSummary = undefined,
	// P3c (ADR-0056) — the durable, persisted Interim Thought Step rail for
	// a COMPLETED turn (`ChatMessage.thoughtSteps`). Undefined while
	// streaming; populated at completion in the same browser session too
	// (P3d wired the terminal `data-stream-metadata` frame to carry
	// `thoughtSteps`, mirroring `completionWarningCodes`), not only after a
	// reload.
	thoughtSteps = undefined,
	// P4 (ADR-0056) — the raw wire values of the latest live "deliberation"
	// data-response-activity entry (MessageBubble's own reuse of the same
	// reverse-scan-latest-match pattern P3c already established for
	// liveThoughtStepClass above). Both already exist on ResponseActivityEntry
	// ($lib/response-activity-types) and are already emitted by deliberation-runner.ts — this
	// slice reuses them, it invents nothing new. See
	// $lib/utils/deliberation-progress.ts for the pure decision this feeds.
	livePassIndex = undefined,
	livePassTotal = undefined,
	// P4 (ADR-0056) — true once RESPONSE_ACTIVITY_IDS.DRAFTING_ANSWER has been
	// observed this turn (MessageBubble scans the same
	// message.responseActivity array). Combined with livePassTotal > 1, this
	// is the concluding-phase signal: deliberation (including its silent
	// tail passes) has fully resolved and the model has moved into the final
	// answer-generating call.
	draftingAnswerReached = false,
}: {
	content?: string;
	thinkingIsDone?: boolean;
	segments?: ThinkingSegment[];
	streaming?: boolean;
	thinkingDurationSeconds?: number;
	answerStarted?: boolean;
	liveThoughtStepClass?: string;
	liveThoughtStepEntity?: string;
	liveThoughtStepSummary?: string;
	thoughtSteps?: InterimThoughtStep[];
	livePassIndex?: number;
	livePassTotal?: number;
	draftingAnswerReached?: boolean;
} = $props();

let expanded = $state(false);
let container = $state<HTMLDivElement | undefined>(undefined);
let prevContentLength = $state(0);
let contentFresh = $state(false);
let newCharStart = $state(-1);
let freshTimeout: ReturnType<typeof setTimeout> | undefined;
// P1 (ADR-0056) — reasoning-delta liveness watchdog. NOT a free-running
// clock: this single timeout is (re)scheduled only when real reasoning
// content/segment growth is observed (the same growth signal that already
// drives `contentFresh` below), and is cleared on every such event. If it
// ever fires, that means REASONING_STALL_MS has elapsed with no real
// growth — an honest "stalled" signal, not a cosmetic tick. Value chosen to
// sit comfortably above normal inter-chunk gaps (the server batches
// reasoning text in >=20-char bursts) without flipping to the honest
// fallback on every brief pause.
const REASONING_STALL_MS = 8000;
let reasoningStalled = $state(false);
let stallTimeout: ReturnType<typeof setTimeout> | undefined;

type FetchedSource = {
	title: string;
	url: string;
	// Citation-driven status from C1: "selected" = the answer cited this
	// source; "reference"/"rejected" = retrieved but not cited. Absent for
	// plain read (fetch_url) pages, which have no citation concept.
	status?: MessageEvidenceStatus;
	// Compact reason/snippet surfaced in the chip's hover tooltip.
	reason?: string;
};

const isActiveThinking = $derived(!thinkingIsDone);
const visibleSegmentsRaw = $derived(segments.filter(isVisibleThinkingSegment));

function isDeliberationStatusSegment(
	segment: ThinkingSegment,
): segment is DeliberationStatusSegment {
	return (
		segment.type === "status" &&
		segment.id.startsWith("deliberation-pass-") &&
		segment.label.trim().length > 0
	);
}

function getDeliberationPassIndex(segmentId: string): number {
	const match = segmentId.match(/deliberation-pass-(\d+)/i);
	const parsed = match ? Number.parseInt(match[1], 10) : NaN;
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function getDeliberationStatusIconType(
	segment: DeliberationStatusSegment,
):
	| "search"
	| "clipboard-check"
	| "shield-alert"
	| "languages"
	| "layers"
	| "bot" {
	if (segment.type !== "status") return "search";
	const passKind = segment.passKind;
	if (
		passKind === "context_source_gap_review" ||
		passKind === "evidence_gap_review" ||
		passKind === "source_reconciliation"
	)
		return "search";
	if (
		passKind === "missed_user_need_check" ||
		passKind === "answer_plan_critique" ||
		passKind === "final_format_style_check"
	)
		return "clipboard-check";
	if (
		passKind === "contradiction_risk_check" ||
		passKind === "adversarial_edge_case_check"
	)
		return "shield-alert";
	if (passKind === "hungarian_parity_check") return "languages";
	if (passKind === "workspace_synthesis") return "layers";
	if (passKind === "viable_alternatives_preservation") return "bot";
	const pass = getDeliberationPassIndex(segment.id);
	if (pass === 1) return "search";
	if (pass === 2) return "clipboard-check";
	return "shield-alert";
}

function formatDeliberationStatusLabel(
	segment: DeliberationStatusSegment,
): string {
	const label = segment.label.trim();
	if (!label) return "";
	const current =
		typeof segment.passIndex === "number" && Number.isInteger(segment.passIndex)
			? segment.passIndex
			: getDeliberationPassIndex(segment.id);
	const total = segment.passTotal;
	if (typeof total === "number" && Number.isInteger(total) && total > 0) {
		return $t("chat.deliberatingProgress", { current, total, label });
	}
	return label;
}

const latestDeliberationStatusSegment = $derived.by(() => {
	for (let i = visibleSegmentsRaw.length - 1; i >= 0; i -= 1) {
		if (isDeliberationStatusSegment(visibleSegmentsRaw[i])) {
			return visibleSegmentsRaw[i];
		}
	}
	return undefined;
});

const latestDeliberationStatusSegmentId = $derived.by(() =>
	latestDeliberationStatusSegment?.type === "status"
		? latestDeliberationStatusSegment.id
		: null,
);

const visibleSegments = $derived(
	streaming
		? visibleSegmentsRaw.filter((segment) => {
				if (!isDeliberationStatusSegment(segment)) return true;
				return latestDeliberationStatusSegmentId
					? segment.id === latestDeliberationStatusSegmentId
					: false;
			})
		: visibleSegmentsRaw,
);
const hasSegments = $derived(visibleSegments.length > 0);
const visibleTools = $derived(segments.filter(isVisibleThinkingToolCall));
const hasVisibleSurface = $derived(
	content.trim().length > 0 || hasSegments || visibleTools.length > 0,
);
// P1 (ADR-0056) — a currently-running tool call is itself real, visible
// progress (its own pulsing dot already shows that), so it must never be
// reported as a "stalled" reasoning phase even if raw reasoning text has
// briefly stopped arriving while the tool runs.
const anyToolRunning = $derived(
	visibleTools.some((tool) => tool.status === "running"),
);

type ToolCallSegment = ThinkingSegment & { type: "tool_call" };
type TextSegment = ThinkingSegment & { type: "text" };
type StatusSegment = ThinkingSegment & { type: "status" };

// Connector tool calls (calendar/contacts/email/files/location/media/photos)
// can fire dozens of times per turn. Collapse repeated calls to the same
// capability into a single expandable group instead of spamming one row per
// call — mirrors the existing fetchedSourceGroup collapse precedent below.
type ToolStackEntry =
	| { kind: "tool"; tool: ToolCallSegment; key: string }
	| {
			kind: "connector-group";
			name: string;
			tools: ToolCallSegment[];
			key: string;
	  };

const toolStackEntries: ToolStackEntry[] = $derived.by(() => {
	const entries: ToolStackEntry[] = [];
	let groupIndexByName: Map<string, number> | null = null;
	visibleTools.forEach((tool, i) => {
		if (isConnectionToolName(tool.name)) {
			if (!groupIndexByName) groupIndexByName = new Map();
			const existingIndex = groupIndexByName.get(tool.name);
			if (existingIndex !== undefined) {
				const entry = entries[existingIndex];
				if (entry.kind === "connector-group") entry.tools.push(tool);
				return;
			}
			groupIndexByName.set(tool.name, entries.length);
			entries.push({
				kind: "connector-group",
				name: tool.name,
				tools: [tool],
				key: `group-${tool.name}-${i}`,
			});
			return;
		}
		groupIndexByName = null;
		entries.push({
			kind: "tool",
			tool,
			key: tool.callId ?? `${tool.name + JSON.stringify(tool.input)}-${i}`,
		});
	});
	return entries;
});

// Interleaved thinking view: group connector calls only within a contiguous
// run of connector tool_call segments. Any non-connector segment (thinking
// text, a status step, or a non-connector tool call) breaks the run, so the
// grouping never reorders content relative to the surrounding narration.
type InterleavedEntry =
	| { kind: "text"; segment: TextSegment; key: string }
	| { kind: "status"; segment: StatusSegment; key: string }
	| { kind: "tool"; segment: ToolCallSegment; key: string }
	| {
			kind: "connector-group";
			name: string;
			tools: ToolCallSegment[];
			key: string;
	  }
	// P3c (ADR-0056) — a classified Interim Thought Step, interleaved into
	// the SAME completed rail as tool calls and context-preparation activity
	// (see the merge in interleavedEntries below), never a separate list.
	| { kind: "thought_step"; step: InterimThoughtStep; key: string };

// P3c — honesty gate for the completed rail: "only render steps that exist
// with a resolvable anchor" (ADR-0056). `content` here is `message.thinking`
// — the exact same flat string every ThoughtStepAnchor's [start, end) span
// indexes into (guaranteed server-side; see thought-step-classifier.ts).
const anchoredThoughtSteps = $derived(
	(thoughtSteps ?? []).filter(
		(step) => resolveThoughtStepAnchorSpan(step.anchor, content) !== null,
	),
);

const interleavedEntries: InterleavedEntry[] = $derived.by(() => {
	const entries: InterleavedEntry[] = [];
	let runGroupIndexByName: Map<string, number> | null = null;
	visibleSegments.forEach((seg, i) => {
		if (seg.type === "tool_call" && isConnectionToolName(seg.name)) {
			if (!runGroupIndexByName) runGroupIndexByName = new Map();
			const existingIndex = runGroupIndexByName.get(seg.name);
			if (existingIndex !== undefined) {
				const entry = entries[existingIndex];
				if (entry.kind === "connector-group") entry.tools.push(seg);
				return;
			}
			runGroupIndexByName.set(seg.name, entries.length);
			entries.push({
				kind: "connector-group",
				name: seg.name,
				tools: [seg],
				key: `group-${seg.name}-${i}`,
			});
			return;
		}
		runGroupIndexByName = null;
		if (seg.type === "tool_call") {
			entries.push({
				kind: "tool",
				segment: seg,
				key: seg.callId ?? `${seg.name + JSON.stringify(seg.input)}-${i}`,
			});
		} else if (seg.type === "status") {
			entries.push({ kind: "status", segment: seg, key: seg.id });
		} else {
			entries.push({ kind: "text", segment: seg, key: `text-${i}` });
		}
	});
	if (anchoredThoughtSteps.length === 0) return entries;
	// P3c — merge classified steps into the SAME positions they actually
	// occurred at. A ThoughtStepAnchor's offsets index into `content`
	// (message.thinking), which is exactly, invariantly, the concatenation
	// of only this array's `text`-kind entries in order (tool_call/status
	// entries never consume any of that offset space — see
	// stream.ts's flushPendingThinking, which is the single place both are
	// built from the same chunk). So walking `entries` while tracking a
	// running text-offset and inserting each step right after the text
	// entry whose span first reaches its anchor's start reproduces true
	// arrival order without needing any timestamp on the segments
	// themselves. Steps are already anchor.start-ordered (append-only,
	// P3a/P3b), so a single forward pass suffices.
	const merged: InterleavedEntry[] = [];
	let textOffset = 0;
	let stepIndex = 0;
	const flushStepsUpTo = (offset: number) => {
		while (
			stepIndex < anchoredThoughtSteps.length &&
			(anchoredThoughtSteps[stepIndex].anchor?.start ?? 0) < offset
		) {
			const step = anchoredThoughtSteps[stepIndex];
			merged.push({
				kind: "thought_step",
				step,
				key: `thought-step-${step.id}`,
			});
			stepIndex += 1;
		}
	};
	for (const entry of entries) {
		merged.push(entry);
		if (entry.kind === "text") textOffset += entry.segment.content.length;
		flushStepsUpTo(textOffset);
	}
	// Any step whose anchor starts at/after all reasoning text seen (e.g. the
	// very last classified step, whose window can extend to the end of the
	// trace) goes at the end rather than being silently dropped.
	flushStepsUpTo(Number.POSITIVE_INFINITY);
	return merged;
});

function connectorGroupLabel(name: string): string {
	const key = getConnectionToolLabelKey(name);
	return $t(key ?? "toolCalls.generic");
}

function connectorGroupSummary(name: string, count: number): string {
	return `${connectorGroupLabel(name)} · ${$t("toolCalls.actionsCount", { count })}`;
}

function formatGroupedConnectorAction(tool: ToolCallSegment): string {
	const action =
		typeof tool.input.action === "string"
			? formatConnectionToolAction(tool.input.action)
			: "";
	return action || formatToolCall(tool.name, tool.input);
}

$effect(() => {
	const totalLength = hasSegments
		? visibleSegments.reduce(
				(sum, s) =>
					sum +
					(s.type === "text"
						? s.content.length
						: s.type === "status"
							? s.label.length
							: 0),
				0,
			)
		: content.length;
	if (totalLength > prevContentLength && isActiveThinking) {
		contentFresh = true;
		newCharStart = prevContentLength;
		clearTimeout(freshTimeout);
		freshTimeout = setTimeout(() => {
			contentFresh = false;
		}, 500);
	}
	prevContentLength = totalLength;
	// P1 (ADR-0056) — the stall watchdog. Any real signal this effect reacts
	// to (reasoning/status text growing, OR a tool call segment changing
	// status — itself a form of progress even with no text growth) proves
	// the turn is live, so it clears any stalled state and reschedules the
	// watchdog from now. If NO such signal arrives for REASONING_STALL_MS,
	// nothing reschedules it and it fires on its own, on the real event
	// loop — never a fixed/free-running tick unrelated to actual events.
	if (isActiveThinking) {
		reasoningStalled = false;
		clearTimeout(stallTimeout);
		stallTimeout = setTimeout(() => {
			reasoningStalled = true;
		}, REASONING_STALL_MS);
	} else {
		clearTimeout(stallTimeout);
	}
	return () => {
		clearTimeout(freshTimeout);
		clearTimeout(stallTimeout);
	};
});

// P1 (ADR-0056) — the live reasoning-phase spine state. Pure decision
// (deriveReasoningSpineState) over real signals only: no free-running clock
// drives this, unlike the counting-up stopwatch it replaces.
const reasoningSpineState: ReasoningSpineLiveState = $derived(
	deriveReasoningSpineState({
		answerStarted,
		deltaStalled: reasoningStalled && !anyToolRunning,
	}),
);

function reasoningSpineLabelKey(state: ReasoningSpineLiveState): I18nKey {
	if (state === "writing_answer") return "chat.responseActivity.writingAnswer";
	if (state === "reasoning_stalled")
		return "chat.responseActivity.stillWorking";
	return "chat.thinking";
}

const liveSpineLabelKey = $derived(reasoningSpineLabelKey(reasoningSpineState));

// P3c (ADR-0056) — one localized label per closed classifier activity class
// (src/lib/types.ts THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES), reusing the
// exact keys P3b already added to chat.ts. `satisfies Record<...>` keeps
// this exhaustive against the closed enum, mirroring
// TURN_ACKNOWLEDGMENT_LABEL_KEYS's precedent in MessageBubble.svelte.
const THOUGHT_STEP_CLASS_LABEL_KEYS = {
	"understanding-request":
		"chat.responseActivity.thoughtStep.understandingRequest",
	"recalling-context": "chat.responseActivity.thoughtStep.recallingContext",
	"weighing-options": "chat.responseActivity.thoughtStep.weighingOptions",
	"working-through-logic":
		"chat.responseActivity.thoughtStep.workingThroughLogic",
	"checking-details": "chat.responseActivity.thoughtStep.checkingDetails",
	"drafting-approach": "chat.responseActivity.thoughtStep.draftingApproach",
} as const satisfies Record<ThoughtStepClassifierActivityClass, I18nKey>;

// Honesty gate (ADR-0056): a class outside the closed enum — garbage,
// future/unknown, or otherwise — never renders anything, live or
// completed; the caller falls back to whatever it would have shown anyway
// (the spine label live, nothing in the completed rail). The entity is
// composed in only when non-empty; it is never re-validated as a verbatim
// substring here because the server (P3a/P3b) already guarantees that
// before a step is ever emitted or persisted — this function only decides
// what to render, never what to trust.
function thoughtStepDisplayLabel(
	activityClass: string,
	entity: string | undefined,
): string | null {
	if (!isThoughtStepClassifierActivityClass(activityClass)) return null;
	const label = $t(THOUGHT_STEP_CLASS_LABEL_KEYS[activityClass]);
	const trimmedEntity = entity?.trim();
	return trimmedEntity
		? $t("chat.responseActivity.thoughtStepEntity", {
				label,
				entity: trimmedEntity,
			})
		: label;
}

// P3c — the live header's currently classified step's activity class, only
// once it has passed the same honesty gate thoughtStepDisplayLabel already
// enforces (a recognized member of the closed enum). Kept as its own
// derived (rather than inlining the guard at each call site) so the header
// icon and the phase-label fallback share one single "is this trustworthy"
// decision — see thoughtStepClassIcon below, which needs a narrowed
// ThoughtStepClassifierActivityClass, not a bare string.
const liveThoughtStepRecognizedClass = $derived(
	liveThoughtStepClass &&
		isThoughtStepClassifierActivityClass(liveThoughtStepClass)
		? liveThoughtStepClass
		: null,
);

// P3c — the live header's current classified step's phase-label fallback,
// if any has arrived yet this turn. `undefined`/an unrecognized class both
// resolve to `null` — see the UX contract's precedence in ADR-0056.
const liveThoughtStepLabel = $derived(
	liveThoughtStepRecognizedClass
		? thoughtStepDisplayLabel(
				liveThoughtStepRecognizedClass,
				liveThoughtStepEntity,
			)
		: null,
);

// TS2-c (ADR-0056 amendment) — the live header's actual headline: the
// step's entity-grounded `summary` when the server sent one (composed by
// the classifier from the anchored span, dropped server-side unless it
// passed the verbatim-tether guard), else the phase-label fallback above
// (unchanged pre-amendment behavior). `null` whenever the phase label
// itself would be `null` — a summary is never shown for an unrecognized
// class, keeping the same honesty floor as before this slice.
const liveThoughtStepHeadline = $derived(
	liveThoughtStepLabel
		? liveThoughtStepSummary?.trim() || liveThoughtStepLabel
		: null,
);

// TS2-c — the closed activity-class enum's secondary signal: a small
// leading icon per class, mirroring the existing
// getDeliberationStatusIconType/deliberation-status-icon precedent exactly
// (a plain string tag decided in script, rendered via an if/else chain in
// the thoughtStepClassIcon snippet below — no dynamic-component map, to
// match this file's established idiom).
function getThoughtStepClassIconType(
	activityClass: ThoughtStepClassifierActivityClass,
):
	| "help-circle"
	| "history"
	| "scale"
	| "workflow"
	| "list-checks"
	| "pen-line" {
	if (activityClass === "understanding-request") return "help-circle";
	if (activityClass === "recalling-context") return "history";
	if (activityClass === "weighing-options") return "scale";
	if (activityClass === "working-through-logic") return "workflow";
	if (activityClass === "checking-details") return "list-checks";
	return "pen-line"; // "drafting-approach"
}

// P4 (ADR-0056) — the determinate deliberation-progress state, a pure
// decision (deriveDeliberationProgressState) over already-computed
// passIndex/passTotal plus the deterministic drafting-answer/answer-started
// facts P1 already tracks. At `standard` depth (empty deliberation plan,
// livePassTotal never set) this is always `{ kind: "none" }`, so the header
// falls straight through to liveThoughtStepLabel/the spine label exactly as
// it did before this slice — P4 is additive, never a branch that can change
// standard-depth behavior.
const deliberationProgressState = $derived(
	deriveDeliberationProgressState({
		passIndex: livePassIndex,
		passTotal: livePassTotal,
		draftingAnswerReached,
		answerStarted,
	}),
);

// Takes precedence over liveThoughtStepLabel: a numeric "pass N of M" or the
// concluding state is strictly more informative than a qualitative
// classified-step guess, which is the entire point of this slice — surface
// determinate progress wherever the system genuinely has it. `null` when
// there is nothing determinate to show, in which case the header falls back
// exactly as it did before P4.
const deliberationProgressLabel = $derived.by(() => {
	const state = deliberationProgressState;
	if (state.kind === "pass") {
		return $t("chat.responseActivity.deliberationPass", {
			index: state.index,
			total: state.total,
		});
	}
	if (state.kind === "concluding") {
		return $t("chat.responseActivity.deliberationFinishing");
	}
	return null;
});

// Shared "Ns" / "Nm Ns" formatter — not itself localized (matches the
// pre-existing precedent: chat.thoughtFor's "{time}" placeholder already
// took a preformatted string like this, with no per-unit translation).
// Extracted so the retrospective total below and each clean-list step row's
// own duration (see stepDurationLabel further down) share one formatter.
function formatDurationLabel(seconds: number): string {
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
}

// Retrospective duration only — computed once the turn is done. The active
// phase no longer shows any numeric elapsed time (see reasoningSpineState
// above), only the current live spine label.
const formattedThinkingTime = $derived.by(() => {
	if (!thinkingIsDone) return "";
	return formatDurationLabel(thinkingDurationSeconds);
});

function extractHostname(raw: string): string {
	try {
		return new URL(raw).hostname.replace(/^www\./, "");
	} catch {
		return raw.slice(0, 40);
	}
}

function getFaviconUrl(raw: string): string | null {
	// Privacy proxy (ADR 0043, Slice 12): route the favicon through our own
	// /api/favicon endpoint so researched domains are no longer leaked to
	// Google's s2/favicons. The endpoint always returns an image (a globe
	// fallback when no icon exists), so the `onerror` hide-img path below is
	// now rarely exercised but retained as a safety net.
	try {
		const parsed = new URL(raw);
		const host = parsed.hostname.replace(/^www\./, "");
		return `/api/favicon?domain=${encodeURIComponent(host)}`;
	} catch {
		return null;
	}
}

function isFetchTool(name: string): boolean {
	const n = name.toLowerCase();
	return (
		n.includes("fetch") ||
		n.includes("url") ||
		n.includes("web") ||
		n.includes("browse")
	);
}

function toUrlList(value: unknown): string[] {
	return String(value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter((part) => {
			try {
				new URL(part);
				return true;
			} catch {
				return false;
			}
		});
}

function getFetchUrls(name: string, input: Record<string, unknown>): string[] {
	if (isFileProductionToolName(name)) return [];
	if (!isFetchTool(name)) return [];
	return Object.values(input).flatMap(toUrlList);
}

// Pull a compact tooltip reason for a web candidate: prefer its snippet, then
// fall back to a reasoning/description/reason field the server may attach on
// the candidate's metadata bag.
function candidateReason(candidate: ToolEvidenceCandidate): string | undefined {
	if (candidate.snippet?.trim()) return candidate.snippet.trim();
	const meta = candidate.metadata ?? {};
	for (const key of ["reason", "reasoning", "description", "summary"]) {
		const value = meta[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function isCitedSource(source: FetchedSource): boolean {
	return source.status === "selected";
}

// Cited (status "selected") sources lead; everything else keeps its original
// order behind them. Stable so the collapsed favicon stack and the expanded
// chip row agree on ordering.
function orderCitedFirst(sources: FetchedSource[]): FetchedSource[] {
	const cited = sources.filter(isCitedSource);
	const rest = sources.filter((source) => !isCitedSource(source));
	return [...cited, ...rest];
}

function getFetchedSources(segment: ThinkingSegment): FetchedSource[] {
	if (segment.type !== "tool_call" || segment.name !== "research_web")
		return [];
	return orderCitedFirst(
		dedupeSourcesByUrl(
			(segment.candidates ?? [])
				.filter((candidate) => candidate.sourceType === "web" && candidate.url)
				.map((candidate) => ({
					title: candidate.title || extractHostname(candidate.url ?? ""),
					url: candidate.url as string,
					status: candidate.status,
					reason: candidateReason(candidate),
				})),
		),
	);
}

function getFetchUrlSources(
	name: string,
	input: Record<string, unknown>,
): FetchedSource[] {
	return dedupeSourcesByUrl(
		getFetchUrls(name, input).map((url) => ({
			title: extractHostname(url),
			url,
		})),
	);
}

function dedupeSourcesByUrl(sources: FetchedSource[]): FetchedSource[] {
	const indexByUrl = new Map<string, number>();
	const deduped: FetchedSource[] = [];
	for (const source of sources) {
		const existingIndex = indexByUrl.get(source.url);
		if (existingIndex === undefined) {
			indexByUrl.set(source.url, deduped.length);
			deduped.push(source);
			continue;
		}
		// On a URL collision, prefer the cited ("selected") copy so a divergent
		// status (e.g. the same URL retrieved once as a reference and once as a
		// citation) never drops the citation. First-occurrence position is kept.
		const existing = deduped[existingIndex];
		if (source.status === "selected" && existing.status !== "selected") {
			deduped[existingIndex] = source;
		}
	}
	return deduped;
}

// Uncited chips beyond this count fold behind a "+N" reveal so a long tail of
// "also found" sources can't dominate the compact chip row. Cited chips are
// always shown in full — they're the answer's actual citations (and already
// capped server-side to MAX_PAYLOAD_SOURCES).
const UNCITED_CHIP_LIMIT = 6;

function citedCount(sources: FetchedSource[]): number {
	return sources.filter(isCitedSource).length;
}

function uncitedSources(sources: FetchedSource[]): FetchedSource[] {
	return sources.filter((source) => !isCitedSource(source));
}

function fetchedSourceSummary(
	sources: FetchedSource[],
	kind: "search" | "read",
): string {
	const count = sources.length;
	if (kind === "read") {
		return $t("toolCalls.readPagesCount", { count });
	}
	const base = `${$t("toolCalls.searchedWeb")} · ${$t("toolCalls.sourcesCount", { count })}`;
	const cited = citedCount(sources);
	if (cited > 0) {
		return `${base} · ${$t("toolCalls.citedCount", { count: cited })}`;
	}
	return base;
}

function chipTooltip(source: FetchedSource): string {
	return source.reason ? `${source.title}\n${source.reason}` : source.title;
}

// Task 11b — agenda peek + photo strip. Both read exclusively from
// segment.candidates (never modelPayload): candidates are the user's own
// tool-evidence data, already streamed to the client on every tool_call
// segment for the Sources tab, so this is a display-only peek reusing that
// same channel rather than a new server event. Gated on the connector
// tool's NAME first (calendar/photos always group into a connector-group
// entry, even for a single call — see toolStackEntries above), so a web or
// document candidate can never be mistaken for an agenda/photo item even if
// it happened to carry a similarly-named metadata key.
const AGENDA_PEEK_MAX = 5;
const PHOTO_STRIP_MAX = 8;

function isCalendarToolName(name: string): boolean {
	return name.toLowerCase() === "calendar";
}

function isPhotosToolName(name: string): boolean {
	return name.toLowerCase() === "photos";
}

function getAgendaCandidates(
	tools: ToolCallSegment[],
): ToolEvidenceCandidate[] {
	return tools
		.flatMap((tool) => tool.candidates ?? [])
		.filter((candidate) => typeof candidate.metadata?.start === "string")
		.slice(0, AGENDA_PEEK_MAX);
}

function getPhotoCandidates(tools: ToolCallSegment[]): ToolEvidenceCandidate[] {
	return tools
		.flatMap((tool) => tool.candidates ?? [])
		.filter(
			(candidate) => typeof candidate.metadata?.thumbnailPath === "string",
		)
		.slice(0, PHOTO_STRIP_MAX);
}

function formatEventTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

// Maps a photo candidate's server-internal thumbnailPath
// ("/api/assets/{assetId}/thumbnail" — see photos.ts's toCandidate) to the
// Task 11a authed per-user proxy route that actually serves the bytes
// ("/api/connections/immich/thumbnail/{assetId}"). The Immich API key never
// reaches the client either way — this is purely a URL rewrite.
function immichThumbnailUrl(thumbnailPath: unknown): string | null {
	if (typeof thumbnailPath !== "string") return null;
	const match = thumbnailPath.match(/^\/api\/assets\/([^/]+)\/thumbnail$/);
	return match ? `/api/connections/immich/thumbnail/${match[1]}` : null;
}

function hideBrokenThumbnail(event: Event): void {
	const img = event.currentTarget;
	if (img instanceof HTMLImageElement) img.style.display = "none";
}

function formatToolCall(name: string, input: Record<string, unknown>): string {
	const n = name.toLowerCase();
	const firstVal = () => String(Object.values(input)[0] ?? "").slice(0, 200);
	const toolLabel = $t(getHumanReadableToolNameKey(name));
	if (isFileProductionToolName(name)) {
		return toolLabel;
	}
	if (n.includes("search") || n.includes("tavily")) {
		const q = input.query ?? input.q ?? Object.values(input)[0];
		const label =
			n === "research_web" || n.includes("web")
				? toolLabel
				: $t("toolCalls.search");
		return `${label}: "${String(q ?? "").slice(0, 200)}"`;
	}
	if (isFetchTool(name)) {
		const raw = String(Object.values(input)[0] ?? "");
		return `${toolLabel}: ${extractHostname(raw)}`;
	}
	// Connection tools ("calendar", "files", ...) label by their capability +
	// the human-formatted action ("Calendar: list events"), never the raw
	// "list_events" first-value that read vague to end users.
	if (isConnectionToolName(name)) {
		const action =
			typeof input.action === "string"
				? formatConnectionToolAction(input.action)
				: "";
		return action ? `${toolLabel}: ${action}` : toolLabel;
	}
	return firstVal() ? `${toolLabel}: ${firstVal()}` : toolLabel;
}

function getToolTitle(name: string, input: Record<string, unknown>): string {
	const n = name.toLowerCase();
	if (n.includes("search") || n.includes("tavily")) {
		const q = input.query ?? input.q ?? Object.values(input)[0];
		return String(q ?? "");
	}
	if (isFileProductionToolName(name)) {
		const title = input.requestTitle ?? input.filename ?? input.documentIntent;
		return title ? String(title) : "produce_file";
	}
	if (isFetchTool(name)) {
		return String(Object.values(input)[0] ?? "");
	}
	return String(Object.values(input)[0] ?? "");
}

function formatThinkingTextForDisplay(text: string): string {
	return text.replace(/([a-z0-9)])([.!?])(?=[A-Z](?:[a-z]|\s))/g, "$1$2\n\n");
}

function getFormattedFreshStart(text: string, rawStart: number): number {
	return formatThinkingTextForDisplay(text.slice(0, rawStart)).length;
}

// TS2-c (ADR-0056 amendment, "Disclosure UX: clean by default, transparency
// on demand") — clicking a completed step no longer opens the whole raw
// Thinking Trace scrolled to a highlight; it reveals ONLY that step's own
// anchored span (resolveThoughtStepAnchorSpan's sliced substring), replacing
// the clean step list with a single focused card. The full continuous trace
// moves to the separate, explicit `showFullReasoning` opt-in below — this
// state is deliberately just an id, not a span: the span itself is derived
// (selectedStepReveal), so it always reflects the current `content` rather
// than a snapshot taken at click time.
let selectedStepId = $state<string | null>(null);
let selectedStepRevealEl = $state<HTMLElement | undefined>(undefined);
// TS2-c — the opt-in, off-by-default "show full reasoning" control (ADR-0056
// amendment). Only meaningful together with anchoredThoughtSteps.length > 0
// (the clean-list mode); the pre-existing no-thoughtSteps fallback path
// below never reads this and always shows its own raw content directly, per
// this ADR's "P1 is the floor" invariant.
let showFullReasoning = $state(false);

// P3c honesty gate, reused: a selection only resolves to a reveal when the
// step still exists among the anchored (resolvable) steps AND its span still
// resolves against the current `content` — mirrors anchoredThoughtSteps'
// own filter, so a selection can never show stale or unresolvable text.
const selectedStepReveal = $derived.by(() => {
	if (!selectedStepId) return null;
	const step = anchoredThoughtSteps.find((s) => s.id === selectedStepId);
	if (!step) return null;
	const span = resolveThoughtStepAnchorSpan(step.anchor, content);
	if (!span) return null;
	return { step, span };
});

function selectThoughtStep(step: InterimThoughtStep) {
	// Clicking the already-selected step's row is the way back to the step
	// list — no separate close-only control needed for that path, though
	// the explicit "Back to steps" button below covers it too.
	selectedStepId = selectedStepId === step.id ? null : step.id;
}

function closeSelectedStepReveal() {
	selectedStepId = null;
}

$effect(() => {
	if (!selectedStepReveal || !selectedStepRevealEl) return;
	// Defensive guard (mirrors MessageInput.svelte's identical check):
	// jsdom's default test environment does not implement scrollIntoView.
	if (typeof selectedStepRevealEl.scrollIntoView !== "function") return;
	selectedStepRevealEl.scrollIntoView({
		block: "center",
		behavior: prefersReducedMotion() ? "auto" : "smooth",
	});
});

// TS2-c — the compact, ordered clean-list view's entries: the SAME
// true-arrival-order merge interleavedEntries already computes (tool calls,
// deliberation/context status rows, and classified thought steps at the
// exact position they occurred), just without the raw reasoning `text`
// entries — those are what made the old always-on view "a big mess" per
// this slice's owner complaint, and now live only behind the explicit
// showFullReasoning toggle below. Only meaningful once
// anchoredThoughtSteps.length > 0; the caller only renders this in that
// branch.
const cleanRailEntries = $derived(
	interleavedEntries.filter(
		(entry): entry is Exclude<InterleavedEntry, { kind: "text" }> =>
			entry.kind !== "text",
	),
);

// TS2-c — a step's displayed duration: the honest, mechanically-derivable
// span between this step's own createdAt and the NEXT anchored step's
// createdAt. Deliberately does not estimate a duration for the last step
// (no "end of reasoning" timestamp reaches the client) rather than show a
// fabricated number — silence over a guess, matching this ADR's honesty
// discipline for step CONTENT extended to step TIMING.
const nextAnchoredStepCreatedAtById = $derived.by(() => {
	const map = new Map<string, number>();
	for (let i = 0; i < anchoredThoughtSteps.length - 1; i += 1) {
		const current = anchoredThoughtSteps[i];
		const next = anchoredThoughtSteps[i + 1];
		if (
			typeof current.createdAt === "number" &&
			typeof next.createdAt === "number"
		) {
			map.set(current.id, next.createdAt);
		}
	}
	return map;
});

function stepDurationLabel(step: InterimThoughtStep): string | null {
	if (typeof step.createdAt !== "number") return null;
	const nextCreatedAt = nextAnchoredStepCreatedAtById.get(step.id);
	if (nextCreatedAt === undefined) return null;
	const deltaMs = nextCreatedAt - step.createdAt;
	if (!(deltaMs > 0)) return null;
	return formatDurationLabel(Math.round(deltaMs / 1000));
}

async function toggle() {
	await preserveScrollOnToggle(container, expanded, () => {
		expanded = !expanded;
		if (!expanded) {
			selectedStepId = null;
			showFullReasoning = false;
		}
	});
}
</script>

<script module>
	import { slide } from 'svelte/transition';
	import { preserveScrollOnToggle } from '$lib/actions/preserve-scroll';
</script>

{#snippet toolStatusIcon(status: 'running' | 'done' | 'failed', variant: 'header' | 'inline')}
	{#if status === 'running'}
		<span class={variant === 'header' ? 'tool-dot' : 'tool-dot-inline'}></span>
	{:else if status === 'failed'}
		<XCircle class={variant === 'header' ? 'fail-icon-header' : 'fail-icon'} size={12} strokeWidth={1.5} aria-hidden="true" />
	{:else}
		<Check class={variant === 'header' ? 'check-icon-header' : 'check-icon'} size={12} strokeWidth={1.5} aria-hidden="true" />
	{/if}
{/snippet}

{#snippet toolFailedBadge()}
	<span class="tool-status-badge tool-status-badge--failed">{$t('toolCalls.failed')}</span>
{/snippet}

<!--
	TS2-c (ADR-0056 amendment) — the closed activity class's secondary
	signal: a small leading icon, never the headline. Same if/else-over-a-
	string-tag shape as getDeliberationStatusIconType's icon block above it
	in this file, deliberately not a dynamic-component map, to match this
	file's established idiom for "pick one of a few known icons".
-->
{#snippet thoughtStepClassIcon(activityClass: ThoughtStepClassifierActivityClass)}
	{@const iconType = getThoughtStepClassIconType(activityClass)}
	{#if iconType === 'help-circle'}
		<HelpCircle class="thought-step-class-icon" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'history'}
		<History class="thought-step-class-icon" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'scale'}
		<Scale class="thought-step-class-icon" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'workflow'}
		<Workflow class="thought-step-class-icon" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'list-checks'}
		<ListChecks class="thought-step-class-icon" size={13} strokeWidth={2} aria-hidden="true" />
	{:else}
		<PenLine class="thought-step-class-icon" size={13} strokeWidth={2} aria-hidden="true" />
	{/if}
{/snippet}

{#snippet fetchedChip(source: FetchedSource, dimUncited: boolean)}
	{@const faviconUrl = getFaviconUrl(source.url)}
	{@const cited = isCitedSource(source)}
	<a
		class="fetched-source-chip"
		class:is-cited={cited}
		class:is-uncited={!cited && dimUncited}
		href={source.url}
		target="_blank"
		rel="noopener noreferrer"
		title={chipTooltip(source)}
		aria-label={source.title}
	>
		{#if faviconUrl}
			<img
				class="fetched-favicon"
				src={faviconUrl}
				alt=""
				loading="lazy"
				decoding="async"
				referrerpolicy="no-referrer"
				onerror={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
			/>
		{/if}
		{#if cited}
			<span class="fetched-chip-cited-dot" aria-hidden="true"></span>
		{/if}
		<span class="fetched-source-tooltip" role="tooltip" aria-hidden="true">
			<span class="fetched-tooltip-title">
				{#if cited}
					<span class="fetched-tooltip-cited">{$t('toolCalls.citedMarker')}</span>
				{/if}
				{source.title}
			</span>
			{#if source.reason}
				<span class="fetched-tooltip-reason">{source.reason}</span>
			{/if}
		</span>
	</a>
{/snippet}

{#snippet fetchedSourceGroup(sources: FetchedSource[], summaryClass: string, kind: "search" | "read")}
	{@const cited = sources.filter(isCitedSource)}
	{@const uncited = uncitedSources(sources)}
	{@const visibleUncited = uncited.slice(0, UNCITED_CHIP_LIMIT)}
	{@const overflowUncited = uncited.slice(UNCITED_CHIP_LIMIT)}
	<!-- Only dim uncited chips when there's actually a cited source to contrast
	     against. In the zero-citation fallback (and for read-page/fetch_url
	     segments, which have no citation concept), every chip renders neutral at
	     full opacity instead of a uniformly dimmed row. -->
	{@const dimUncited = cited.length > 0}
	<details class="fetched-source-group">
		<summary class={summaryClass}>
			<span class="fetched-source-summary">
				<span class="fetched-favicon-stack" aria-hidden="true">
					{#each sources as source}
						{@const faviconUrl = getFaviconUrl(source.url)}
						{#if faviconUrl}
							<img
								class="fetched-favicon-stack-icon"
								src={faviconUrl}
								alt=""
								loading="lazy"
								decoding="async"
								referrerpolicy="no-referrer"
								onerror={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
							/>
						{/if}
					{/each}
				</span>
				<span>{fetchedSourceSummary(sources, kind)}</span>
			</span>
		</summary>
		<div class="fetched-source-chips">
			{#each cited as source}
				{@render fetchedChip(source, dimUncited)}
			{/each}
			{#each visibleUncited as source}
				{@render fetchedChip(source, dimUncited)}
			{/each}
			{#if overflowUncited.length > 0}
				<details class="fetched-chip-more">
					<summary
						class="fetched-chip-more-summary"
						aria-label={$t('toolCalls.moreSourcesLabel', { count: overflowUncited.length })}
					>{$t('toolCalls.moreSourcesCount', { count: overflowUncited.length })}</summary>
					<div class="fetched-source-chips fetched-source-chips--overflow">
						{#each overflowUncited as source}
							{@render fetchedChip(source, dimUncited)}
						{/each}
					</div>
				</details>
			{/if}
		</div>
	</details>
{/snippet}

{#snippet connectorGroupDetails(tools: ToolCallSegment[], summaryClass: string)}
	<details class="connector-group">
		<summary class={summaryClass}>{connectorGroupSummary(tools[0].name, tools.length)}</summary>
		<div class="connector-action-list">
			{#each tools as tool, i (tool.callId ?? tool.name + JSON.stringify(tool.input) + '-' + i)}
				<div class="connector-action-item" class:is-failed={tool.status === 'failed'}>
					{@render toolStatusIcon(tool.status, 'inline')}
					<span class="tool-item-label">{formatGroupedConnectorAction(tool)}</span>
					{#if tool.status === 'failed'}
						{@render toolFailedBadge()}
					{/if}
				</div>
			{/each}
		</div>
	</details>
{/snippet}

{#snippet agendaPeek(items: ToolEvidenceCandidate[])}
	<div class="agenda-peek">
		<span class="peek-label">{$t('toolCalls.agendaUpcoming')}</span>
		<ul class="agenda-list">
			{#each items as item (item.id)}
				<li class="agenda-row">
					<span class="agenda-time">{formatEventTime(String(item.metadata?.start ?? ''))}</span>
					<span class="agenda-title">{item.title}</span>
					{#if item.metadata?.location}
						<span class="agenda-location">{item.metadata.location}</span>
					{/if}
				</li>
			{/each}
		</ul>
	</div>
{/snippet}

{#snippet photoStrip(items: ToolEvidenceCandidate[])}
	<div class="photo-strip">
		<span class="peek-label">{$t('toolCalls.photos')}</span>
		<div class="photo-strip-row">
			{#each items as item (item.id)}
				{@const thumbUrl = immichThumbnailUrl(item.metadata?.thumbnailPath)}
				{#if thumbUrl}
					{#if item.url}
						<a
							class="photo-strip-link"
							href={item.url}
							target="_blank"
							rel="noopener noreferrer"
						>
							<img
								class="photo-strip-thumb"
								src={thumbUrl}
								alt={item.title}
								loading="lazy"
								decoding="async"
								onerror={hideBrokenThumbnail}
							/>
						</a>
					{:else}
						<img
							class="photo-strip-thumb"
							src={thumbUrl}
							alt={item.title}
							loading="lazy"
							decoding="async"
							onerror={hideBrokenThumbnail}
						/>
					{/if}
				{/if}
			{/each}
		</div>
	</div>
{/snippet}

{#snippet singleToolStackRow(tool: ToolCallSegment)}
	{@const fetchedSources = getFetchedSources(tool)}
	{#if fetchedSources.length > 0}
		<div class="tool-call-row" class:is-running={tool.status === 'running'} class:is-failed={tool.status === 'failed'}>
			{@render toolStatusIcon(tool.status, 'header')}
			{@render fetchedSourceGroup(fetchedSources, 'tool-label-text', 'search')}
			{#if tool.status === 'failed'}
				{@render toolFailedBadge()}
			{/if}
		</div>
	{:else if getFetchUrlSources(tool.name, tool.input).length > 0}
		{@const fetchUrlSources = getFetchUrlSources(tool.name, tool.input)}
		<div class="tool-call-row" class:is-running={tool.status === 'running'} class:is-failed={tool.status === 'failed'}>
			{@render toolStatusIcon(tool.status, 'header')}
			{@render fetchedSourceGroup(fetchUrlSources, 'tool-label-text', 'read')}
			{#if tool.status === 'failed'}
				{@render toolFailedBadge()}
			{/if}
		</div>
	{:else}
		<div class="tool-call-row" class:is-running={tool.status === 'running'} class:is-failed={tool.status === 'failed'}>
			{@render toolStatusIcon(tool.status, 'header')}
			<span class="tool-label-text" title={getToolTitle(tool.name, tool.input)}>{formatToolCall(tool.name, tool.input)}</span>
			{#if tool.status === 'failed'}
				{@render toolFailedBadge()}
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet connectorGroupStackRow(tools: ToolCallSegment[])}
	{@const anyRunning = tools.some((t) => t.status === 'running')}
	{@const anyFailed = !anyRunning && tools.some((t) => t.status === 'failed')}
	<div class="tool-call-row" class:is-running={anyRunning} class:is-failed={anyFailed}>
		{@render toolStatusIcon(anyRunning ? 'running' : anyFailed ? 'failed' : 'done', 'header')}
		{@render connectorGroupDetails(tools, 'tool-label-text')}
		{#if anyFailed}
			{@render toolFailedBadge()}
		{/if}
	</div>
	{#if isCalendarToolName(tools[0].name)}
		{@const agendaItems = getAgendaCandidates(tools)}
		{#if agendaItems.length > 0}
			{@render agendaPeek(agendaItems)}
		{/if}
	{:else if isPhotosToolName(tools[0].name)}
		{@const photoItems = getPhotoCandidates(tools)}
		{#if photoItems.length > 0}
			{@render photoStrip(photoItems)}
		{/if}
	{/if}
{/snippet}

{#snippet singleToolItem(seg: ToolCallSegment)}
	{@const fetchedSources = getFetchedSources(seg)}
	{#if fetchedSources.length > 0}
		<div class="tool-call-item" class:is-failed={seg.status === 'failed'}>
			{@render toolStatusIcon(seg.status, 'inline')}
			{@render fetchedSourceGroup(fetchedSources, 'tool-item-label', 'search')}
			{#if seg.status === 'failed'}
				{@render toolFailedBadge()}
			{/if}
		</div>
	{:else if getFetchUrlSources(seg.name, seg.input).length > 0}
		{@const fetchUrlSources = getFetchUrlSources(seg.name, seg.input)}
		<div class="tool-call-item" class:is-failed={seg.status === 'failed'}>
			{@render toolStatusIcon(seg.status, 'inline')}
			{@render fetchedSourceGroup(fetchUrlSources, 'tool-item-label', 'read')}
			{#if seg.status === 'failed'}
				{@render toolFailedBadge()}
			{/if}
		</div>
	{:else}
		<div class="tool-call-item" class:is-failed={seg.status === 'failed'}>
			{@render toolStatusIcon(seg.status, 'inline')}
			<span class="tool-item-label" title={getToolTitle(seg.name, seg.input)}>{formatToolCall(seg.name, seg.input)}</span>
			{#if seg.status === 'failed'}
				{@render toolFailedBadge()}
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet connectorGroupItem(tools: ToolCallSegment[])}
	{@const anyRunning = tools.some((t) => t.status === 'running')}
	{@const anyFailed = !anyRunning && tools.some((t) => t.status === 'failed')}
	<div class="tool-call-item" class:is-failed={anyFailed}>
		{@render toolStatusIcon(anyRunning ? 'running' : anyFailed ? 'failed' : 'done', 'inline')}
		{@render connectorGroupDetails(tools, 'tool-item-label')}
		{#if anyFailed}
			{@render toolFailedBadge()}
		{/if}
	</div>
{/snippet}

<!--
	Extracted (TS2-c) so the same event-derived status row (context
	preparation / deliberation-pass status) renders identically whether it
	appears in the pre-existing no-thoughtSteps fallback view below, or in
	the new clean step list — one markup source, not a fork that could drift.
-->
{#snippet statusStepEntry(rawStatusSeg: StatusSegment)}
	<!-- svelte-check's control-flow narrowing over an if/else chain keyed
	     off an unrelated {@const} (iconType) below misnarrows this to
	     `never` in the sibling branches without this cast — mirrors the
	     pre-existing `entry.segment as any` this snippet was extracted
	     from, at the original call site. -->
	{@const statusSeg = rawStatusSeg as any}
	{@const isDeliberationStatus = isDeliberationStatusSegment(statusSeg)}
	<div
		class="status-step"
		class:status-deliberation={isDeliberationStatus}
		class:is-running={statusSeg.status === 'running'}
	>
		{#if isDeliberationStatus}
			{@const iconType = getDeliberationStatusIconType(statusSeg)}
			{#if iconType === 'search'}
				<Search class="deliberation-status-icon" data-deliberation-icon="search" size={14} strokeWidth={2} aria-hidden="true" />
			{:else if iconType === 'clipboard-check'}
				<ClipboardCheck class="deliberation-status-icon" data-deliberation-icon="clipboard-check" size={14} strokeWidth={2} aria-hidden="true" />
			{:else if iconType === 'shield-alert'}
				<ShieldAlert class="deliberation-status-icon" data-deliberation-icon="shield-alert" size={14} strokeWidth={2} aria-hidden="true" />
			{:else if iconType === 'languages'}
				<Languages class="deliberation-status-icon" data-deliberation-icon="languages" size={14} strokeWidth={2} aria-hidden="true" />
			{:else if iconType === 'layers'}
				<Layers class="deliberation-status-icon" data-deliberation-icon="layers" size={14} strokeWidth={2} aria-hidden="true" />
			{:else}
				<Bot class="deliberation-status-icon" data-deliberation-icon="bot" size={14} strokeWidth={2} aria-hidden="true" />
			{/if}
		{:else if statusSeg.status === 'running'}
			<span class="tool-dot-inline"></span>
		{:else}
			<Check class="check-icon" size={12} strokeWidth={1.5} aria-hidden="true" />
		{/if}
		<span class="status-step-label">{isDeliberationStatus ? formatDeliberationStatusLabel(statusSeg) : statusSeg.label}</span>
	</div>
{/snippet}

<!--
	P3c (ADR-0056) / TS2-c (amendment) — a completed classified step, now
	rendered ONLY in the clean step list (see cleanRailEntries): phase icon
	(secondary signal) + headline (summary, falling back to the phase label)
	+ this step's own duration when honestly derivable. Its label is the
	accessible name (never overridden by aria-label, so a screen reader
	hears exactly the localized headline text); `title` gives sighted users
	a hover hint for the anchored-span reveal. Honesty: thoughtStepDisplayLabel
	returns null for an unrecognized class, and the caller renders nothing
	for it — no blank row, no fabricated label — exactly as before this
	slice.
-->
{#snippet thoughtStepEntry(step: InterimThoughtStep)}
	{@const phaseLabel = thoughtStepDisplayLabel(step.activityClass, step.entity)}
	{#if phaseLabel}
		{@const headline = step.summary?.trim() || phaseLabel}
		{@const duration = stepDurationLabel(step)}
		<button
			type="button"
			class="thought-step-row"
			class:is-active={selectedStepId === step.id}
			onclick={() => selectThoughtStep(step)}
			title={$t('chat.thoughtStep.viewInTrace')}
		>
			{#if isThoughtStepClassifierActivityClass(step.activityClass)}
				{@render thoughtStepClassIcon(step.activityClass)}
			{/if}
			<span class="status-step-label">{headline}</span>
			{#if duration}
				<span class="thought-step-duration">{duration}</span>
			{/if}
		</button>
	{/if}
{/snippet}

{#if hasVisibleSurface}
<div class="thinking-block" bind:this={container}>
	<button
		type="button"
		class="thinking-header"
		onclick={toggle}
		aria-expanded={expanded}
	>
		<!--
			P1 (ADR-0056) — aria-live="polite" here is already rate-limited by
			construction: this text only changes at coarse spine-state
			transitions (mount, an honest stall after REASONING_STALL_MS,
			the answer starting, completion), never per-character or per-tick,
			because nothing here is driven by a free-running timer. P3c extends
			this SAME region rather than adding a competing live region: a new
			classified step is exactly the kind of coarse transition this was
			already built for (the classifier itself rate-limits to roughly one
			step per 5-7s). P4 extends it again, same discipline: "pass N of M"
			and the concluding state are rare, coarse transitions (deliberation
			passes run on the order of seconds), never a competing live region.
		-->
		<span class="thinking-label" class:is-active={isActiveThinking} aria-live="polite">
			{#if thinkingIsDone && formattedThinkingTime}
				{$t('chat.thoughtFor', { time: formattedThinkingTime })}
			{:else if thinkingIsDone}
				{$t('chat.thought')}
			{:else if deliberationProgressLabel}
				{deliberationProgressLabel}
			{:else if liveThoughtStepHeadline}
				<!--
					TS2-c (ADR-0056 amendment) — the closed activityClass is now a
					SECONDARY signal (a small leading icon), never the headline
					itself: liveThoughtStepHeadline already resolved to the step's
					summary, falling back to the phase label, in script.
				-->
				{#if liveThoughtStepRecognizedClass}
					{@render thoughtStepClassIcon(liveThoughtStepRecognizedClass)}
				{/if}
				{liveThoughtStepHeadline}
			{:else}
				{$t(liveSpineLabelKey)}
			{/if}
		</span>
		<ChevronDown class={`chevron${expanded ? ' expanded' : ''}`} size={14} strokeWidth={2} aria-hidden="true" />
	</button>

	{#if visibleTools.length > 0 || thinkingIsDone}
		<div class="tool-call-stack" class:fade-out={thinkingIsDone}>
			{#each toolStackEntries as entry (entry.key)}
				{#if entry.kind === 'connector-group'}
					{@render connectorGroupStackRow(entry.tools)}
				{:else}
					{@render singleToolStackRow(entry.tool)}
				{/if}
			{/each}
		</div>
	{/if}

{#if expanded}
<div class="thinking-content" class:content-fresh={contentFresh} transition:slide>
			{#if anchoredThoughtSteps.length > 0}
				<!--
					TS2-c (ADR-0056 amendment, "Disclosure UX: clean by default,
					transparency on demand") — once this turn has a durable,
					honesty-gated step rail, the expanded panel defaults to the
					compact clean list below rather than dumping the raw,
					interleaved reasoning text. Selecting a step reveals ONLY that
					step's own anchored span (selectedStepReveal); the full
					continuous raw trace is opt-in (showFullReasoning), off by
					default. The pre-existing no-thoughtSteps view (the
					`{:else}` branch at the bottom of this block) is untouched —
					P1's floor never changes.
				-->
				{#if selectedStepReveal}
					<div class="step-anchor-reveal">
						<button type="button" class="raw-trace-back" onclick={closeSelectedStepReveal}>
							<ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />
							{$t('chat.thoughtStep.backToSteps')}
						</button>
						<pre class="thinking-text" bind:this={selectedStepRevealEl}><mark class="thought-step-anchor-highlight">{selectedStepReveal.span}</mark></pre>
					</div>
				{:else if showFullReasoning}
					<div class="full-reasoning-view">
						<button type="button" class="raw-trace-back" onclick={() => (showFullReasoning = false)}>
							<ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />
							{$t('chat.thoughtStep.hideFullReasoning')}
						</button>
						<pre class="thinking-text">{formatThinkingTextForDisplay(content)}</pre>
					</div>
				{:else}
					<div class="thought-step-clean-list">
						{#each cleanRailEntries as entry (entry.key)}
							{#if entry.kind === 'status'}
								{@render statusStepEntry(entry.segment)}
							{:else if entry.kind === 'tool'}
								<div class="thought-rail-chip">{@render singleToolItem(entry.segment)}</div>
							{:else if entry.kind === 'thought_step'}
								{@render thoughtStepEntry(entry.step)}
							{:else}
								<div class="thought-rail-chip">{@render connectorGroupItem(entry.tools)}</div>
							{/if}
						{/each}
					</div>
					<button type="button" class="full-reasoning-toggle" onclick={() => (showFullReasoning = true)}>
						{$t('chat.thoughtStep.showFullReasoning')}
					</button>
				{/if}
			{:else if hasSegments}
				{#each interleavedEntries as entry (entry.key)}
				{#if entry.kind === 'text'}
					<pre class="thinking-text">{formatThinkingTextForDisplay(entry.segment.content)}</pre>
				{:else if entry.kind === 'status'}
					{@render statusStepEntry(entry.segment)}
					{:else if entry.kind === 'tool'}
						{@render singleToolItem(entry.segment)}
					{:else if entry.kind === 'connector-group'}
						{@render connectorGroupItem(entry.tools)}
					{/if}
				{/each}
		{:else}
			<pre class="thinking-text">
				{#if isActiveThinking && newCharStart > 0 && newCharStart < content.length}
					{@const formattedContent = formatThinkingTextForDisplay(content)}
					{@const formattedNewCharStart = getFormattedFreshStart(content, newCharStart)}
					{formattedContent.slice(0, formattedNewCharStart)}<span class="word-new">{formattedContent.slice(formattedNewCharStart)}</span>
				{:else}
					{formatThinkingTextForDisplay(content)}
				{/if}
			</pre>
		{/if}
		</div>
	{/if}
</div>
{/if}

<style>
	.thinking-block {
		margin-bottom: var(--space-md);
		width: 100%;
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
	}

	.thinking-header {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-xs) 0;
		background: transparent;
		border: none;
		cursor: pointer;
		max-width: 100%;
		width: 100%;
		min-width: 0;
	}

	.thinking-header:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
		border-radius: 2px;
	}

	.thinking-label {
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 500;
		color: var(--text-muted);
	}

	@keyframes thinking-sweep {
		0%   { background-position: 250% center; }
		100% { background-position: -250% center; }
	}

	.thinking-label.is-active {
		background: linear-gradient(
			90deg,
			var(--text-muted)    0%,
			var(--text-muted)    35%,
			var(--accent)        47%,
			var(--text-primary)  50%,
			var(--accent)        53%,
			var(--text-muted)    65%,
			var(--text-muted)    100%
		);
		background-size: 500% 100%;
		background-clip: text;
		-webkit-background-clip: text;
		color: transparent;
		-webkit-text-fill-color: transparent;
		animation: thinking-sweep 6s linear infinite;
	}

	.chevron {
		color: var(--icon-muted);
		transition: transform var(--duration-standard) var(--ease-out);
		flex-shrink: 0;
	}

	.chevron.expanded {
		transform: rotate(180deg);
	}

	/* Tool call stack — accumulates all tool rows, visible without expanding */
	.tool-call-stack {
		padding: var(--space-xs) 0;
		width: 100%;
		min-width: 0;
		transition: opacity 400ms var(--ease-out), max-height 400ms var(--ease-out);
		max-height: 999px;
		overflow: hidden;
	}

	.tool-call-stack.fade-out {
		opacity: 0;
		max-height: 0;
		padding: 0;
		pointer-events: none;
	}

	.tool-call-row {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: 3px 0;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-muted);
		width: 100%;
		min-width: 0;
	}

	.tool-call-row.is-running {
		color: var(--text-secondary);
	}

	/* E1/E2 — a failed tool call is a terminal outcome distinct from "done":
	   the row keeps the danger color so it reads as an error, not a quiet
	   success, at a glance. */
	.tool-call-row.is-failed {
		color: var(--danger);
	}

	.tool-status-badge {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		padding: 1px 6px;
		border-radius: 9999px;
		font-family: var(--font-sans);
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.tool-status-badge--failed {
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 16%, transparent);
	}

	.tool-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		flex-shrink: 0;
		animation: tool-pulse 1.5s ease-in-out infinite;
	}

	@keyframes tool-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.35; }
	}

	.tool-label-text {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
		white-space: normal;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.fetched-source-group {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
	}

	.fetched-source-group summary {
		cursor: pointer;
		list-style-position: inside;
	}

	.fetched-source-summary {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		max-width: 100%;
		vertical-align: middle;
	}

	.fetched-favicon-stack {
		display: inline-flex;
		align-items: center;
		flex: 0 1 auto;
		min-width: 0;
		max-width: min(260px, 45vw);
		overflow: hidden;
		padding: 1px 0 1px 1px;
	}

	.fetched-favicon-stack-icon {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 1px solid var(--surface-elevated);
		background: var(--surface-elevated);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--border-default) 55%, transparent);
		flex: 0 0 auto;
		object-fit: cover;
	}

	.fetched-favicon-stack-icon + .fetched-favicon-stack-icon {
		margin-left: -5px;
	}

	.fetched-favicon {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 1px solid var(--surface-elevated);
		background: var(--surface-elevated);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--border-default) 55%, transparent);
		flex: 0 0 auto;
		object-fit: cover;
	}

	/* Compact cited-first chip row: reuses the 14px favicon circle tokens from
	   the collapsed stack, wrapping into a tidy grid instead of the old
	   full-width vertical link list. */
	.fetched-source-chips {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 6px;
		padding-left: 16px;
	}

	.fetched-source-chips--overflow {
		margin-top: 6px;
		padding-left: 0;
	}

	.fetched-source-chip {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		flex: 0 0 auto;
	}

	.fetched-source-chip .fetched-favicon {
		width: 14px;
		height: 14px;
	}

	/* Cited chips lead and carry a subtle accent ring so the answer's actual
	   citations read as primary; uncited ("also found") chips sit dimmed. */
	.fetched-source-chip.is-cited {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent);
	}

	.fetched-source-chip.is-uncited {
		opacity: 0.55;
	}

	.fetched-source-chip.is-uncited:hover,
	.fetched-source-chip.is-uncited:focus-visible {
		opacity: 1;
	}

	.fetched-source-chip:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.fetched-chip-cited-dot {
		position: absolute;
		right: -1px;
		bottom: -1px;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		border: 1px solid var(--surface-page);
	}

	/* Hover/focus tooltip: favicon-adjacent card with title (line 1) + compact
	   reason (line 2). Absolutely positioned within the chip (never fixed), so
	   it never leaks out of the thinking block's own scroll context. */
	.fetched-source-tooltip {
		position: absolute;
		bottom: calc(100% + 6px);
		left: 50%;
		transform: translateX(-50%);
		z-index: 20;
		display: none;
		flex-direction: column;
		gap: 2px;
		width: max-content;
		max-width: min(260px, 60vw);
		padding: 6px 8px;
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
		border: 1px solid var(--border-default);
		box-shadow: 0 4px 14px color-mix(in srgb, var(--shadow-color, #000) 18%, transparent);
		font-family: var(--font-sans);
		text-align: left;
		pointer-events: none;
	}

	.fetched-source-chip:hover .fetched-source-tooltip,
	.fetched-source-chip:focus-visible .fetched-source-tooltip {
		display: flex;
	}

	.fetched-tooltip-title {
		font-size: var(--text-xs, 0.75rem);
		font-weight: 600;
		color: var(--text-primary);
		line-height: 1.3;
		overflow-wrap: anywhere;
	}

	.fetched-tooltip-cited {
		display: inline-block;
		margin-right: 4px;
		padding: 0 5px;
		border-radius: 9999px;
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 16%, transparent);
	}

	.fetched-tooltip-reason {
		font-size: var(--text-xs, 0.75rem);
		color: var(--text-muted);
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.fetched-chip-more {
		flex: 0 0 auto;
	}

	.fetched-chip-more-summary {
		cursor: pointer;
		list-style: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 22px;
		height: 22px;
		padding: 0 6px;
		border-radius: 9999px;
		background: var(--surface-elevated);
		border: 1px solid var(--border-default);
		font-family: var(--font-sans);
		font-size: var(--text-xs, 0.75rem);
		color: var(--text-muted);
	}

	.fetched-chip-more-summary::-webkit-details-marker {
		display: none;
	}

	.connector-group {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
	}

	.connector-group summary {
		cursor: pointer;
		list-style-position: inside;
	}

	.connector-action-list {
		display: grid;
		gap: 4px;
		margin-top: 4px;
		padding-left: 16px;
	}

	.connector-action-item {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.connector-action-item.is-failed {
		color: var(--danger);
	}

	.check-icon-header {
		color: var(--success);
		width: 12px;
		height: 12px;
		flex-shrink: 0;
	}

	.fail-icon-header {
		color: var(--danger);
		width: 12px;
		height: 12px;
		flex-shrink: 0;
	}

	/* Agenda peek + photo strip (Task 11b) — subtle, tasteful peeks rendered
	   alongside the connector group's stack row, visible without expanding. */
	.agenda-peek,
	.photo-strip {
		margin: 4px 0 2px;
		padding-left: 16px;
	}

	.peek-label {
		display: block;
		font-family: var(--font-sans);
		font-size: var(--text-xs, 0.75rem);
		font-weight: 500;
		color: var(--text-muted);
		margin-bottom: 4px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.agenda-list {
		display: grid;
		gap: 3px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.agenda-row {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 6px;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-secondary);
		min-width: 0;
	}

	.agenda-time {
		flex: 0 0 auto;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.agenda-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.agenda-location {
		flex: 0 1 auto;
		min-width: 0;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.agenda-location::before {
		content: "· ";
	}

	.photo-strip-row {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		padding-bottom: 2px;
	}

	.photo-strip-link {
		flex: 0 0 auto;
		display: block;
		line-height: 0;
	}

	.photo-strip-thumb {
		width: 48px;
		height: 48px;
		flex: 0 0 auto;
		border-radius: 6px;
		object-fit: cover;
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
	}

	.thinking-content {
		padding: var(--space-sm) 0 var(--space-sm);
		width: 100%;
		min-width: 0;
}

.word-new {
animation: wordFadeIn 300ms ease-out forwards;
}

@keyframes wordFadeIn {
from { opacity: 0; transform: translateY(2px); }
to   { opacity: 1; transform: translateY(0); }
}

@keyframes thinkContentFadeIn {
from { opacity: 0.5; }
to   { opacity: 1; }
}

	@keyframes deliberationStatusFade {
		from {
			opacity: 0;
			transform: translateY(-2px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.thinking-content.content-fresh {
animation: thinkContentFadeIn 300ms ease-out;
}

	.thinking-text {
		margin: 0;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		line-height: 1.5;
		color: var(--text-muted);
		white-space: pre-wrap;
		word-break: break-word;
	}

	/* Inline tool call rows between thinking text segments */
	.tool-call-item {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-muted);
		margin: var(--space-xs) 0;
		width: 100%;
		min-width: 0;
	}

	.tool-call-item.is-failed {
		color: var(--danger);
	}

	.status-step {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-muted);
		margin: var(--space-xs) 0;
		width: 100%;
		min-width: 0;
	}

	.status-step.is-running {
		color: var(--text-secondary);
	}

	.status-step-label {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
		white-space: normal;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.status-step.status-deliberation {
		font-size: var(--text-sm);
		font-weight: 600;
		animation: deliberationStatusFade 220ms var(--ease-out) both;
	}

	:global(.deliberation-status-icon) {
		color: currentColor;
		width: 14px;
		height: 14px;
		flex-shrink: 0;
	}

	.tool-dot-inline {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		flex-shrink: 0;
		opacity: 0.6;
		animation: tool-pulse 1.5s ease-in-out infinite;
	}

	.tool-item-label {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
		white-space: normal;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.check-icon {
		color: var(--success);
		width: 12px;
		height: 12px;
		flex-shrink: 0;
	}

	.fail-icon {
		color: var(--danger);
		width: 12px;
		height: 12px;
		flex-shrink: 0;
	}

	/* P3c (ADR-0056) — a completed classified thought step. Same visual
	   rhythm as .status-step (icon + label row) but an actual <button>: the
	   row is the jump-anchor into the raw Thinking Trace. */
	.thought-step-row {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		width: 100%;
		min-width: 0;
		margin: var(--space-xs) 0;
		padding: 0;
		background: transparent;
		border: none;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-muted);
		text-align: left;
		cursor: pointer;
	}

	.thought-step-row:hover .status-step-label,
	.thought-step-row:focus-visible .status-step-label,
	.thought-step-row.is-active .status-step-label {
		color: var(--text-primary);
		text-decoration: underline;
		text-decoration-style: dotted;
		text-underline-offset: 2px;
	}

	.thought-step-row:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
		border-radius: 2px;
	}

	/* TS2-c (ADR-0056 amendment) — the closed activity class's secondary
	   signal: a small leading icon on a step row/the live header, never the
	   headline itself. Mirrors :global(.deliberation-status-icon) below. */
	:global(.thought-step-class-icon) {
		color: currentColor;
		width: 13px;
		height: 13px;
		flex-shrink: 0;
	}

	/* TS2-c — a step row's own honestly-derived duration, right-aligned by
	   the label's flex:1 1 auto pushing it to the row's trailing edge. */
	.thought-step-duration {
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
		font-size: var(--text-xs, 0.75rem);
		color: var(--text-muted);
	}

	/* TS2-c — the default expanded view once a turn has a durable step rail:
	   a compact, ordered list (thought-step rows + tool/status rows), no raw
	   reasoning prose. Same layout rhythm as .raw-trace-view below it. */
	.thought-step-clean-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		width: 100%;
		min-width: 0;
	}

	/* TS2-c — wraps a tool/connector-group row inside the clean list so it
	   reads as a distinct inline chip rather than prose-adjacent text; the
	   nested .tool-call-item keeps every bit of its existing behavior
	   (favicons, connector grouping, agenda/photo peeks, failed badges) —
	   only its outer shape changes here. */
	.thought-rail-chip {
		display: inline-flex;
		align-items: center;
		max-width: 100%;
		margin: 2px 0;
		padding: 3px 10px;
		border-radius: 9999px;
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
	}

	.thought-rail-chip .tool-call-item {
		margin: 0;
	}

	/* TS2-c — the opt-in "show full reasoning" control, off by default. A
	   plain text-link style so it reads as a secondary, deliberate action,
	   not another list row. */
	.full-reasoning-toggle {
		align-self: flex-start;
		margin-top: var(--space-xs);
		padding: 2px 0;
		background: transparent;
		border: none;
		font-family: var(--font-sans);
		font-size: var(--text-xs, 0.75rem);
		color: var(--text-muted);
		text-decoration: underline;
		text-decoration-style: dotted;
		text-underline-offset: 2px;
		cursor: pointer;
	}

	.full-reasoning-toggle:hover,
	.full-reasoning-toggle:focus-visible {
		color: var(--text-secondary);
	}

	.full-reasoning-toggle:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
		border-radius: 2px;
	}

	/* TS2-c — the per-step anchored-span reveal (selecting a step) and the
	   opt-in full-reasoning view share this same "back button + raw text"
	   shape; P3c's original .raw-trace-view naming survives on the shared
	   back-button style below since both are the same one-way-back pattern. */
	.step-anchor-reveal,
	.full-reasoning-view {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		width: 100%;
		min-width: 0;
	}

	.raw-trace-back {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 2px 10px 2px 6px;
		border-radius: 9999px;
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
		font-family: var(--font-sans);
		font-size: var(--text-xs, 0.75rem);
		color: var(--text-secondary);
		cursor: pointer;
	}

	.raw-trace-back:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	mark.thought-step-anchor-highlight {
		background: color-mix(in srgb, var(--accent) 30%, transparent);
		color: inherit;
		border-radius: 3px;
		padding: 0 1px;
	}

@media (prefers-reduced-motion: reduce) {
	.thinking-label.is-active {
		color: var(--text-muted);
		-webkit-text-fill-color: var(--text-muted);
		background: none;
		animation: none;
	}

	.chevron {
		transition: none;
	}

	.tool-dot,
	.tool-dot-inline {
		animation: none;
		opacity: 0.7;
	}

	.thinking-content.content-fresh {
		animation: none;
		opacity: 1;
	}

	.word-new {
		animation: none;
		opacity: 1;
	}
}
</style>
