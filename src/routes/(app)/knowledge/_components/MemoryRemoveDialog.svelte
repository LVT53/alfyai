<script lang="ts">
import { t } from "$lib/i18n";
let {
	text,
	scopeLabel,
	busy,
	disabled,
	onRemove,
	onCancel,
}: {
	text: string;
	scopeLabel: string;
	busy: boolean;
	disabled: boolean;
	onRemove: () => void;
	onCancel: () => void;
} = $props();
</script>
<section class="memory-card memory-form" data-testid="memory-remove" aria-labelledby="memory-remove-title"><div class="memory-caption">{scopeLabel}</div><h2 tabindex="-1" data-memory-heading id="memory-remove-title">{$t('memoryNew.removeTitle')}</h2><p class="memory-description">{$t('memoryNew.removeHelp')}</p><blockquote class="memory-remove-quote">{text}</blockquote><p class="memory-description">{$t('memoryNew.removeAgain')}</p><footer class="memory-form-actions"><button type="button" class="btn-secondary memory-button" onclick={onCancel}>{$t('memoryNew.cancel')}</button><button type="button" class="btn-danger memory-button" onclick={onRemove} disabled={busy||disabled}>{$t(busy?'memoryNew.removing':'memoryNew.remove')}</button></footer></section>
