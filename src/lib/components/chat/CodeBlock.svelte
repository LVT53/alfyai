<script lang="ts">
import { slide } from "svelte/transition";
import { preserveScrollOnToggle } from "$lib/actions/preserve-scroll";
import { t } from "$lib/i18n";
import { ChevronDown, Copy } from "@lucide/svelte";

let {
	code = "",
	language = undefined,
	contentHtml = "",
}: {
	code?: string;
	language?: string;
	contentHtml?: string;
} = $props();

// Long-block line collapse (C2). A code block taller than
// COLLAPSE_THRESHOLD_LINES renders clamped to COLLAPSED_VISIBLE_LINES with a
// bottom fade and a per-block "Show N more lines" / "Show less" toggle. Short
// blocks are unaffected (no toggle, no clamp). This is separate from the
// existing whole-block `collapsed` header toggle above it. LINE_HEIGHT_EM
// matches the rendered code line-height (leading-[1.5]).
const COLLAPSE_THRESHOLD_LINES = 30;
const COLLAPSED_VISIBLE_LINES = 15;
const LINE_HEIGHT_EM = 1.5;

let copied = $state(false);
let collapsed = $state(false);
let linesExpanded = $state(false);
let container = $state<HTMLDivElement | undefined>(undefined);
let copyTimeout: ReturnType<typeof setTimeout> | undefined;

// Count logical lines from the raw source (ignore a single trailing newline so
// a block ending in "\n" is not counted as one line longer than it reads).
const lineCount = $derived(code.replace(/\n+$/, "").split("\n").length);
const isLong = $derived(lineCount > COLLAPSE_THRESHOLD_LINES);
const hiddenLineCount = $derived(
	Math.max(lineCount - COLLAPSED_VISIBLE_LINES, 0),
);
const isClamped = $derived(isLong && !linesExpanded);
const clampMaxHeight = `${COLLAPSED_VISIBLE_LINES * LINE_HEIGHT_EM}em`;

async function toggleCollapse() {
	await preserveScrollOnToggle(container, collapsed, () => {
		collapsed = !collapsed;
	});
}

async function toggleLines() {
	await preserveScrollOnToggle(container, linesExpanded, () => {
		linesExpanded = !linesExpanded;
	});
}

async function copyToClipboard() {
	try {
		await navigator.clipboard.writeText(code);
		copied = true;
		clearTimeout(copyTimeout);
		copyTimeout = setTimeout(() => {
			copied = false;
		}, 2000);
	} catch (err) {
		console.error("Failed to copy code: ", err);
	}
}
</script>

<div class="code-block relative my-md w-full font-mono text-[14px]" bind:this={container}>
	<div class="code-header">
			<button
				type="button"
				class="code-toggle"
				onclick={toggleCollapse}
				aria-label={collapsed ? $t('codeBlock.expand') : $t('codeBlock.collapse')}
			>
			<span class={`chevron${collapsed ? ' collapsed' : ''}`}>
				<ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
			</span>
			<span class="lowercase">{language ?? 'code'}</span>
		</button>

		{#if !collapsed}
			<button
				type="button"
				class="btn-icon-bare copy-button min-h-[44px] min-w-[44px] gap-1.5"
				onclick={copyToClipboard}
			aria-label={$t('codeBlock.copyCode')}
			title={$t('codeBlock.copyCode')}
			>
				{#if copied}
					<span class="text-success font-sans text-[12px] font-medium">{$t('codeBlock.copied')}</span>
				{:else}
				<Copy size={16} strokeWidth={2} aria-hidden="true" />
				{/if}
			</button>
		{/if}
	</div>

	{#if !collapsed}
		<div class="code-body" transition:slide={{ duration: 200 }}>
			<div
				class="code-clip"
				class:code-clip--clamped={isClamped}
				style={isClamped ? `max-height: ${clampMaxHeight};` : undefined}
			>
				<div class="code-content w-full overflow-x-auto p-md text-[14px] leading-[1.5]">
					{@html contentHtml}
				</div>
				{#if isClamped}
					<div class="code-clip__fade" aria-hidden="true"></div>
				{/if}
			</div>
			{#if isLong}
				<div class="code-lines-toggle-wrap">
					<button
						type="button"
						data-testid="code-lines-toggle"
						class="code-lines-toggle"
						aria-expanded={linesExpanded}
						onclick={toggleLines}
					>
						{linesExpanded
							? $t('codeBlock.showLess')
							: $t('codeBlock.showMoreLines', { count: hiddenLineCount })}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style lang="postcss">
	.code-block {
		position: relative;
	}

	.code-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-xs) 0;
	}

	.code-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 0;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 500;
		color: var(--text-muted);
		transition: color var(--duration-standard) var(--ease-out);
	}

	.code-toggle:hover {
		color: var(--text-primary);
	}

	.code-toggle:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
		border-radius: 2px;
	}

	.chevron {
		color: var(--icon-muted);
		transition: transform var(--duration-standard) var(--ease-out);
		flex-shrink: 0;
	}

	.chevron.collapsed {
		transform: rotate(-90deg);
	}

	.code-body {
		border-radius: var(--radius-md, 0.5rem);
		border: 1px solid var(--border-default);
		background: var(--surface-code);
		box-shadow: var(--shadow-sm);
		overflow: hidden;
	}

	/* Line-collapse (C2): the clip owns the vertical clamp; the inner
	   .code-content keeps its own horizontal scroll. When clamped we hide the
	   vertical overflow and lay a bottom fade over the cut-off lines. */
	.code-clip {
		position: relative;
	}

	.code-clip--clamped {
		overflow: hidden;
	}

	.code-clip__fade {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 3.5em;
		background: linear-gradient(
			to bottom,
			transparent,
			var(--surface-code)
		);
		pointer-events: none;
	}

	.code-lines-toggle-wrap {
		display: flex;
		justify-content: center;
		border-top: 1px solid var(--border-subtle, var(--border-default));
		padding: var(--space-xs) 0;
	}

	.code-lines-toggle {
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		padding: 0 var(--space-sm);
		background: transparent;
		border: none;
		cursor: pointer;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: 560;
		color: var(--text-muted);
		transition: color var(--duration-standard) var(--ease-out);
	}

	.code-lines-toggle:hover {
		color: var(--text-primary);
	}

	.code-lines-toggle:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
		border-radius: 2px;
	}

	.code-content :global(pre) {
		margin: 0 !important;
		padding: 0 !important;
		background: transparent !important;
		min-width: 100%;
		width: max-content;
	}

	.code-content :global(code) {
		font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
	}

	.copy-button {
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	@media (min-width: 768px) {
		.copy-button {
			opacity: 0.4;
		}

		.code-block:hover .copy-button,
		.copy-button:focus-visible {
			opacity: 1;
		}
	}

	/* Touch devices: affordances are ALWAYS visible at full opacity. The
	 * query mirrors isTouchDevice() (hover: none + pointer: coarse). */
	@media (hover: none) and (pointer: coarse) {
		.copy-button {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.chevron {
			transition: none;
		}
	}
</style>
