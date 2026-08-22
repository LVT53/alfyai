<script lang="ts">
// A3 Stage 2 diagram kind: a ```chart fence rendered with Chart.js on a
// <canvas>. The fence body is a JSON Chart.js config, e.g.
//   { "type": "bar",
//     "data": { "labels": ["A","B"], "datasets": [{ "label": "X", "data": [1,2] }] } }
// Client-only: Chart.js needs a live DOM, so it is dynamic-imported inside a
// client-only $effect (never at module top-level / never during SSR) that
// rebuilds the chart whenever the parsed config changes. Server-side and
// pre-mount we render the <canvas> placeholder only. Invalid JSON or a config
// missing `type`/`data` degrades to the raw source + an error note — it never
// crashes the message. Chart.js renders to <canvas> (no HTML injection), so no
// sanitizer involvement is needed.
import { onMount } from "svelte";
import { t } from "$lib/i18n";

let { code = "" }: { code?: string } = $props();

type ChartInstance = { destroy: () => void };

let canvas = $state<HTMLCanvasElement | null>(null);
let chartInstance: ChartInstance | null = null;
let mounted = $state(false);
// Guards against overlapping async instantiations (the dynamic import is async):
// a newer config change bumps the token so a stale in-flight build bails out.
let renderToken = 0;

// Parse + shape-validate synchronously so SSR and the client agree on whether
// this is a renderable chart or the raw-source fallback.
const parsed = $derived.by(
	(): { ok: true; config: unknown } | { ok: false } => {
		try {
			const value: unknown = JSON.parse(code);
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				return { ok: false };
			}
			const record = value as Record<string, unknown>;
			if (typeof record.type !== "string") return { ok: false };
			if (!record.data || typeof record.data !== "object") return { ok: false };
			return { ok: true, config: value };
		} catch {
			return { ok: false };
		}
	},
);

async function instantiate(config: unknown) {
	const token = ++renderToken;
	if (!canvas) return;
	try {
		const { default: Chart } = await import("chart.js/auto");
		if (token !== renderToken || !canvas) return; // superseded / unmounted
		chartInstance?.destroy();
		chartInstance = new Chart(
			canvas,
			// Chart.js validates the concrete config shape at runtime; we only
			// guaranteed `type` + `data` above.
			config as ConstructorParameters<typeof Chart>[1],
		) as unknown as ChartInstance;
	} catch {
		// A Chart.js runtime error (bad dataset shape, etc.) must not crash the
		// message — leave the placeholder canvas in place silently.
		if (token !== renderToken) return;
		chartInstance = null;
	}
}

function teardown() {
	renderToken++;
	chartInstance?.destroy();
	chartInstance = null;
}

onMount(() => {
	mounted = true;
	return teardown;
});

// Client-only ($effect never runs during SSR). Rebuilds the chart whenever the
// parsed config changes: MarkdownRenderer's block {#each} is unkeyed
// (index-reconciled), so a chart block whose JSON changes at the same index
// reuses THIS component instance and onMount never re-fires — this effect is what
// keeps the canvas in sync (bar→line, invalid→valid, translation toggle, …). The
// `mounted` guard defers the first build until the canvas is bound. If the config
// becomes invalid the canvas is unmounted (the {#if parsed.ok} below), so we tear
// the stale Chart.js instance down here too.
$effect(() => {
	if (!mounted) return;
	if (parsed.ok) {
		void instantiate(parsed.config);
	} else {
		teardown();
	}
});
</script>

{#if parsed.ok}
  <div class="markdown-chart">
    <canvas bind:this={canvas}></canvas>
  </div>
{:else}
  <div class="markdown-diagram-error" role="note">{$t('diagram.chartError')}</div>
  <pre class="markdown-diagram-source"><code>{code}</code></pre>
{/if}

<style>
  .markdown-chart {
    position: relative;
    width: 100%;
    max-width: 100%;
    margin: var(--space-sm) 0;
  }

  .markdown-chart canvas {
    max-width: 100%;
  }

  .markdown-diagram-error {
    margin: var(--space-sm) 0 var(--space-2xs, 0.25rem);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .markdown-diagram-source {
    margin: 0 0 var(--space-sm);
    padding: var(--space-sm);
    border-radius: var(--radius-md, 0.5rem);
    border: 1px solid var(--border-default);
    background: var(--surface-code);
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
</style>
