<script lang="ts">
// The one card every artifact kind renders as, in chat and in the panel's
// list (Slice 0 Task S6). Three chrome modes share one body-dispatch:
// "row" is the panel list's one-line-per-item row (redesign §5.2, agent 2);
// "full" is the standalone in-chat card (redesign §5.2/§9.2, Wave 2.5 Step
// 12) — its OWN head (icon, title, subtitle line, version, pending-review
// pill) is one button, with the trailing "Open ›" / "Open in panel" /
// "Review ›" affordance built into it, never a second control; "body"
// renders only the kind's body — no title, icon, kind label or version pill
// of its own — for a host that already draws its own header.
//
// The File kind hosted by ToolActivityRow is such a host: the row chrome
// always renders its own icon and its own verb+object line (`item.object`)
// before the body ever opens ("Produced budget.xlsx"), and chrome="body"
// must never repeat that line — the File body (`FileProductionCard.svelte`,
// moved here from ToolActivityRow, imported lazily so a chat page with no
// file-producing turn never pays for its chunk) never has. Asserted by
// ArtifactCard.test.ts and ToolActivityRow.test.ts: the composed row+body
// markup shows a title exactly once, for the File kind.
//
// The other four kinds' in-chat card is chrome="full" instead (Wave 2.5 Step
// 12 changed this from chrome="body"): the approved mockup's own `.a-card`
// deliberately repeats the title — once on the tool row's compact status
// line ("Created Weekend plan"), once on the card's own head — so a create_
// artifact/edit_artifact card reads as a real deliverable next to the chat,
// not a nested log entry. `ArtifactCard.test.ts` and
// `artifact-chat-card.spec.ts` assert the row+card pair together instead of
// a single-title invariant for this chrome.
import { Check, ChevronRight, CircleSlash, Sparkles } from "@lucide/svelte";
import { t, type I18nKey } from "$lib/i18n";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import { ARTIFACT_KIND_ICONS } from "./kind-icons";

export interface ArtifactCardTickableItem {
	id: string;
	text: string;
	done: boolean;
}

export interface ArtifactCardView {
	id: string;
	kind: ArtifactKind;
	title: string;
	/**
	 * A second line under the title, e.g. the Document's "Document · 3 tabs"
	 * (T9.4, `documentArtifactCardView` in `document/card-view.ts`) —
	 * already-localised by the caller, exactly like `madeBy`. `null`/omitted
	 * renders nothing, so every other kind is unaffected by this field.
	 */
	subtitle?: string | null;
	/** Rendered as "made by Alfy {when}"; the caller supplies the already-localised time. */
	madeBy?: string | null;
	/**
	 * The bare relative time ("2 min ago"), already localised — `chrome="row"`'s
	 * own right-aligned time (redesign §5.2), never the "made by Alfy …"
	 * sentence `madeBy` renders: the row's time column is too narrow for the
	 * full sentence, and repeating "Alfy" on every row was one of the
	 * mockup's own complaints (§5.1 problem 4). `null`/omitted renders no time.
	 */
	updatedAtLabel?: string | null;
	versionNumber?: number | null;
	/** Null while a job is still running, so Open is not offered. */
	openTargetId?: string | null;
	/**
	 * `chrome="row"` and `chrome="full"`: how many of THIS item's changes are
	 * waiting for review right now (redesign §5.2's "Pending review shows as
	 * a status pill"). A row shows a pill instead of its resting chevron; a
	 * standalone card's head shows the same pill plus "Review ›" instead of
	 * "Open ›" (§5.2's in-chat card, Wave 2.5 Step 12). `null`/omitted/0
	 * renders the resting chevron / plain "Open ›". This is the same
	 * ephemeral, session-only signal the chat header's count-button dot reads
	 * (`liveDocumentAlfyActivity`) — a later Wave 2.5 agent's durable
	 * "pending review survives a reload" work is expected to replace what
	 * feeds this field, not this field itself.
	 */
	pendingReviewCount?: number | null;
	/**
	 * `chrome="full"` only (redesign §4.2 "The chat side", Wave 2.5 Step 11):
	 * the count of undismissed refusal notes — independent from
	 * `pendingReviewCount` above (the mockup's own `oneLeft`/`revLeft` copy
	 * family treats them as two separate signals: "N changes to review" is
	 * what got APPLIED, this is what Alfy left untouched). Shown as its own
	 * pill beside `pendingReviewCount`'s. `null`/omitted/0 renders nothing.
	 * The SAME ephemeral, session-only `alfyActivity` signal feeds both —
	 * `ToolActivityRow.svelte`'s own `artifactCardView`.
	 */
	refusedCount?: number | null;
	/**
	 * `chrome="row"` and `chrome="full"`: this item is the one currently open
	 * in the panel. A row is tinted; a standalone card is outlined in accent
	 * and its head reads "Open in panel" instead of "Open ›" (redesign §5.2).
	 */
	current?: boolean;
	/**
	 * `chrome="full"` only (Wave 2.5 Step 12/13): a create_artifact call is
	 * still running and its kind/title are already known. Swaps the body for
	 * a shimmering skeleton and the subtitle for an "Alfy is writing…" line,
	 * and disables the head (there is nothing to open yet — `openTargetId`
	 * stays unset for this state). Mutually exclusive with `failedReason`.
	 */
	creating?: boolean;
	/**
	 * `chrome="full"` only (Wave 2.5 Step 12/13): a settled, business-level
	 * refusal of create_artifact — already-resolved plain text (the tool's
	 * own model-facing reason), never a code, mirroring `RefusalNotice`'s own
	 * "each type resolves its own reason vocabulary before handing it here"
	 * rule. `null`/omitted renders no failure state.
	 */
	failedReason?: string | null;
	/**
	 * `chrome="full"` only (Wave 2.5 Step 13): the App panel's own status-row
	 * sentence ("Alfy checked the facts and fixed one thing."), already
	 * localised by the caller through the same `APP_VERIFY_LINE_KEYS` map the
	 * panel itself reads — never re-derived here. `null`/omitted (every other
	 * kind, or an App whose verification was never checked) renders nothing.
	 */
	factCheckLine?: string | null;
	tickable?: {
		items: ArtifactCardTickableItem[];
		/**
		 * How many task items REALLY exist — equal to `items.length` unless the
		 * caller is working from a bounded subset (the chat card's server
		 * preview, T9 steps 4/7, never carries more than the first five).
		 * Falls back to `items.length` when omitted, so a full-body caller
		 * (the panel) needs no change.
		 */
		totalCount?: number;
		onToggle: (id: string) => void;
	} | null;
}

let {
	view,
	job = null,
	chrome = "full",
	onOpen = undefined,
	onOpenDocument = undefined,
	onRetry = undefined,
	onCancel = undefined,
	onDismiss = undefined,
}: {
	view: ArtifactCardView;
	/** Live job state for the File kind in the chat. */
	job?: FileProductionJob | null;
	/**
	 * "full" draws the header row (icon, title, kind label, version pill,
	 * Open) for the in-chat card; "body" renders only the body, for a host
	 * that already draws its own header; "row" is the one-line panel-list row
	 * (redesign §5.2) — icon, title, a muted kind/facts/version line, time,
	 * and a chevron or a pending-review pill, with the whole row as the
	 * button.
	 */
	chrome?: "full" | "body" | "row";
	onOpen?: ((artifactId: string) => void) | undefined;
	/**
	 * The File body's own per-file Open action (one job can produce several
	 * files, each its own DocumentWorkspaceItem) — narrower than `onOpen`'s
	 * one artifact id, so it is its own prop rather than overloading `onOpen`.
	 */
	onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onRetry?: ((jobId: string) => void) | undefined;
	onCancel?: ((jobId: string) => void) | undefined;
	onDismiss?: ((jobId: string) => void) | undefined;
} = $props();

const TICKABLE_VISIBLE_LIMIT = 5;

let KindIcon = $derived(ARTIFACT_KIND_ICONS[view.kind]);
let visibleTickableItems = $derived(
	view.tickable?.items.slice(0, TICKABLE_VISIBLE_LIMIT) ?? [],
);
let hiddenTickableCount = $derived(
	Math.max(
		0,
		(view.tickable?.totalCount ?? view.tickable?.items.length ?? 0) -
			TICKABLE_VISIBLE_LIMIT,
	),
);

// The File body is lazy: a chat page with no file-producing turn must not
// pay for FileProductionCard's chunk. Cached so re-opening the same job
// does not re-request the module.
let FileProductionBody = $state<
	typeof import("../chat/FileProductionCard.svelte").default | null
>(null);
$effect(() => {
	if (view.kind !== "file" || !job || FileProductionBody) return;
	// Guard against setting state once this effect is no longer live: the
	// card can unmount (row collapsed, panel closed) before the dynamic
	// import resolves, and an unguarded `.then()` would still write to
	// `FileProductionBody` after teardown. The cleanup below runs
	// synchronously on unmount (and before any re-run of this effect), so
	// `cancelled` is already true by the time a stale import settles.
	let cancelled = false;
	void import("../chat/FileProductionCard.svelte").then((module) => {
		if (!cancelled) FileProductionBody = module.default;
	});
	return () => {
		cancelled = true;
	};
});

function handleOpen(): void {
	if (view.openTargetId) onOpen?.(view.openTargetId);
}
</script>

{#if chrome === 'body' && view.kind === 'file'}
	{#if job && FileProductionBody}
		<FileProductionBody {job} {onOpenDocument} {onRetry} {onCancel} {onDismiss} />
	{/if}
{:else if chrome === 'row'}
	<button
		type="button"
		class="artifact-row"
		class:artifact-row-current={view.current}
		data-testid="artifact-row"
		disabled={!view.openTargetId}
		onclick={handleOpen}
	>
		<span class="artifact-row-icon" aria-hidden="true">
			<KindIcon size={18} strokeWidth={1.75} aria-hidden="true" />
		</span>
		<span class="artifact-row-main">
			<span class="artifact-row-title">{view.title}</span>
			<span class="artifact-row-sub">
				<span>{view.subtitle ?? $t(`artifacts.type.${view.kind}` as I18nKey)}</span>
				{#if view.versionNumber}
					<span class="artifact-row-sep" aria-hidden="true">·</span>
					<span>{$t('artifacts.card.version', { n: view.versionNumber })}</span>
				{/if}
			</span>
		</span>
		<span class="artifact-row-end">
			{#if view.updatedAtLabel}
				<span class="artifact-row-time">{view.updatedAtLabel}</span>
			{/if}
			{#if view.pendingReviewCount}
				<span class="pill artifact-row-pill">
					<Sparkles size={12} strokeWidth={2} aria-hidden="true" />
					{$t('artifacts.panel.pendingReview', { count: view.pendingReviewCount })}
				</span>
			{:else if view.pendingReviewCount === 0}
				<!-- Wave 2.5 review (F1): "reviewed" is a real, positive answer —
				     a marker exists (Alfy edited this Document) and nothing is
				     pending right now — distinct from a document that was never
				     touched at all, which still falls through to the plain
				     chevron below. -->
				<span class="pill artifact-row-pill-reviewed">
					<Check size={12} strokeWidth={2} aria-hidden="true" />
					{$t('artifacts.panel.reviewed')}
				</span>
			{:else}
				<span class="artifact-row-chev" aria-hidden="true">
					<ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
				</span>
			{/if}
		</span>
	</button>
{:else}
	{#snippet tickableBlock()}
		{#if view.tickable}
			<ul class="artifact-card-tickable">
				{#each visibleTickableItems as tickItem (tickItem.id)}
					<li>
						<label class="artifact-card-tick-row">
							<input
								type="checkbox"
								checked={tickItem.done}
								onclick={(event) => {
									// A checkbox's native click default action flips its own
									// `.checked` property immediately, independent of the
									// `checked={tickItem.done}` binding above — which only
									// re-syncs the DOM when `done`'s VALUE changes. A caller
									// that (correctly) leaves `done` untouched after a refused
									// toggle (a version conflict, a network failure) gives
									// Svelte no reason to touch the checkbox again, so the box
									// would stay visually ticked while the stored document
									// still says otherwise. Preventing the native default makes
									// `checked` the ONLY thing that ever moves this checkbox, so
									// a no-op `done` genuinely means a no-op checkbox.
									event.preventDefault();
									view.tickable?.onToggle(tickItem.id);
								}}
							/>
							<span class:artifact-card-tick-done={tickItem.done}>{tickItem.text}</span>
						</label>
					</li>
				{/each}
			</ul>
			{#if hiddenTickableCount > 0}
				<div class="artifact-card-more">
					{$t('artifacts.card.moreItems', { count: hiddenTickableCount })}
				</div>
			{/if}
		{/if}
	{/snippet}

	<div
		class="artifact-card"
		class:artifact-card-full={chrome === 'full'}
		class:artifact-card-current={chrome === 'full' && view.current}
		data-testid="artifact-card"
	>
		{#if chrome === 'full'}
			<!-- The head IS the button (redesign §5.2: "the head is one button") —
			     icon, title, subtitle/version/pending-review line, and the
			     trailing Open/Review affordance all live inside one control, never
			     a separate "Open" button beside a non-interactive header. -->
			<button
				type="button"
				class="artifact-card-head"
				data-testid="artifact-card-head"
				disabled={!view.openTargetId}
				onclick={handleOpen}
			>
				<span class="artifact-card-icon" aria-hidden="true">
					<KindIcon size={18} strokeWidth={1.75} aria-hidden="true" />
				</span>
				<span class="artifact-card-headtext">
					<span class="artifact-card-title">{view.title}</span>
					<span class="artifact-card-sub">
						{#if view.creating}
							<span class="artifact-card-sub-writing">{$t('artifacts.card.creatingSubtitle')}</span>
						{:else}
							<span>{view.subtitle ?? $t(`artifacts.type.${view.kind}` as I18nKey)}</span>
						{/if}
						{#if view.versionNumber}
							<span class="artifact-card-sep" aria-hidden="true">·</span>
							<span>{$t('artifacts.card.version', { n: view.versionNumber })}</span>
						{/if}
						{#if view.pendingReviewCount}
							<span class="pill artifact-card-pending">
								<Sparkles size={12} strokeWidth={2} aria-hidden="true" />
								{$t('artifacts.panel.pendingReview', { count: view.pendingReviewCount })}
							</span>
						{:else if view.pendingReviewCount === 0}
							<!-- Wave 2.5 review (F1): "the card reads ✓ Reviewed" once
							     Keep/Undo/Keep-all resolves every pending change — a
							     positive confirmation, not silence, and never the
							     stale "N to review" pill this replaces. -->
							<span class="pill artifact-card-reviewed">
								<Check size={12} strokeWidth={2} aria-hidden="true" />
								{$t('artifacts.panel.reviewed')}
							</span>
						{/if}
						{#if view.refusedCount}
							<span class="pill artifact-card-refused">
								<CircleSlash size={12} strokeWidth={2} aria-hidden="true" />
								{$t('artifacts.panel.leftAlone', { count: view.refusedCount })}
							</span>
						{/if}
					</span>
				</span>
				{#if view.openTargetId}
					<span class="artifact-card-cta">
						{#if view.pendingReviewCount || view.refusedCount}
							{$t('artifacts.card.review')}
						{:else if view.current}
							{$t('artifacts.card.openInPanel')}
						{:else}
							{$t('artifacts.card.open')}
						{/if}
						<ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
					</span>
				{/if}
			</button>

			{#if view.creating}
				<!-- Wave 2.5 Step 12 (redesign §7.2 row 25): three shimmering lines
				     in place of whatever body this kind would eventually show —
				     `app.css`'s global reduced-motion override already collapses
				     the animation to a static skeleton (§7.3). -->
				<div class="artifact-card-body artifact-card-skeleton" aria-hidden="true">
					<span class="artifact-card-skel-line" style="width: 72%"></span>
					<span class="artifact-card-skel-line" style="width: 58%"></span>
					<span class="artifact-card-skel-line" style="width: 64%"></span>
				</div>
			{:else if view.failedReason}
				<div class="artifact-card-body artifact-card-failed" role="alert">
					<p class="artifact-card-failed-title">{$t('artifacts.card.failedTitle')}</p>
					<p class="artifact-card-failed-reason">{view.failedReason}</p>
				</div>
			{:else}
				{#if view.factCheckLine}
					<div class="artifact-card-body artifact-card-factcheck">
						{view.factCheckLine}
					</div>
				{/if}
				{#if view.tickable}
					<div class="artifact-card-body">
						{@render tickableBlock()}
					</div>
				{/if}
			{/if}
		{:else}
			{#if view.subtitle}
				<div class="artifact-card-subtitle">{view.subtitle}</div>
			{/if}

			{#if view.madeBy}
				<div class="artifact-card-madeby">{view.madeBy}</div>
			{/if}

			{@render tickableBlock()}

			{#if view.openTargetId}
				<button type="button" class="artifact-card-open" onclick={handleOpen}>
					{$t('artifacts.card.open')}
				</button>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.artifact-card {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs, 0.375rem);
	}

	/* chrome="full" — the standalone in-chat card (redesign §5.2, Wave 2.5
	   Step 12): a real bordered card, never just a flex column of parts, so
	   it stands on its own below the tool row instead of reading as another
	   line inside it. Scoped to this modifier class (not the bare
	   `.artifact-card`) so chrome="body" — a host that draws its own box
	   already (ToolActivityRow's `.act-body`) — is untouched. */
	.artifact-card-full {
		gap: 0;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg, 12px);
		background: var(--surface-page);
		box-shadow: var(--shadow-sm);
		overflow: hidden;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out);
	}

	/* The item this card is FOR is already open in the panel (redesign §5.2). */
	.artifact-card-current {
		border-color: color-mix(in srgb, var(--accent) 55%, transparent);
		box-shadow: 0 0 0 3px var(--accent-tint);
	}

	/* The head IS the button: icon, title/subtitle column, and the trailing
	   Open/Review affordance all sit in one control (redesign §5.2's "the
	   head is one button" — the same whole-element-is-the-button shape
	   chrome="row" already uses, just laid out as a card head instead of a
	   one-line row). */
	.artifact-card-head {
		display: grid;
		grid-template-columns: 36px minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.75rem 0.75rem 0.75rem 0.875rem;
		border: 0;
		background: transparent;
		text-align: left;
		font-family: var(--font-sans);
		cursor: pointer;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.artifact-card-head:hover:not(:disabled) {
		background: var(--surface-overlay);
	}

	.artifact-card-head:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring) inset;
	}

	.artifact-card-head:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.artifact-card-headtext {
		min-width: 0;
	}

	/* The kind tile (redesign §5.2's `.kind-tile`): bigger and tinted, unlike
	   chrome="body"/"row"'s plain muted-icon treatment, because this is the
	   card's own identity mark, not a decoration beside someone else's title. */
	.artifact-card-icon {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		flex: 0 0 auto;
		border-radius: 9px;
		background: var(--accent-tint);
		color: var(--accent-text);
	}

	.artifact-card-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-primary);
		font-weight: 700;
		letter-spacing: 0.01em;
	}

	.artifact-card-sub {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.125rem 0.375rem;
		margin-top: 0.125rem;
		color: var(--text-muted);
		font-size: 0.78rem;
	}

	.artifact-card-sep {
		opacity: 0.6;
	}

	/* Wave 2.5 Step 12: the mockup's `sub.innerHTML =
	   '<span style="color:var(--accent-text)">Alfy is writing…</span>'` — the
	   one thing that changes colour while a create_artifact call is running. */
	.artifact-card-sub-writing {
		color: var(--accent-text);
	}

	.artifact-card-pending {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 20px;
		padding: 0 0.44rem;
		border-radius: var(--radius-full);
		background: var(--accent-tint);
		color: var(--accent-text);
		font-size: 0.69rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}

	/* Same shape as `.artifact-card-pending`, warning-toned to match
	   `RefusalNotice.svelte`/`CommentCard.svelte`'s own refusal treatment —
	   "the two should read as the same family" (rd3a's hand-off). */
	.artifact-card-refused {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 20px;
		padding: 0 0.44rem;
		border-radius: var(--radius-full);
		background: var(--warning-tint);
		color: var(--warning-text);
		font-size: 0.69rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}

	/* Same shape as `.artifact-card-pending`, success-toned — "the card reads
	   ✓ Reviewed" (Wave 2.5 review, F1) once nothing is pending anymore. */
	.artifact-card-reviewed {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 20px;
		padding: 0 0.44rem;
		border-radius: var(--radius-full);
		background: var(--success-tint);
		color: var(--success-text);
		font-size: 0.69rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}

	.artifact-card-cta {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 0.25rem;
		padding: 0.3rem 0.5rem;
		border-radius: var(--radius-md);
		color: var(--accent-text);
		font-size: 0.78rem;
		font-weight: 700;
		white-space: nowrap;
	}

	.artifact-card-head:hover:not(:disabled) .artifact-card-cta {
		background: var(--accent-tint);
	}

	/* Aligns under the head's text column (14px head padding + 36px icon +
	   12px gap = 62px), mirroring the mockup's `.a-card-body` exactly. */
	.artifact-card-body {
		padding: 0.125rem 0.875rem 0.75rem 62px;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	/* Wave 2.5 Step 12 (redesign §7.2 row 25): the mockup's own `.skeleton` /
	   `.skel-line` shimmer, reusing this card's existing tokens instead of a
	   second colour system. `prefers-reduced-motion` collapses the animation
	   to 0.01ms through app.css's existing global override (§7.3) — a static
	   skeleton, never a spinning/looping one. */
	.artifact-card-skeleton {
		gap: 0.5rem;
		padding-top: 0.25rem;
	}

	.artifact-card-skel-line {
		height: 10px;
		border-radius: 5px;
		background: linear-gradient(
			90deg,
			var(--surface-elevated) 25%,
			color-mix(in srgb, var(--accent) 10%, var(--surface-elevated)) 50%,
			var(--surface-elevated) 75%
		);
		background-size: 200% 100%;
		animation: artifact-card-shimmer 1.4s ease-in-out infinite;
	}

	@keyframes artifact-card-shimmer {
		from {
			background-position: 150% 0;
		}
		to {
			background-position: -50% 0;
		}
	}

	/* Wave 2.5 Step 12: a refused create_artifact's own "could not be made"
	   card. Deliberately as calm as `RefusalNotice.svelte`'s own treatment —
	   the row's glyph (turned red via `item.status === "failed"`) already
	   signals the failure; the card explains it rather than shouting it. */
	.artifact-card-failed-title {
		margin: 0;
		color: var(--text-primary);
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.artifact-card-failed-reason {
		margin: 0.125rem 0 0;
		color: var(--text-muted);
		font-size: 0.78rem;
	}

	/* Wave 2.5 Step 13: the App panel's own status-row sentence, echoed here —
	   plain text, same muted tone as the subtitle line above it. */
	.artifact-card-factcheck {
		color: var(--text-muted);
		font-size: 0.78rem;
	}

	.artifact-card-subtitle,
	.artifact-card-madeby {
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.artifact-card-tickable {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.artifact-card-tick-row {
		display: flex;
		align-items: center;
		gap: var(--space-xs, 0.375rem);
		color: var(--text-primary);
		font-size: var(--text-sm);
		cursor: pointer;
	}

	/* Redesign §5.2: "checklist ticks are 44 px tall on phones" — a task's
	   whole row (the `<label>`, not just the visual checkbox square) is the
	   tap target, so a taller row is enough; it applies to both chrome
	   values since they share this exact row markup. */
	@media (max-width: 767px) {
		.artifact-card-tick-row {
			min-height: 44px;
		}
	}

	.artifact-card-tick-done {
		color: var(--text-muted);
		text-decoration: line-through;
	}

	.artifact-card-more {
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.artifact-card-open {
		align-self: flex-start;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		padding: 0.3rem 0.7rem;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		cursor: pointer;
	}

	.artifact-card-open:hover {
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-elevated));
	}

	.artifact-card-open:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* chrome="row" — the panel list's one-line-per-item row (redesign §5.2): the whole row is the button. */
	.artifact-row {
		display: grid;
		grid-template-columns: 34px minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		min-height: 56px;
		padding: 0.5rem 0.75rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		text-align: left;
		font-family: var(--font-sans);
		cursor: pointer;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.artifact-row:hover {
		background: var(--surface-elevated);
	}

	.artifact-row-current {
		background: var(--accent-tint);
	}

	.artifact-row:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring) inset;
	}

	.artifact-row:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.artifact-row-icon {
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		flex: 0 0 auto;
		border-radius: 8px;
		background: var(--accent-tint);
		color: var(--accent-text);
	}

	.artifact-row-main {
		min-width: 0;
	}

	.artifact-row-title {
		display: block;
		overflow: hidden;
		color: var(--text-primary);
		font-size: 0.875rem;
		font-weight: 700;
		letter-spacing: 0.01em;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.artifact-row-sub {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.125rem 0.375rem;
		margin-top: 0.125rem;
		color: var(--text-muted);
		font-size: 0.78rem;
	}

	.artifact-row-sep {
		opacity: 0.55;
	}

	.artifact-row-end {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.25rem;
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.artifact-row-chev {
		display: inline-flex;
		color: var(--icon-muted);
		opacity: 0;
		transform: translateX(-4px);
		transition:
			opacity var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.artifact-row:hover .artifact-row-chev,
	.artifact-row:focus-visible .artifact-row-chev {
		opacity: 1;
		transform: none;
	}

	.artifact-row-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 20px;
		padding: 0 0.44rem;
		border-radius: var(--radius-full);
		background: var(--accent-tint);
		color: var(--accent-text);
		font-size: 0.69rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}

	/* Same shape as `.artifact-row-pill`, success-toned — see
	   `.artifact-card-reviewed`'s own doc comment. */
	.artifact-row-pill-reviewed {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 20px;
		padding: 0 0.44rem;
		border-radius: var(--radius-full);
		background: var(--success-tint);
		color: var(--success-text);
		font-size: 0.69rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}
</style>
