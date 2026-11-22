<script lang="ts">
import {
	ArrowUpRight,
	ChevronDown,
	Folder,
	MessageSquare,
	Pencil,
	Trash2,
	UserRound,
} from "@lucide/svelte";
import { slide } from "svelte/transition";
import { conversationDisplayTitle } from "$lib/shared/conversation-title";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import { buildChatSourceMessageHref } from "$lib/client/document-workspace-navigation";
import {
	reducedMotionAware,
	MOTION_DURATION,
	MOTION_EASE,
} from "$lib/utils/motion";
import type { MemoryDetail } from "$lib/memory-types";
let {
	detail,
	scopeLabel,
	disabled,
	onEdit,
	onRemove,
}: {
	detail: MemoryDetail;
	scopeLabel: string;
	disabled: boolean;
	onEdit: () => void;
	onRemove: () => void;
} = $props();
let versionsOpen = $state(false);
const reveal = reducedMotionAware(slide);
function date(value: string) {
	const d = new Date(value);
	return Number.isNaN(d.getTime())
		? $t("memoryNew.unknownDate")
		: new Intl.DateTimeFormat($uiLanguage, { dateStyle: "medium" }).format(d);
}
</script>
<div class="memory-detail" data-testid="memory-detail">
 <section class="memory-card"><header class="memory-card-head"><h2 tabindex="-1" data-memory-heading>{$t('memoryNew.statement')}</h2><button type="button" class="btn-secondary memory-button" onclick={onEdit} disabled={disabled||!detail.canEdit}><Pencil size={15} strokeWidth={1.8} aria-hidden="true"/>{$t('memoryNew.edit')}</button></header><p class="memory-statement">{detail.row.text}</p><footer class="memory-meta"><span>{#if detail.row.ref.scope.kind==='project'}<Folder size={14} strokeWidth={1.8} aria-hidden="true"/>{:else}<UserRound size={14} strokeWidth={1.8} aria-hidden="true"/>{/if}{scopeLabel}</span>{#if detail.row.updatedAt}<time datetime={detail.row.updatedAt}>{date(detail.row.updatedAt)}</time>{/if}</footer></section>
 {#if detail.origin==="manual"||detail.origin==="conversation"||detail.sources.length}
  <section class="memory-card">
   <header class="memory-card-head">
    <div>
     <h3>{$t(detail.origin==="manual"?"memoryNew.addedByYou":"memoryNew.conversation")}</h3>
     {#if detail.versions.length}<p class="memory-description">{$t("memoryNew.editedByYou")}</p>{/if}
    </div>
   </header>
   {#each detail.sources as source (source.id)}
    <div class="memory-source">
     {#if source.available&&source.conversationId&&source.messageId}
      <a class="memory-conversation" href={buildChatSourceMessageHref({conversationId:source.conversationId,assistantMessageId:source.messageId})}>
       <MessageSquare size={17} strokeWidth={1.8} aria-hidden="true"/>
       <span>{conversationDisplayTitle(source.title,$t("chat.untitledConversation"))}</span>
       <ArrowUpRight size={15} strokeWidth={1.8} aria-hidden="true"/>
      </a>
     {:else}
      <p class="memory-description">{$t("memoryNew.evidenceUnavailable")}</p>
     {/if}
     {#if source.available&&source.quote}
      <div class="memory-quotation">
       <div class="memory-caption memory-quotation-meta">
        <span>{$t("memoryNew.youWrote")}</span>
        <time datetime={source.assertedAt}>{date(source.assertedAt)}</time>
       </div>
       <blockquote>{source.quote}</blockquote>
      </div>
     {/if}
    </div>
   {:else}
    {#if detail.origin==="conversation"}
     <div class="memory-source"><p class="memory-description">{$t("memoryNew.evidenceUnavailable")}</p></div>
    {/if}
   {/each}
  </section>
 {/if}
 {#if detail.versions.length}<section class="memory-card"><button type="button" class="memory-disclosure" aria-expanded={versionsOpen} aria-controls="memory-versions" onclick={()=>versionsOpen=!versionsOpen}><span><span class="memory-section-title">{$t('memoryNew.versions')}</span><span class="memory-description">{$t('memoryNew.versionsHelp')}</span></span><ChevronDown size={17} strokeWidth={1.8} class={versionsOpen?'memory-chevron-open':''} aria-hidden="true"/></button>{#if versionsOpen}<div id="memory-versions" transition:reveal={{duration:MOTION_DURATION.emphasis,easing:MOTION_EASE.emphasis}}>{#each detail.versions as version}<div class="memory-version"><div class="memory-meta"><span>{$t('memoryNew.noLongerUsed')}</span><time datetime={version.changedAt}>{date(version.changedAt)}</time></div><p>{version.text}</p></div>{/each}</div>{/if}</section>{/if}
 <section class="memory-removal"><div><h3>{$t('memoryNew.remove')}</h3><p class="memory-description">{$t('memoryNew.conversationsStay')}</p></div><button type="button" class="btn-danger memory-button" onclick={onRemove} disabled={disabled||!detail.canRemove}><Trash2 size={16} strokeWidth={1.8} aria-hidden="true"/>{$t('memoryNew.remove')}</button></section>
</div>
