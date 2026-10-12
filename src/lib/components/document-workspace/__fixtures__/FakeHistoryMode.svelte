<!--
	Test-only fixture for DocumentWorkspace.history.test.ts: stands in for the lazy
	History mode (`history/history-parts`), which fetches a real version list. Not the
	real thing — do not import this outside test files.
-->
<script lang="ts">
let { onDone, title }: { onDone: () => void; title: string } = $props();
</script>

<section data-testid="fake-history" aria-label={`History of ${title}`}>
	<button type="button" data-testid="fake-history-done" onclick={() => onDone()}>Done</button>
</section>
