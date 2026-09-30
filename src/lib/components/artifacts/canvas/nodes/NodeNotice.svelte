<script lang="ts">
/**
 * What a block says in its own place when it cannot show itself: its content
 * could not be loaded (`LazyNode`) or could not be drawn (`NodeShell`'s
 * boundary), with the one thing a reader can do about it. One card for both, so
 * the two never drift apart and the editor's first paint carries the markup once.
 */
import { t } from "$lib/i18n";

let {
	message,
	testid,
	retry,
}: { message: string; testid: string; retry: () => void } = $props();
</script>

<div class="notice" role="alert" data-testid={testid}>
	<p>{message}</p>
	<button type="button" class="btn-secondary btn-sm nodrag" onclick={retry}>
		{$t("artifacts.canvas.chat.retry")}
	</button>
</div>

<style>
	.notice {
		box-sizing: border-box;
		width: 100%;
		height: 100%;
		padding: 10px 12px;
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.notice p {
		margin: 0 0 6px;
	}
</style>
