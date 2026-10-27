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
import { imageFileUrl } from "$lib/client/api/images";
import { t } from "$lib/i18n";
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
		{#if shown}
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
		{:else if status === 'error'}
			<p class="ivp-error" role="alert">{$t('artifacts.image.panel.loadFailed')}</p>
		{/if}
	</div>
	{#if shown && (marksLine || shown.prompt)}
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
		gap: 0.625rem;
		min-height: 0;
		padding: 0.75rem 1rem 1rem;
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
		padding: 0 0.3rem;
		border-radius: var(--radius-sm) 0 var(--radius-sm) 0;
		/* The mark colours are data, the same in both themes, and so is the letter on them. */
		color: #fff;
		font-family: var(--font-sans);
		font-size: 0.7rem;
		font-weight: 800;
		line-height: 1.25rem;
	}

	.ivp-error {
		margin: 0;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.875rem;
	}

	.ivp-foot {
		display: flex;
		flex: none;
		flex-direction: column;
		gap: 0.375rem;
		font-family: var(--font-sans);
		font-size: 0.8125rem;
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
		margin: 0.375rem 0 0;
		color: var(--text-primary);
		line-height: 1.45;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
