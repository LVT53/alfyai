<script lang="ts">
import { t } from "$lib/i18n";
import { ChevronDown } from "@lucide/svelte";
import { slide } from "svelte/transition";
import {
	reducedMotionAware,
	MOTION_DURATION,
	MOTION_EASE,
} from "$lib/utils/motion";
let {
	draft = $bindable(""),
	savedText,
	scopeLabel,
	busy,
	disabled,
	onSave,
	onDraftChange,
	onCancel,
}: {
	draft: string;
	savedText: string | null;
	scopeLabel: string;
	busy: boolean;
	disabled: boolean;
	onSave: () => void;
	onDraftChange: (value: string) => void;
	onCancel: () => void;
} = $props();
let compare = $state(false);
const reveal = reducedMotionAware(slide);
</script>
<form class="memory-card memory-form" data-testid="memory-editor" onsubmit={event=>{event.preventDefault();if(!disabled&&draft.trim())onSave();}}>
 <div class="memory-caption">{scopeLabel}</div><h2 tabindex="-1" data-memory-heading>{$t(savedText===null?'memoryNew.add':'memoryNew.editTitle')}</h2><p class="memory-description">{$t(savedText===null?'memoryNew.addHelp':'memoryNew.editHelp')}</p>
 <label for="memory-draft" class="memory-section-title">{$t('memoryNew.statement')}</label><textarea id="memory-draft" bind:value={draft} oninput={event=>onDraftChange(event.currentTarget.value)} required disabled={busy} rows="6"></textarea>
 {#if savedText!==null}<div class="memory-comparison"><button class="memory-disclosure" type="button" aria-expanded={compare} aria-controls="memory-saved-wording" onclick={()=>compare=!compare}><span>{$t('memoryNew.savedVersion')}</span><ChevronDown size={16} strokeWidth={1.8} class={compare?'memory-chevron-open':''} aria-hidden="true"/></button>{#if compare}<p id="memory-saved-wording" transition:reveal={{duration:MOTION_DURATION.emphasis,easing:MOTION_EASE.emphasis}}>{savedText}</p>{/if}</div>{/if}
 <footer class="memory-form-actions"><button type="button" class="btn-secondary memory-button" onclick={onCancel}>{$t('memoryNew.cancel')}</button><button type="submit" class="btn-primary memory-button" disabled={disabled||!draft.trim()}>{$t(busy?'memoryNew.saving':'memoryNew.save')}</button></footer>
</form>
