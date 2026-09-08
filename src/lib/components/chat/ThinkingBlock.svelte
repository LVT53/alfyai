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
	Check,
	ChevronDown,
	ChevronLeft,
	Globe,
	HelpCircle,
	History,
	ListChecks,
	PenLine,
	Scale,
	Workflow,
} from "@lucide/svelte";
import {
	deriveReasoningSpineState,
	type ReasoningSpineLiveState,
} from "$lib/utils/reasoning-spine";
import { prefersReducedMotion } from "$lib/utils/motion";
import {
	resolveThoughtStepAnchorSpan,
	resolveThoughtStepDisplayContext,
} from "$lib/utils/thought-step-anchor";
import {
	isConnectionToolName,
	isVisibleThinkingSegment,
	isVisibleThinkingToolCall,
} from "$lib/utils/tool-calls";
import {
	getAgendaCandidates,
	getPhotoCandidates,
	immichThumbnailUrl,
	isCalendarToolName,
	isPhotosToolName,
	type ToolCallSegment,
} from "$lib/utils/tool-evidence-presentation";
import {
	buildConnectorActivityItem,
	buildFileProductionActivityItem,
	buildToolActivityItem,
	buildToolActivitySummary,
	type ToolActivityItem,
} from "$lib/utils/tool-activity";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import ToolActivityIcon from "./ToolActivityIcon.svelte";
import ToolActivityList from "./ToolActivityList.svelte";
import ToolActivityRow from "./ToolActivityRow.svelte";
import { thoughtStepIconTypeForClass } from "$lib/utils/activity-presentation";

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
	// "Answer now" — fires when the user clicks the header's quick-answer
	// button (see the `.answer-now-button` in the template below). Undefined
	// hides the button entirely regardless of the live spine state, matching
	// this file's existing optional-callback convention (see toolStatusIcon
	// callers etc.) — MessageBubble always supplies it when it has an
	// onRegenerate handler of its own to forward to.
	onAnswerNow = undefined,
	// Unified tool activity rows — file-production jobs are now rendered as
	// activity rows in this same list instead of as separate cards under the
	// message body, so MessageBubble threads them (and their actions) through
	// here. A produced file is a DELIVERABLE: its row never folds into the
	// collapsed summary strip, it stays pinned with its body open.
	fileProductionJobs = [],
	onOpenDocument = undefined,
	onRetryFileProductionJob = undefined,
	onCancelFileProductionJob = undefined,
	onDismissFileProductionJob = undefined,
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
	onAnswerNow?: () => void;
	fileProductionJobs?: FileProductionJob[];
	onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onRetryFileProductionJob?: ((jobId: string) => void) | undefined;
	onCancelFileProductionJob?: ((jobId: string) => void) | undefined;
	onDismissFileProductionJob?: ((jobId: string) => void) | undefined;
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

const hasSegments = $derived(visibleSegmentsRaw.length > 0);
const visibleTools = $derived(segments.filter(isVisibleThinkingToolCall));
// The reasoning surface proper — what the "Thinking…"/"Thought for N s"
// header describes. A file-production job alone is NOT reasoning, so it never
// conjures a thinking header (see hasVisibleSurface below): it renders as a
// bare pinned activity row.
const hasThinkingSurface = $derived(
	content.trim().length > 0 || hasSegments || visibleTools.length > 0,
);
const hasVisibleSurface = $derived(
	hasThinkingSurface || fileProductionJobs.length > 0,
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

// Unified tool activity rows — the ONE list every tool call renders through,
// in arrival order. Built from the exact same toolStackEntries the pill stack
// was built from, so grouping/order behavior is unchanged; only the row shape
// (and the per-tool grammar, which now lives in the pure `tool-activity.ts`)
// is new.
const activityItems: ToolActivityItem[] = $derived(
	toolStackEntries.map((entry) =>
		entry.kind === "connector-group"
			? buildConnectorActivityItem(entry.tools, entry.key, $t)
			: buildToolActivityItem(entry.tool, entry.key, $t),
	),
);

// File-production jobs never ride in `segments` (isVisibleThinkingToolCall
// filters produce_file out), so they get their own list, rendered below the
// block and always visible: a produced file is a deliverable, not a step.
const fileActivityItems: ToolActivityItem[] = $derived(
	fileProductionJobs.map((job) => buildFileProductionActivityItem(job, $t)),
);

const fileJobsByActivityKey = $derived(
	Object.fromEntries(
		fileProductionJobs.map((job) => [`file-job-${job.id}`, job]),
	),
);

// Deliverables (a route with a real map card) keep a row of their own with
// the body open once the block collapses; everything else folds into the
// muted summary strip.
const pinnedActivityItems = $derived(activityItems.filter((it) => it.pinned));
const activitySummary = $derived(
	buildToolActivitySummary(
		activityItems.filter((it) => !it.pinned),
		$t,
	),
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
	visibleSegmentsRaw.forEach((seg, i) => {
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

// Connector agenda/photo peeks stay attached to their group's row — keyed by
// the same activity key so the list can render each one directly under the
// row it belongs to.
const connectorPeeks = $derived.by(() => {
	const peeks: Record<
		string,
		{ agenda: ToolEvidenceCandidate[]; photos: ToolEvidenceCandidate[] }
	> = {};
	for (const entry of toolStackEntries) {
		if (entry.kind !== "connector-group") continue;
		peeks[entry.key] = {
			agenda: isCalendarToolName(entry.name)
				? getAgendaCandidates(entry.tools)
				: [],
			photos: isPhotosToolName(entry.name)
				? getPhotoCandidates(entry.tools)
				: [],
		};
	}
	return peeks;
});

$effect(() => {
	const totalLength = hasSegments
		? visibleSegmentsRaw.reduce(
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

// "Answer now" — visible only while reasoning is still streaming and the
// visible answer has not started yet (the mockup's "reasoning-spine state",
// i.e. `reasoning_active` or its stalled variant, never `writing_answer`):
// once real answer text starts arriving, `answerStarted` flips `true`,
// `reasoningSpineState` becomes `writing_answer`, and this goes false on its
// own — no separate "hide after first text" branch needed. Also requires a
// handler (`onAnswerNow`) and never renders once the turn is done, matching
// `isActiveThinking`'s existing "still streaming" gate used throughout this
// file.
const showAnswerNow = $derived(
	isActiveThinking &&
		Boolean(onAnswerNow) &&
		reasoningSpineState !== "writing_answer",
);

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

// TS2-c — the closed activity-class enum's secondary signal: a small leading
// icon per class. The mapping (thoughtStepIconTypeForClass) now lives in the
// shared activity-presentation.ts; this file keeps only the icon-TYPE ->
// Lucide switch in the thoughtStepClassIcon snippet below (a plain string tag
// rendered via an if/else chain — no dynamic-component map, to match this
// file's established idiom).

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

// Unified tool activity rows — ONE open-set for every row, wherever it
// renders (the live stack, the expanded rail, a pinned deliverable). A Set
// (not a single id) because multiple rows can each be independently open
// without disturbing their neighbors, and one shared set means a row opened
// in the live stack is still open once the block is expanded.
let openActivityKeys = $state<Set<string>>(new Set());

function toggleActivityRow(key: string): void {
	const next = new Set(openActivityKeys);
	if (next.has(key)) {
		next.delete(key);
	} else {
		next.add(key);
	}
	openActivityKeys = next;
}

// Deliverables (a route, a produced file) open themselves ONCE, the first
// time they appear — that is the point of pinning them. Recorded in a plain
// (non-reactive) set so re-opening is a one-time default, never a re-open
// that fights the user closing the row.
const autoOpenedActivityKeys = new Set<string>();
$effect(() => {
	const defaults = [...pinnedActivityItems, ...fileActivityItems].map(
		(item) => item.key,
	);
	const missing = defaults.filter((key) => !autoOpenedActivityKeys.has(key));
	if (missing.length === 0) return;
	const next = new Set(openActivityKeys);
	for (const key of missing) {
		autoOpenedActivityKeys.add(key);
		next.add(key);
	}
	openActivityKeys = next;
});

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
	const reveal = resolveThoughtStepDisplayContext(step.anchor, content);
	if (!reveal) return null;
	// Owner feedback (2026-09-08) — "it cuts off mid sentences". The
	// HIGHLIGHT is the whole sentence (or sentences) the anchored span sits
	// in, not the raw span: `before + span + after` is marked as one unit, so
	// even an old, pre-snap persisted anchor that starts or ends mid-word
	// reads as a complete thought. `leadIn`/`tailOut` are one further
	// sentence of real, un-highlighted context on each side (never crossing a
	// paragraph break) so the reader sees where the thought sits.
	return {
		step,
		leadIn: reveal.leadIn,
		highlight: `${reveal.before}${reveal.span}${reveal.after}`,
		tailOut: reveal.tailOut,
	};
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
// context status rows, and classified thought steps at the
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

<!--
	TS2-c (ADR-0056 amendment) — the closed activity class's secondary
	signal: a small leading icon, never the headline. An if/else-over-a-
	string-tag shape, deliberately not a dynamic-component map, to match this
	file's established idiom for "pick one of a few known icons".
-->
{#snippet thoughtStepClassIcon(activityClass: ThoughtStepClassifierActivityClass)}
	{@const iconType = thoughtStepIconTypeForClass(activityClass)}
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
	Extracted (TS2-c) so the same event-derived status row (context
	preparation status) renders identically whether it appears in the
	pre-existing no-thoughtSteps fallback view below, or in the new clean
	step list — one markup source, not a fork that could drift.
-->
{#snippet statusStepEntry(statusSeg: StatusSegment)}
	<div
		class="status-step"
		class:is-running={statusSeg.status === 'running'}
	>
		{#if statusSeg.status === 'running'}
			<span class="tool-dot-inline"></span>
		{:else}
			<Check class="check-icon" size={12} strokeWidth={1.5} aria-hidden="true" />
		{/if}
		<span class="status-step-label">{statusSeg.label}</span>
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

<!--
	The connector agenda peek / photo strip belongs to its group's row, so it
	renders directly beneath it via ToolActivityList's `afterItem` snippet
	rather than as a stray block at the end of the list.
-->
{#snippet connectorPeek(item: ToolActivityItem)}
	{@const peek = connectorPeeks[item.key]}
	{#if peek && peek.agenda.length > 0}
		{@render agendaPeek(peek.agenda)}
	{:else if peek && peek.photos.length > 0}
		{@render photoStrip(peek.photos)}
	{/if}
{/snippet}

{#if hasVisibleSurface}
<div class="thinking-block" bind:this={container}>
	{#if hasThinkingSurface}
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
				step per 5-7s).
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
			"Answer now" — flush right on this SAME header row, a flex sibling of
			the expand/collapse button (two <button>s cannot nest), exactly like
			the "Show full reasoning" toggle below. Plain text, no border/background
			(per the approved mockup) — deliberately NOT styled like that pill
			toggle, so it reads as a lightweight escape hatch rather than a second
			disclosure control. No notice/hint text anywhere around it.
		-->
		{#if showAnswerNow}
			<button
				type="button"
				class="answer-now-button"
				onclick={() => onAnswerNow?.()}
			>
				{$t('chat.answerNow')}
			</button>
		{/if}
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
	{/if}

	<!--
		The unified activity list. While the turn is live it is the full list in
		arrival order. Once the turn is done AND the block is collapsed it folds
		into one muted summary strip (clicking it expands the block — the same
		action as the header), with deliverables staying behind as pinned rows
		whose body is open. Expanded, the rows live inside the panel below,
		interleaved with the reasoning rail, so nothing is shown twice.
	-->
	{#if activityItems.length > 0 && !thinkingIsDone}
		<ToolActivityList
			items={activityItems}
			openKeys={openActivityKeys}
			onToggle={toggleActivityRow}
			afterItem={connectorPeek}
			testId="tool-activity-stack"
		/>
	{:else if activityItems.length > 0 && !expanded}
		{#if activitySummary.length > 0}
			<button
				type="button"
				class="activity-summary-strip"
				data-testid="tool-activity-summary"
				onclick={toggle}
				aria-expanded={expanded}
				aria-label={$t('toolActivity.expandActivity')}
			>
				{#each activitySummary as entry, index (entry.key)}
					{#if index > 0}
						<span class="summary-dot" aria-hidden="true">·</span>
					{/if}
					<span class="summary-item">
						<ToolActivityIcon iconType={entry.iconType} size={13} />
						{entry.label}
					</span>
				{/each}
				<ChevronDown class="act-chevron summary-chevron" size={14} strokeWidth={2} aria-hidden="true" />
			</button>
		{/if}
		{#if pinnedActivityItems.length > 0}
			<ToolActivityList
				items={pinnedActivityItems}
				openKeys={openActivityKeys}
				onToggle={toggleActivityRow}
				testId="tool-activity-pinned"
			/>
		{/if}
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
						<pre class="thinking-text" bind:this={selectedStepRevealEl}>{selectedStepReveal.leadIn}<mark class="thought-step-anchor-highlight">{selectedStepReveal.highlight}</mark>{selectedStepReveal.tailOut}</pre>
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
								<ToolActivityRow
									item={buildToolActivityItem(entry.segment, entry.key, $t)}
									open={openActivityKeys.has(entry.key)}
									onToggle={toggleActivityRow}
								/>
							{:else if entry.kind === 'thought_step'}
								{@render thoughtStepEntry(entry.step)}
							{:else}
								<ToolActivityRow
									item={buildConnectorActivityItem(entry.tools, entry.key, $t)}
									open={openActivityKeys.has(entry.key)}
									onToggle={toggleActivityRow}
								/>
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
						<ToolActivityRow
							item={buildToolActivityItem(entry.segment, entry.key, $t)}
							open={openActivityKeys.has(entry.key)}
							onToggle={toggleActivityRow}
						/>
					{:else if entry.kind === 'connector-group'}
						<ToolActivityRow
							item={buildConnectorActivityItem(entry.tools, entry.key, $t)}
							open={openActivityKeys.has(entry.key)}
							onToggle={toggleActivityRow}
						/>
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

	<!--
		Produced files are deliverables, not steps: they never fold into the
		summary strip and never hide inside the collapsed block. They render as
		pinned activity rows here — one component, one shape, replacing the old
		standalone FileProductionCard list under the message body.
	-->
	{#if fileActivityItems.length > 0}
		<ToolActivityList
			items={fileActivityItems}
			openKeys={openActivityKeys}
			onToggle={toggleActivityRow}
			jobsByKey={fileJobsByActivityKey}
			{onOpenDocument}
			onRetryJob={onRetryFileProductionJob}
			onCancelJob={onCancelFileProductionJob}
			onDismissJob={onDismissFileProductionJob}
			testId="tool-activity-files"
		/>
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

	/* Done + collapsed: the whole activity list folds into one muted line
	   under "Thought for N s" — icon + short label per tool, separated by
	   middle dots. Clicking it expands the thinking block (the same action as
	   the header). Deliverables never fold in; they stay as pinned rows. */
	.activity-summary-strip {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px 10px;
		width: 100%;
		min-width: 0;
		padding: 2px 0;
		border: none;
		background: transparent;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		color: var(--text-muted);
		text-align: left;
		cursor: pointer;
		transition: color var(--duration-standard) var(--ease-out);
	}

	.activity-summary-strip:hover,
	.activity-summary-strip:focus-visible {
		color: var(--text-primary);
	}

	.activity-summary-strip:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
		border-radius: 4px;
	}

	.summary-item {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
	}

	.summary-dot {
		color: color-mix(in srgb, var(--text-muted) 55%, transparent);
	}

	.activity-summary-strip :global(.summary-chevron) {
		margin-left: 2px;
	}

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


	/* The running dot of a context-preparation status step (the one row in
	   this file that is NOT a tool activity row). */
	.tool-dot-inline {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		flex-shrink: 0;
		opacity: 0.6;
		animation: tool-pulse 1.5s ease-in-out infinite;
	}

	@keyframes tool-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.35; }
	}

	.check-icon {
		color: var(--success);
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
	   headline itself. */
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

	/* "Answer now" — a plain text button flush right on the header row, per
	   the approved mockup: no border, no background, text-sm/500, muted ->
	   accent on hover. Deliberately NOT the pill shape
	   .full-reasoning-header-toggle uses below — this reads as a lightweight
	   inline action, not a secondary disclosure control. */
	.answer-now-button {
		flex-shrink: 0;
		padding: 0;
		border: none;
		background: transparent;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 500;
		color: var(--text-muted);
		white-space: nowrap;
		cursor: pointer;
		transition: color var(--duration-standard) var(--ease-out);
	}

	.answer-now-button:hover,
	.answer-now-button:focus-visible {
		color: var(--accent);
	}

	.answer-now-button:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
		border-radius: 2px;
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

	.tool-dot-inline {
		animation: none;
		opacity: 0.7;
	}

	.word-new {
		animation: none;
		opacity: 1;
	}
}
</style>
