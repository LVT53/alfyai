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
import { parseJsonLenient } from "$lib/utils/lenient-json";

let { code = "" }: { code?: string } = $props();

type ChartInstance = { destroy: () => void };

// The chart types Chart.js/auto actually registers. The model sometimes invents
// unsupported types (e.g. "gantt"), which pass a naive `typeof type === string`
// check but then throw "not a registered controller" at instantiation — leaving
// a silent blank canvas. Gating on this set up front degrades those to the
// honest raw-source fallback instead. (A timeline is better asked for as a
// ```mermaid gantt.) Compared case-insensitively; Chart.js gets the original.
const SUPPORTED_CHART_TYPES = new Set([
	"bar",
	"line",
	"scatter",
	"bubble",
	"pie",
	"doughnut",
	"polararea",
	"radar",
]);

let canvas = $state<HTMLCanvasElement | null>(null);
let chartInstance: ChartInstance | null = null;
let mounted = $state(false);
// Set when Chart.js throws at runtime (a valid type but a bad dataset shape) so
// the template can fall back to the source instead of leaving a blank canvas.
let renderFailed = $state(false);
// Guards against overlapping async instantiations (the dynamic import is async):
// a newer config change bumps the token so a stale in-flight build bails out.
let renderToken = 0;

// Parse + shape-validate synchronously so SSR and the client agree on whether
// this is a renderable chart or the raw-source fallback.
const parsed = $derived.by(
	(): { ok: true; config: unknown } | { ok: false } => {
		// Lenient parse: strict first, then a conservative brace/comma repair so a
		// config that is merely one closing brace short (the common local-model
		// defect) still renders instead of falling back to raw source.
		const value = parseJsonLenient(code);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false };
		}
		const record = value as Record<string, unknown>;
		if (typeof record.type !== "string") return { ok: false };
		if (!SUPPORTED_CHART_TYPES.has(record.type.trim().toLowerCase())) {
			return { ok: false };
		}
		if (!record.data || typeof record.data !== "object") return { ok: false };
		return { ok: true, config: value };
	},
);

async function instantiate(config: unknown) {
	const token = ++renderToken;
	// NB: do NOT read `canvas` synchronously here. This runs inside the render
	// $effect, so a synchronous `canvas` read would make the effect depend on the
	// canvas — and toggling `renderFailed` mounts/unmounts the canvas, which would
	// then re-run the effect in an infinite loop. Read it only after the await.
	try {
		const { default: Chart } = await import("chart.js/auto");
		if (token !== renderToken || !canvas) return; // superseded / unmounted / unbound
		chartInstance?.destroy();
		chartInstance = new Chart(
			canvas,
			// Chart.js validates the concrete config shape at runtime; we only
			// guaranteed `type` + `data` above.
			config as ConstructorParameters<typeof Chart>[1],
		) as unknown as ChartInstance;
	} catch {
		// A Chart.js runtime error (bad dataset shape, etc.) must not crash the
		// message. Surface the raw-source fallback rather than a silent blank canvas.
		if (token !== renderToken) return;
		chartInstance = null;
		renderFailed = true;
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
		// A fresh config is a fresh attempt: clear any prior runtime-failure flag
		// so a config that now parses/renders recovers from the fallback.
		renderFailed = false;
		void instantiate(parsed.config);
	} else {
		teardown();
	}
});
</script>

{#if parsed.ok && !renderFailed}
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
