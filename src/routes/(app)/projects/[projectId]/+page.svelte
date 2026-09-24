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
// its answer rather than guessing from what it sent. Both reads are wrapped in
// `untrack` because seeding a rune from a load value is deliberately a
// snapshot: the page's own state is what changes afterwards, not the load.
let instructionsText = $state(untrack(() => data.project.instructions ?? ""));
let hasInstructions = $state(untrack(() => data.project.hasInstructions));
let instructionsDialogOpen = $state(false);

// `null` until the first read lands, which is what tells `HomeSurface` apart
// "no files" from "not read yet" — the chip must never hide behind a read that
// has not finished.
let projectFiles = $state<ProjectKnowledgeItem[] | null>(null);
let filesDialogOpen = $state(false);

// Consumed once, at the first render of this route: the sidebar's "New chat"
// item is the only thing that sets it (see conversation-session.ts), and it is
// spent by the open rather than read, so a reload does not steal the caret.
const focusComposer = untrack(() =>
	consumeProjectComposerFocus(data.project.id),
);

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
 * "no files" is the one lie that loses the user their way into the modal.
 */
async function refreshProjectFiles(projectId: string): Promise<void> {
	try {
		projectFiles = await fetchProjectFiles(projectId);
	} catch {
		// Left as it was.
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
	files={projectFiles ?? []}
	onRefresh={() => refreshProjectFiles(data.project.id)}
	onClose={() => (filesDialogOpen = false)}
/>
