<script lang="ts">
// An Image version in History (plan 2b T4, design 5.7): the family's History
// shell (rail, toolbar, Restore) with this kind's preview. The version's picture,
// and when it is compared with another (the one before it, or now), a wipe
// between the two (`CompareWipe`): the other underneath, this one over it. A
// version made with marks shows them on the picture they were drawn on, in the
// colours of `MARK_COLOURS`. What Alfy was asked for is kept in a closed
// details, below the picture.
//
// A picture is not stepped through change by change: the preview always reports
// no changes, so the shell shows no stepper. Bodies come from History's one
// shared memory (`version-bodies.ts`); the preview loads full pictures (the rail
// has the thumbnails).
// The icon file itself, not the barrel: History's preview registry test loads this
// module cold, and the barrel alone costs it several seconds to transform.
import Paperclip from "@lucide/svelte/icons/paperclip";
import { imageFileUrl } from "$lib/client/api/images";
import { t } from "$lib/i18n";
import { oneLineName } from "$lib/shared/one-line-name";
import {
	type ImageVersionBody,
	MARK_COLOURS,
	parseImageVersionBody,
} from "$lib/shared/artifacts/image-body";
import type { HistoryPreviewProps } from "../history/history-previews";
import { versionBody } from "../history/version-bodies";
import CompareWipe from "./CompareWipe.svelte";
import ImagePicture from "./ImagePicture.svelte";

let {
	artifactId,
	conversationId,
	versionId,
	baseVersionId,
	compare,
	nowVersionId,
	nowHash,
	label,
	title = "",
	onAttachPicture,
	onState,
}: HistoryPreviewProps = $props();

let status = $state<"loading" | "ready" | "error">("loading");
let shown = $state.raw<ImageVersionBody | null>(null);
let base = $state.raw<ImageVersionBody | null>(null);
let position = $state(50);
let token = 0;

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
const marks = $derived(
	shown?.marks && base && shown.baseFileId === base.fileId ? shown.marks : [],
);
const marksLine = $derived(
	marks.length > 0
		? $t("artifacts.image.history.marks", {
				letters: marks.map((mark) => mark.letter).join(", "),
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
	{#each marks as mark (mark.letter)}
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

<div class="ivp" role="region" aria-label={label} data-testid="image-version-preview" data-status={status}>
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
				{#if base}
					<CompareWipe
						beforeUrl={url(base.fileId)}
						afterUrl={url(shown.fileId)}
						width={shown.width}
						height={shown.height}
						bind:position
						label={$t('artifacts.image.history.wipe')}
						beforeTag={tags.before}
						afterTag={tags.after}
						marks={marks.length > 0 ? markLayer : undefined}
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
					</div>
				{/if}
			</div>
		{/if}
	</div>
	{#if onAttachPicture}
		<!-- One row, there whether the version has loaded or not, so the picture
		     above is the same size before and after it loads. -->
		<div class="ivp-actions">
			<button
				type="button"
				class="ivp-attach"
				data-testid="image-version-preview-attach"
				disabled={!shown}
				onclick={() => shown && onAttachPicture({ imageFileId: shown.fileId, name: oneLineName(title || label) })}
			>
				<Paperclip size={14} strokeWidth={2} aria-hidden="true" />
				{$t('artifacts.image.card.attach')}
			</button>
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
	   by CSS alone, so a History that changes shape never re-flows it by script. */
	.ivp-stage {
		position: relative;
		display: grid;
		place-items: center;
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

	.ivp-actions {
		display: flex;
		flex: none;
		justify-content: flex-start;
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
