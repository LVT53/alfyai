<script lang="ts">
import { t } from "$lib/i18n";
import type { DepthAppliedProfile } from "$lib/server/services/chat-turn/depth-metadata-types";
import type { ChatMessage } from "$lib/server/services/messages-types";
import type { InstructionScope } from "$lib/shared/instructions";
import { instructionScopeKey } from "$lib/shared/instructions";
import { projects } from "$lib/stores/projects";
import { estimateTokenCount } from "$lib/utils/tokens";
import ModelIcon from "$lib/components/ui/ModelIcon.svelte";
import LogoMark from "$lib/components/chat/LogoMark.svelte";
import ScopeToken from "$lib/components/instructions/ScopeToken.svelte";

let {
	message,
	modelIconUrl = null,
	atlasCostUsdMicros = null,
	onOpenSources = undefined,
}: {
	message: ChatMessage;
	modelIconUrl?: string | null;
	atlasCostUsdMicros?: number | null;
	// Workspaces Slice E — what the "Project files" row does when it is clicked:
	// opens the Sources panel and gets this popover out of the way. The row is
	// the popover's own way of pointing at a surface it does not contain.
	onOpenSources?: (() => void) | undefined;
} = $props();

type AuditRow = {
	label: string;
	value: string;
	kind?: "model" | "sources";
	iconUrl?: string | null;
	// Rendered as tokens instead of the string value. Used where the value is
	// a set of things — scopes, not text — because a token is unmistakable
	// where a joined string reads like prose (see ScopeToken).
	scopeTokens?: InstructionScope[];
	// Present on a row that goes somewhere when clicked, which is what makes it
	// a button rather than a line of text.
	onSelect?: (() => void) | undefined;
};

let hasThinkingText = $derived(Boolean(message.thinking?.trim()));
let thinkingTokenCount = $derived(
	message.thinkingTokenCount ??
		(hasThinkingText ? estimateTokenCount(message.thinking ?? "") : 0),
);
let responseTokenCount = $derived(
	message.responseTokenCount ?? estimateTokenCount(message.content),
);
let totalTokenCount = $derived(
	message.totalTokenCount ?? thinkingTokenCount + responseTokenCount,
);
let primaryRows = $derived(buildPrimaryRows());

// ADR-0061 collapsed the off/auto/max ladder into a single thinking toggle,
// so `requested` on a NEW message is only ever "thorough" | "quick" and the
// badge shows that directly. A message persisted before the migration can
// still carry a legacy requested value ("off" | "auto" | "max" — this field
// isn't re-validated against the current ReasoningDepth type at read time)
// and, for a stale "auto" turn, an appliedProfile the classifier picked
// ("extended" | "maximum") that no toggle can produce any more — that
// legacy profile name is still worth showing, so it renders instead.
function isLegacyRequestedDepth(value: unknown): boolean {
	return value === "off" || value === "auto" || value === "max";
}

function formatAppliedDepthProfile(profile: DepthAppliedProfile): string {
	if (profile === "off") return $t("messageBubble.depthProfileOff");
	if (profile === "extended") return $t("messageBubble.depthProfileExtended");
	if (profile === "maximum") return $t("messageBubble.depthProfileMaximum");
	return $t("messageBubble.depthProfileStandard");
}

function formatDepthMetadata(metadata: ChatMessage["depthMetadata"]): string {
	if (!metadata) return "";
	const label = isLegacyRequestedDepth(metadata.requested)
		? formatAppliedDepthProfile(metadata.appliedProfile)
		: metadata.requested === "quick"
			? $t("messageBubble.depthQuick")
			: $t("messageBubble.depthThorough");
	return metadata.fallback
		? `${label} ${$t("messageBubble.depthFallbackSuffix")}`
		: label;
}

// Which instruction scopes shaped this reply, derived only from what the turn
// recorded. Scopes and never text: the Info surface can be shown on a shared
// screen, so it says "You" and not what the user wrote. An empty list means no
// row at all — a row with no tokens would claim something happened.
//
// The project token is given a projectId and, when the shell knows it, the
// project's name. The name is not the protected half of this row — the
// instruction text is, and it is never here: the project's name is already on
// the sidebar and in the chat's own breadcrumb, and a token with no label at
// all tells the reader nothing. A project the user has since deleted resolves
// to no name and renders the way it did before: the token invents nothing.
function instructionScopeTokens(): InstructionScope[] {
	const applied = message.instructionsApplied;
	if (!applied) return [];
	const scopes: InstructionScope[] = [];
	if (applied.personal) scopes.push({ kind: "personal" });
	if (applied.projectId) {
		scopes.push({
			kind: "project",
			projectId: applied.projectId,
			name: $projects.find((project) => project.id === applied.projectId)?.name,
		});
	}
	return scopes;
}

function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	const seconds = ms / 1000;
	if (seconds < 60) {
		return `${seconds.toFixed(1)}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = (seconds % 60).toFixed(1);
	return `${minutes}m ${remainingSeconds}s`;
}

function buildPrimaryRows(): AuditRow[] {
	const rows: AuditRow[] = [];
	if (message.providerDisplayName) {
		rows.push({
			label: $t("messageBubble.auditProvider"),
			value: message.providerDisplayName,
			kind: "model",
			iconUrl: message.providerIconUrl ?? null,
		});
	}
	if (message.modelDisplayName) {
		const isAtlasModel = message.modelDisplayName
			?.toLowerCase()
			.includes("atlas");
		rows.push({
			label: $t("messageBubble.auditModel"),
			value: message.modelDisplayName,
			kind: "model",
			iconUrl: isAtlasModel ? "__atlas_logo__" : modelIconUrl,
		});
	}
	const instructionScopes = instructionScopeTokens();
	if (instructionScopes.length > 0) {
		rows.push({
			label: $t("messageBubble.auditInstructions"),
			value: "",
			scopeTokens: instructionScopes,
		});
	}
	// Workspaces Slice E — how many of the project's files this turn read, and
	// where to see them. A count and a direction, never a list: names belong in
	// the Sources panel, where the user can open the file itself. The row is
	// absent (not "0") when the turn read none, because a row about nothing is
	// still a claim that something happened.
	if (message.projectFilesRead && message.projectFilesRead > 0) {
		rows.push({
			label: $t("projects.infoProjectFiles"),
			value:
				message.projectFilesRead === 1
					? $t("projects.infoProjectFilesValueOne")
					: $t("projects.infoProjectFilesValue", {
							count: message.projectFilesRead,
						}),
			kind: "sources",
			onSelect: onOpenSources,
		});
	}
	const depthLabel = formatDepthMetadata(message.depthMetadata);
	if (depthLabel) {
		rows.push({ label: $t("messageBubble.reasoningDepth"), value: depthLabel });
	}
	if (message.generationDurationMs && message.generationDurationMs > 0) {
		rows.push({
			label: $t("messageBubble.auditResponseTime"),
			value: formatDuration(message.generationDurationMs),
		});
	}
	if (thinkingTokenCount > 0) {
		rows.push({
			label: $t("messageBubble.auditThinkingTokens"),
			value: thinkingTokenCount.toLocaleString(),
		});
	}
	if (responseTokenCount > 0) {
		rows.push({
			label: $t("messageBubble.auditResponseTokens"),
			value: responseTokenCount.toLocaleString(),
		});
	}
	if (totalTokenCount > 0) {
		rows.push({
			label: $t("messageBubble.auditTotalTokens"),
			value: totalTokenCount.toLocaleString(),
		});
	}
	// Citation auto-repair summary (web-citation-audit.ts): a rewritten or
	// stripped citation still counts as "verified" here — after the repair
	// pass every surviving link is either an exact retrieved-source match or
	// was rewritten to one, so this is the count of citations the reader can
	// trust once the repair has run.
	if (message.citationAudit) {
		const verifiedCount =
			message.citationAudit.verified + message.citationAudit.repaired;
		if (verifiedCount > 0) {
			rows.push({
				label: $t("messageBubble.auditCitationAudit"),
				value: $t("messageBubble.auditVerifiedSources", {
					count: verifiedCount,
				}),
			});
		}
	}
	if (atlasCostUsdMicros != null && atlasCostUsdMicros > 0) {
		rows.push({
			label: $t("messageBubble.auditCost"),
			value: `$${(atlasCostUsdMicros / 1_000_000).toFixed(6)}`,
		});
	} else if (message.costUsd != null) {
		rows.push({
			label: $t("messageBubble.auditCost"),
			value: `$${message.costUsd.toFixed(6)}`,
		});
	}
	return rows;
}
</script>

<div class="audit-panel" role="region" aria-labelledby={`response-audit-title-${message.id}`}>
	<div class="audit-heading" id={`response-audit-title-${message.id}`}>
		{$t('messageBubble.info')}
	</div>

	{#if primaryRows.length > 0}
		<div class="audit-section">
			{#each primaryRows as row (`primary-${row.label}`)}
				{#if row.onSelect}
					<button type="button" class="audit-row audit-row--action" onclick={row.onSelect}>
						<span class="audit-label">{row.label}</span>
						<span class="audit-value audit-action-value">
							<span>{row.value}</span>
						</span>
					</button>
				{:else}
				<div class="audit-row">
					<span class="audit-label">{row.label}</span>
					<span
						class="audit-value"
						class:audit-model-value={row.kind === 'model'}
						class:audit-token-value={row.scopeTokens}
					>
					{#if row.kind === 'model'}
						{#if row.iconUrl === '__atlas_logo__'}
							<LogoMark size={18} />
						{:else}
							<ModelIcon iconUrl={row.iconUrl ?? null} displayName={row.value} size={18} />
						{/if}
					{/if}
					{#if row.scopeTokens}
						{#each row.scopeTokens as scope (instructionScopeKey(scope))}
							<ScopeToken {scope} />
						{/each}
					{:else}
						<span>{row.value}</span>
					{/if}
					</span>
				</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	.audit-panel {
		width: min(20rem, calc(100vw - 2rem));
		max-height: min(72vh, 32rem);
		overflow-y: auto;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-lg);
		padding: var(--space-sm) var(--space-md);
		font-family: var(--font-sans);
		color: var(--text-primary);
	}

	.audit-heading {
		margin-bottom: var(--space-xs);
		font-size: 0.74rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.audit-section {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: var(--space-xs);
	}

	.audit-row {
		display: flex;
		min-width: 0;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-md);
		font-size: var(--text-2xs);
		line-height: 1.4;
	}

	.audit-label {
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	.audit-value {
		display: inline-flex;
		min-width: 0;
		justify-content: flex-end;
		text-align: right;
		overflow-wrap: anywhere;
		word-break: break-word;
		color: var(--text-primary);
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}

	.audit-model-value {
		align-items: center;
		gap: var(--space-xs);
	}

	.audit-token-value {
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}

	/* A row that goes somewhere: same line, same type, but it reads as
	 * something you can press — and it is a real <button>, so keyboard focus
	 * and Enter work without a second handler. */
	.audit-row--action {
		width: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.audit-row--action:hover .audit-action-value,
	.audit-row--action:focus-visible .audit-action-value {
		color: var(--accent);
	}

	.audit-row--action:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: var(--radius-sm);
	}

	@media (max-width: 640px) {
		.audit-panel {
			width: min(20rem, calc(100vw - 1rem));
			max-height: 70vh;
		}

		.audit-row {
			gap: var(--space-sm);
		}
	}
</style>
