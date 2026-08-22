<script lang="ts">
// A3 Stage 2 diagram kind: a ```mermaid fence rendered to SVG. mermaid is heavy
// and needs a live DOM, so it is dynamic-imported LAZILY inside a client-only
// effect (never at module top-level / never during SSR) — it must not block
// first paint of an answer. mermaid renders source → an SVG string, which we
// pass through OUR DOMPurify SVG gate (sanitizeHtml { svg: true }) before {@html}
// injection. A parse error (or any render failure) is caught and degrades to the
// raw source + an error note — it never crashes the message. Server-side and
// pre-render we show a lightweight placeholder.
import { onMount } from "svelte";
import { t } from "$lib/i18n";
import { sanitizeHtml } from "$lib/utils/html-sanitizer";

let { code = "" }: { code?: string } = $props();

const uid = $props.id();

let svgHtml = $state("");
let errored = $state(false);
let mounted = $state(false);

// Lazy-load mermaid + run its one-time init on first render. The dynamic
// import() itself is module-cached by the runtime, so additional diagrams pay
// only a cheap idempotent initialize, never a second download.
type MermaidModule = {
	initialize: (config: Record<string, unknown>) => void;
	render: (id: string, text: string) => Promise<{ svg: string }>;
};
let mermaidPromise: Promise<MermaidModule> | null = null;

async function loadMermaid(): Promise<MermaidModule> {
	if (!mermaidPromise) {
		mermaidPromise = import("mermaid").then((module) => {
			const mermaid = module.default as unknown as MermaidModule;
			mermaid.initialize({
				startOnLoad: false,
				// Strictest posture: mermaid's own DOMPurify pass runs too, and we
				// render pure-SVG labels (htmlLabels:false) so nothing lands in a
				// <foreignObject> that our SVG profile would strip.
				securityLevel: "strict",
				htmlLabels: false,
				flowchart: { htmlLabels: false },
				theme: "default",
			});
			return mermaid;
		});
	}
	return mermaidPromise;
}

let renderToken = 0;

async function renderDiagram(source: string) {
	const token = ++renderToken;
	const trimmed = source.trim();
	if (!trimmed) {
		svgHtml = "";
		errored = false;
		return;
	}
	// A CSS id must not start with a digit; $props.id() can, so prefix it.
	const renderId = `mermaid-${uid}`.replace(/[^a-zA-Z0-9_-]/g, "-");
	try {
		const mermaid = await loadMermaid();
		const { svg } = await mermaid.render(renderId, trimmed);
		if (token !== renderToken) return; // a newer render superseded this one
		// Gate the mermaid SVG through our own sanitizer before injecting it.
		svgHtml = sanitizeHtml(svg, {
			svg: true,
			allowStyleTags: true,
			allowStyleAttributes: true,
		});
		errored = false;
	} catch {
		if (token !== renderToken) return;
		errored = true;
		svgHtml = "";
		// mermaid may leave an orphaned measurement node behind on a parse error.
		if (typeof document !== "undefined") {
			document.getElementById(renderId)?.remove();
			document.getElementById(`d${renderId}`)?.remove();
		}
	}
}

onMount(() => {
	mounted = true;
});

// Client-only (effects never run during SSR). Re-renders if the source changes.
$effect(() => {
	if (!mounted) return;
	void renderDiagram(code);
});
</script>

{#if errored}
  <div class="markdown-diagram-error" role="note">{$t('diagram.mermaidError')}</div>
  <pre class="markdown-diagram-source"><code>{code}</code></pre>
{:else if svgHtml}
  <div class="markdown-mermaid">{@html svgHtml}</div>
{:else}
  <!-- SSR / pre-render placeholder: show the source so there is never a blank gap. -->
  <pre class="markdown-diagram-source markdown-mermaid-placeholder" aria-label={$t('diagram.loading')}><code>{code}</code></pre>
{/if}

<style>
  .markdown-mermaid {
    margin: var(--space-sm) 0;
    max-width: 100%;
    overflow-x: auto;
    text-align: center;
  }

  .markdown-mermaid :global(svg) {
    max-width: 100%;
    height: auto;
  }

  .markdown-diagram-error {
    margin: var(--space-sm) 0 var(--space-2xs, 0.25rem);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .markdown-diagram-source {
    margin: var(--space-sm) 0;
    padding: var(--space-sm);
    border-radius: var(--radius-md, 0.5rem);
    border: 1px solid var(--border-default);
    background: var(--surface-code);
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .markdown-mermaid-placeholder {
    opacity: 0.75;
  }
</style>
