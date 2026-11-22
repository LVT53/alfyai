<script lang="ts">
import { AnalyticsCard } from "$lib/components/analytics";
import { t } from "$lib/i18n";
import type { PictureSearchMonth } from "$lib/server/services/image-search-analytics/monthly";
import { uiLanguage } from "$lib/stores/settings";
import { intlLocale } from "$lib/utils/locale";

let {
	data,
	trackingSince,
	currentAllowance,
	currency,
}: {
	data: PictureSearchMonth;
	trackingSince?: string;
	currentAllowance?: number;
	currency: Intl.NumberFormat;
} = $props();

const locale = $derived(intlLocale($uiLanguage));
const number = $derived(new Intl.NumberFormat(locale));
const percent = $derived(
	new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }),
);
const month = $derived(
	new Intl.DateTimeFormat(locale, {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${data.month}-01T00:00:00Z`)),
);
const since = $derived(
	trackingSince
		? new Intl.DateTimeFormat(locale, {
				dateStyle: "long",
				timeZone: "UTC",
			}).format(new Date(trackingSince))
		: "",
);
const budgetRows = $derived([
	{
		label: $t("analytics.pictureAll"),
		list: data.imageListMicros,
		billed: data.imageBilledMicros,
	},
	...(data.coverage === "none"
		? []
		: [
				{
					label: $t("analytics.pictureExtras"),
					list: data.extraListMicros,
					billed: data.extraBilledMicros,
				},
			]),
	{
		label: $t("analytics.pictureAllParallel"),
		list: data.sharedListMicros,
		billed: data.sharedBilledMicros,
	},
]);

function dollars(micros: number) {
	return currency.format(micros / 1_000_000);
}
</script>

<div class="mt-4" data-testid="picture-search-analytics">
	<AnalyticsCard title={$t("analytics.pictureTitle", {month})}>
		<p class="mb-3 text-xs text-text-muted">{$t("analytics.pictureScope")}</p>
		{#if data.coverage === "none"}
			<p class="mb-4 text-sm text-text-muted">{$t("analytics.pictureHistorical")}</p>
		{:else}
			{#if data.coverage === "partial" && since}
				<p class="mb-4 text-sm text-text-muted">{$t("analytics.picturePartial", {date: since})}</p>
			{/if}
			<div class="grid gap-6 sm:grid-cols-2">
				<div>
					<h4 class="settings-label">{$t("analytics.pictureFrequency")}</h4>
					<p class="mt-1 mb-3 font-semibold tabular-nums">
						{$t("analytics.pictureRatio", {searched: number.format(data.searchedTurns), turns: number.format(data.normalChatTurns)})}
						{#if data.normalChatTurns > 0}
							<span class="text-text-muted">({percent.format(data.searchedTurns / data.normalChatTurns)})</span>
						{/if}
					</p>
					<dl class="outcomes">
						<dt>{$t("analytics.pictureAttempts")}</dt><dd>{number.format(data.attempts)}</dd>
						<dt>{$t("analytics.pictureExtra")}</dt><dd>{number.format(data.extraAttempts)}</dd>
						<dt>{$t("analytics.pictureEmpty")}</dt><dd>{number.format(data.empty)}</dd>
						<dt>{$t("analytics.pictureFailed")}</dt><dd>{number.format(data.failed)}</dd>
						<dt>{$t("analytics.pictureCandidates")}</dt><dd>{number.format(data.candidates)}</dd>
					</dl>
				</div>
				<div>
					<h4 class="settings-label mb-3">{$t("analytics.pictureOutcomes")}</h4>
					<dl class="outcomes">
						<dt>{$t("analytics.pictureShown")}</dt><dd>{number.format(data.shown)}</dd>
						<dt>{$t("analytics.pictureLoaded")}</dt><dd>{number.format(data.loaded)}</dd>
						<dt>{$t("analytics.pictureLoadFailed")}</dt><dd>{number.format(data.loadFailed)}</dd>
						<dt>{$t("analytics.pictureUnknown")}</dt><dd>{number.format(data.shown - data.loaded - data.loadFailed)}</dd>
					</dl>
					<p class="mt-3 text-xs text-text-muted">{$t("analytics.pictureOutcomeNote")}</p>
				</div>
			</div>
		{/if}
		<h4 class="settings-label mt-5 mb-2">{$t("analytics.pictureSpend")}</h4>
		<div class="overflow-x-auto">
			<table class="budget w-full text-sm" aria-label={$t("analytics.pictureSpend")}>
				<thead><tr>
					<th scope="col">{$t("analytics.pictureGroup")}</th>
					<th scope="col">{$t("analytics.pictureList")}</th>
					<th scope="col">{$t("analytics.pictureCovered")}</th>
					<th scope="col">{$t("analytics.pictureBilled")}</th>
				</tr></thead>
				<tbody>
					{#each budgetRows as row (row.label)}
						<tr><th scope="row">{row.label}</th><td>{dollars(row.list)}</td><td>{dollars(row.list - row.billed)}</td><td>{dollars(row.billed)}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if data.coverage !== "none" && data.imageCalls > 0}
			<p class="mt-2 text-xs text-text-muted">{$t("analytics.pictureExtraMetered", {all: number.format(data.imageCalls), extra: number.format(data.meteredExtraCalls)})}</p>
		{/if}
		{#if currentAllowance !== undefined}
			<p class="mt-3 text-sm">{$t("analytics.pictureRemaining", {
				remaining: dollars(Math.max(0, currentAllowance - data.sharedListMicros)),
				allowance: dollars(currentAllowance)
			})}</p>
		{/if}
	</AnalyticsCard>
</div>

<style>
	.outcomes { display: grid; grid-template-columns: 1fr auto; gap: .35rem 1rem; font-size: .875rem; }
	.outcomes dt, .budget thead { color: var(--text-muted); }
	.outcomes dd, .budget td { text-align: right; font-variant-numeric: tabular-nums; }
	.budget :is(th, td) { padding: .4rem .5rem; }
	.budget th { font-weight: 500; text-align: right; }
	.budget th:first-child { padding-left: 0; text-align: left; }
	.budget tr { border-bottom: 1px solid var(--border-default); }
</style>
