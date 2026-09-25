<script lang="ts">
/**
 * The project page: the landing surface in project mode, plus the two things
 * the surface cannot own for itself — the Instructions dialog and the Files
 * modal, whose open states, seeds and calls belong to the route. Everything
 * else (the greeting band, the incognito arm, the composer and its
 * send/draft plumbing) is `HomeSurface`, because forking the home page to add a
 * project would have meant two send paths, two draft flows and two incognito
 * arms.
 *
 * The project's files are read here and nowhere else in this route: the modal
 * renders what this state holds, and every mutation it makes ends in
 * `refreshProjectFiles`, so the quiet line's count and the modal's list are
 * always the same list — the server's last word on it.
 */
import { ApiError } from "$lib/client/api/http";
import {
	fetchProjectFiles,
	saveProjectInstructions,
} from "$lib/client/api/projects";
import { consumeProjectComposerFocus } from "$lib/client/conversation-session";
import HomeSurface from "$lib/components/home/HomeSurface.svelte";
import InstructionsDialog from "$lib/components/instructions/InstructionsDialog.svelte";
import type { ProjectKnowledgeItem } from "$lib/server/services/knowledge";
import { t } from "$lib/i18n";
import { untrack } from "svelte";
import {
	type InstructionScope,
	instructionScopeKey,
} from "$lib/shared/instructions";
import ProjectFilesDialog from "./_components/ProjectFilesDialog.svelte";
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

// `null` until the first read lands, which is what tells `HomeSurface` and the
// Files modal apart "no files" from "not read yet" — the chip must never hide
// behind a read that has not finished, and the modal must never call a project
// empty before its list has arrived. Handed to both as it is, never as `[]`.
let projectFiles = $state<ProjectKnowledgeItem[] | null>(null);
// True only while `projectFiles` is still `null` because the most recent read
// of it failed, not because one is in flight — see `refreshProjectFiles`. The
// modal cannot tell those two apart from `files` alone, since both leave it
// `null`.
let projectFilesFailed = $state(false);
let filesDialogOpen = $state(false);
// Not state: nothing renders it. It orders the reads by the moment they were
// STARTED, which is the only order the list can trust (see below).
let fileReadSequence = 0;

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
	// The Files modal's `null` means "not read yet" (see `projectFiles`'s own
	// comment); a leftover list from the project just left is worse than that
	// meaning, because it renders as this project's real answer — rows with
	// Remove buttons that would unlink someone else's document. Clearing it
	// here puts the modal back in its loading state until the effect below's
	// read of the project now on screen lands.
	projectFiles = null;
	projectFilesFailed = false;
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

/**
 * Re-read the project's files. A failed read leaves the last answer standing
 * rather than emptying the chip: the previous list was true a moment ago, and
 * "no files" is the one lie that loses the user their way into the modal. The
 * one exception is the FIRST read: with no previous answer to stand on, "left
 * as it was" is `null` forever, which the modal would show as "Loading…"
 * forever too — so a failure with nothing on screen yet is the one case that
 * sets `projectFilesFailed`, for a truthful line instead of an endless spinner.
 *
 * The list is ordered by when a read was STARTED, not by when it answered. A
 * read that began before a removal carries the list from before that removal
 * whatever its latency, and the connection that answers last is not the one
 * carrying the newest truth — a slow first read landing after the removal's own
 * refresh would put the file back on screen, and with it a Remove button for a
 * link that is already gone. So an older answer is dropped, failure included;
 * the same guard covers a navigation to another project, whose reads are newer
 * by the same rule.
 */
async function refreshProjectFiles(projectId: string): Promise<void> {
	const sequence = ++fileReadSequence;
	// A fresh attempt — including a manual retry — goes back to "loading",
	// never straight from one stale error to another.
	projectFilesFailed = false;
	try {
		const files = await fetchProjectFiles(projectId);
		if (sequence !== fileReadSequence) return;
		projectFiles = files;
	} catch {
		if (sequence !== fileReadSequence) return;
		// Left as it was: an answer no newer than the list on screen has nothing
		// to say about it, whether it succeeded or failed. Unless "as it was" is
		// nothing at all, in which case the modal needs to hear that this failed
		// rather than keep waiting for a read that is not coming back.
		if (projectFiles === null) projectFilesFailed = true;
	}
}

function openFilesDialog(): void {
	filesDialogOpen = true;
	void refreshProjectFiles(data.project.id);
}

// Browser-only (an effect never runs during SSR), and re-run if the route's
// project changes under this component — the count belongs to the project in
// the URL, not to the page instance.
$effect(() => {
	const projectId = data.project.id;
	void refreshProjectFiles(projectId);
});
</script>

<svelte:head>
	<title>{data.project.name} · Alfy AI</title>
</svelte:head>

<HomeSurface
	mode={{
		kind: "project",
		project: { id: data.project.id, name: data.project.name },
		fileCount: projectFiles?.length,
		chatCount: data.chatCount,
		lastActivityAt: data.lastActivityAt,
	}}
	recent={recentChats}
	projectHasInstructions={hasInstructions}
	{focusComposer}
	onOpenInstructions={() => (instructionsDialogOpen = true)}
	onOpenFiles={openFilesDialog}
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

<ProjectFilesDialog
	open={filesDialogOpen}
	projectId={data.project.id}
	projectName={data.project.name}
	files={projectFiles}
	filesFailed={projectFilesFailed}
	onRefresh={() => refreshProjectFiles(data.project.id)}
	onClose={() => (filesDialogOpen = false)}
/>
