<script lang="ts">
import { t } from "$lib/i18n";
import "./analytics.css";
import {
	formatMonthLabel,
	isNextDisabled,
	isPrevDisabled,
	stepMonth,
} from "./month-nav-logic";

interface MonthNavProps {
	/** Chronologically ascending "YYYY-MM" keys. */
	months: string[];
	/** Selected month key, or `null` for all-time. */
	selected: string | null;
	/** Called with the new month key, or `null` for all-time. */
	onChange: (month: string | null) => void;
	/** Optional BCP-47 locale for the month label. */
	locale?: string;
}

let { months, selected, onChange, locale }: MonthNavProps = $props();

let prevDisabled = $derived(isPrevDisabled(months, selected));
let nextDisabled = $derived(isNextDisabled(months, selected));
let label = $derived(
	selected === null
		? $t("analytics.allTime")
		: formatMonthLabel(selected, locale),
);

function goPrev() {
	if (prevDisabled) return;
	onChange(stepMonth(months, selected, -1));
}

function goNext() {
	if (nextDisabled) return;
	onChange(stepMonth(months, selected, 1));
}
</script>

<div class="flex items-center">
	<button
		type="button"
		class="month-nav-btn"
		disabled={prevDisabled}
		aria-label={$t("analytics.previousMonth")}
		onclick={goPrev}
	>
		‹
	</button>
	<span class="month-label">{label}</span>
	<button
		type="button"
		class="month-nav-btn"
		disabled={nextDisabled}
		aria-label={$t("analytics.nextMonth")}
		onclick={goNext}
	>
		›
	</button>
	{#if selected !== null}
		<button
			type="button"
			class="month-alltime-btn"
			onclick={() => onChange(null)}
		>
			{$t("analytics.allTime")}
		</button>
	{/if}
</div>
