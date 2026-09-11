/**
 * The composer bar and the "+" menu, as arithmetic.
 *
 * Everyday redesign, Composer board — Direction B ("three icons, honest
 * states") for the bar, with Direction A's menu behind the plus. Three things
 * stay on the bar because they are the three you reach for mid-sentence —
 * attach, accounts, thinking — and everything else moved into the menu.
 *
 * Two rules govern what the bar draws, and both live here rather than in the
 * markup so they can be stated once and tested without a DOM:
 *
 *  1. An icon that is ON is a filled accent disc, not a tinted glyph. The old
 *     bar recoloured a 19px outline, which is a hue shift on a hairline —
 *     unreadable at a glance and invisible to anyone who does not already
 *     know what the resting colour was.
 *  2. A count appears only when there is one to show. The bare "0" bubble on
 *     the accounts plug was the clearest symptom of the old bar: a number
 *     that existed in order to say nothing.
 *
 * The tooltips follow from the same state: each names the control AND what it
 * is currently doing ("Accounts — 2 of 3 on for this message"), so one hover
 * answers both "what is this" and "is it on".
 */

/** The three controls that stay on the bar. */
export type ComposerBarIcon = "attach" | "accounts" | "thinking";

/**
 * A tooltip, as a key plus its parameters. Returned rather than resolved so
 * this module stays free of the i18n store and the component keeps ownership
 * of translation — the same split the command parser already uses.
 */
export interface ComposerTooltip {
	key: string;
	params?: Record<string, string | number>;
}

/**
 * The count badge on the accounts icon — or nothing.
 *
 * Zero is not a badge. With no accounts on, the icon is already in its
 * resting (unfilled) state, which says the same thing without asking anyone
 * to read a digit.
 */
export function accountsBadge(onCount: number): number | null {
	return onCount > 0 ? onCount : null;
}

/**
 * Whether the attach icon is filled.
 *
 * It fills while there is a document on the message — an uploaded attachment
 * or a linked document — so the bar and the chip above it say the same thing,
 * and clearing either one clears both.
 */
export function attachIsOn(
	attachmentCount: number,
	linkedDocumentCount: number,
): boolean {
	return attachmentCount + linkedDocumentCount > 0;
}

/** Whether the accounts icon is filled: connected, and at least one on. */
export function accountsIsOn(
	hasConnections: boolean,
	onCount: number,
): boolean {
	return hasConnections && onCount > 0;
}

export function attachTooltip(
	canAttach: boolean,
	attachmentCount: number,
	linkedDocumentCount: number,
): ComposerTooltip {
	if (!canAttach) return { key: "composerBar.attachUnavailable" };
	const total = attachmentCount + linkedDocumentCount;
	if (total === 0) return { key: "composerBar.attachOff" };
	return { key: "composerBar.attachOn", params: { count: total } };
}

export function accountsTooltip(
	hasConnections: boolean,
	onCount: number,
	totalCount: number,
): ComposerTooltip {
	if (!hasConnections) return { key: "composerBar.accountsNone" };
	if (onCount === 0) return { key: "composerBar.accountsOff" };
	return {
		key: "composerBar.accountsOn",
		params: { on: onCount, total: totalCount },
	};
}

export function thinkingTooltip(on: boolean): ComposerTooltip {
	return { key: on ? "composerBar.thinkingOn" : "composerBar.thinkingOff" };
}

// ── The "+" menu ─────────────────────────────────────────────────────
//
// One menu holds everything the composer can do, in the order the board
// draws it: the actions this message can take, then the switches, then the
// accounts, then the two settings that are about the conversation rather than
// the message. The row list is built here so the markup and the keyboard
// navigation are driven by the same array — a menu whose arrow keys walk a
// different list than the one on screen is the classic way this breaks.

export type ComposerMenuRowKind =
	/** Does something and closes the menu (Attach file). */
	| "action"
	/** Opens a picker of its own (Skills, Atlas report, Model, Style). */
	| "nav"
	/** Flips in place; the menu stays open (Web search, Thinking, Incognito). */
	| "switch"
	/** Leaves for somewhere else (Manage connections). */
	| "link";

export interface ComposerMenuRow {
	id: string;
	kind: ComposerMenuRowKind;
	/** Rows sharing a section are drawn under one heading. */
	section: "message" | "switches" | "accounts" | "conversation";
	/** Per-account rows carry the account they switch. */
	accountId?: string;
	/** A row that is visible but cannot be chosen (Atlas while unconfigured). */
	disabled?: boolean;
}

export interface ComposerMenuInput {
	canAttach: boolean;
	skillsEnabled: boolean;
	atlasVisible: boolean;
	atlasAvailable: boolean;
	thinkingAvailable: boolean;
	hasConnections: boolean;
	readyAccountIds: readonly string[];
	personalityCount: number;
}

/**
 * The rows the menu shows, in order.
 *
 * Everything that can be absent is absent rather than disabled, with one
 * exception: Atlas, which stays visible and disabled when the deployment has
 * not configured it, because the reason ("no Parallel key") is worth stating
 * and a missing row cannot state anything.
 */
export function buildComposerMenuRows(
	input: ComposerMenuInput,
): ComposerMenuRow[] {
	const rows: ComposerMenuRow[] = [];

	rows.push({ id: "attach", kind: "action", section: "message" });
	if (input.skillsEnabled) {
		rows.push({ id: "skills", kind: "nav", section: "message" });
	}
	if (input.atlasVisible) {
		rows.push({
			id: "atlas",
			kind: "nav",
			section: "message",
			disabled: !input.atlasAvailable,
		});
	}

	rows.push({ id: "web-search", kind: "switch", section: "switches" });
	if (input.thinkingAvailable) {
		rows.push({ id: "thinking", kind: "switch", section: "switches" });
	}
	rows.push({ id: "incognito", kind: "switch", section: "switches" });

	if (input.hasConnections) {
		rows.push({ id: "accounts-master", kind: "switch", section: "accounts" });
		for (const accountId of input.readyAccountIds) {
			rows.push({
				id: `account:${accountId}`,
				kind: "switch",
				section: "accounts",
				accountId,
			});
		}
	}
	rows.push({ id: "manage-connections", kind: "link", section: "accounts" });

	rows.push({ id: "model", kind: "nav", section: "conversation" });
	if (input.personalityCount > 0) {
		rows.push({ id: "style", kind: "nav", section: "conversation" });
	}

	return rows;
}

/** True when this row is the first of its section — i.e. wants a heading. */
export function isSectionStart(
	rows: ComposerMenuRow[],
	index: number,
): boolean {
	if (index === 0) return true;
	return rows[index].section !== rows[index - 1].section;
}

/**
 * Where the arrow keys move focus.
 *
 * Returns the next index, or `null` when the key is not one this menu owns —
 * so the caller knows whether to swallow the event. Wraps at both ends
 * (a menu with a dead end at the bottom makes you travel the whole list to
 * reach the row above the one you are on), and skips disabled rows so Atlas
 * cannot swallow focus while it is unconfigured.
 */
export function nextMenuIndex(
	rows: readonly { disabled?: boolean }[],
	current: number,
	key: string,
): number | null {
	const selectable = rows
		.map((row, index) => ({ row, index }))
		.filter((entry) => !entry.row.disabled)
		.map((entry) => entry.index);
	if (selectable.length === 0) return null;

	if (key === "Home") return selectable[0];
	if (key === "End") return selectable[selectable.length - 1];

	const step = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
	if (step === 0) return null;

	// Where we are in the *selectable* list, or just before its start so that
	// a first ArrowDown lands on the first row.
	const position = selectable.indexOf(current);
	if (position === -1) return step === 1 ? selectable[0] : selectable.at(-1);

	const next = (position + step + selectable.length) % selectable.length;
	return selectable[next];
}
