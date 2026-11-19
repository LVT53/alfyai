<script lang="ts">
/** Quiet Memory list: the real scope dropdown, Add, search and padded rows. */
import { ChevronDown, ChevronRight, Plus, Search } from "@lucide/svelte";
import { t } from "$lib/i18n";
import DrawnBar from "./DrawnBar.svelte";
import { isLit } from "./drawing-spot";
let {
	lit = null,
	spot = undefined,
}: { lit?: string | null; spot?: string | undefined } = $props();
</script>
<section class="drawn-memory" data-drawing-spot={spot} class:drawing-spot-lit={isLit(spot,lit)}>
 <div class="head"><span class="scope">{$t('memoryNew.personal')}<span class="drawn-ic"><ChevronDown size="100%" strokeWidth={1.8} aria-hidden="true"/></span></span><span class="add"><span class="drawn-ic"><Plus size="100%" strokeWidth={1.8} aria-hidden="true"/></span>{$t('memoryNew.add')}</span></div>
 <div class="search"><span class="drawn-ic"><Search size="100%" strokeWidth={1.8} aria-hidden="true"/></span>{$t('memoryNew.search')}</div>
 {#each ['84%','68%','75%'] as width}<div class="row"><span class="lines"><DrawnBar {width}/><DrawnBar width="30%" tone="soft"/></span><span class="drawn-ic"><ChevronRight size="100%" strokeWidth={1.8} aria-hidden="true"/></span></div>{/each}
</section>
<style>
.drawn-memory{border:1px solid var(--border-default);border-radius:calc(var(--u)*6);background:var(--surface-elevated);padding:calc(var(--u)*7);font-family:var(--font-sans);color:var(--text-primary);font-size:calc(var(--u)*7)}.head{display:flex;justify-content:space-between;align-items:center;gap:calc(var(--u)*5);margin-bottom:calc(var(--u)*7)}.scope,.add,.search{display:flex;align-items:center;gap:calc(var(--u)*3)}.scope{font-weight:600}.add{border:1px solid var(--border-default);border-radius:calc(var(--u)*3);padding:calc(var(--u)*3)}.drawn-ic{--ic:8;flex:none}.search{padding:calc(var(--u)*5);border:1px solid var(--border-default);border-radius:calc(var(--u)*3);color:var(--text-muted);margin-bottom:calc(var(--u)*5)}.row{display:flex;align-items:center;gap:calc(var(--u)*7);padding:calc(var(--u)*8) calc(var(--u)*5);border-bottom:1px solid var(--border-default)}.row:last-child{border:0}.lines{display:flex;flex:1;flex-direction:column;gap:calc(var(--u)*4)}
</style>
