<script lang="ts">
// An Image version in History (plan 2b T4, design 5.7): the family's History
// shell (rail, toolbar, Restore) with this kind's preview. The version's picture,
// and when it is compared with another (the one before it, or now), a wipe
// between the two (`CompareWipe`): the other underneath, this one over it. A
// version made with marks shows them on the picture they were drawn on, in the
// colours of `MARK_COLOURS`. What Alfy was asked for is kept in a closed
// details, below the picture.
//
// Edit this version (an older version the reader chose): the picture alone, large,
// with the panel's own Mark tool. The boxes go to the page like any others and
// become the composer's marks chip on this version's file. The page holds them
// with no version, so what lands later never drops them. On a phone the way back to
// the composer is the same "Tell Alfy what to change".
//
// A picture is not stepped through change by change: the preview always reports
// no changes, so the shell shows no stepper. Bodies come from History's one
// shared memory (`version-bodies.ts`); the preview loads full pictures (the rail
// has the thumbnails).
// The icon file itself, not the barrel: History's preview registry test loads this
// module cold, and the barrel alone costs it several seconds to transform.
import Paperclip from "@lucide/svelte/icons/paperclip";
import SquareDashed from "@lucide/svelte/icons/square-dashed";
import { tick, untrack } from "svelte";
import { imageFileUrl } from "$lib/client/api/images";
import { t } from "$lib/i18n";
import { oneLineName } from "$lib/shared/one-line-name";
import {
	type ImageMark,
	type ImageVersionBody,
	MARK_COLOURS,
	MAX_MARKS,
	parseImageVersionBody,
} from "$lib/shared/artifacts/image-body";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import type { HistoryPreviewProps } from "../history/history-previews";
import { versionBody } from "../history/version-bodies";
import CompareWipe from "./CompareWipe.svelte";
import ImagePicture from "./ImagePicture.svelte";
import { markNoteKey } from "./mark-geometry";
import MarkLayer from "./MarkLayer.svelte";
import MarkNote from "./MarkNote.svelte";
import MarkTools from "./MarkTools.svelte";

let {
	artifactId,
	conversationId,
	versionId,
	at = undefined,
	baseVersionId,
	compare,
	nowVersionId,
	nowHash,
	label,
	title = "",
	onAttachPicture,
	canEdit = false,
	marks: heldMarks = null,
	onMarksChange,
	onMarksContinue,
	onState,
}: HistoryPreviewProps = $props();

let status = $state<"loading" | "ready" | "error">("loading");
let shown = $state.raw<ImageVersionBody | null>(null);
let base = $state.raw<ImageVersionBody | null>(null);
let position = $state(50);
let token = 0;

/** Edit this version is open: the picture alone, with the Mark tool. */
let editing = $state(false);
let marking = $state(false);
/** A ninth box was drawn: "Up to 8 marks" shows until a box goes. */
let refused = $state(false);
let root = $state<HTMLElement | null>(null);
let editButton = $state<HTMLButtonElement | null>(null);
let isPhone = $state(isPhoneViewport());
$effect(() => watchPhoneViewport((phone) => (isPhone = phone)));

const canEditHere = $derived(canEdit && Boolean(onMarksChange));
/** The held boxes, on this version's own file only. */
const editMarks = $derived(
	shown && heldMarks?.imageFileId === shown.fileId ? heldMarks.marks : [],
);

$effect(() => {
	if (!marking || editMarks.length < MAX_MARKS) refused = false;
});

// The switch above asks for the wipe, which Edit this version covers: asked for, it
// shows. The boxes stay held, and Edit this version brings them back.
let comparedWith = untrack(() => compare);
$effect(() => {
	if (compare === comparedWith) return;
	comparedWith = compare;
	editing = false;
	marking = false;
});

/** Boxes held on this version open it for editing once, on arriving here: later loads (a new "now", the compare switch) leave the reader's choice alone. */
let arrived = false;

function startEditing(): void {
	editing = true;
	marking = true;
	void tick().then(() =>
		root
			?.querySelector<HTMLElement>('[data-testid="image-body-mark"]')
			?.focus(),
	);
}

function stopEditing(): void {
	editing = false;
	marking = false;
	void tick().then(() => editButton?.focus());
}

function changeMarks(next: ImageMark[]): void {
	if (!shown) return;
	onMarksChange?.(
		next.length > 0 ? { imageFileId: shown.fileId, marks: next } : null,
	);
}

const markNoteI18n = $derived(
	markNoteKey({ refused, marking, count: editMarks.length, isPhone }),
);
const markNote = $derived(
	markNoteI18n
		? $t(markNoteI18n, {
				letters: editMarks.map((mark) => mark.letter).join(", "),
			})
		: "",
);

async function bodyOf(id: string): Promise<ImageVersionBody> {
	const parsed = parseImageVersionBody(
		await versionBody({
			artifactId,
			versionId: id,
			conversationId,
			nowVersionId,
			nowHash,
		}),
	);
	if (!parsed) throw new Error("not a picture");
	return parsed;
}

async function load(id: string, baseId: string | null): Promise<void> {
	const mine = ++token;
	status = "loading";
	onState({ status: "loading", changeCount: 0 });
	try {
		const [target, other] = await Promise.all([
			bodyOf(id),
			baseId && baseId !== id ? bodyOf(baseId) : Promise.resolve(null),
		]);
		if (mine !== token) return;
		shown = target;
		base = other;
		status = "ready";
		// Coming back to a version with boxes on it: they are shown where they can be changed.
		if (!arrived && canEditHere && heldMarks?.imageFileId === target.fileId) {
			editing = true;
			marking = true;
		}
		arrived = true;
		onState({ status: "ready", changeCount: 0 });
	} catch {
		if (mine !== token) return;
		// Never the picture of the version before under this one's row.
		shown = null;
		base = null;
		status = "error";
		onState({ status: "error", changeCount: 0 });
	}
}

$effect(() => {
	void load(versionId, baseVersionId);
});

const url = (fileId: string) => imageFileUrl(fileId, { conversationId });

/** The marks were drawn on the picture this version was made from: shown only when that is the picture underneath. */
const versionMarks = $derived(
	shown?.marks && base && shown.baseFileId === base.fileId ? shown.marks : [],
);
const marksLine = $derived(
	versionMarks.length > 0
		? $t("artifacts.image.history.marks", {
				letters: versionMarks.map((mark) => mark.letter).join(", "),
			})
		: null,
);
const tags = $derived(
	compare === "now"
		? {
				before: $t("artifacts.history.now"),
				after: $t("artifacts.image.history.then"),
			}
		: {
				before: $t("artifacts.image.card.before"),
				after: $t("artifacts.image.card.after"),
			},
);
</script>

{#snippet markLayer()}
	{#each versionMarks as mark (mark.letter)}
		<span
			class="ivp-mark"
			style:left="{mark.x * 100}%"
			style:top="{mark.y * 100}%"
			style:width="{mark.w * 100}%"
			style:height="{mark.h * 100}%"
			style:border-color={MARK_COLOURS[mark.letter]}
			data-testid="image-version-mark"
		>
			<span class="ivp-mark-letter" style:background={MARK_COLOURS[mark.letter]}>{mark.letter}</span>
		</span>
	{/each}
{/snippet}

<div bind:this={root} class="ivp" role="region" aria-label={label} data-testid="image-version-preview" data-status={status}>
	<div class="ivp-stage">
		{#if status === 'error'}
			<p class="ivp-error" role="alert">{$t('artifacts.image.panel.loadFailed')}</p>
		{:else if shown}
			<div
				class="ivp-frame"
				style:--ratio={shown.width / shown.height}
				style:--natural-width="{shown.width}px"
				data-testid="image-version-frame-box"
			>
				{#if base && !editing}
					<CompareWipe
						beforeUrl={url(base.fileId)}
						afterUrl={url(shown.fileId)}
						width={shown.width}
						height={shown.height}
						bind:position
						label={$t('artifacts.image.history.wipe')}
						beforeTag={tags.before}
						afterTag={tags.after}
						marks={versionMarks.length > 0 ? markLayer : undefined}
						hasAlpha={shown.hasAlpha || base.hasAlpha}
					/>
				{:else}
					<div class="ivp-single" data-testid="image-version-picture">
						<ImagePicture
							fileId={shown.fileId}
							width={shown.width}
							height={shown.height}
							hasAlpha={shown.hasAlpha}
							alt={label}
							{conversationId}
							variant="original"
						/>
						{#if editing}
							<div class="ivp-marks">
								<MarkLayer
									marks={editMarks}
									active={marking}
									onChange={changeMarks}
									onRefused={() => (refused = true)}
								/>
							</div>
						{/if}
					</div>
				{/if}
			</div>
			{#if editing}
				<MarkNote text={markNote} />
			{/if}
		{/if}
	</div>
	{#if onAttachPicture || canEditHere}
		<!-- One row, there whether the version has loaded or not, so the picture
		     above is the same size before and after it loads, but not seen until the
		     first version has: its prompt arrives under the row and the row moves up
		     by the prompt's height, and a row that moves as it is about to be pressed
		     is a layout shift. -->
		<div class="ivp-actions" class:is-pending={status === 'loading' && !shown}>
			{#if editing}
				<MarkTools
					{marking}
					canContinue={isPhone && editMarks.length > 0 && Boolean(onMarksContinue)}
					onToggle={() => (marking = !marking)}
					onContinue={onMarksContinue}
				/>
				<button type="button" class="ivp-attach" data-testid="image-version-edit-stop" onclick={stopEditing}>
					{$t('artifacts.image.history.editStop')}
				</button>
			{:else if canEditHere}
				<button
					bind:this={editButton}
					type="button"
					class="ivp-attach"
					data-testid="image-version-edit"
					disabled={!shown}
					onclick={startEditing}
				>
					<SquareDashed size={14} strokeWidth={2} aria-hidden="true" />
					{$t('artifacts.image.history.edit')}
				</button>
			{/if}
			{#if onAttachPicture}
				<button
				type="button"
				class="ivp-attach"
				data-testid="image-version-preview-attach"
				disabled={!shown}
				onclick={() => shown && onAttachPicture({ imageFileId: shown.fileId, name: oneLineName(title || label), at })}
			>
				<Paperclip size={14} strokeWidth={2} aria-hidden="true" />
				{$t('artifacts.image.history.attach')}
				</button>
			{/if}
		</div>
	{/if}
	{#if status !== 'error' && shown && (marksLine || shown.prompt)}
		<div class="ivp-foot">
			{#if marksLine}
				<p class="ivp-marks-line">{marksLine}</p>
			{/if}
			{#if shown.prompt}
				<details class="ivp-prompt" data-testid="image-version-prompt">
					<summary>{$t('artifacts.image.history.prompt')}</summary>
					<p class="ivp-prompt-text">{shown.prompt}</p>
				</details>
			{/if}
		</div>
	{/if}
</div>

<style>
	.ivp {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		gap: var(--space-sm);
		min-height: 0;
		padding: calc(var(--space-sm) + var(--space-xs)) var(--space-md) var(--space-md);
		box-sizing: border-box;
	}

	/* As in the panel's body: the stage is the container the picture is fitted to
	   by CSS alone, so a History that changes shape never re-flows it by script.
	   The picture hangs from History's toolbar, as the Document's preview starts
	   right under it (V3), instead of floating centred between two empty bands;
	   the Attach row keeps its room at the foot and shows once the version has
	   loaded, together with the prompt under it, so a version loading moves
	   nothing that can be seen. */
	.ivp-stage {
		position: relative;
		display: grid;
		place-items: start center;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
		container-type: size;
	}

	.ivp-frame {
		position: relative;
		width: min(100cqw, calc(100cqh * var(--ratio)), var(--natural-width));
		aspect-ratio: var(--ratio);
		border-radius: var(--radius-md);
		overflow: hidden;
	}

	.ivp-frame :global(.compare-wipe),
	.ivp-single,
	.ivp-single :global(.image-picture) {
		width: 100%;
		height: 100%;
	}

	.ivp-mark {
		position: absolute;
		box-sizing: border-box;
		border: 2px solid;
		border-radius: var(--radius-sm);
	}

	.ivp-mark-letter {
		position: absolute;
		top: -1px;
		left: -1px;
		padding: 0 var(--space-xs);
		border-radius: var(--radius-sm) 0 var(--radius-sm) 0;
		/* The mark colours are data, the same in both themes, and so is the letter on them. */
		color: #fff;
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		font-weight: 800;
		line-height: calc(var(--space-md) + var(--space-xs));
	}

	/* The boxes lie on the picture's own rectangle: their numbers are fractions of it. */
	.ivp-marks {
		position: absolute;
		inset: 0;
	}

	.ivp-actions {
		display: flex;
		flex: none;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-start;
		gap: var(--space-sm);
	}

	/* Hidden, not removed: it keeps its room, and a box that is not visible does not
	   count as moving when the prompt arrives under it and pushes it up. */
	.ivp-actions.is-pending {
		visibility: hidden;
	}

	.ivp-attach {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		min-height: 2.75rem;
		padding: 0 var(--space-md);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: var(--surface-page);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 600;
		cursor: pointer;
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	@media (pointer: fine) {
		.ivp-attach {
			min-height: 2rem;
		}

		/* The Mark button's height (it is taller than these): the row keeps it before
		   Edit this version too, or the picture above moves when the tool arrives. */
		.ivp-actions {
			min-height: 2.25rem;
		}
	}

	.ivp-attach:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.ivp-attach:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.ivp-error {
		margin: 0;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
	}

	.ivp-foot {
		display: flex;
		flex: none;
		flex-direction: column;
		gap: calc(var(--space-xs) * 1.5);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
	}

	.ivp-marks-line {
		margin: 0;
		color: var(--text-muted);
		font-weight: 600;
	}

	.ivp-prompt summary {
		color: var(--text-muted);
		font-weight: 600;
		cursor: pointer;
	}

	.ivp-prompt summary:focus-visible {
		outline: none;
		border-radius: var(--radius-sm);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.ivp-prompt-text {
		margin: calc(var(--space-xs) * 1.5) 0 0;
		color: var(--text-primary);
		line-height: 1.45;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
