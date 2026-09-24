<script lang="ts">
/**
 * The landing route: the layout's data, the home summary, and nothing else.
 *
 * The surface itself — greeting, incognito arm, composer, drafts, prepared
 * conversation and the board — lives in `HomeSurface.svelte`, because the
 * project page is the same surface in another mode (Workspaces Slice D). The
 * extraction moved code and changed no behaviour.
 */
import {
	EMPTY_HOME_SUMMARY,
	fetchHomeSummary,
	type HomeSummary,
} from "$lib/client/api/home";
import HomeSurface from "$lib/components/home/HomeSurface.svelte";
import { onMount } from "svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

let summary = $state<HomeSummary>(EMPTY_HOME_SUMMARY);
let summaryLoaded = $state(false);
// Bound to the surface: a send has begun, so the poll below has nothing left
// to usefully refresh while the page hands off to the new chat.
let sendStarted = $state(false);

async function refreshHomeSummary() {
	try {
		summary = await fetchHomeSummary();
	} catch {
		// The board degrades to a greeting and a composer rather than to an
		// error: none of these strips is something the user asked for.
		summary = EMPTY_HOME_SUMMARY;
	} finally {
		summaryLoaded = true;
	}
}

onMount(() => {
	void refreshHomeSummary();

	// The summary is cached 30 seconds server-side, so polling faster would
	// only re-read the cache.
	const summaryTimer = setInterval(() => {
		if (sendStarted) return;
		void refreshHomeSummary();
	}, 30_000);
	return () => {
		clearInterval(summaryTimer);
	};
});
</script>

<svelte:head>
	<title>Alfy AI</title>
</svelte:head>

<HomeSurface
	mode={{ kind: "home" }}
	recent={summary.recent}
	weekly={summary.weekly}
	weeklyTotal={summary.weeklyTotal}
	bind:sendStarted
	running={summary.running}
	projects={summary.projects}
	memoryReviewCount={summary.memoryReviewCount}
	memoryReviewNoticeDismissed={summary.memoryReviewNoticeDismissed}
	{summaryLoaded}
	displayName={data.user?.displayName ?? null}
	userId={data.user?.id ?? null}
	isAdmin={data.user?.role === 'admin'}
	maxMessageLength={data.maxMessageLength}
	composerCommandRegistryEnabled={data.composerCommandRegistryEnabled}
	atlasAvailability={data.atlasAvailability ?? null}
	initialPersonalityId={data.userPersonality ?? null}
/>
