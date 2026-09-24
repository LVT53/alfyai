<script lang="ts">
/**
 * The project page: the landing surface in project mode, plus the one thing
 * the surface cannot own for itself — the Instructions dialog, whose open
 * state, seeded text and save call belong to the route. Everything else (the
 * greeting band, the incognito arm, the composer and its send/draft plumbing)
 * is `HomeSurface`, because forking the home page to add a project would have
 * meant two send paths, two draft flows and two incognito arms.
 */
import { ApiError } from "$lib/client/api/http";
import { saveProjectInstructions } from "$lib/client/api/projects";
import { consumeProjectComposerFocus } from "$lib/client/conversation-session";
import HomeSurface from "$lib/components/home/HomeSurface.svelte";
import InstructionsDialog from "$lib/components/instructions/InstructionsDialog.svelte";
import { t } from "$lib/i18n";
import { untrack } from "svelte";
import {
	type InstructionScope,
	instructionScopeKey,
} from "$lib/shared/instructions";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// The chip under the composer mirrors what is stored, seeded from the load and
// updated from each save's own response: the server decides what "has
// instructions" means (a whitespace-only save is a clear), so the page takes
// its answer rather than guessing from what it sent. The seed is wrapped in
// `untrack` because seeding a rune from a load value is deliberately a
// snapshot: the page's own state is what changes afterwards, not the load.
//
// `/projects/[projectId]` is one route, so opening another project from the
// sidebar is a client-side navigation that reuses this component and changes
// only `data`. A seed captured once would show the previous project's text —
// and Save would write it into the project now on screen — so the effect below
// re-seeds whenever the load hands over a different project.
let seededProjectId = $state(untrack(() => data.project.id));
let instructionsText = $state(untrack(() => data.project.instructions ?? ""));
let hasInstructions = $state(untrack(() => data.project.hasInstructions));
let instructionsDialogOpen = $state(false);

// Taken once per project the page actually shows: the sidebar's "New chat"
// item is the only thing that sets the marker (see conversation-session.ts),
// and it is spent by the open rather than read, so a reload does not steal the
// caret. The same re-seed pass picks it up for the project a navigation
// switched to, which is the only way a reused component can hear a request
// made for the page it is not yet showing.
let focusComposer = $state(
	untrack(() => consumeProjectComposerFocus(data.project.id)),
);

$effect(() => {
	if (seededProjectId === data.project.id) return;
	seededProjectId = data.project.id;
	instructionsText = data.project.instructions ?? "";
	hasInstructions = data.project.hasInstructions;
	focusComposer = consumeProjectComposerFocus(data.project.id);
});

const projectScope = $derived<InstructionScope>({
	kind: "project",
	projectId: data.project.id,
	name: data.project.name,
});
const projectScopes = $derived<InstructionScope[]>([projectScope]);
const instructionTextKey = $derived(instructionScopeKey(projectScope));

// The project's chats, in the shape the shared list draws. `atlasFinished` is
// false because this page's own read does not carry it: the Atlas badge
// belongs to the home board's summary, and inventing one here would mean a
// second query for a mark the mockup does not draw on this page.
const recentChats = $derived(
	data.chats.map((chat) => ({ ...chat, atlasFinished: false })),
);

async function save(payload: {
	scope: InstructionScope;
	text: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const project = await saveProjectInstructions(
			data.project.id,
			payload.text,
		);
		instructionsText = payload.text.trim();
		hasInstructions = project.hasInstructions;
		instructionsDialogOpen = false;
		return { ok: true };
	} catch (error) {
		// The dialog stays open with the text intact. A project deleted while
		// this page was open says so in the reader's own language rather than
		// echoing the endpoint's English; anything else gets the dialog's own
		// localized line by returning an empty error.
		return {
			ok: false,
			error:
				error instanceof ApiError && error.status === 404
					? $t("projects.missing")
					: "",
		};
	}
}
</script>

<svelte:head>
	<title>{data.project.name} · Alfy AI</title>
</svelte:head>

<HomeSurface
	mode={{
		kind: "project",
		project: { id: data.project.id, name: data.project.name },
		chatCount: data.chatCount,
		lastActivityAt: data.lastActivityAt,
	}}
	recent={recentChats}
	projectHasInstructions={hasInstructions}
	{focusComposer}
	onOpenInstructions={() => (instructionsDialogOpen = true)}
	displayName={data.user?.displayName ?? null}
	userId={data.user?.id ?? null}
	isAdmin={data.user?.role === "admin"}
	maxMessageLength={data.maxMessageLength}
	composerCommandRegistryEnabled={data.composerCommandRegistryEnabled}
	atlasAvailability={data.atlasAvailability ?? null}
	initialPersonalityId={data.userPersonality ?? null}
/>

<InstructionsDialog
	open={instructionsDialogOpen}
	scope={projectScope}
	scopes={projectScopes}
	initialText={{ [instructionTextKey]: instructionsText }}
	onSave={save}
	onClose={() => (instructionsDialogOpen = false)}
/>
