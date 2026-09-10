<script lang="ts">
// The left navigator. Thirteen stacked cards became seven named pages plus a
// read-only one; the badge on each page is the number of edits still waiting
// for Save there, so a pending change on another page can never be lost
// silently.
import {
	Activity,
	Bolt,
	Bot,
	Gauge,
	KeyRound,
	Server,
	Settings2,
	SlidersHorizontal,
	Sparkles,
} from "@lucide/svelte";
import { t } from "$lib/i18n";
import { SYSTEM_PAGE_LABEL_KEY, type SystemPageId } from "./pages";
import "./system.css";

let {
	active,
	dirtyByPage = {},
	counts = {},
	onselect,
}: {
	active: SystemPageId;
	dirtyByPage?: Partial<Record<SystemPageId, number>>;
	counts?: Partial<Record<SystemPageId, number>>;
	onselect: (page: SystemPageId) => void;
} = $props();

const ICONS = {
	general: Settings2,
	models: Server,
	aiTasks: Bot,
	integrations: KeyRound,
	limits: Gauge,
	skills: Sparkles,
	advanced: SlidersHorizontal,
	diagnostics: Activity,
} as const;

const EDITABLE: SystemPageId[] = [
	"general",
	"models",
	"aiTasks",
	"integrations",
	"limits",
	"skills",
	"advanced",
];
</script>

<nav class="sys-nav" aria-label={$t('admin.system.nav.a11y')} data-testid="system-nav">
	<span class="sys-nav-group">{$t('admin.system.nav.title')}</span>
	{#each EDITABLE as page (page)}
		{@const Icon = ICONS[page]}
		{@const dirty = dirtyByPage[page] ?? 0}
		<button
			type="button"
			class="sys-nav-item"
			aria-current={active === page ? 'page' : undefined}
			data-testid={`system-nav-${page}`}
			onclick={() => onselect(page)}
		>
			<span class="sys-nav-icon">
				<Icon size={15} strokeWidth={2} aria-hidden="true" />
			</span>
			<span class="sys-nav-name">{$t(SYSTEM_PAGE_LABEL_KEY[page])}</span>
			{#if dirty > 0}
				<span class="sys-nav-badge sys-nav-badge-dirty" data-testid={`system-nav-dirty-${page}`}>
					{dirty}
				</span>
			{:else if counts[page]}
				<span class="sys-nav-badge">{counts[page]}</span>
			{/if}
		</button>
	{/each}

	<span class="sys-nav-group">{$t('admin.system.nav.readOnly')}</span>
	<button
		type="button"
		class="sys-nav-item"
		aria-current={active === 'diagnostics' ? 'page' : undefined}
		data-testid="system-nav-diagnostics"
		onclick={() => onselect('diagnostics')}
	>
		<span class="sys-nav-icon">
			<Activity size={15} strokeWidth={2} aria-hidden="true" />
		</span>
		<span class="sys-nav-name">{$t('admin.system.pages.diagnostics')}</span>
	</button>

	<p class="sys-nav-foot">
		<span class="sys-chip sys-chip-live">
			<Bolt size={9} strokeWidth={2.5} aria-hidden="true" />
			{$t('admin.system.appliesImmediately')}
		</span>
		{$t('admin.system.appliesImmediatelyLegend')}
	</p>
</nav>
