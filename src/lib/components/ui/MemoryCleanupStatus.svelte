<script lang="ts">
import { onMount } from "svelte";
import { t } from "$lib/i18n";
import {
	fetchMemoryCleanupStatus,
	retryMemoryCleanup,
	type MemoryCleanupStatus,
} from "$lib/client/api/settings";
import ErrorMessage from "$lib/components/chat/ErrorMessage.svelte";
let cleanup = $state<MemoryCleanupStatus | null>(null);
let error = $state("");
let busy = $state(false);
let completed = $state(false);
let alive = false;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
function apply(next: MemoryCleanupStatus) {
	completed = Boolean(
		cleanup?.nativeCleanupPending && !next.nativeCleanupPending,
	);
	cleanup = next;
	error = "";
	clearTimeout(timer);
	if (next.nativeCleanupPending) timer = setTimeout(() => void load(), 3000);
}
async function load() {
	const read = ++seq;
	try {
		const result = await fetchMemoryCleanupStatus();
		if (alive && read === seq) apply(result);
	} catch {
		if (alive && read === seq) {
			error = $t("memoryCleanup.loadFailed");
			if (cleanup?.nativeCleanupPending)
				timer = setTimeout(() => void load(), 3000);
		}
	}
}
async function retry(id: string) {
	if (busy) return;
	busy = true;
	try {
		await retryMemoryCleanup(id);
		if (alive) await load();
	} catch {
		if (alive) error = $t("memoryCleanup.failed");
	} finally {
		if (alive) busy = false;
	}
}
onMount(() => {
	alive = true;
	void load();
	window.addEventListener("focus", load);
	window.addEventListener("memory-cleanup-changed", load);
	return () => {
		alive = false;
		++seq;
		clearTimeout(timer);
		window.removeEventListener("focus", load);
		window.removeEventListener("memory-cleanup-changed", load);
	};
});
</script>
{#if error}<ErrorMessage {error} canRetry={!busy} onRetry={()=>void load()} onClose={()=>error=''}/>{/if}
{#if cleanup?.nativeCleanupPending}<div class="cleanup-status" data-testid="memory-cleanup-status"><p role="status">{$t(cleanup.cleanupOperations.some(op=>op.retryable)?'memoryCleanup.failed':'memoryCleanup.pending')}</p>{#each cleanup.cleanupOperations.filter(op=>op.retryable) as operation (operation.id)}<button type="button" class="btn-secondary" disabled={busy} onclick={()=>void retry(operation.id)}>{$t('memoryCleanup.retry')}</button>{/each}</div>{:else if completed}<p class="cleanup-status" role="status">{$t('memoryCleanup.complete')}</p>{/if}
<style>.cleanup-status{padding:12px 0;font-family:var(--font-sans);font-size:13px;line-height:1.6;color:var(--text-muted)}.cleanup-status p{margin:0 0 8px}</style>
