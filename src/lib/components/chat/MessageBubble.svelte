<script lang="ts">
import { isDark } from "$lib/stores/theme";
import { t, type I18nKey } from "$lib/i18n";
import {
	isVisibleThinkingSegment,
	isVisibleThinkingToolCall,
} from "$lib/utils/tool-calls";
import { tokenizeTextLinks } from "$lib/services/linkify";
import { RESPONSE_ACTIVITY_IDS } from "$lib/services/stream-timeline";
import { isTouchDevice } from "$lib/utils/viewport.svelte";
import type {
	ArtifactSummary,
	AtlasAction,
	AtlasJobCard,
	AtlasProfile,
	ChatAttachment,
	ChatMessage,
	DepthAppliedProfile,
	DocumentWorkspaceItem,
	FileProductionJob,
	NormalChatContextPreparationActivityClass,
	ResponseActivityEntry,
	ThinkingSegment,
} from "$lib/types";
import MarkdownRenderer from "./MarkdownRenderer.svelte";
import ThinkingBlock from "./ThinkingBlock.svelte";
import ResponseAuditDetails from "./ResponseAuditDetails.svelte";
import LogoMark from "./LogoMark.svelte";
import FileAttachment from "./FileAttachment.svelte";
import MessageEvidenceDetails from "./MessageEvidenceDetails.svelte";
import FileProductionCard from "./FileProductionCard.svelte";
import AtlasCard from "./AtlasCard.svelte";
import SkillDraftCard from "./SkillDraftCard.svelte";
import { onDestroy, tick } from "svelte";
import {
	Bot,
	Brain,
	Check,
	ClipboardCheck,
	Copy,
	GitBranch,
	Info,
	Languages,
	Layers,
	Pencil,
	RefreshCw,
	Search,
	ShieldAlert,
	X,
} from "@lucide/svelte";
import type { TaskSteeringPayload } from "$lib/types";

let {
	message,
	isLast = false,
	pinnedArtifactIds = [],
	excludedArtifactIds = [],
	fileProductionJobs = [],
	atlasJobs = [],
	conversationId = null,
	modelIcons = {},
	readOnly = false,
	onRegenerate = undefined,
	onEdit = undefined,
	onFork = undefined,
	forkBusy = false,
	onSteer = undefined,
	onOpenDocument = undefined,
	onRetryFileProductionJob = undefined,
	onCancelFileProductionJob = undefined,
	onDismissFileProductionJob = undefined,
	onCancelAtlasJob = undefined,
	onAtlasLifecycleAction = undefined,
	canPublishSkillDrafts = false,
	skillDraftActionState = {},
	onSaveSkillDraft = undefined,
	onDismissSkillDraft = undefined,
	onPublishSkillDraft = undefined,
}: {
	message: ChatMessage;
	isLast?: boolean;
	pinnedArtifactIds?: string[];
	excludedArtifactIds?: string[];
	fileProductionJobs?: FileProductionJob[];
	atlasJobs?: AtlasJobCard[];
	conversationId?: string | null;
	modelIcons?: Record<string, string | null | undefined>;
	readOnly?: boolean;
	onRegenerate?: ((payload: { messageId: string }) => void) | undefined;
	onEdit?:
		| ((payload: { messageId: string; newText: string }) => void)
		| undefined;
	onFork?:
		| ((payload: { messageId: string }) => void | Promise<void>)
		| undefined;
	forkBusy?: boolean;
	onSteer?: ((payload: TaskSteeringPayload) => void) | undefined;
	onOpenDocument?:
		| ((
				document: DocumentWorkspaceItem,
				options?: {
					preservePresentation?: boolean;
					presentation?: "docked" | "expanded";
				},
		  ) => void)
		| undefined;
	onRetryFileProductionJob?: ((jobId: string) => void) | undefined;
	onCancelFileProductionJob?: ((jobId: string) => void) | undefined;
	onDismissFileProductionJob?: ((jobId: string) => void) | undefined;
	onCancelAtlasJob?: ((jobId: string) => void) | undefined;
	onAtlasLifecycleAction?:
		| ((payload: {
				jobId: string;
				action: AtlasAction;
				message: string;
				profile: AtlasProfile;
		  }) => void)
		| undefined;
	canPublishSkillDrafts?: boolean;
	skillDraftActionState?: Record<
		string,
		{ busy?: boolean; error?: string | null }
	>;
	onSaveSkillDraft?:
		| ((payload: {
				messageId: string;
				draftId: string;
		  }) => void | Promise<void>)
		| undefined;
	onDismissSkillDraft?:
		| ((payload: {
				messageId: string;
				draftId: string;
		  }) => void | Promise<void>)
		| undefined;
	onPublishSkillDraft?:
		| ((payload: {
				messageId: string;
				draftId: string;
		  }) => void | Promise<void>)
		| undefined;
} = $props();

let copied = $state(false);
let copyTimeout: ReturnType<typeof setTimeout> | undefined;
let isEditing = $state(false);
let editText = $state("");
let editTextarea: HTMLTextAreaElement | null = $state(null);
let showTimestampTooltip = $state(false);
let showForkDetails = $state(false);
// ADR-0043: the audit-info popover is hover-driven on desktop; on touch
// devices (no hover) a tap on the info button toggles it open.
let infoPopoverTouched = $state(false);
let dedupedFileProductionJobs = $derived(
	fileProductionJobs.reduce(
		(acc, job) => {
			if (!acc.seen.has(job.id)) {
				acc.seen.add(job.id);
				acc.list.push(job);
			}
			return acc;
		},
		{ seen: new Set<string>(), list: [] as FileProductionJob[] },
	).list,
);
let dedupedAtlasJobs = $derived(
	atlasJobs.reduce(
		(acc, job) => {
			if (!acc.seen.has(job.id)) {
				acc.seen.add(job.id);
				acc.list.push(job);
			}
			return acc;
		},
		{ seen: new Set<string>(), list: [] as AtlasJobCard[] },
	).list,
);
let atlasJobCostUsdMicros = $derived(
	dedupedAtlasJobs.length > 0
		? dedupedAtlasJobs.reduce(
				(sum, job) => sum + (job.usage?.costUsdMicros ?? 0),
				0,
			)
		: null,
);
let isUser = $derived(message.role === "user");
let hasAttachments = $derived((message.attachments?.length ?? 0) > 0);
let hasThinking = $derived(Boolean(message.thinking?.trim()));
let isFinalizing = $derived(message.runtimePhase === "finalizing");
const isStreaming = $derived(
	Boolean(message.isStreaming || message.isThinkingStreaming),
);
let markdownIsStreaming = $derived(isStreaming && !isFinalizing);
let liveResponseActivityEntries = $derived(
	!isUser && markdownIsStreaming ? (message.responseActivity ?? []) : [],
);
let thinkingSegmentsForDisplay = $derived(message.thinkingSegments ?? []);
type DeliberationThinkingStatus = Extract<ThinkingSegment, { type: "status" }>;
type DeliberationActivityEntry = Extract<
	ResponseActivityEntry,
	{ kind: "deliberation" }
>;
type DeliberationStatusEntry =
	| DeliberationThinkingStatus
	| DeliberationActivityEntry;
type AttachmentArtifactSummary = ArtifactSummary & { artifactId: string };

function isDeliberationThinkingStatus(
	segment: ThinkingSegment,
): segment is DeliberationThinkingStatus {
	return (
		segment.type === "status" &&
		segment.id.startsWith("deliberation-pass-") &&
		segment.label?.trim().length > 0
	);
}

function isDeliberationActivityEntry(
	entry: ResponseActivityEntry | undefined,
): entry is DeliberationActivityEntry {
	return entry?.kind === "deliberation" && Boolean(entry.label?.trim());
}

function isToolProgressActivity(
	entry: ResponseActivityEntry,
): entry is ResponseActivityEntry & { label: string } {
	return entry.id.startsWith("tool-progress:") && Boolean(entry.label?.trim());
}

let visibleThinkingSegmentsForDisplay = $derived(
	markdownIsStreaming
		? (() => {
				const latestDeliberationStatus = [...thinkingSegmentsForDisplay]
					.reverse()
					.find(isDeliberationThinkingStatus);
				if (!latestDeliberationStatus) {
					return thinkingSegmentsForDisplay;
				}

				return thinkingSegmentsForDisplay.filter(
					(segment) =>
						segment.type !== "status" ||
						!segment.id.startsWith("deliberation-pass-") ||
						segment.id === latestDeliberationStatus.id,
				);
			})()
		: thinkingSegmentsForDisplay,
);
let deliberationThinkingStatus = $derived(
	[...thinkingSegmentsForDisplay].reverse().find(isDeliberationThinkingStatus),
);
let hasVisibleThinkingSegments = $derived(
	thinkingSegmentsForDisplay.some(isVisibleThinkingSegment),
);
let hasToolCalls = $derived(
	thinkingSegmentsForDisplay.some(isVisibleThinkingToolCall),
);
let hasResponseAuditInfo = $derived(
	!isUser &&
		(message.content.trim().length > 0 ||
			hasThinking ||
			Boolean(message.modelDisplayName) ||
			Boolean(message.providerDisplayName) ||
			message.generationDurationMs != null ||
			message.costUsd != null ||
			message.thinkingTokenCount != null ||
			message.responseTokenCount != null ||
			message.totalTokenCount != null ||
			Boolean(message.depthMetadata)),
);
let messageModelIconUrl = $derived(
	message.modelId ? (modelIcons[message.modelId] ?? null) : null,
);
let auditDetailsId = $derived(`message-info-${message.id}`);
let skillDrafts = $derived(message.skillDrafts ?? []);
let sourceForks = $derived(message.sourceForks);
let userMessageSegments = $derived(
	isUser ? tokenizeTextLinks(message.content) : [],
);
// Thinking is definitively done once visible response text has started streaming
// OR the whole message is complete. This keeps the label as "Thinking" between
// multi-burst thinking phases (isThinkingStreaming briefly false, but no content yet).
let isDone = $derived(!message.isStreaming && !message.isThinkingStreaming);
let isGenerating = $derived(
	Boolean(
		(message.isStreaming || message.isThinkingStreaming) && !isFinalizing,
	),
);
let hasVisibleContent = $derived(message.content.trim().length > 0);
let hasAtlasCards = $derived(atlasJobs.length > 0);
let hasFileProductionCards = $derived(
	fileProductionJobs.length > 0 && Boolean(conversationId) && !hasAtlasCards,
);
let showEvidencePending = $derived(
	Boolean(message.evidencePending) && isDone && !hasAtlasCards,
);
let liveDeliberationStatus = $derived(
	markdownIsStreaming
		? ([...liveResponseActivityEntries]
				.reverse()
				.find(isDeliberationActivityEntry) ?? deliberationThinkingStatus)
		: undefined,
);
let liveDeliberationStatusLabel = $derived(
	liveDeliberationStatus?.label?.trim() ?? "",
);
let liveDeliberationStatusDisplayLabel = $derived.by(() => {
	const label = liveDeliberationStatusLabel;
	if (!label) return "";
	const current = deliberationPassIndex(liveDeliberationStatus);
	const total = liveDeliberationStatus?.passTotal;
	if (
		current &&
		typeof total === "number" &&
		Number.isInteger(total) &&
		total > 0
	) {
		return $t("chat.deliberatingProgress", { current, total, label });
	}
	return label;
});
let liveToolProgressActivityEntries = $derived(
	markdownIsStreaming
		? liveResponseActivityEntries.filter(isToolProgressActivity)
		: [],
);
const liveDeliberationStatusIconType = $derived.by(() => {
	if (!liveDeliberationStatus) {
		return "search";
	}
	return deliberationIconType(liveDeliberationStatus.passKind);
});

function deliberationPassIndex(
	status: DeliberationStatusEntry | undefined,
): number | null {
	if (!status) return null;
	if (
		typeof status.passIndex === "number" &&
		Number.isInteger(status.passIndex)
	) {
		return status.passIndex;
	}
	const match = /deliberation-pass-(\d+)/i.exec(status.id);
	const parsed = match ? Number.parseInt(match[1], 10) : NaN;
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function deliberationIconType(
	passKind: string | undefined,
):
	| "search"
	| "clipboard-check"
	| "shield-alert"
	| "languages"
	| "layers"
	| "bot" {
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
	return "search";
}
function isDepthAppliedProfile(value: unknown): value is DepthAppliedProfile {
	return (
		value === "off" ||
		value === "standard" ||
		value === "extended" ||
		value === "maximum"
	);
}

let liveDepthProfile = $derived.by(() => {
	const detail = liveResponseActivityEntries.find(
		(entry) => entry.kind === "depth",
	)?.detail;
	return isDepthAppliedProfile(detail) ? detail : undefined;
});
let resolvedDepthProfile = $derived(
	liveDepthProfile ?? message.depthMetadata?.appliedProfile,
);
let liveEarlyResponseActivityLabelKey = $derived.by((): I18nKey | null => {
	if (liveDeliberationStatusLabel) return null;
	for (const entry of [...liveResponseActivityEntries].reverse()) {
		const labelKey = getKnownEarlyResponseActivityLabelKey(entry);
		if (labelKey) return labelKey;
	}
	return null;
});
let preparingStatusLabel = $derived(
	liveEarlyResponseActivityLabelKey
		? $t(liveEarlyResponseActivityLabelKey)
		: $t("chat.preparingResponse"),
);
let showPreparingStatus = $derived(
	!isUser &&
		isGenerating &&
		!hasVisibleContent &&
		!hasThinking &&
		!hasVisibleThinkingSegments &&
		!liveDeliberationStatusLabel &&
		liveToolProgressActivityEntries.length === 0 &&
		skillDrafts.length === 0 &&
		!hasFileProductionCards &&
		!hasAtlasCards,
);
let showFinalizingStatus = $derived(
	!isUser && isFinalizing && !hasFileProductionCards && !hasAtlasCards,
);
let hasServerPersistedIdentity = $derived(
	message.renderKey === undefined || message.renderKey !== message.id,
);
let canFork = $derived(
	!isUser &&
		!readOnly &&
		Boolean(onFork) &&
		Boolean(message.id) &&
		hasServerPersistedIdentity &&
		!message.wasStopped &&
		!message.isStreaming &&
		!message.isThinkingStreaming &&
		message.content.trim().length > 0,
);
let showLogoBelow = $derived(
	!isUser && isLast && (hasThinking || isGenerating || isFinalizing),
);
let thinkingIsDone = $derived(
	!message.isThinkingStreaming &&
		(message.content.trim().length > 0 || isDone || isFinalizing),
);
let reasoningDepthIndicatorProfile = $derived(
	getVisibleReasoningDepthProfile(
		liveDepthProfile ?? message.depthMetadata?.appliedProfile,
	),
);
let reasoningDepthIndicatorLabel = $derived(
	reasoningDepthIndicatorProfile === "maximum"
		? $t("messageBubble.maxReasoningDepth")
		: reasoningDepthIndicatorProfile === "extended"
			? $t("messageBubble.extendedReasoningDepth")
			: "",
);

function getClipboardText(content: string) {
	return content
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		.replace(/<\/?thinking>/gi, "")
		.trim();
}

function getKnownEarlyResponseActivityLabelKey(
	entry: ResponseActivityEntry,
): I18nKey | null {
	if (
		entry.id === RESPONSE_ACTIVITY_IDS.CONTEXT_PREPARING &&
		entry.kind === "context" &&
		entry.status === "running"
	) {
		return getContextPreparationActivityLabelKey(entry);
	}
	if (
		entry.id === RESPONSE_ACTIVITY_IDS.DRAFTING_ANSWER &&
		entry.kind === "drafting" &&
		entry.status === "running"
	) {
		return "chat.responseActivity.drafting";
	}
	return null;
}

const CONTEXT_PREPARATION_ACTIVITY_LABEL_KEYS = {
	planning: "chat.responseActivity.contextPreparation.planning",
	"context-retrieval": "chat.responseActivity.contextPreparation.retrieval",
	"attachment-processing":
		"chat.responseActivity.contextPreparation.attachments",
	"prompt-assembly": "chat.responseActivity.contextPreparation.assembly",
	"context-compression": "chat.responseActivity.contextPreparation.compression",
	"web-grounding": "chat.responseActivity.contextPreparation.web",
	budgeting: "chat.responseActivity.contextPreparation.budgeting",
} as const satisfies Record<NormalChatContextPreparationActivityClass, I18nKey>;

function getContextPreparationActivityLabelKey(
	entry: ResponseActivityEntry,
): I18nKey {
	const activityClass = entry.contextPreparationClass;
	if (!activityClass) return "chat.responseActivity.contextPreparing";
	return (
		(
			CONTEXT_PREPARATION_ACTIVITY_LABEL_KEYS as Readonly<
				Record<string, I18nKey | undefined>
			>
		)[activityClass] ?? "chat.responseActivity.contextPreparing"
	);
}

async function copyToClipboard() {
	try {
		await navigator.clipboard.writeText(getClipboardText(message.content));
		copied = true;
		clearTimeout(copyTimeout);
		copyTimeout = setTimeout(() => {
			copied = false;
		}, 2000);
	} catch (err) {
		console.error("Failed to copy text: ", err);
	}
}

async function startEdit() {
	editText = message.content;
	isEditing = true;
	await tick();
	editTextarea?.focus();
}

function cancelEdit() {
	isEditing = false;
	editText = "";
}

function submitEdit() {
	const trimmed = editText.trim();
	if (!trimmed || trimmed === message.content) {
		cancelEdit();
		return;
	}
	onEdit?.({ messageId: message.id, newText: trimmed });
	isEditing = false;
	editText = "";
}

function formatTimestamp(ts: number): string {
	const date = new Date(ts);
	const now = new Date();
	const isToday = date.toDateString() === now.toDateString();

	if (isToday) {
		const h = String(date.getHours()).padStart(2, "0");
		const m = String(date.getMinutes()).padStart(2, "0");
		return `${h}:${m}`;
	}
	const day = date.getDate();
	const month = date.toLocaleString("en-GB", { month: "short" });
	return `${day} ${month}`;
}

function formatFullTimestamp(ts: number): string {
	const date = new Date(ts);
	const day = date.getDate();
	const month = date.toLocaleString("en-GB", { month: "long" });
	const year = date.getFullYear();
	const h = String(date.getHours()).padStart(2, "0");
	const m = String(date.getMinutes()).padStart(2, "0");
	return `${day} ${month} ${year}, ${h}:${m}`;
}

function toggleTimestampTooltip(e: MouseEvent) {
	e.stopPropagation();
	showTimestampTooltip = !showTimestampTooltip;
}

// ADR-0043: on touch devices only, a tap on the info button toggles the
// audit-info popover. On desktop the hover/focus-within CSS still drives the
// popover; this handler is a no-op there.
function toggleInfoPopoverOnTouch() {
	if (!isTouchDevice()) return;
	infoPopoverTouched = !infoPopoverTouched;
}

function getVisibleReasoningDepthProfile(
	profile: DepthAppliedProfile | undefined,
): "extended" | "maximum" | null {
	return profile === "extended" || profile === "maximum" ? profile : null;
}

let timestampLabel = $derived(isUser ? formatTimestamp(message.timestamp) : "");
let fullTimestampLabel = $derived(
	isUser ? formatFullTimestamp(message.timestamp) : "",
);
let regenerateButtonId = $derived(`regenerate-button-${message.id}`);
let forkButtonId = $derived(`fork-button-${message.id}`);
let editButtonId = $derived(`edit-button-${message.id}`);
let copyButtonId = $derived(`copy-button-${message.id}`);

function handleEditKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
		e.preventDefault();
		submitEdit();
	}
	if (e.key === "Escape") {
		cancelEdit();
	}
}

$effect(() => {
	if (!showTimestampTooltip) return;

	const handleWindowClick = () => {
		showTimestampTooltip = false;
	};

	window.addEventListener("click", handleWindowClick, { once: true });
	return () => {
		window.removeEventListener("click", handleWindowClick);
	};
});

onDestroy(() => {
	if (copyTimeout) {
		clearTimeout(copyTimeout);
	}
});

function handleViewAttachment(attachment: ArtifactSummary) {
	if (!onOpenDocument) return;
	const artifactId =
		"artifactId" in attachment && attachment.artifactId
			? attachment.artifactId
			: attachment.id;
	onOpenDocument({
		id: `artifact:${artifactId}`,
		source: "knowledge_artifact",
		filename: attachment.name,
		title: attachment.name,
		mimeType: attachment.mimeType,
		artifactId: attachment.id,
		conversationId: attachment.conversationId,
	});
}

function toArtifactSummary(
	attachment: ChatAttachment,
): AttachmentArtifactSummary {
	const artifactId = attachment.artifactId ?? attachment.id;
	return {
		id: artifactId,
		artifactId,
		type: attachment.type,
		retrievalClass: "durable",
		name: attachment.name,
		mimeType: attachment.mimeType,
		sizeBytes: attachment.sizeBytes,
		conversationId: attachment.conversationId,
		summary: null,
		createdAt: attachment.createdAt,
		updatedAt: attachment.createdAt,
	};
}

function skillDraftPayload(draftId: string) {
	return { messageId: message.id, draftId };
}

function skillDraftState(draftId: string) {
	return skillDraftActionState[`${message.id}:${draftId}`] ?? {};
}

function forkLinkLabel(title: string): string {
	return $t("fork.openFork", { title });
}

function toggleForkDetails() {
	showForkDetails = !showForkDetails;
}
</script>

<div class="group flex w-full flex-col {isUser && !isEditing ? 'items-end' : 'items-start'} gap-md py-md fade-in">
	<div
		id={`message-${message.id}`}
		data-message-id={message.id}
		data-testid={isUser ? 'user-message' : 'assistant-message'}
		class="relative flex min-w-0 flex-col font-serif
		{isUser && !isEditing
			? 'max-w-[85%] min-w-0 rounded-md bg-[var(--surface-message-user)] p-md text-text-primary md:max-w-[80%]'
			: isUser
				? 'w-full min-w-0 max-w-full rounded-md bg-[var(--surface-message-user)] p-md text-text-primary'
			: 'w-full min-w-0 max-w-full rounded-none bg-surface-page p-sm text-text-primary'}"
	>
		{#if !isUser && reasoningDepthIndicatorLabel && (hasThinking || hasVisibleThinkingSegments || hasToolCalls)}
			<div class="reasoning-depth-indicator" class:fade-out={thinkingIsDone} data-testid="reasoning-depth-indicator">
				<Brain class="reasoning-depth-icon" size={14} strokeWidth={2} aria-hidden="true" />
				<span>{reasoningDepthIndicatorLabel}</span>
			</div>
		{/if}
	{#if !isUser && liveDeliberationStatusDisplayLabel}
		{#key `${liveDeliberationStatus?.id ?? 'deliberation'}:${liveDeliberationStatusDisplayLabel}`}
			<div class="deliberation-status-line" class:is-running={liveDeliberationStatus?.status === 'running'} data-testid="deliberation-status-line" aria-live="polite">
				{#if liveDeliberationStatusIconType === 'search'}
					<Search
						class="deliberation-status-icon"
						data-deliberation-icon="search"
						size={14}
						strokeWidth={2}
						aria-hidden="true"
					/>
				{:else if liveDeliberationStatusIconType === 'clipboard-check'}
					<ClipboardCheck
						class="deliberation-status-icon"
						data-deliberation-icon="clipboard-check"
						size={14}
						strokeWidth={2}
						aria-hidden="true"
					/>
				{:else if liveDeliberationStatusIconType === 'shield-alert'}
					<ShieldAlert
						class="deliberation-status-icon"
						data-deliberation-icon="shield-alert"
						size={14}
						strokeWidth={2}
						aria-hidden="true"
					/>
				{:else if liveDeliberationStatusIconType === 'languages'}
					<Languages
						class="deliberation-status-icon"
						data-deliberation-icon="languages"
						size={14}
						strokeWidth={2}
						aria-hidden="true"
					/>
				{:else if liveDeliberationStatusIconType === 'layers'}
					<Layers
						class="deliberation-status-icon"
						data-deliberation-icon="layers"
						size={14}
						strokeWidth={2}
						aria-hidden="true"
					/>
				{:else}
					<Bot
						class="deliberation-status-icon"
						data-deliberation-icon="bot"
						size={14}
						strokeWidth={2}
						aria-hidden="true"
					/>
				{/if}
				<span>{liveDeliberationStatusDisplayLabel}</span>
			</div>
			{/key}
		{/if}
		{#if !isUser && liveToolProgressActivityEntries.length > 0}
			<div class="tool-progress-stack" data-testid="tool-progress-stack" aria-live="polite">
				{#each liveToolProgressActivityEntries as activity (activity.id)}
					<div class="tool-progress-line">{activity.label}</div>
				{/each}
			</div>
		{/if}
		{#if !isUser && (hasThinking || hasVisibleThinkingSegments || hasToolCalls)}
		<ThinkingBlock
			content={message.thinking ?? ''}
			thinkingIsDone={thinkingIsDone}
			segments={visibleThinkingSegmentsForDisplay}
			streaming={markdownIsStreaming}
			thinkingDurationSeconds={message.generationDurationMs ? Math.round(message.generationDurationMs / 1000) : 0}
		/>
		{/if}
		{#if isUser}
			{#if isEditing}
				<div class="flex flex-col gap-3">
					<textarea
						bind:this={editTextarea}
						class="w-full resize-none rounded-md border-none bg-[var(--surface-message-user)] p-md font-serif text-[0.875rem] leading-[1.6] text-text-primary focus:outline-none focus:ring-2 focus:ring-focus-ring"
						bind:value={editText}
						onkeydown={handleEditKeydown}
						rows={Math.min(10, Math.max(3, editText.split('\n').length))}
					></textarea>
					<div class="flex items-center gap-0.5 justify-end">
						<button
							type="button"
							class="btn-icon-bare"
							onclick={cancelEdit}
							aria-label={$t('common.cancel')}
						>
							<X size={16} strokeWidth={2} aria-hidden="true" />
						</button>
						<button
							type="button"
							class="btn-icon-bare"
							onclick={submitEdit}
							disabled={!editText.trim()}
							aria-label={$t('chat.sendMessage')}
						>
							<Check size={16} strokeWidth={2} aria-hidden="true" />
						</button>
					</div>
				</div>
			{:else}
				{#if hasAttachments}
					<div class="mb-3 flex flex-wrap gap-2">
						{#each message.attachments ?? [] as attachment (attachment.id)}
							<FileAttachment
								attachment={toArtifactSummary(attachment)}
								variant="compact"
								viewable={Boolean(onOpenDocument)}
								onView={handleViewAttachment}
							/>
						{/each}
					</div>
				{/if}
				<div class="whitespace-pre-wrap break-words text-[0.875rem] leading-[1.5] md:leading-[1.55]">
					{#if userMessageSegments.length > 0}
						{#each userMessageSegments as segment}
							{#if segment.kind === 'link'}
								<a
									class="user-message-link"
									href={segment.href}
									target="_blank"
									rel="noopener noreferrer external"
								>
									{segment.text}
								</a>
							{:else}
								<span>{segment.text}</span>
							{/if}
						{/each}
					{:else}
						{message.content}
					{/if}
				</div>
			{/if}
		{:else}
			<div class="prose-container min-w-0 w-full text-[0.875rem] leading-[1.5] md:leading-[1.55]">
			{#if !hasAtlasCards}
			<MarkdownRenderer
				content={message.content}
				isDark={$isDark}
				isStreaming={markdownIsStreaming}
				compactExternalLinks
			/>
			{/if}
			</div>
			{#if showPreparingStatus}
				<div class="preparing-status" aria-live="polite">{preparingStatusLabel}</div>
			{/if}
			{#if showFinalizingStatus}
				<div class="preparing-status" aria-live="polite">{$t('chat.responseActivity.finalizing')}</div>
			{/if}
			{#if skillDrafts.length > 0}
				<div class="skill-draft-list">
					{#each skillDrafts as draft (draft.id)}
						{@const actionState = skillDraftState(draft.id)}
						<SkillDraftCard
							{draft}
							canPublishSystem={canPublishSkillDrafts}
							busy={Boolean(actionState.busy)}
							actionError={actionState.error ?? null}
							onSave={(draftId) => onSaveSkillDraft?.(skillDraftPayload(draftId))}
							onDismiss={(draftId) => onDismissSkillDraft?.(skillDraftPayload(draftId))}
							onPublish={(draftId) => onPublishSkillDraft?.(skillDraftPayload(draftId))}
						/>
					{/each}
				</div>
			{/if}
			{#if hasFileProductionCards}
				<div class="file-production-inline" data-testid="message-file-production-jobs">
					{#each dedupedFileProductionJobs as job (job.id)}
						<FileProductionCard
							{job}
							onOpenDocument={onOpenDocument}
							onRetry={onRetryFileProductionJob}
							onCancel={onCancelFileProductionJob}
							onDismiss={onDismissFileProductionJob}
						/>
					{/each}
				</div>
			{/if}
			{#if atlasJobs.length > 0}
				<div class="file-production-inline" data-testid="message-atlas-jobs">
					{#each dedupedAtlasJobs as job (job.id)}
						<AtlasCard
							{job}
							onOpenDocument={onOpenDocument}
							onCancel={onCancelAtlasJob}
							onLifecycleAction={onAtlasLifecycleAction}
						/>
					{/each}
				</div>
			{/if}
			{#if sourceForks && sourceForks.count > 0}
				<div
					class="fork-origin-marker"
					data-testid="fork-origin-marker"
					role="note"
					aria-label={$t('fork.originMarkerLabel')}
				>
					<div class="fork-origin-header">
						<div class="fork-origin-icon-chip" aria-hidden="true">
							<GitBranch size={15} strokeWidth={2} aria-hidden="true" />
						</div>
						{#if sourceForks.count === 1}
							<span class="fork-origin-label">{$t('fork.originSingleLabel')}</span>
						{:else}
							<button
								type="button"
								class="fork-origin-summary"
								aria-expanded={showForkDetails}
								onclick={toggleForkDetails}
							>
								{$t('fork.originCountLabel', { count: sourceForks.count })}
							</button>
						{/if}
					</div>
					{#if sourceForks.count === 1 && sourceForks.forks[0]}
						{@const childFork = sourceForks.forks[0]}
						<a
							class="fork-origin-link"
							href={`/chat/${childFork.conversationId}`}
							aria-label={forkLinkLabel(childFork.title)}
						>
							{childFork.title}
						</a>
					{:else if showForkDetails}
						<div class="fork-origin-list">
							{#each sourceForks.forks as childFork (childFork.conversationId)}
								<a
									class="fork-origin-link"
									href={`/chat/${childFork.conversationId}`}
									aria-label={forkLinkLabel(childFork.title)}
								>
									{childFork.title}
								</a>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
			{#if message.evidenceSummary && message.evidenceSummary.groups.length > 0}
				<MessageEvidenceDetails
					evidenceSummary={message.evidenceSummary}
					onOpenDocument={onOpenDocument}
				/>
			{:else if showEvidencePending}
				<div class="evidence-pending">{$t('messageBubble.evidenceLoading')}</div>
			{/if}
			{/if}

	</div>

	{#if !message.isStreaming && !isEditing && !hasAtlasCards}
		<div
			class="copy-action-row flex w-full items-center gap-0.5 opacity-100 transition-opacity duration-[var(--duration-micro)] md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100"
			class:justify-end={isUser}
			class:justify-start={!isUser}
		>
			{#if !isUser && hasResponseAuditInfo}
				<div class="info-container">
					<button
						type="button"
						class="btn-icon-bare info-button min-h-[44px] min-w-[44px]"
						aria-label={$t('messageBubble.info')}
						aria-describedby={auditDetailsId}
						aria-expanded={infoPopoverTouched || undefined}
						onclick={toggleInfoPopoverOnTouch}
					>
						<Info size={16} strokeWidth={2} aria-hidden="true" />
					</button>
					<div
						id={auditDetailsId}
						class="info-popover"
						data-open={infoPopoverTouched ? "true" : "false"}
						class:info-popover-open={infoPopoverTouched}
					>
					<ResponseAuditDetails
						{message}
						modelIconUrl={messageModelIconUrl}
						atlasCostUsdMicros={atlasJobCostUsdMicros}
					/>
					</div>
				</div>
			{/if}

		{#if !isUser && !readOnly}
			<!-- Regenerate button -->
				<div class="action-tooltip-container">
					<button
						id={regenerateButtonId}
						type="button"
						class="btn-icon-bare sm:!min-h-[44px] sm:!min-w-[44px]"
						onclick={() => onRegenerate?.({ messageId: message.id })}
						aria-label={$t('messageBubble.regenerate')}
						aria-describedby={`${regenerateButtonId}-tooltip`}
					>
						<RefreshCw size={16} strokeWidth={2} aria-hidden="true" />
					</button>
					<div
						id={`${regenerateButtonId}-tooltip`}
						class="action-tooltip"
						role="tooltip"
					>
						<div class="tooltip-content">
							<div class="tooltip-row">
								<span class="tooltip-value">{$t('messageBubble.actionRegenerate')}</span>
							</div>
						</div>
					</div>
				</div>
			{/if}

			{#if canFork}
				<div class="action-tooltip-container">
					<button
						id={forkButtonId}
						type="button"
						class="btn-icon-bare sm:!min-h-[44px] sm:!min-w-[44px]"
						onclick={() => onFork?.({ messageId: message.id })}
						disabled={forkBusy}
						aria-label={forkBusy ? $t('fork.creating') : $t('messageBubble.forkFromHere')}
						aria-describedby={`${forkButtonId}-tooltip`}
					>
						{#if forkBusy}
							<span class="mini-spinner" aria-hidden="true"></span>
						{:else}
							<GitBranch size={16} strokeWidth={2} aria-hidden="true" />
						{/if}
					</button>
					<div
						id={`${forkButtonId}-tooltip`}
						class="action-tooltip"
						role="tooltip"
					>
						<div class="tooltip-content">
							<div class="tooltip-row">
								<span class="tooltip-value">{forkBusy ? $t('fork.creating') : $t('messageBubble.actionFork')}</span>
							</div>
						</div>
					</div>
				</div>
			{/if}

			{#if isUser}
				<div class="timestamp-container">
					<button
						type="button"
						class="timestamp-label font-mono tabular-nums"
						onclick={toggleTimestampTooltip}
					>{timestampLabel}</button>
					<div class="timestamp-tooltip" class:visible={showTimestampTooltip}>
						<div class="tooltip-content">
							<div class="tooltip-row">
								<span class="tooltip-value">{fullTimestampLabel}</span>
							</div>
						</div>
					</div>
				</div>
				{#if !readOnly}
					<!-- Edit button -->
					<div class="action-tooltip-container">
						<button
							id={editButtonId}
							type="button"
							class="btn-icon-bare sm:!min-h-[44px] sm:!min-w-[44px]"
							onclick={startEdit}
							aria-label={$t('messageBubble.editMessage')}
							aria-describedby={`${editButtonId}-tooltip`}
						>
							<Pencil size={16} strokeWidth={2} aria-hidden="true" />
						</button>
						<div
							id={`${editButtonId}-tooltip`}
							class="action-tooltip"
							role="tooltip"
						>
							<div class="tooltip-content">
								<div class="tooltip-row">
									<span class="tooltip-value">{$t('messageBubble.actionEdit')}</span>
								</div>
							</div>
						</div>
					</div>
				{/if}
			{/if}

			<div class="action-tooltip-container">
				<button
					id={copyButtonId}
					type="button"
					class="btn-icon-bare sm:!min-h-[44px] sm:!min-w-[44px]"
					onclick={copyToClipboard}
					aria-label={$t('messageBubble.copyMessage')}
					aria-describedby={`${copyButtonId}-tooltip`}
				>
					{#if copied}
						<Check size={16} strokeWidth={2} class="text-icon-primary" aria-hidden="true" />
					{:else}
						<Copy size={16} strokeWidth={2} aria-hidden="true" />
					{/if}
				</button>
				<div
					id={`${copyButtonId}-tooltip`}
					class="action-tooltip"
					role="tooltip"
				>
					<div class="tooltip-content">
						<div class="tooltip-row">
							<span class="tooltip-value">{$t('messageBubble.actionCopy')}</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	{/if}
	{#if showLogoBelow}
		<div class="logo-signature">
			<LogoMark animated={isGenerating} size={42} />
		</div>
	{/if}
</div>

<style lang="postcss">
	/* Override Tailwind prose base font size to match reduced chat text size */
	.prose-container {
		min-width: 0;
		width: 100%;
		max-width: 100%;
		overflow-x: clip;
		overflow-y: visible;
	}

	.user-message-link {
		color: var(--accent);
		font-weight: 560;
		text-decoration-line: underline;
		text-decoration-thickness: 0.08em;
		text-underline-offset: 0.16em;
	}

	.user-message-link:hover,
	.user-message-link:focus-visible {
		color: var(--accent-hover);
		outline: none;
	}

	.user-message-link:focus-visible {
		border-radius: 0.18rem;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 42%, transparent);
	}

	.reasoning-depth-indicator {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		margin-bottom: var(--space-xs);
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 700;
		line-height: 1.25;
		transition: opacity 400ms var(--ease-out), max-height 400ms var(--ease-out);
		max-height: 999px;
		overflow: hidden;
	}

	.reasoning-depth-indicator.fade-out {
		opacity: 0;
		max-height: 0;
		margin-bottom: 0;
		pointer-events: none;
	}

	.deliberation-status-line {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		margin: 0 0 var(--space-xs);
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 600;
		line-height: 1.25;
		animation: deliberationStatusFade 220ms var(--ease-out) both;
	}

	.deliberation-status-line.is-running {
		color: var(--accent);
	}

	.tool-progress-stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-2xs);
		margin: 0 0 var(--space-sm);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		line-height: 1.35;
		color: var(--text-muted);
	}

	.tool-progress-line {
		width: fit-content;
		max-width: 100%;
		overflow-wrap: anywhere;
		animation: deliberationStatusFade 220ms var(--ease-out) both;
	}

	:global(.deliberation-status-icon) {
		width: 14px;
		height: 14px;
		flex: 0 0 auto;
		color: currentColor;
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
	.prose-container :global(.prose) {
		width: 100%;
		min-width: 0;
		max-width: 100%;
	}

	.prose-container :global(.prose) {
		font-size: var(--text-md);
		line-height: 1.5;
	}
	@media (min-width: 768px) {
		.prose-container :global(.prose) {
			font-size: var(--text-md);
			line-height: 1.55;
		}
	}
	.prose-container :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-sm);
		margin: 1rem 0;
		max-height: 400px;
		object-fit: contain;
		background-color: var(--surface-elevated);
	}
	.prose-container :global(.source-link-chip img.source-link-chip__favicon) {
		margin: 0;
	}
	.prose-container :global(p),
	.prose-container :global(li),
	.prose-container :global(blockquote),
	.prose-container :global(h1),
	.prose-container :global(h2),
	.prose-container :global(h3),
	.prose-container :global(h4),
	.prose-container :global(h5),
	.prose-container :global(h6) {
		word-break: break-word;
		overflow-wrap: break-word;
	}
	/* But don't break code — let it scroll */
	.prose-container :global(pre),
	.prose-container :global(code) {
		word-break: normal;
		overflow-wrap: normal;
	}
	.prose-container :global(.markdown-table-wrap) {
		width: 100%;
		min-width: 0;
		max-width: 100%;
		margin: 0 0 var(--space-md);
	}
	.prose-container :global(.markdown-table-wrap[data-overflow='scroll']) {
		overflow-x: auto;
		padding-bottom: 0.15rem;
	}
	.prose-container :global(.markdown-table-wrap[data-overflow='fit']) {
		overflow-x: clip;
	}
	.prose-container :global(.markdown-table-wrap table) {
		width: 100%;
		min-width: 0;
		table-layout: fixed;
		border-collapse: collapse;
	}
	.prose-container :global(.markdown-table-wrap[data-overflow='scroll'] table) {
		width: max-content;
		min-width: 100%;
		table-layout: auto;
	}
	.prose-container :global(.markdown-table-wrap th),
	.prose-container :global(.markdown-table-wrap td) {
		white-space: normal;
		word-break: normal;
		overflow-wrap: break-word;
		hyphens: auto;
		vertical-align: top;
	}
	.prose-container :global(.markdown-table-wrap th a),
	.prose-container :global(.markdown-table-wrap td a),
	.prose-container :global(.markdown-table-wrap th code),
	.prose-container :global(.markdown-table-wrap td code) {
		word-break: break-word;
		overflow-wrap: anywhere;
	}
	.prose-container :global(a),
	.prose-container :global(li code),
	.prose-container :global(p code),
	.prose-container :global(blockquote code) {
		overflow-wrap: anywhere;
		word-break: break-word;
	}
	.prose-container :global(p) {
		margin-top: 0;
		margin-bottom: var(--space-md);
	}
	.prose-container :global(p:last-child) {
		margin-bottom: 0;
	}
	.fade-in {
		animation: fadeIn var(--duration-micro) var(--ease-out) forwards;
	}
	.copy-action-row {
		margin-top: var(--space-sm);
	}

	.mini-spinner {
		width: 1rem;
		height: 1rem;
		border: 2px solid currentColor;
		border-right-color: transparent;
		border-radius: 999px;
		animation: spin 700ms linear infinite;
	}

	.file-production-inline {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		margin-top: var(--space-md);
	}

	.preparing-status {
		margin-top: var(--space-xs);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		line-height: 1.4;
		color: var(--text-muted);
	}

	.fork-origin-marker {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		margin-top: var(--space-md);
		width: 100%;
		max-width: 100%;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--surface-elevated) 90%, var(--accent) 10%);
		border: 1px solid color-mix(in srgb, var(--border-subtle) 80%, var(--accent) 20%);
	}

	.fork-origin-header {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.fork-origin-icon-chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--accent) 16%, transparent);
		color: var(--accent);
	}

	.fork-origin-label {
		font-weight: 700;
		color: var(--text-primary);
		white-space: nowrap;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		line-height: 1.35;
	}

	.fork-origin-link {
		display: inline-flex;
		align-items: center;
		padding: 0.2rem 0.4rem;
		background: color-mix(in srgb, var(--surface-overlay) 82%, transparent);
		border-radius: var(--radius-md);
		color: var(--text-secondary);
		text-decoration: none;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		line-height: 1.35;
		transition: background 150ms var(--ease-out);
	}

	.fork-origin-link:hover,
	.fork-origin-link:focus-visible {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--text-primary);
		outline: none;
	}

	.fork-origin-summary {
		display: inline-flex;
		border: 0;
		background: transparent;
		color: var(--text-primary);
		cursor: pointer;
		font: inherit;
		font-weight: 700;
		padding: 0;
		text-align: left;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		line-height: 1.35;
	}

	.fork-origin-summary:hover,
	.fork-origin-summary:focus-visible {
		text-decoration: underline;
		text-underline-offset: 0.18em;
		outline: none;
	}

	.fork-origin-list {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: var(--space-xs);
	}

	.evidence-pending {
		margin-top: var(--space-md);
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 70%, transparent 30%);
		padding-top: var(--space-sm);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	@keyframes fadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.info-container {
		position: relative;
		display: inline-flex;
	}

	.info-popover {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 0;
		transform: translateY(4px);
		opacity: 0;
		visibility: hidden;
		transition:
			opacity var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			visibility var(--duration-standard);
		z-index: 50;
		pointer-events: none;
		max-width: calc(100vw - 2rem);
	}

	/* ADR-0043: hover + focus-within are the DESKTOP reveal path (quiet by
	 * default, revealed on hover / keyboard focus). Scoped to hover-capable
	 * devices so a touch tap (which also focuses the button) cannot keep the
	 * popover pinned open via :focus-within — touch uses the tap-toggle. */
	@media (hover: hover) {
		.info-container:hover .info-popover,
		.info-container:focus-within .info-popover {
			opacity: 1;
			visibility: visible;
			transform: translateY(0);
			pointer-events: auto;
		}
	}

	/* ADR-0043: touch tap-toggle (no hover/focus-within on touch). */
	.info-popover.info-popover-open {
		opacity: 1;
		visibility: visible;
		transform: translateY(0);
		pointer-events: auto;
	}

	.tooltip-content {
		background: var(--surface-overlay);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		padding: var(--space-sm) var(--space-md);
		box-shadow: var(--shadow-lg);
		white-space: nowrap;
	}

	.tooltip-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		line-height: 1.4;
	}

	.tooltip-value {
		color: var(--text-primary);
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}

	.timestamp-container {
		position: relative;
		display: inline-flex;
	}

	.action-tooltip-container {
		position: relative;
		display: inline-flex;
	}

	.timestamp-label {
		font-size: var(--text-2xs);
		color: var(--text-muted);
		padding: 0 0.5rem;
		min-height: 44px;
		line-height: 1;
		display: inline-flex;
		align-items: center;
		background: none;
		border: none;
		cursor: default;
	}

	.timestamp-tooltip {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%) translateY(4px);
		opacity: 0;
		visibility: hidden;
		transition:
			opacity var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			visibility var(--duration-standard);
		z-index: 50;
		pointer-events: none;
	}

	.action-tooltip {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%) translateY(4px);
		opacity: 0;
		visibility: hidden;
		transition:
			opacity var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			visibility var(--duration-standard);
		z-index: 50;
		pointer-events: none;
	}

	.timestamp-container:hover .timestamp-tooltip,
	.timestamp-tooltip.visible {
		opacity: 1;
		visibility: visible;
		transform: translateX(-50%) translateY(0);
		pointer-events: auto;
	}

	.action-tooltip-container:hover .action-tooltip,
	.action-tooltip-container:focus-within .action-tooltip {
		opacity: 1;
		visibility: visible;
		transform: translateX(-50%) translateY(0);
	}

	.logo-signature {
		display: flex;
		justify-content: flex-start;
		margin-top: var(--space-xs);
		opacity: 0.85;
	}

	@media (prefers-reduced-motion: reduce) {
		.deliberation-status-line,
		.tool-progress-line {
			animation: none;
		}

		.info-popover,
		.timestamp-tooltip,
		.action-tooltip {
			transition: none;
		}
	}
</style>
