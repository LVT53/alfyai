<script module lang="ts">
/** The tab a reader last used, kept for the next version they select (a preview is made anew for each). */
let lastTab: "preview" | "code" = "preview";
</script>

<script lang="ts">
/**
 * An App's version, read-only (ruling 76, versioning.md §5.4, Q7). Two views, as in
 * the App's own body:
 *
 *   - Preview: that version RUNNING, in the very frame the live App runs in (the
 *     same sandbox attribute, `AppFrame.svelte`), served by the old-App version route
 *     and against today's saved data. It is read-only: the route's bridge makes the
 *     frame's own `set` reject, and the parent refuses every `alfy.storage` set the
 *     frame could post whatever its bridge says (`previewVersionId`), so looking at
 *     an old version can never change what the App has saved. A version the route
 *     will not serve (422: written before a rule that forbids what it does, so it
 *     cannot run now) is "Code only": the reader is told, and Code is the view.
 *   - Code: the source with the lines the version added and removed marked
 *     (`line-diff.ts`), a long unchanged run folded into one line that opens, and
 *     each change a stop for the stepper in the toolbar.
 *
 * Which version it is compared with is the shell's (`baseVersionId`): the one
 * before it ("This version's changes") or the newest ("Compared with now").
 */
import { CodeXml, Eye } from "@lucide/svelte";
import { onDestroy, tick, untrack } from "svelte";
import type { HistoryPreviewProps } from "$lib/components/artifacts/history/history-previews";
import {
	type CodeRow,
	diffLines,
	foldUnchanged,
	type LineOp,
} from "$lib/components/artifacts/history/line-diff";
import { versionBody } from "$lib/components/artifacts/history/version-bodies";
import { t } from "$lib/i18n";
import { prefersReducedMotion } from "$lib/utils/motion";
import AppFrame from "./AppFrame.svelte";

let {
	artifactId,
	conversationId,
	versionId,
	baseVersionId,
	compare,
	nowVersionId,
	nowHash,
	label,
	changeCursor,
	onState,
}: HistoryPreviewProps = $props();

/** A source over this many characters is not compared (the server does not diff it either): "Too large to compare". */
const LARGE_BODY_CHARS = 256 * 1024;
const FLASH_MS = 900;
/** How far above its first change the source opens: a little of what leads up to it. */
const CONTEXT_PX = 48;

let tab = $state<"preview" | "code">(lastTab);
let status = $state<"loading" | "ready" | "error" | "large">("loading");
/** Whether the version route will serve this version: asked once for the version shown. */
let runnable = $state<"checking" | "yes" | "no">("checking");
let rows = $state.raw<CodeRow[]>([]);
let changes = $state(0);
let hadBase = $state(false);
let empty = $state(false);
let opened = $state.raw<ReadonlySet<number>>(new Set());
let flashing = $state<number | null>(null);
let scroller = $state<HTMLElement | null>(null);
let token = 0;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

const idBase = $derived(`history-app-${artifactId}-${versionId}`);

function bodyOf(id: string): Promise<string> {
	return versionBody({
		artifactId,
		versionId: id,
		conversationId,
		nowVersionId,
		nowHash,
	});
}

/** The version route's own address (`AppFrame` builds the same one for the frame). */
function versionRoute(id: string): string {
	return (
		`/api/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(id)}/app` +
		(conversationId
			? `?conversationId=${encodeURIComponent(conversationId)}`
			: "")
	);
}

async function load(id: string, baseId: string | null): Promise<void> {
	const mine = ++token;
	status = "loading";
	try {
		const [target, base] = await Promise.all([
			bodyOf(id),
			baseId ? bodyOf(baseId) : Promise.resolve<string | null>(null),
		]);
		const large =
			target.length > LARGE_BODY_CHARS ||
			(base !== null && base.length > LARGE_BODY_CHARS);
		// A first version, or one too large to compare, is its source listed whole.
		const compared = base !== null && !large;
		const ops: LineOp[] = compared
			? diffLines(base, target)
			: diffLines(target, target);
		const folded = foldUnchanged(ops);
		if (mine !== token) return;
		rows = folded.rows;
		changes = compared ? folded.changes : 0;
		hadBase = compared;
		empty = target.trim() === "";
		opened = new Set();
		status = large ? "large" : "ready";
	} catch {
		if (mine !== token) return;
		status = "error";
	}
}

/**
 * Asks the version route whether it will serve this version. Only the status is
 * wanted (a HEAD: the route runs the same checks and sends no body); a 422 means
 * the version cannot run now (`not_runnable`), a 404 that it is gone.
 */
async function probe(id: string): Promise<void> {
	runnable = "checking";
	try {
		const response = await fetch(versionRoute(id), { method: "HEAD" });
		if (id !== versionId) return;
		if (response.status === 422) {
			runnable = "no";
			tab = "code";
		} else if (response.status === 404) {
			runnable = "yes";
			status = "error";
		} else {
			runnable = "yes";
		}
	} catch {
		if (id !== versionId) return;
		// Offline or the server is away: the frame would say nothing either.
		runnable = "yes";
		status = "error";
	}
}

$effect(() => {
	const id = versionId;
	const baseId = baseVersionId;
	// What the compared-with source is when the newest row saved again.
	nowHash;
	void load(id, baseId);
});

$effect(() => {
	const id = versionId;
	untrack(() => void probe(id));
});

// What the shell shows: nothing to step through on the Preview tab, the changes on Code.
$effect(() => {
	const current = tab;
	const state = status;
	const count = changes;
	onState({
		status: state,
		changeCount: current === "code" && state === "ready" ? count : 0,
		codeOnly: runnable === "no",
		checking: runnable === "checking",
	});
});

function choose(next: "preview" | "code") {
	if (next === "preview" && runnable === "no") return;
	tab = next;
	lastTab = next;
}

function handleTabKeydown(event: KeyboardEvent) {
	if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
	event.preventDefault();
	const next = tab === "preview" ? "code" : "preview";
	if (next === "preview" && runnable === "no") return;
	choose(next);
	void tick().then(() => {
		(event.currentTarget as HTMLElement)
			.parentElement?.querySelector<HTMLElement>('[aria-selected="true"]')
			?.focus();
	});
}

// The source opens at its first change, not at the top of a file whose first
// lines are the same in every version: once for each comparison it is drawn for.
let landedOn: CodeRow[] | null = null;
$effect(() => {
	if (tab !== "code" || status !== "ready" || changes === 0) return;
	if (landedOn === rows) return;
	landedOn = rows;
	void tick().then(() => {
		const first = scroller?.querySelector<HTMLElement>('[data-change="0"]');
		if (!first || !scroller) return;
		scroller.scrollTop = Math.max(
			0,
			first.getBoundingClientRect().top -
				scroller.getBoundingClientRect().top +
				scroller.scrollTop -
				CONTEXT_PX,
		);
	});
});

// The stepper: scroll to the change and flash it (a heavier ring and a deeper tint
// for 900 ms; the ring alone, still, under reduced motion).
let lastNonce = -1;
$effect(() => {
	const { index, nonce } = changeCursor;
	if (nonce === lastNonce) return;
	lastNonce = nonce;
	if (index < 0 || tab !== "code" || status !== "ready") return;
	void tick().then(() => {
		const target = scroller?.querySelector<HTMLElement>(
			`[data-change="${index}"]`,
		);
		if (!target) return;
		target.scrollIntoView({
			block: "center",
			behavior: prefersReducedMotion() ? "auto" : "smooth",
		});
		flashing = index;
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => {
			if (flashing === index) flashing = null;
		}, FLASH_MS);
	});
});
onDestroy(() => {
	if (flashTimer) clearTimeout(flashTimer);
});

function openFold(index: number) {
	opened = new Set(opened).add(index);
}

const mark = (op: LineOp["op"]) => (op === "add" ? "+" : op === "del" ? "−" : " ");

const note = $derived(
	tab !== "code"
		? null
		: status === "large"
			? $t("artifacts.history.tooLarge")
			: status === "ready" && hadBase && compare === "step" && changes === 0
				? $t("artifacts.history.noChanges")
				: null,
);
</script>

<div
	class="history-app"
	role="group"
	aria-label={label}
	aria-busy={status === 'loading'}
	data-testid="history-preview"
	data-kind="app"
>
	<div class="bar">
		<div class="seg" role="tablist" aria-label={$t('artifacts.app.tabs.a11y')}>
			<button
				type="button"
				role="tab"
				id="{idBase}-tab-preview"
				class="seg-tab"
				aria-selected={tab === 'preview'}
				aria-controls="{idBase}-panel-preview"
				tabindex={tab === 'preview' ? 0 : -1}
				disabled={runnable === 'no'}
				data-testid="history-app-tab-preview"
				onclick={() => choose('preview')}
				onkeydown={handleTabKeydown}
			>
				<Eye size={14} strokeWidth={1.75} aria-hidden="true" />
				{$t('artifacts.app.tab.preview')}
			</button>
			<button
				type="button"
				role="tab"
				id="{idBase}-tab-code"
				class="seg-tab"
				aria-selected={tab === 'code'}
				aria-controls="{idBase}-panel-code"
				tabindex={tab === 'code' ? 0 : -1}
				data-testid="history-app-tab-code"
				onclick={() => choose('code')}
				onkeydown={handleTabKeydown}
			>
				<CodeXml size={14} strokeWidth={1.75} aria-hidden="true" />
				{$t('artifacts.app.tab.code')}
			</button>
		</div>
		{#if runnable === 'no'}
			<p class="note note-warn" data-testid="history-app-code-only" role="status">
				{$t('artifacts.history.app.codeOnly')}
			</p>
		{:else if note}
			<p class="note" data-testid="history-preview-note">{note}</p>
		{/if}
	</div>

	{#if status === 'error'}
		<div class="state" role="alert">
			<span>{$t('artifacts.history.previewError')}</span>
			<button
				type="button"
				class="btn-secondary btn-sm"
				onclick={() => {
					void load(versionId, baseVersionId);
					void probe(versionId);
				}}
			>
				{$t('common.retry')}
			</button>
		</div>
	{:else if tab === 'preview'}
		<div
			id="{idBase}-panel-preview"
			role="tabpanel"
			aria-labelledby="{idBase}-tab-preview"
			class="panel panel-frame"
			data-testid="history-app-preview"
		>
			{#if runnable === 'checking'}
				<div class="skeleton" aria-hidden="true"><span class="block"></span></div>
			{:else}
				<p class="runs" data-testid="history-app-runs">{$t('artifacts.history.appRuns')}</p>
				<div class="frame">
					<AppFrame
						{artifactId}
						version={0}
						title={label}
						{conversationId}
						previewVersionId={versionId}
					/>
				</div>
			{/if}
		</div>
	{:else}
		<!-- A scrolling region must be reachable by keyboard (WCAG 2.1.1): the source scrolls, so it takes the focus. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			id="{idBase}-panel-code"
			role="tabpanel"
			aria-labelledby="{idBase}-tab-code"
			class="panel panel-code"
			tabindex="0"
			bind:this={scroller}
			aria-busy={status === 'loading'}
			data-testid="history-app-code"
		>
			{#if status === 'loading'}
				<div class="skeleton" aria-hidden="true">
					<span class="line-skel"></span>
					<span class="line-skel short"></span>
					<span class="line-skel"></span>
					<span class="line-skel medium"></span>
				</div>
			{:else if empty}
				<p class="runs">{$t('artifacts.history.app.noSource')}</p>
			{:else}
				<div class="code" aria-label={$t('artifacts.history.app.codeLabel')}>
					{#each rows as row, index (index)}
						{#if row.type === 'fold'}
							{#if opened.has(index)}
								{#each row.lines as line, at (at)}
									<div class="line line-same"><span class="mark" aria-hidden="true"> </span><span class="text">{line.text}</span></div>
								{/each}
							{:else}
								<button
									type="button"
									class="fold"
									data-testid="history-fold"
									onclick={() => openFold(index)}
								>
									{$t('artifacts.history.app.unchangedLines', { count: row.count })}
								</button>
							{/if}
						{:else}
							<div
								class="line line-{row.op}"
								class:flash={row.change !== null && flashing === row.change}
								data-change={row.change}
							>
								<span class="mark" aria-hidden="true">{mark(row.op)}</span>
								{#if row.op !== 'same'}<span class="sr-only">{row.op === 'add' ? $t('artifacts.history.added') : $t('artifacts.history.removedSr')}</span>{/if}
								<span class="text">{row.text}</span>
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.history-app {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
		background: var(--surface-page);
	}

	.bar {
		display: flex;
		flex: 0 0 auto;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
		padding: 0.625rem 1rem 0.375rem;
	}

	/* The App's own segmented control, as small. */
	.seg {
		display: inline-flex;
		padding: 2px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
	}

	.seg-tab {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		min-height: 2rem;
		padding: 0.25rem 0.75rem;
		border: 0;
		border-radius: calc(var(--radius-md) - 2px);
		background: transparent;
		color: var(--text-muted);
		font-size: 0.8125rem;
		font-weight: 600;
		cursor: pointer;
	}

	.seg-tab[aria-selected='true'] {
		background: var(--surface-page);
		color: var(--text-primary);
		box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.08));
	}

	.seg-tab:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.seg-tab:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.note {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.78rem;
		font-weight: 600;
	}

	.note-warn {
		color: var(--text-primary);
	}

	.state {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		padding: 2rem 1rem;
		color: var(--text-muted);
		font-size: 0.875rem;
	}

	.panel {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
	}

	.panel-frame {
		padding: 0 1rem 1rem;
		gap: 0.5rem;
	}

	.runs {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.78rem;
	}

	.frame {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 14rem;
	}

	/* The source scrolls inside this panel, so it is a block, not a flex column: a flex
	   item that clips its own overflow may shrink below its content, and the lines past
	   the panel's height would be cut off with nothing to scroll. */
	.panel-code {
		display: block;
		overflow: auto;
		padding: 0.25rem 1rem 1.5rem;
		outline: none;
	}

	.panel-code:focus-visible {
		box-shadow: inset 0 0 0 2px var(--focus-ring);
	}

	.code {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		overflow: hidden;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.78rem;
		line-height: 1.5;
	}

	.line {
		display: flex;
		gap: 0.5rem;
		padding: 0 0.625rem;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.mark {
		flex: 0 0 0.75rem;
		color: var(--text-muted);
		text-align: center;
		user-select: none;
	}

	.text {
		min-width: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--text-primary);
	}

	.line-add {
		background: color-mix(in srgb, var(--success) 14%, transparent);
	}

	.line-del {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
	}

	.line-del .text {
		color: var(--text-muted);
		text-decoration: line-through;
		text-decoration-color: color-mix(in srgb, var(--danger) 55%, transparent);
	}

	/* The stepper's stop: the change's lines ringed for 900 ms. */
	.line.flash {
		background: color-mix(in srgb, var(--accent-fill) 20%, transparent);
		box-shadow: inset 3px 0 0 var(--accent-fill);
	}

	.fold {
		display: block;
		width: 100%;
		min-height: 1.75rem;
		padding: 0.125rem 0.625rem;
		border: 0;
		border-block: 1px dashed var(--border-default);
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: 0.75rem;
		text-align: left;
		cursor: pointer;
	}

	.fold:hover {
		background: color-mix(in srgb, var(--text-primary) 5%, transparent);
	}

	.fold:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}

	.skeleton {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem 0;
	}

	.block {
		display: block;
		height: 10rem;
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		animation: history-app-pulse 1.4s ease-in-out infinite;
	}

	.line-skel {
		display: block;
		height: 0.75rem;
		width: 90%;
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
		animation: history-app-pulse 1.4s ease-in-out infinite;
	}

	.line-skel.short {
		width: 45%;
	}

	.line-skel.medium {
		width: 70%;
	}

	@keyframes history-app-pulse {
		50% {
			opacity: 0.55;
		}
	}

	/* A finger needs 44 px: the tabs and a fold are targets on a phone. */
	@media (max-width: 639px), (pointer: coarse) {
		.seg-tab {
			min-height: 2.75rem;
			padding-inline: 1rem;
		}

		.fold {
			min-height: 2.75rem;
		}
	}
</style>
