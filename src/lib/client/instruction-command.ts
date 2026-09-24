/**
 * What `/instruction` needs from the browser side, in one place: which scopes
 * the dialog may offer from where the user is standing, the text already saved
 * in each of them, and the write that goes back through the same two routes the
 * Settings row and the project page already use.
 *
 * It lives here rather than in each surface because three of them open this
 * dialog — the home board, a project page, and a chat — and each one would
 * otherwise resolve its own default scope and pick its own endpoint. The
 * surfaces keep what is genuinely theirs: when the dialog opens, and what
 * happens after it saves.
 */
import { ApiError } from "$lib/client/api/http";
import {
	fetchProject,
	saveProjectInstructions,
} from "$lib/client/api/projects";
import {
	fetchUserSettings,
	updateUserPreferences,
} from "$lib/client/api/settings";
import {
	type InstructionScope,
	instructionScopeKey,
} from "$lib/shared/instructions";

export interface InstructionDialogSeed {
	/** The scope the dialog opens on: the project's when there is one. */
	scope: InstructionScope;
	/** Every scope the user may switch to. One entry means no switch. */
	scopes: InstructionScope[];
	/** Saved text per scope, keyed "personal" or `project:<id>`. */
	initialText: Record<string, string>;
}

/**
 * Opens the dialog on a line to append. The scope is a request, not a
 * command: a surface clamps it to the scopes it can actually offer, which is
 * what keeps a suggestion aimed at a since-deleted project from opening an
 * editor over the wrong text.
 *
 * `onSaved` runs only after the write succeeded — that is where the caller
 * records that the user answered an offer, and it must not happen for a save
 * that failed.
 */
export type OpenInstructionDialog = (
	text: string,
	options?: {
		scope?: InstructionScope;
		onSaved?: () => void | Promise<void>;
	},
) => void;

const PERSONAL_SCOPE: InstructionScope = { kind: "personal" };

/**
 * Reads the text the dialog has to show before anything is written.
 *
 * Both reads are awaited before the dialog opens because the dialog seeds its
 * buffers once, from whatever `initialText` holds at that moment: opening first
 * and filling in later would let Save write the appended line over the saved
 * text it never drew. A failed read therefore propagates — the caller decides
 * what to tell the user — rather than opening an empty editor over real text.
 */
export async function loadInstructionDialogSeed(
	projectId: string | null,
): Promise<InstructionDialogSeed> {
	const personalSettings = fetchUserSettings();
	if (!projectId) {
		const settings = await personalSettings;
		return {
			scope: PERSONAL_SCOPE,
			scopes: [PERSONAL_SCOPE],
			initialText: {
				[instructionScopeKey(PERSONAL_SCOPE)]:
					settings.preferences.personalInstructions ?? "",
			},
		};
	}

	// The name comes back with the text: a project scope token without one
	// renders an icon and no label, which is not a scope anybody can read.
	const [settings, project] = await Promise.all([
		personalSettings,
		fetchProject(projectId),
	]);
	const projectScope: InstructionScope = {
		kind: "project",
		projectId: project.id,
		name: project.name,
	};
	return {
		scope: projectScope,
		scopes: [projectScope, PERSONAL_SCOPE],
		initialText: {
			[instructionScopeKey(projectScope)]: project.instructions ?? "",
			[instructionScopeKey(PERSONAL_SCOPE)]:
				settings.preferences.personalInstructions ?? "",
		},
	};
}

export type InstructionSaveOutcome =
	| { ok: true }
	/**
	 * `missing` is the one failure a surface names itself — the project was
	 * deleted while the dialog was open, so "could not save the instructions"
	 * would be misdirection. Everything else is left to the dialog's own line.
	 */
	| { ok: false; missing: boolean };

/** Writes the scope on screen. Only that one — the dialog's own rule. */
export async function saveInstructionScope(
	scope: InstructionScope,
	text: string,
): Promise<InstructionSaveOutcome> {
	try {
		if (scope.kind === "project" && scope.projectId) {
			await saveProjectInstructions(scope.projectId, text);
		} else {
			await updateUserPreferences({ personalInstructions: text });
		}
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			missing: error instanceof ApiError && error.status === 404,
		};
	}
}
