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
import { WORKSPACE_CONVERSATION_DELETED_EVENT } from "$lib/client/document-workspace-state";
import HomeSurface from "$lib/components/home/HomeSurface.svelte";
import { landingSendStarted } from "$lib/stores/ui";
import { onMount } from "svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

let summary = $state<HomeSummary>(EMPTY_HOME_SUMMARY);
let summaryLoaded = $state(false);
// Bound to the surface: a send has begun, so the poll below has nothing left
// to usefully refresh while the page hands off to the new chat.
let sendStarted = $state(false);

// The shell's feature-note strip has to disappear the moment a send starts,
// and the send starts down in the composer. Mirror the local flag into the
// shared store; the cleanup is the page handing off, not a dismissal.
$effect(() => {
	landingSendStarted.set(sendStarted);
	return () => landingSendStarted.set(false);
});

// Not state: nothing renders it. A delete reads the summary between polls, so
// two reads can be in flight at once, and only the one started last may land:
// an older answer arriving second would put a just-deleted chat back.
let summaryReadSequence = 0;

async function refreshHomeSummary() {
	const read = ++summaryReadSequence;
	try {
		const next = await fetchHomeSummary();
		if (read === summaryReadSequence) summary = next;
	} catch {
		// The board degrades to a greeting and a composer rather than to an
		// error: none of these strips is something the user asked for.
		if (read === summaryReadSequence) summary = EMPTY_HOME_SUMMARY;
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

	// A chat deleted in the sidebar leaves Recent now, not at the next poll.
	// The store raises the event once the server has deleted it, and the
	// delete has dropped the cached summary, so this read comes back without
	// the chat and with the next one moved up into its place.
	const refreshAfterDelete = () => {
		if (sendStarted) return;
		void refreshHomeSummary();
	};
	window.addEventListener(
		WORKSPACE_CONVERSATION_DELETED_EVENT,
		refreshAfterDelete,
	);
	return () => {
		clearInterval(summaryTimer);
		window.removeEventListener(
			WORKSPACE_CONVERSATION_DELETED_EVENT,
			refreshAfterDelete,
		);
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
