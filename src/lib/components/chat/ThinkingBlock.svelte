<script lang="ts">
import { t, type I18nKey } from "$lib/i18n";
import type {
	InterimThoughtStep,
	ThoughtStepClassifierActivityClass,
} from "$lib/response-activity-types";
import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";
import type { ThinkingSegment } from "$lib/server/services/messages-types";
import { isThoughtStepClassifierActivityClass } from "$lib/response-activity-types";
import {
	Brain,
	Calendar,
	Check,
	ChevronDown,
	ChevronLeft,
	Clapperboard,
	ClipboardCheck,
	Bot,
	FileText,
	Folder,
	GitBranch,
	Globe,
	HelpCircle,
	History,
	Image as ImageIcon,
	Images,
	Languages,
	Layers,
	Link,
	ListChecks,
	ListTodo,
	Mail,
	MapPin,
	PenLine,
	Scale,
	Search,
	ShieldAlert,
	Users,
	Workflow,
	Wrench,
	XCircle,
} from "@lucide/svelte";
import {
	deriveReasoningSpineState,
	type ReasoningSpineLiveState,
} from "$lib/utils/reasoning-spine";
import { deriveDeliberationProgressState } from "$lib/utils/deliberation-progress";
import { prefersReducedMotion } from "$lib/utils/motion";
import {
	resolveThoughtStepAnchorSpan,
	resolveThoughtStepDisplayContext,
} from "$lib/utils/thought-step-anchor";
import {
	formatConnectionToolAction,
	getConnectionToolLabelKey,
	getToolCallIconType,
	isConnectionToolName,
	isFileProductionToolName,
	isVisibleThinkingSegment,
	isVisibleThinkingToolCall,
	type ToolCallIconType,
} from "$lib/utils/tool-calls";
import {
	buildFetchedSourceSummary,
	type FetchedSource,
	formatToolCall as formatToolCallLabel,
	getAgendaCandidates,
	getFaviconUrl,
	getFetchedSources,
	getFetchUrlSources,
	getPhotoCandidates,
	getToolTitle,
	immichThumbnailUrl,
	isCalendarToolName,
	isCitedSource,
	isPhotosToolName,
	type ToolCallSegment,
} from "$lib/utils/tool-evidence-presentation";

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
let newCharStart = $state(-1);
// P1 (ADR-0056) — reasoning-delta liveness watchdog. NOT a free-running
// clock: this single timeout is (re)scheduled only when real reasoning
// content/segment growth is observed (the same growth signal that already
// drives `newCharStart` below), and is cleared on every such event. If it
// ever fires, that means REASONING_STALL_MS has elapsed with no real
// growth — an honest "stalled" signal, not a cosmetic tick. Value chosen to
// sit comfortably above normal inter-chunk gaps (the server batches
// reasoning text in >=20-char bursts) without flipping to the honest
// fallback on every brief pause.
const REASONING_STALL_MS = 8000;
let reasoningStalled = $state(false);
let stallTimeout: ReturnType<typeof setTimeout> | undefined;

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

type TextSegment = ThinkingSegment & { type: "text" };
type StatusSegment = ThinkingSegment & { type: "status" };

// Connector tool calls (calendar/contacts/email/files/location/media/photos)
// can fire dozens of times per turn. Collapse repeated calls to the same
// capability into a single expandable group instead of spamming one row per
// call — mirrors the existing fetched-source disclosure collapse precedent
// below (fetchedSourceSummaryButton + fetchedSourceResultsPanel).
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

// Owner polish pass, item 6 — live current-step emphasis. The LAST entry in
// toolStackEntries is, by construction, whatever most recently arrived on
// the real event stream (the array is rebuilt fresh from `segments` on every
// growth), so "the latest one" needs no timer of its own — it falls straight
// out of the same real-event-driven array this rail already recomputes.
// Emphasis only applies while the turn is actually still active
// (isActiveThinking): once thinkingIsDone, nothing is "in progress" anymore
// and every row settles to its calm resting state, matching the owner's
// "completed steps settle back to a calm state".
const latestToolStackEntryKey = $derived(
	isActiveThinking && toolStackEntries.length > 0
		? toolStackEntries[toolStackEntries.length - 1].key
		: null,
);

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
	// Owner polish pass (visual fixes) — only the newly-arrived tail gets the
	// .word-new entrance below; the previous whole-panel "content-fresh"
	// opacity dip re-triggered on every growth burst and read as the panel
	// flashing to half-transparent mid-stream, so it is gone entirely.
	if (totalLength > prevContentLength && isActiveThinking) {
		newCharStart = prevContentLength;
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

// The search/read source-summary text is one of only two tool-evidence
// presenters that touch i18n; it stays here as a one-line shell binding the
// component's `$t` into the pure builder in tool-evidence-presentation.ts.
// Everything else (source shaping, dedupe, cited-ordering, favicon proxy URL,
// agenda/photo candidate extraction, immich thumbnail URL, getToolTitle) is
// imported directly from that module.
function fetchedSourceSummary(
	sources: FetchedSource[],
	kind: "search" | "read",
): string {
	return buildFetchedSourceSummary(sources, kind, $t);
}

function formatEventTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

function hideBrokenThumbnail(event: Event): void {
	const img = event.currentTarget;
	if (img instanceof HTMLImageElement) img.style.display = "none";
}

// The tool-call chip label is the other i18n-coupled presenter: a one-line
// shell binding `$t` into the pure builder in tool-evidence-presentation.ts.
function formatToolCall(name: string, input: Record<string, unknown>): string {
	return formatToolCallLabel(name, input, $t);
}

// Owner polish pass, item 7 — clickable tool chips. Mirrors the existing
// click-to-reveal interaction the reasoning steps already have
// (selectThoughtStep/selectedStepReveal above): one consistent interaction
// model, not a second one invented for tools. `openToolDetailKeys` is a Set
// (not a single id) because, unlike a step reveal (which replaces the whole
// panel with one focused card), multiple tool-call rows can each be
// independently expanded in place without disturbing their neighbors.
let openToolDetailKeys = $state<Set<string>>(new Set());

function toggleToolDetail(key: string): void {
	const next = new Set(openToolDetailKeys);
	if (next.has(key)) {
		next.delete(key);
	} else {
		next.add(key);
	}
	openToolDetailKeys = next;
}

// The search/read source disclosure (the favicon summary row) expands in
// place with the same click-to-reveal model as the tool-detail panels above.
// Converted from a native <details> to a controlled open-set so the reveal can
// carry the app's standard slide transition (a native <details> cannot animate
// its open/close) and so the revealed result list can break out to the full
// width of the chip instead of being nested inside the summary's inline flow.
let openFetchedGroupKeys = $state<Set<string>>(new Set());

function toggleFetchedGroup(key: string): void {
	const next = new Set(openFetchedGroupKeys);
	if (next.has(key)) {
		next.delete(key);
	} else {
		next.add(key);
	}
	openFetchedGroupKeys = next;
}

// A chip only ever appears clickable (see hasToolDetail below, consumed by
// the template to decide button-vs-plain-span) when there is something to
// reveal beyond its own already-visible label: a non-empty argument, a
// server-provided outputSummary, or extra metadata. This is the "must not
// appear falsely clickable" guard from the owner's brief.
function hasToolDetail(segment: {
	input: Record<string, unknown>;
	outputSummary?: string | null;
	metadata?: Record<string, string | number | boolean | null>;
}): boolean {
	return (
		toolDetailArguments(segment.input).length > 0 ||
		Boolean(segment.outputSummary?.trim()) ||
		Boolean(segment.metadata && Object.keys(segment.metadata).length > 0)
	);
}

// Renders whatever arguments the tool call actually carries — a plain,
// honest key/value dump of segment.input, the same data source
// getToolTitle/formatToolCall already read from, just unabridged. Field
// NAMES are the tool's own parameter identifiers (e.g. "query", "url"), not
// user-facing prose, so — like the existing metadata.errorCode display
// elsewhere in this file — they are shown as-is rather than localized.
function toolDetailArguments(
	input: Record<string, unknown>,
): { key: string; value: string }[] {
	return Object.entries(input ?? {})
		.map(([key, value]) => [key, String(value ?? "").trim()] as const)
		.filter(([, value]) => value.length > 0)
		.map(([key, value]) => ({ key, value: value.slice(0, 500) }));
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
	// Show the anchored span (highlighted) plus enough surrounding text to
	// complete its own sentence, so the reveal no longer begins/ends
	// mid-sentence. `before`/`after` are real, un-highlighted context.
	const reveal = resolveThoughtStepDisplayContext(step.anchor, content);
	if (!reveal) return null;
	return { step, ...reveal };
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

// TS2-c relocation (owner polish pass, item 1) — the opt-in "show full
// reasoning" control now lives flush right on the SAME header row as the
// "Thought for {time}" label, a sibling of the expand/collapse button
// rather than a child of it (two <button>s cannot nest). Turning it ON also
// clears any per-step anchor selection so the full trace is what actually
// renders next (selectedStepReveal would otherwise take template
// precedence over showFullReasoning — see the {#if}/{:else if} chain
// below).
function toggleFullReasoning(): void {
	showFullReasoning = !showFullReasoning;
	if (showFullReasoning) {
		selectedStepId = null;
	}
}
</script>

<script module>
	import { fly, slide } from 'svelte/transition';
	import { preserveScrollOnToggle } from '$lib/actions/preserve-scroll';
	import { reducedMotionAware } from '$lib/utils/motion';

	// Owner polish pass, item 3 — every entrance animation this slice adds
	// (the anchored-span reveal, the full-reasoning block, the "back to
	// steps" transition, and the tool-chip detail reveal) goes through these
	// two wrapped transitions rather than the bare svelte/transition
	// functions, so prefers-reduced-motion is honored everywhere without
	// repeating the check at each call site. See motion.ts: Svelte's `css`
	// transitions interpolate styles directly, which the app-wide CSS
	// reduced-motion override cannot reach, unlike plain :hover transitions.
	const slideTransition = reducedMotionAware(slide);
	const flyTransition = reducedMotionAware(fly);
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

<!--
	Tier 0 (chat-experience-elevation §3) — the search/read source disclosure,
	split into two snippets so the opened result list can render as a full-width
	SIBLING panel BELOW the pill rather than wrapping inside it. This is what
	keeps the header line (tick + favicon summary + caret) a stable single line:
	the pill's width never changes on toggle, so the tick stays vertically
	centered and does not jump when the panel opens/closes.

	`fetchedSourceSummaryButton` is just the collapsed header button: the
	favicon stack + summary text + disclosure caret. `groupKey` keys the
	open-set so each row toggles independently.
-->
{#snippet fetchedSourceSummaryButton(sources: FetchedSource[], summaryClass: string, kind: "search" | "read", groupKey: string)}
	{@const isOpen = openFetchedGroupKeys.has(groupKey)}
	<button
		type="button"
		class={`${summaryClass} fetched-source-summary-btn`}
		aria-expanded={isOpen}
		onclick={() => toggleFetchedGroup(groupKey)}
	>
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
			<span class="fetched-source-summary-text">{fetchedSourceSummary(sources, kind)}</span>
		</span>
		<ChevronDown class={`fetched-source-caret${isOpen ? ' expanded' : ''}`} size={13} strokeWidth={2} aria-hidden="true" />
	</button>
{/snippet}

<!--
	Tier 0 — the opened result list, a full-width sibling panel rendered AFTER
	the pill row (never a child of it). One result per line (favicon left, page
	title right), sliding in with the app's standard height transition. There is
	no "+N" fold — a web turn returns only a handful of sources, so the whole
	list is shown. Each row re-exposes its full excerpt in an un-clipped hover
	popover (Fix D): title + reason, sized to content, wraps freely, never
	truncated; the native `title` attr stays as the non-hover / a11y fallback.
-->
{#snippet fetchedSourceResultsPanel(sources: FetchedSource[], groupKey: string)}
	{#if openFetchedGroupKeys.has(groupKey)}
		<div class="fetched-source-results" transition:slideTransition={{ duration: 200 }}>
			{#each sources as source (source.url)}
				{@const faviconUrl = getFaviconUrl(source.url)}
				{@const cited = isCitedSource(source)}
				{@const reason = source.reason?.trim()}
				<a
					class="fetched-source-result"
					class:is-cited={cited}
					href={source.url}
					target="_blank"
					rel="noopener noreferrer"
					title={source.reason ?? source.title}
				>
					<span class="fetched-source-result-favicon" aria-hidden="true">
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
						{:else}
							<Globe class="fetched-source-result-globe" size={13} strokeWidth={2} aria-hidden="true" />
						{/if}
					</span>
					<span class="fetched-source-result-title">{source.title}</span>
					{#if cited}
						<Check class="fetched-source-result-cited" size={12} strokeWidth={2.2} aria-hidden="true" />
					{/if}
					{#if reason}
						<span class="fetched-source-popover" role="tooltip" aria-hidden="true">
							<span class="fetched-source-popover-title">{source.title}</span>
							<span class="fetched-source-popover-reason">{reason}</span>
						</span>
					{/if}
				</a>
			{/each}
		</div>
	{/if}
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

<!--
	Owner polish pass, item 2 — a relevant, action-specific icon per tool-call
	chip instead of the previous generic status-only glyph. iconType is a
	plain string tag out of getToolCallIconType (tool-calls.ts), rendered here
	via the same if/else-over-a-string-tag idiom this file already uses for
	getDeliberationStatusIconType/getThoughtStepClassIconType above — no
	dynamic-component map, to match this file's established shape for "pick
	one of a few known icons". Connection-tool cases render the exact same
	Lucide glyph SettingsConnectionsTab's CAPABILITY_ICONS already uses per
	capability, so a "Calendar" tool call always reads as the same calendar
	glyph everywhere in the app.
-->
{#snippet toolIdentityIcon(iconType: ToolCallIconType)}
	{#if iconType === 'web-search'}
		<Globe class="tool-identity-icon" data-tool-icon="web-search" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'fetch-url'}
		<Link class="tool-identity-icon" data-tool-icon="fetch-url" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'image-search'}
		<Images class="tool-identity-icon" data-tool-icon="image-search" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'memory'}
		<Brain class="tool-identity-icon" data-tool-icon="memory" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'file-production'}
		<FileText class="tool-identity-icon" data-tool-icon="file-production" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'calendar'}
		<Calendar class="tool-identity-icon" data-tool-icon="calendar" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'contacts'}
		<Users class="tool-identity-icon" data-tool-icon="contacts" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'email'}
		<Mail class="tool-identity-icon" data-tool-icon="email" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'files'}
		<Folder class="tool-identity-icon" data-tool-icon="files" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'location'}
		<MapPin class="tool-identity-icon" data-tool-icon="location" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'media'}
		<Clapperboard class="tool-identity-icon" data-tool-icon="media" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'photos'}
		<ImageIcon class="tool-identity-icon" data-tool-icon="photos" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'repos'}
		<GitBranch class="tool-identity-icon" data-tool-icon="repos" size={13} strokeWidth={2} aria-hidden="true" />
	{:else if iconType === 'tasks'}
		<ListTodo class="tool-identity-icon" data-tool-icon="tasks" size={13} strokeWidth={2} aria-hidden="true" />
	{:else}
		<Wrench class="tool-identity-icon" data-tool-icon="generic" size={13} strokeWidth={2} aria-hidden="true" />
	{/if}
{/snippet}

<!--
	Owner polish pass, item 7 — a generic tool-call chip's click-to-reveal
	detail panel: whatever the segment actually carries (arguments,
	outputSummary, status), never fabricated. Entrance animated via
	flyTransition (fade+slide), the same primitive the anchored-span/
	full-reasoning reveals below use, for one consistent feel.
-->
{#snippet toolDetailPanel(segment: ToolCallSegment)}
	{@const args = toolDetailArguments(segment.input)}
	<div class="tool-detail-panel" in:flyTransition={{ y: 6, duration: 160 }}>
		{#if args.length > 0}
			<div class="tool-detail-section">
				<span class="tool-detail-section-label">{$t('toolCalls.detailArguments')}</span>
				{#each args as arg (arg.key)}
					<div class="tool-detail-row">
						<span class="tool-detail-key">{arg.key}</span>
						<span class="tool-detail-value">{arg.value}</span>
					</div>
				{/each}
			</div>
		{/if}
		{#if segment.outputSummary?.trim()}
			<div class="tool-detail-section">
				<span class="tool-detail-section-label">{$t('toolCalls.detailResult')}</span>
				<p class="tool-detail-value tool-detail-result">{segment.outputSummary}</p>
			</div>
		{/if}
	</div>
{/snippet}

{#snippet singleToolStackRow(tool: ToolCallSegment, rowKey: string, isCurrent: boolean)}
	{@const fetchedSources = getFetchedSources(tool)}
	{#if fetchedSources.length > 0}
		<!-- Tier 0 Fix A — no toolIdentityIcon here; the summary text names the
		     tool. Fix B — the results panel is a full-width sibling AFTER the
		     pill row, so the row stays a stable single line. -->
		<div class="tool-call-row" class:is-running={tool.status === 'running'} class:is-failed={tool.status === 'failed'} class:is-current-step={isCurrent}>
			{@render toolStatusIcon(tool.status, 'header')}
			{@render fetchedSourceSummaryButton(fetchedSources, 'tool-label-text', 'search', rowKey)}
			{#if tool.status === 'failed'}
				{@render toolFailedBadge()}
			{/if}
		</div>
		{@render fetchedSourceResultsPanel(fetchedSources, rowKey)}
	{:else if getFetchUrlSources(tool.name, tool.input).length > 0}
		{@const fetchUrlSources = getFetchUrlSources(tool.name, tool.input)}
		<div class="tool-call-row" class:is-running={tool.status === 'running'} class:is-failed={tool.status === 'failed'} class:is-current-step={isCurrent}>
			{@render toolStatusIcon(tool.status, 'header')}
			{@render fetchedSourceSummaryButton(fetchUrlSources, 'tool-label-text', 'read', rowKey)}
			{#if tool.status === 'failed'}
				{@render toolFailedBadge()}
			{/if}
		</div>
		{@render fetchedSourceResultsPanel(fetchUrlSources, rowKey)}
	{:else}
		<div class="tool-call-row" class:is-running={tool.status === 'running'} class:is-failed={tool.status === 'failed'} class:is-current-step={isCurrent}>
			{@render toolStatusIcon(tool.status, 'header')}
			{@render toolIdentityIcon(getToolCallIconType(tool.name))}
			{#if hasToolDetail(tool)}
				<button
					type="button"
					class="tool-label-text tool-label-text--clickable"
					title={getToolTitle(tool.name, tool.input)}
					aria-expanded={openToolDetailKeys.has(rowKey)}
					onclick={() => toggleToolDetail(rowKey)}
				>{formatToolCall(tool.name, tool.input)}</button>
			{:else}
				<span class="tool-label-text" title={getToolTitle(tool.name, tool.input)}>{formatToolCall(tool.name, tool.input)}</span>
			{/if}
			{#if tool.status === 'failed'}
				{@render toolFailedBadge()}
			{/if}
		</div>
		{#if hasToolDetail(tool) && openToolDetailKeys.has(rowKey)}
			{@render toolDetailPanel(tool)}
		{/if}
	{/if}
{/snippet}

{#snippet connectorGroupStackRow(tools: ToolCallSegment[], isCurrent: boolean)}
	{@const anyRunning = tools.some((t) => t.status === 'running')}
	{@const anyFailed = !anyRunning && tools.some((t) => t.status === 'failed')}
	<div class="tool-call-row" class:is-running={anyRunning} class:is-failed={anyFailed} class:is-current-step={isCurrent}>
		{@render toolStatusIcon(anyRunning ? 'running' : anyFailed ? 'failed' : 'done', 'header')}
		{@render toolIdentityIcon(getToolCallIconType(tools[0].name))}
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

{#snippet singleToolItem(seg: ToolCallSegment, rowKey: string)}
	{@const fetchedSources = getFetchedSources(seg)}
	{#if fetchedSources.length > 0}
		<!-- Tier 0 Fix A/B — no identity icon; results panel is a sibling AFTER
		     the .tool-call-item header line. -->
		<div class="tool-call-item" class:is-failed={seg.status === 'failed'}>
			{@render toolStatusIcon(seg.status, 'inline')}
			{@render fetchedSourceSummaryButton(fetchedSources, 'tool-item-label', 'search', rowKey)}
			{#if seg.status === 'failed'}
				{@render toolFailedBadge()}
			{/if}
		</div>
		{@render fetchedSourceResultsPanel(fetchedSources, rowKey)}
	{:else if getFetchUrlSources(seg.name, seg.input).length > 0}
		{@const fetchUrlSources = getFetchUrlSources(seg.name, seg.input)}
		<div class="tool-call-item" class:is-failed={seg.status === 'failed'}>
			{@render toolStatusIcon(seg.status, 'inline')}
			{@render fetchedSourceSummaryButton(fetchUrlSources, 'tool-item-label', 'read', rowKey)}
			{#if seg.status === 'failed'}
				{@render toolFailedBadge()}
			{/if}
		</div>
		{@render fetchedSourceResultsPanel(fetchUrlSources, rowKey)}
	{:else}
		<div class="tool-call-item" class:is-failed={seg.status === 'failed'}>
			{@render toolStatusIcon(seg.status, 'inline')}
			{@render toolIdentityIcon(getToolCallIconType(seg.name))}
			{#if hasToolDetail(seg)}
				<button
					type="button"
					class="tool-item-label tool-item-label--clickable"
					title={getToolTitle(seg.name, seg.input)}
					aria-expanded={openToolDetailKeys.has(rowKey)}
					onclick={() => toggleToolDetail(rowKey)}
				>{formatToolCall(seg.name, seg.input)}</button>
			{:else}
				<span class="tool-item-label" title={getToolTitle(seg.name, seg.input)}>{formatToolCall(seg.name, seg.input)}</span>
			{/if}
			{#if seg.status === 'failed'}
				{@render toolFailedBadge()}
			{/if}
		</div>
		{#if hasToolDetail(seg) && openToolDetailKeys.has(rowKey)}
			{@render toolDetailPanel(seg)}
		{/if}
	{/if}
{/snippet}

{#snippet connectorGroupItem(tools: ToolCallSegment[])}
	{@const anyRunning = tools.some((t) => t.status === 'running')}
	{@const anyFailed = !anyRunning && tools.some((t) => t.status === 'failed')}
	<div class="tool-call-item" class:is-failed={anyFailed}>
		{@render toolStatusIcon(anyRunning ? 'running' : anyFailed ? 'failed' : 'done', 'inline')}
		{@render toolIdentityIcon(getToolCallIconType(tools[0].name))}
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
	<div class="thinking-header-row">
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
			<!--
				Owner polish pass (visual fixes) — each branch's TEXT sits in its own
				.thinking-label-text span so the live sweep gradient (background-clip:
				text + color: transparent) can never leak onto the leading class icon:
				Lucide strokes with currentColor, so the old label-level transparent
				color rendered the icon invisible and left a blank slot on the left of
				the live headline.
			-->
			<span class="thinking-label" class:is-active={isActiveThinking} aria-live="polite">
				{#if thinkingIsDone && formattedThinkingTime}
					<span class="thinking-label-text">{$t('chat.thoughtFor', { time: formattedThinkingTime })}</span>
				{:else if thinkingIsDone}
					<span class="thinking-label-text">{$t('chat.thought')}</span>
				{:else if deliberationProgressLabel}
					<span class="thinking-label-text">{deliberationProgressLabel}</span>
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
					<span class="thinking-label-text">{liveThoughtStepHeadline}</span>
				{:else}
					<span class="thinking-label-text">{$t(liveSpineLabelKey)}</span>
				{/if}
			</span>
			<ChevronDown class={`chevron${expanded ? ' expanded' : ''}`} size={14} strokeWidth={2} aria-hidden="true" />
		</button>
		<!--
			Owner polish pass, item 1 — the "Show full reasoning" toggle now
			lives flush right on this SAME header row (a flex sibling of the
			expand/collapse button, since two <button>s cannot nest), rather
			than below the clean list. Only meaningful once a durable step rail
			exists and the panel is actually open — matches the pre-existing
			gating anchoredThoughtSteps.length > 0 already used below.
		-->
		{#if expanded && anchoredThoughtSteps.length > 0}
			<!--
				Owner polish pass (visual fixes) — the toggle grows in with a
				horizontal slide (the same wrapped slide primitive as the panel
				below, on the x axis since this is a width change on a header row)
				instead of popping in: the chevron beside it glides left as the
				toggle takes its space rather than jumping.
			-->
			<button
				type="button"
				class="full-reasoning-header-toggle"
				onclick={toggleFullReasoning}
				aria-pressed={showFullReasoning}
				transition:slideTransition={{ axis: 'x', duration: 200 }}
			>
				{$t(showFullReasoning ? 'chat.thoughtStep.hideFullReasoning' : 'chat.thoughtStep.showFullReasoning')}
			</button>
		{/if}
	</div>

	{#if visibleTools.length > 0 || thinkingIsDone}
		<div class="tool-call-stack" class:fade-out={thinkingIsDone}>
			{#each toolStackEntries as entry (entry.key)}
				{#if entry.kind === 'connector-group'}
					{@render connectorGroupStackRow(entry.tools, entry.key === latestToolStackEntryKey)}
				{:else}
					{@render singleToolStackRow(entry.tool, entry.key, entry.key === latestToolStackEntryKey)}
				{/if}
			{/each}
		</div>
	{/if}

{#if expanded}
<!--
	Owner polish pass (visual fixes) — expand/collapse is a plain vertical
	slide at the app's standard disclosure duration (CodeBlock's code-body and
	ConversationList's sections both use slide at 200ms). The previous
	horizontal (axis: 'x') slide animated WIDTH, so on close the panel's text
	re-wrapped into a one-word-wide column mid-animation — the "collapses into
	a 1x1 row" flash. A height slide never re-wraps content.
	reducedMotionAware (slideTransition, see <script module> above) collapses
	this to an instant, zero-duration transition under prefers-reduced-motion.
-->
<div class="thinking-content" transition:slideTransition={{ duration: 200 }}>
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
					P1's floor never changes. Owner polish pass, item 3 — each of
					these three branches gets its own flyTransition (fade+slide)
					entrance so the swap between them is never instant/jarring,
					including the "back to steps" direction (the clean-list branch
					re-entering is just as animated as leaving it).
				-->
				{#if selectedStepReveal}
					<div class="step-anchor-reveal" in:flyTransition={{ y: 8, duration: 200 }}>
						<button type="button" class="raw-trace-back" onclick={closeSelectedStepReveal}>
							<ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />
							{$t('chat.thoughtStep.backToSteps')}
						</button>
						<pre class="thinking-text" bind:this={selectedStepRevealEl}>{selectedStepReveal.before}<mark class="thought-step-anchor-highlight">{selectedStepReveal.span}</mark>{selectedStepReveal.after}</pre>
					</div>
				{:else if showFullReasoning}
					<div class="full-reasoning-view" in:flyTransition={{ y: 8, duration: 200 }}>
						<button type="button" class="raw-trace-back" onclick={() => { showFullReasoning = false; }}>
							<ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />
							{$t('chat.thoughtStep.backToSteps')}
						</button>
						<pre class="thinking-text">{formatThinkingTextForDisplay(content)}</pre>
					</div>
				{:else}
					<div class="thought-step-clean-list" in:flyTransition={{ y: 8, duration: 200 }}>
						{#each cleanRailEntries as entry (entry.key)}
							{#if entry.kind === 'status'}
								{@render statusStepEntry(entry.segment)}
							{:else if entry.kind === 'tool'}
								<div class="thought-rail-chip">{@render singleToolItem(entry.segment, entry.key)}</div>
							{:else if entry.kind === 'thought_step'}
								{@render thoughtStepEntry(entry.step)}
							{:else}
								<div class="thought-rail-chip">{@render connectorGroupItem(entry.tools)}</div>
							{/if}
						{/each}
					</div>
				{/if}
			{:else if hasSegments}
				<div class="interleaved-rail">
				{#each interleavedEntries as entry (entry.key)}
				{#if entry.kind === 'text'}
					<pre class="thinking-text">{formatThinkingTextForDisplay(entry.segment.content)}</pre>
				{:else if entry.kind === 'status'}
					{@render statusStepEntry(entry.segment)}
					{:else if entry.kind === 'tool'}
						{@render singleToolItem(entry.segment, entry.key)}
					{:else if entry.kind === 'connector-group'}
						{@render connectorGroupItem(entry.tools)}
					{/if}
				{/each}
				</div>
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
		/* Tier 0 Fix D — the per-result hover popover (position: absolute) must
		   never be clipped. An `overflow: hidden` here would trap it (its
		   containing block, .fetched-source-result, is a descendant), so the
		   block no longer clips: the old reason for it (edge-clipping the
		   full-bleed tool bars) is obsolete now that every child is a
		   content-hugging pill and all text wraps (min-width: 0 + word-break),
		   so nothing overflows horizontally to need clipping. */
		overflow: visible;
	}

	/* Owner polish pass, item 1 — the header's own expand/collapse button and
	   the (conditionally rendered) "Show full reasoning" toggle are now flex
	   siblings on one row, so the toggle can sit flush right without nesting
	   a <button> inside a <button>. */
	.thinking-header-row {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		width: 100%;
		min-width: 0;
	}

	.thinking-header {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-xs) 0;
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		max-width: 100%;
		flex: 1 1 auto;
		min-width: 0;
		transition: color 150ms var(--ease-out);
	}

	/* Owner polish pass (visual fixes) — hover matches the app's other
	   disclosure headers (CodeBlock's .code-toggle:hover): muted -> primary.
	   The old muted -> secondary shift was invisible in the light theme,
	   where --text-muted and --text-secondary are the same color. The live
	   (is-active) sweep label stays untouched on hover. */
	.thinking-header:hover .thinking-label:not(.is-active),
	.thinking-header:focus-visible .thinking-label:not(.is-active) {
		color: var(--text-primary);
	}

	.thinking-header:hover .chevron,
	.thinking-header:focus-visible .chevron {
		color: var(--icon-primary);
	}

	.thinking-header:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
		border-radius: 2px;
	}

	.thinking-label {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: 1 1 auto;
		min-width: 0;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 500;
		color: var(--text-muted);
		transition: color var(--duration-standard) var(--ease-out);
	}

	.thinking-label-text {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	@keyframes thinking-sweep {
		0%   { background-position: 250% center; }
		100% { background-position: -250% center; }
	}

	/* Owner polish pass (visual fixes) — the sweep now targets only the inner
	   text span. Applied at the label level, its `color: transparent` also hit
	   the leading class icon (Lucide strokes with currentColor), rendering it
	   invisible and leaving a blank slot on the left of the live headline. */
	.thinking-label.is-active .thinking-label-text {
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

	/* Owner polish pass, item 5 — chevron vertical-centering fix. Lucide's
	   SVG defaults to inline/baseline layout, which sits it low relative to
	   the label text next to it (worse still once the label can wrap to two
	   lines): `display: block` removes the inline-baseline quirk entirely,
	   and `align-self: center` guarantees it centers on the row's cross axis
	   regardless of how tall the label grows. */
	.chevron {
		display: block;
		align-self: center;
		color: var(--icon-muted);
		transition: transform var(--duration-standard) var(--ease-out), color 150ms var(--ease-out);
		flex-shrink: 0;
	}

	.chevron.expanded {
		transform: rotate(180deg);
	}

	/* Tool call stack — accumulates all tool rows, visible without expanding.
	   Owner polish pass (visual fixes) — rows are laid out as a left-aligned
	   column of content-hugging chips (see .tool-call-row below) rather than
	   full-bleed bars. The fade-out's max-height easing front-loads the drop
	   so the visible collapse starts immediately instead of the old
	   999px -> 0 linear ramp, which kept the stack at full height for most of
	   the transition and then snapped shut in the last few frames. */
	.tool-call-stack {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
		padding: var(--space-xs) 0;
		width: 100%;
		min-width: 0;
		transition: opacity var(--duration-emphasis) var(--ease-out),
			max-height 350ms cubic-bezier(0.2, 0.9, 0.25, 1),
			padding 350ms cubic-bezier(0.2, 0.9, 0.25, 1);
		max-height: 999px;
		/* Tier 0 Fix D — no `overflow: hidden` at rest, so a result row's hover
		   popover can extend below the stack without being clipped. The clip is
		   only needed while the stack collapses on completion, so it moves onto
		   .fade-out below (no hover happens during that teardown). */
	}

	.tool-call-stack.fade-out {
		opacity: 0;
		max-height: 0;
		padding: 0;
		overflow: hidden;
		pointer-events: none;
	}

	/* Owner polish pass (visual fixes) — a tool call renders as the SAME chip
	   in the live stack as in the expanded clean list (.thought-rail-chip
	   below shares these exact tokens): content-hugging pill, --border-default
	   hairline, --surface-elevated fill. The old full-bleed bar (negative
	   margins + width: calc(100% + 12px)) stretched edge to edge and had its
	   rounded corners clipped by .thinking-block's overflow: hidden — the
	   "not rounded while running" complaint. */
	.tool-call-row {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		width: fit-content;
		max-width: 100%;
		min-width: 0;
		padding: 3px 10px;
		border-radius: var(--radius-full);
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-muted);
		transition: background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out);
	}

	/* Tier 0 Fix B/C — the pill is a stable single line at its natural
	   fit-content width. The opened result list is a full-width SIBLING panel
	   below it (.fetched-source-results, rendered after this row), so the row
	   never grows, the tick stays vertically centered, and its width never
	   snaps on open/close. (The previous flex-wrap + flex-basis:100% breakout
	   and the align-items:flex-start-on-open override are gone.) */

	/* Owner polish pass, item 3 — hover feedback for the always-visible tool
	   stack row itself (the summary/button children inside it already get
	   their own hover state below). */
	.tool-call-row:hover {
		background: var(--surface-overlay);
	}

	.tool-call-row.is-running {
		color: var(--text-secondary);
	}

	/* E1/E2 — a failed tool call is a terminal outcome distinct from "done":
	   the row keeps the danger color so it reads as an error, not a quiet
	   success, at a glance. */
	.tool-call-row.is-failed {
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 30%, transparent);
	}

	/* Owner polish pass (visual fixes) — live current-step emphasis. Only the
	   single most-recently-arrived tool row (see latestToolStackEntryKey in
	   script — driven purely by real event arrival, no timer) gets the pulse;
	   every other row stays in its plain resting state. A slow, gentle
	   breathing of the chip's own fill between two close accent tints — the
	   old 1.8s background + box-shadow ring pulse read as flashing. The chip
	   keeps its border-radius in this state (radius lives on the base rule
	   above and is never overridden here). */
	@keyframes current-step-pulse {
		0%, 100% {
			background-color: color-mix(in srgb, var(--accent) 4%, var(--surface-elevated));
		}
		50% {
			background-color: color-mix(in srgb, var(--accent) 11%, var(--surface-elevated));
		}
	}

	.tool-call-row.is-current-step {
		border-color: color-mix(in srgb, var(--accent) 30%, transparent);
		animation: current-step-pulse 3.2s ease-in-out infinite;
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

	/* The collapsed summary is now a real <button> (not a native <summary>) so
	   the open reveal can slide and break out to full width. It keeps the label
	   typography passed in via summaryClass (tool-label-text / tool-item-label)
	   and lays out as: [favicon stack + summary text] ......... [caret]. */
	.fetched-source-summary-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
		margin: 0;
		padding: 0;
		border: none;
		background: transparent;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
		border-radius: 4px;
		transition: color 150ms var(--ease-out);
	}

	.fetched-source-summary-btn:hover,
	.fetched-source-summary-btn:focus-visible {
		color: var(--text-primary);
	}

	.fetched-source-summary-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.connector-group summary::marker {
		color: var(--icon-muted);
		font-size: 0.7em;
	}

	.fetched-source-summary {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		flex: 1 1 auto;
		vertical-align: middle;
	}

	.fetched-source-summary-text {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	/* The trailing disclosure caret; rotates when the result list is open. */
	:global(.fetched-source-caret) {
		flex-shrink: 0;
		color: var(--icon-muted);
		transition: transform var(--duration-standard) var(--ease-out);
	}

	:global(.fetched-source-caret.expanded) {
		transform: rotate(180deg);
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

	/* Tier 0 Fix B — the opened result list is a full-width SIBLING panel that
	   sits below the pill (it is a sibling of .tool-call-row / .tool-call-item
	   now, not a wrapped child). It stretches full width wherever it lands: in
	   the tool-call-stack (a flex column, align-items: flex-start) and the
	   interleaved rail its own width: 100% pins it edge to edge; in the
	   clean-list chip the chip switches to a stretch column (see
	   .thought-rail-chip:has(.fetched-source-results) below). One result per
	   row, sliding open on height only — the pill's width never changes. */
	.fetched-source-results {
		width: 100%;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
		margin-top: 6px;
	}

	/* One result: favicon left, page title right, hover wash across the WHOLE
	   line. The title wraps freely (overflow-wrap: anywhere) — no fixed-size
	   box to clip or overflow it. position: relative anchors the Fix D hover
	   excerpt popover below. */
	.fetched-source-result {
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		min-width: 0;
		padding: 5px 8px;
		border-radius: var(--radius-sm);
		text-decoration: none;
		color: var(--text-secondary);
		transition: background-color 150ms var(--ease-out), color 150ms var(--ease-out);
	}

	.fetched-source-result:hover,
	.fetched-source-result:focus-visible {
		background: var(--surface-overlay);
		color: var(--text-primary);
		outline: none;
	}

	.fetched-source-result:focus-visible {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.fetched-source-result-favicon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		flex-shrink: 0;
		/* nudge down so it optically aligns with the first line of the title */
		margin-top: 1px;
	}

	.fetched-source-result-favicon .fetched-favicon {
		width: 16px;
		height: 16px;
	}

	:global(.fetched-source-result-globe) {
		color: var(--icon-muted);
	}

	.fetched-source-result-title {
		flex: 1 1 auto;
		min-width: 0;
		font-size: var(--text-sm);
		line-height: 1.4;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	/* Cited sources (the answer's actual citations) read a touch stronger and
	   carry a small accent check, so the citation signal survives the switch
	   from the old ringed chip to a plain row. */
	.fetched-source-result.is-cited .fetched-source-result-title {
		color: var(--text-primary);
		font-weight: 500;
	}

	:global(.fetched-source-result-cited) {
		flex-shrink: 0;
		margin-top: 2px;
		color: var(--accent);
	}

	/* Tier 0 Fix D — the per-result hover excerpt popover, reinstated and
	   fixed. Anchored to the row (which is position: relative), it opens just
	   below the row and clamps its width, wrapping the full title + excerpt
	   with NO fixed height and NO clipping on any side — the old bug was a
	   hard-limited box that cut the text off. pointer-events: none so it never
	   eats the row's own whole-line hover wash; the native `title` attr stays
	   as the non-hover / a11y fallback. Clip-safety note: .thinking-block and
	   .tool-call-stack were relaxed above, but the real scroll ancestor is
	   .scroll-container in MessageArea.svelte (overflow-x: hidden;
	   overflow-y: auto), which was NOT relaxed. This popover stays inside it
	   only because it is left-anchored (left: 0) and width-capped at
	   min(360px, 90vw) — a future right-anchored or wider popover would need
	   care to avoid being clipped by .scroll-container. */
	.fetched-source-popover {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 60;
		display: flex;
		flex-direction: column;
		gap: 3px;
		width: max-content;
		max-width: min(360px, 90vw);
		padding: 8px 10px;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-md, 0 8px 24px -8px rgba(0, 0, 0, 0.35));
		white-space: normal;
		overflow-wrap: anywhere;
		word-break: break-word;
		pointer-events: none;
		opacity: 0;
		visibility: hidden;
		transition: opacity 120ms var(--ease-out);
	}

	.fetched-source-result:hover .fetched-source-popover,
	.fetched-source-result:focus-within .fetched-source-popover,
	.fetched-source-result:focus-visible .fetched-source-popover {
		opacity: 1;
		visibility: visible;
	}

	.fetched-source-popover-title {
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 600;
		line-height: 1.35;
		color: var(--text-primary);
	}

	.fetched-source-popover-reason {
		font-family: var(--font-sans);
		font-size: var(--text-xs, 0.75rem);
		line-height: 1.45;
		color: var(--text-secondary);
	}

	.connector-group {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
	}

	.connector-group summary {
		cursor: pointer;
		list-style-position: inside;
		border-radius: 2px;
		transition: color 150ms var(--ease-out);
	}

	.connector-group summary:hover,
	.connector-group summary:focus-visible {
		color: var(--text-primary);
	}

	.connector-group summary:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
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

	.thinking-text {
		margin: 0;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		line-height: 1.5;
		color: var(--text-muted);
		white-space: pre-wrap;
		word-break: break-word;
	}

	/* Owner polish pass, item 4 — the raw/live interleaved trace (used while
	   streaming, or as the pre-existing fallback when no durable step rail
	   exists yet) gets the same "each action reads as a distinct unit"
	   treatment as the clean list: a hairline divider between consecutive
	   direct children. */
	.interleaved-rail {
		display: flex;
		flex-direction: column;
		width: 100%;
		min-width: 0;
	}

	.interleaved-rail > :global(*:not(:last-child)) {
		border-bottom: 1px solid var(--border-subtle);
		padding-bottom: 6px;
		margin-bottom: 4px;
	}

	/* A tool row immediately followed by its OWN opened reveal (the click-opened
	   detail panel, item 7, OR the Tier 0 sibling source-results panel) is still
	   one entry, not two — suppress the divider between them so the reveal reads
	   as part of the same unit, not a separate action. */
	.interleaved-rail > :global(.tool-call-item:has(+ .tool-detail-panel)),
	.interleaved-rail > :global(.tool-call-item:has(+ .fetched-source-results)) {
		border-bottom: none;
		padding-bottom: 0;
		margin-bottom: 0;
	}

	/* Inline tool call rows between thinking text segments. Tier 0 Fix B — a
	   stable single-line pill at fit-content width; its opened source list is a
	   full-width sibling panel below it, never a wrapped child, so this row
	   keeps align-items: center and never grows on toggle. */
	.tool-call-item {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-muted);
		margin: var(--space-xs) 0;
		width: 100%;
		max-width: 100%;
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
		/* The label's color/underline lifts on hover in step with the row's own
		   background wash (.thought-step-row transitions background-color at the
		   same 150ms) — previously the text snapped instantly while the box
		   animated, which read as rushed. */
		transition: color 150ms var(--ease-out),
			text-decoration-color 150ms var(--ease-out);
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

	/* Owner polish pass, item 2 — the tool-call chip's action-specific icon
	   (toolIdentityIcon), same sizing rhythm as the other small leading
	   icons in this file (.deliberation-status-icon/.thought-step-class-icon
	   above/below). */
	:global(.tool-identity-icon) {
		color: currentColor;
		width: 13px;
		height: 13px;
		flex-shrink: 0;
		opacity: 0.85;
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
	   row is the jump-anchor into the raw Thinking Trace. Owner polish pass,
	   item 3 — a subtle background wash on hover/focus, matching every other
	   interactive row in this file, plus a `background-color` transition so
	   it settles rather than snapping. */
	.thought-step-row {
		display: flex;
		/* flex-start, not center: when the headline wraps to a second line the
		   leading icon and trailing duration pin to the FIRST line and the text
		   reads as a natural left-aligned block, instead of the whole label
		   floating to the vertical middle of the row. */
		align-items: flex-start;
		gap: var(--space-xs);
		width: 100%;
		min-width: 0;
		margin: 0;
		padding: 5px 6px;
		border-radius: var(--radius-sm);
		background: transparent;
		border: none;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-muted);
		text-align: left;
		cursor: pointer;
		transition: background-color 150ms var(--ease-out);
	}

	/* Optically center the small leading icon / trailing duration on the first
	   line of the headline now that the row aligns to flex-start. */
	.thought-step-row > :global(.thought-step-class-icon) {
		margin-top: 3px;
	}

	.thought-step-row .thought-step-duration {
		margin-top: 1px;
	}

	.thought-step-row:hover,
	.thought-step-row:focus-visible {
		background: var(--surface-elevated);
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
		border-radius: var(--radius-sm);
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
	   reasoning prose. Same layout rhythm as .raw-trace-view below it. Owner
	   polish pass, item 4 — a hairline divider between consecutive text-style
	   rows (thought-step-row/status-step) gives each action a clean, distinct
	   unit instead of a loose stack; chips already read as distinct units via
	   their own pill border, so they're left alone. */
	.thought-step-clean-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		min-width: 0;
	}

	.thought-step-clean-list > .thought-step-row:not(:last-child),
	.thought-step-clean-list > .status-step:not(:last-child) {
		border-bottom: 1px solid var(--border-subtle);
		padding-bottom: 7px;
		margin-bottom: 2px;
	}

	/* TS2-c — wraps a tool/connector-group row inside the clean list so it
	   reads as a distinct inline chip rather than prose-adjacent text; the
	   nested .tool-call-item keeps every bit of its existing behavior
	   (favicons, connector grouping, agenda/photo peeks, failed badges) —
	   only its outer shape changes here. Owner polish pass, item 3 — a hover
	   wash so the chip reads as clickable when it wraps a clickable tool row. */
	.thought-rail-chip {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		max-width: 100%;
		margin: 2px 0;
		padding: 3px 10px;
		border-radius: var(--radius-full);
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
		transition: background-color var(--duration-standard) var(--ease-out), border-color var(--duration-standard) var(--ease-out);
	}

	/* An expanded inner disclosure (a click-opened .tool-detail-panel, or the
	   open source-result list) relaxes the pill into the card radius and stacks
	   its reveal BELOW the header row: the chip goes full width and column, so
	   the result list can span edge to edge instead of bulging out sideways as
	   a lozenge beside the label. */
	.thought-rail-chip:has(.tool-detail-panel),
	.thought-rail-chip:has(.fetched-source-results) {
		border-radius: var(--radius-md);
		width: 100%;
		flex-direction: column;
		align-items: stretch;
	}

	/* A connector group still uses a native <details>; open, it only relaxes
	   the pill radius (its action list lays out inside the summary, so it
	   doesn't need the full-width column breakout above). */
	.thought-rail-chip:has(details[open]) {
		border-radius: var(--radius-md);
	}

	.thought-rail-chip:has(.tool-label-text--clickable:hover),
	.thought-rail-chip:has(.tool-item-label--clickable:hover) {
		border-color: var(--accent);
	}

	/* The inner row keeps every behavior; only its outer sizing changes so the
	   chip hugs its content instead of stretching into a full-width lozenge. */
	.thought-rail-chip .tool-call-item {
		margin: 0;
		width: auto;
	}

	/* Owner polish pass, item 1 — the "Show full reasoning" toggle, relocated
	   flush right onto the header row. A small pill button (matching
	   .raw-trace-back's shape) so it reads as a deliberate, secondary control
	   next to the chevron, not a stray text link. Its own label already
	   switches between "Show"/"Hide" in script (see toggleFullReasoning). */
	.full-reasoning-header-toggle {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		padding: 3px 10px;
		border-radius: var(--radius-full);
		border: 1px solid var(--border-default);
		background: transparent;
		font-family: var(--font-sans);
		font-size: var(--text-xs, 0.75rem);
		color: var(--text-muted);
		/* Keeps the label on one line while the entrance slide (axis: 'x')
		   animates the button's width — mid-animation re-wrap would flash. */
		white-space: nowrap;
		cursor: pointer;
		transition: background-color var(--duration-standard) var(--ease-out), color var(--duration-standard) var(--ease-out), border-color var(--duration-standard) var(--ease-out);
	}

	.full-reasoning-header-toggle:hover {
		color: var(--text-primary);
		border-color: var(--accent);
		background: var(--surface-elevated);
	}

	.full-reasoning-header-toggle:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
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

	/* Owner polish pass, item 4 — the raw trace reads as its own distinct,
	   framed unit (border + background) rather than blending into the rest
	   of the panel. */
	.step-anchor-reveal .thinking-text,
	.full-reasoning-view .thinking-text {
		padding: var(--space-sm);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
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
		transition: background-color 150ms var(--ease-out), border-color 150ms var(--ease-out);
	}

	.raw-trace-back:hover {
		color: var(--text-primary);
		border-color: var(--accent);
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

	/* Owner polish pass, item 7 — a generic tool-call chip's label becomes an
	   actual <button> only when it has extra detail to reveal (see
	   hasToolDetail in script); styled to look identical to the plain <span>
	   it replaces at rest, so only the hover/focus affordance below signals
	   it's now clickable. */
	.tool-label-text--clickable,
	.tool-item-label--clickable {
		background: transparent;
		border: none;
		padding: 0;
		margin: 0;
		font: inherit;
		text-align: left;
		color: inherit;
		cursor: pointer;
		border-radius: 2px;
		transition: color 150ms var(--ease-out);
	}

	.tool-label-text--clickable:hover,
	.tool-label-text--clickable:focus-visible,
	.tool-item-label--clickable:hover,
	.tool-item-label--clickable:focus-visible {
		color: var(--text-primary);
		text-decoration: underline;
		text-decoration-style: dotted;
		text-underline-offset: 2px;
	}

	.tool-label-text--clickable:focus-visible,
	.tool-item-label--clickable:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* Owner polish pass, item 7 — the tool-call detail panel: arguments,
	   result, and status, whatever the segment actually carries. */
	.tool-detail-panel {
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: 100%;
		min-width: 0;
		margin: 4px 0 6px;
		padding: var(--space-sm);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
	}

	/* Nested inside a chip card the panel sits on the chip's own elevated
	   fill, so it steps up to the overlay surface to stay readable as an
	   inset section. */
	.thought-rail-chip .tool-detail-panel {
		margin: 2px 0 4px;
		background: var(--surface-overlay);
	}

	.tool-detail-section {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.tool-detail-section-label {
		font-family: var(--font-sans);
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--text-muted);
	}

	.tool-detail-row {
		display: flex;
		gap: 6px;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-xs, 0.75rem);
	}

	.tool-detail-key {
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	.tool-detail-key::after {
		content: ":";
	}

	/* One size for every value under a sub-heading: the Arguments rows already
	   inherit --text-xs from .tool-detail-row, so pinning the same size here
	   keeps the Result prose visually uniform with them (the mono/sans font
	   split is deliberate — structured args vs. a prose summary). */
	.tool-detail-value {
		flex: 1 1 auto;
		min-width: 0;
		overflow-wrap: anywhere;
		font-size: var(--text-xs, 0.75rem);
		color: var(--text-secondary);
		margin: 0;
	}

	.tool-detail-result {
		font-family: var(--font-sans);
	}

@media (prefers-reduced-motion: reduce) {
	.thinking-label.is-active .thinking-label-text {
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

	.word-new {
		animation: none;
		opacity: 1;
	}

	/* Live current-step emphasis falls back to a static highlight, no pulse,
	   under prefers-reduced-motion — same tint the pulse breathes around. */
	.tool-call-row.is-current-step {
		animation: none;
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-elevated));
	}
}
</style>
