<script lang="ts">
/**
 * The Memory page's subject index (layout C, `MemorySubjectIndex`): the scope
 * dropdown and Add, the Overview row, search, two subjects (the Projects one
 * with its tag) and the Earlier row. Counts and previews are content: bars.
 */
import {
	ChevronDown,
	ChevronRight,
	Plus,
	Search,
	Sparkle,
} from "@lucide/svelte";
import { t } from "$lib/i18n";
import DrawnBar from "./DrawnBar.svelte";
import { isLit } from "./drawing-spot";
let {
	lit = null,
	spot = undefined,
}: { lit?: string | null; spot?: string | undefined } = $props();
const subjects = [
	{ word: "memorySubjects.subject.about_you", preview: "78%", tag: false },
	{ word: "memorySubjects.subject.projects", preview: "58%", tag: true },
] as const;
</script>
<section class="drawn-memory" data-drawing-spot={spot} class:drawing-spot-lit={isLit(spot,lit)}>
 <div class="head"><span class="scope">{$t('memoryNew.personal')}<span class="drawn-ic"><ChevronDown size="100%" strokeWidth={1.8} aria-hidden="true"/></span></span><span class="add"><span class="drawn-ic"><Plus size="100%" strokeWidth={1.8} aria-hidden="true"/></span>{$t('memorySubjects.add')}</span></div>
 <div class="overview"><span class="mark"><span class="drawn-ic"><Sparkle size="100%" strokeWidth={1.8} aria-hidden="true"/></span></span><span class="overview-copy"><span class="overview-title">{$t('memorySubjects.overviewPersonal')}</span><span class="overview-hint">{$t('memorySubjects.overviewHint')}</span></span></div>
 <div class="search"><span class="drawn-ic"><Search size="100%" strokeWidth={1.8} aria-hidden="true"/></span>{$t('memorySubjects.search')}</div>
 {#each subjects as subject (subject.word)}<div class="row"><span class="lines"><span class="name">{$t(subject.word)}{#if subject.tag}<span class="tag">{$t('memorySubjects.active')}</span>{/if}</span><DrawnBar width={subject.preview} tone="soft"/></span><span class="count"><DrawnBar width="100%"/><span class="drawn-ic"><ChevronRight size="100%" strokeWidth={1.8} aria-hidden="true"/></span></span></div>{/each}
 <div class="earlier"><span class="drawn-ic"><ChevronRight size="100%" strokeWidth={2} aria-hidden="true"/></span><span class="earlier-word">{$t('memorySubjects.earlier')}</span><DrawnBar width="46%" tone="soft"/></div>
</section>
<style>
.drawn-memory{border:1px solid var(--border-default);border-radius:calc(var(--u)*6);background:var(--surface-elevated);padding:calc(var(--u)*7);font-family:var(--font-sans);color:var(--text-primary);font-size:calc(var(--u)*7)}.head{display:flex;justify-content:space-between;align-items:center;gap:calc(var(--u)*5);margin-bottom:calc(var(--u)*5)}.scope,.add,.search{display:flex;align-items:center;gap:calc(var(--u)*3)}.scope{font-weight:600}.add{border:1px solid var(--border-default);border-radius:calc(var(--u)*3);padding:calc(var(--u)*3)}.drawn-ic{--ic:8;flex:none}.overview{display:flex;align-items:center;gap:calc(var(--u)*5);padding:calc(var(--u)*5);border-radius:calc(var(--u)*5);background:var(--surface-page);margin-bottom:calc(var(--u)*5)}.mark{display:inline-flex;align-items:center;justify-content:center;width:calc(var(--u)*16);height:calc(var(--u)*16);border-radius:calc(var(--u)*4);background:var(--accent-tint);color:var(--accent-text);flex:none}.overview-copy{display:flex;flex-direction:column;gap:calc(var(--u)*1);min-width:0}.overview-title{font-weight:600}.overview-hint{color:var(--text-muted);font-size:calc(var(--u)*6)}.search{padding:calc(var(--u)*4) calc(var(--u)*5);border:1px solid var(--border-default);border-radius:calc(var(--u)*3);color:var(--text-muted);margin-bottom:calc(var(--u)*3)}.row{display:flex;align-items:center;gap:calc(var(--u)*7);padding:calc(var(--u)*5) 0;border-bottom:1px solid var(--border-default)}.lines{display:flex;flex:1;flex-direction:column;gap:calc(var(--u)*3);min-width:0}.name{display:flex;align-items:center;gap:calc(var(--u)*3);font-weight:600}.tag{padding:0 calc(var(--u)*3);border-radius:calc(var(--u)*6);background:var(--accent-tint);color:var(--accent-text);font-weight:500;font-size:calc(var(--u)*6)}.count{display:flex;align-items:center;gap:calc(var(--u)*2);width:calc(var(--u)*14);flex:none}.earlier{display:flex;align-items:center;gap:calc(var(--u)*3);margin-top:calc(var(--u)*5);padding:calc(var(--u)*4) calc(var(--u)*5);border:1px dashed var(--border-default);border-radius:calc(var(--u)*5)}.earlier-word{font-weight:600;flex:none}
</style>
