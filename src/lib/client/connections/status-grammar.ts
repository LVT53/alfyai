// Connections redesign — ONE visual grammar for every connection state.
//
// The old panel used three grammars for a single axis: a healthy connection
// rendered nothing at all, a broken one rendered an icon whose only
// explanation was a `title` tooltip (invisible on touch), and a disconnected
// one rendered a text chip. Here every state is the same three things — a
// coloured dot, a word, and a sentence saying what happened and when — and
// every non-healthy state also names the one action that fixes it.
//
// This module owns that derivation as pure data (i18n keys + already-
// formatted params, never rendered strings) so it can be tested without a
// component and reused by the settings row, the detail dialog and the chat
// composer's account list alike.
import type { ConnectionPublic } from "$lib/client/api/connections";
import type { I18nKey } from "$lib/i18n";
import { type Capability, getProviderCatalogEntry } from "./provider-catalog";

export type StatusTone = "ok" | "warn" | "danger" | "muted";

export type StatusRecoveryKind = "signIn" | "fix" | "connectAgain";

export type ConnectionStatusGrammar = {
	tone: StatusTone;
	/** The one word in the status column: "Connected", "Turned off", … */
	word: I18nKey;
	/** The sentence underneath it, saying what happened and when. */
	sentence: I18nKey;
	sentenceParams: Record<string, string>;
	/**
	 * The single action that fixes this state, or null when nothing is wrong.
	 * `kind` is what the caller does with it (all three re-run the connect
	 * wizard in reconnect mode); the label differs because "Fix this" and
	 * "Connect again" are not the same promise.
	 */
	recovery: { kind: StatusRecoveryKind; label: I18nKey } | null;
	/**
	 * The provider's own error string, if any. Never part of the sentence —
	 * it is backend phrasing, so it belongs behind a "What went wrong?"
	 * disclosure, not in the row.
	 */
	technicalDetail: string | null;
};

export type GrammarFormatters = {
	/** "12 minutes ago" — for a time close enough to still feel like now. */
	relative: (epochSeconds: number) => string;
	/** "8 September" — for a date far enough away to be a landmark. */
	date: (epochSeconds: number) => string;
	/** "09:14 today" — for a failure precise enough to correlate with. */
	dateTime: (epochSeconds: number) => string;
};

const DAY_SECONDS = 86_400;

function toLocale(language: string): string {
	return language === "hu" ? "hu-HU" : "en-GB";
}

// Deliberately not reusing $lib/utils/time's formatRelativeTime: that one is
// hard-coded to en-US and emits "3 hour ago"/"Yesterday" fragments that can't
// be dropped into a Hungarian sentence. Intl.RelativeTimeFormat gives both
// languages a correct phrase for free.
export function makeGrammarFormatters(
	language: string,
	now: () => number = () => Date.now(),
): GrammarFormatters {
	const locale = toLocale(language);
	const relativeFormat = new Intl.RelativeTimeFormat(locale, {
		numeric: "auto",
	});
	const dateFormat = new Intl.DateTimeFormat(locale, {
		day: "numeric",
		month: "long",
	});
	const dateTimeFormat = new Intl.DateTimeFormat(locale, {
		day: "numeric",
		month: "long",
		hour: "2-digit",
		minute: "2-digit",
	});

	return {
		relative(epochSeconds) {
			const deltaSeconds = Math.round(epochSeconds - now() / 1000);
			const absolute = Math.abs(deltaSeconds);
			if (absolute < 60) return relativeFormat.format(deltaSeconds, "second");
			if (absolute < 3600) {
				return relativeFormat.format(Math.round(deltaSeconds / 60), "minute");
			}
			if (absolute < DAY_SECONDS) {
				return relativeFormat.format(Math.round(deltaSeconds / 3600), "hour");
			}
			if (absolute < 30 * DAY_SECONDS) {
				return relativeFormat.format(
					Math.round(deltaSeconds / DAY_SECONDS),
					"day",
				);
			}
			return dateFormat.format(epochSeconds * 1000);
		},
		date(epochSeconds) {
			return dateFormat.format(epochSeconds * 1000);
		},
		dateTime(epochSeconds) {
			return dateTimeFormat.format(epochSeconds * 1000);
		},
	};
}

/**
 * The row's whole status column, derived from the connection alone.
 *
 * Every branch has a no-timestamp fallback: a connection that has never been
 * read through, or one whose status has never changed since it was created,
 * gets a sentence that simply doesn't name a time. Inventing one from
 * `updatedAt` would be worse than saying less — that field also moves when
 * the user flips a capability switch.
 */
export function connectionStatusGrammar(
	conn: Pick<
		ConnectionPublic,
		"provider" | "status" | "statusDetail" | "createdAt"
	> & {
		lastUsedAt?: number | null;
		statusChangedAt?: number | null;
	},
	formatters: GrammarFormatters,
): ConnectionStatusGrammar {
	const provider = getProviderCatalogEntry(conn.provider).displayName;
	const technicalDetail = conn.statusDetail?.trim() || null;

	switch (conn.status) {
		case "connected": {
			if (conn.lastUsedAt) {
				return {
					tone: "ok",
					word: "connections.status.connected",
					sentence: "connections.status.sentence.lastUsed",
					sentenceParams: { when: formatters.relative(conn.lastUsedAt) },
					recovery: null,
					technicalDetail: null,
				};
			}
			return {
				tone: "ok",
				word: "connections.status.connected",
				sentence: "connections.status.sentence.readyNotUsedYet",
				sentenceParams: { when: formatters.date(conn.createdAt) },
				recovery: null,
				technicalDetail: null,
			};
		}
		case "needs_reauth": {
			return {
				tone: "warn",
				word: "connections.status.needsSignIn",
				sentence: conn.statusChangedAt
					? "connections.status.sentence.needsSignInOn"
					: "connections.status.sentence.needsSignIn",
				sentenceParams: {
					provider,
					...(conn.statusChangedAt
						? { when: formatters.date(conn.statusChangedAt) }
						: {}),
				},
				recovery: { kind: "signIn", label: "connections.actions.signInAgain" },
				technicalDetail,
			};
		}
		case "error": {
			return {
				tone: "danger",
				word: "connections.status.unreachable",
				sentence: conn.statusChangedAt
					? "connections.status.sentence.unreachableAt"
					: "connections.status.sentence.unreachable",
				sentenceParams: {
					provider,
					...(conn.statusChangedAt
						? { when: formatters.dateTime(conn.statusChangedAt) }
						: {}),
				},
				recovery: { kind: "fix", label: "connections.actions.fixThis" },
				technicalDetail,
			};
		}
		default: {
			return {
				tone: "muted",
				word: "connections.status.turnedOff",
				sentence: conn.statusChangedAt
					? "connections.status.sentence.turnedOffOn"
					: "connections.status.sentence.turnedOff",
				sentenceParams: conn.statusChangedAt
					? { when: formatters.date(conn.statusChangedAt) }
					: {},
				recovery: {
					kind: "connectAgain",
					label: "connections.actions.connectAgain",
				},
				technicalDetail,
			};
		}
	}
}

// ── Capabilities: granted vs enabled vs catalogued ──────────────

/**
 * What the provider actually granted. Falls back to the provider's whole
 * catalogue when the server didn't say (an older response, or a fixture),
 * which is the pre-redesign behaviour — never claim a capability was denied
 * on missing information.
 */
export function grantedCapabilitiesOf(
	conn: Pick<ConnectionPublic, "provider"> & {
		grantedCapabilities?: string[];
	},
): Capability[] {
	const catalogue = getProviderCatalogEntry(conn.provider).capabilities;
	if (!conn.grantedCapabilities) return [...catalogue];
	const granted = new Set(conn.grantedCapabilities);
	return catalogue.filter((capability) => granted.has(capability));
}

/** Catalogued but not granted — the greyed "Ask again" lines. */
export function deniedCapabilitiesOf(
	conn: Pick<ConnectionPublic, "provider"> & {
		grantedCapabilities?: string[];
	},
): Capability[] {
	const granted = new Set(grantedCapabilitiesOf(conn));
	return getProviderCatalogEntry(conn.provider).capabilities.filter(
		(capability) => !granted.has(capability),
	);
}

export type CapabilityChipState = "on" | "off" | "denied";

export type CapabilityChip =
	| { kind: "capability"; capability: Capability; state: CapabilityChipState }
	| { kind: "writes"; variant: "folders"; folderCount: number }
	| { kind: "writes"; variant: "drafts" }
	| { kind: "writes"; variant: "confirm" };

/**
 * The chip row under a connection's name. A capability the user switched off
 * is quiet; one the provider refused says so ("Contacts — not allowed"),
 * because those two look identical today and mean completely different things.
 *
 * A writable connection with writes ON gets one extra chip, because "Alfy may
 * change this account" is the single most consequential thing a row can say
 * and it was previously invisible from the list.
 */
export function capabilityChipsOf(
	conn: Pick<
		ConnectionPublic,
		"provider" | "capabilities" | "allowWrites" | "writeAllowlist"
	> & { grantedCapabilities?: string[] },
): CapabilityChip[] {
	const entry = getProviderCatalogEntry(conn.provider);
	const granted = new Set(grantedCapabilitiesOf(conn));
	const enabled = new Set(conn.capabilities);

	const chips: CapabilityChip[] = entry.capabilities.map((capability) => ({
		kind: "capability" as const,
		capability,
		state: !granted.has(capability)
			? ("denied" as const)
			: enabled.has(capability)
				? ("on" as const)
				: ("off" as const),
	}));

	if (entry.writable && conn.allowWrites) {
		if (entry.pathBasedWrites) {
			chips.push({
				kind: "writes",
				variant: "folders",
				folderCount: conn.writeAllowlist.length,
			});
		} else if (conn.provider === "imap") {
			// A mailbox's writes are drafts, and saying so is more useful than
			// the generic word "writes" on the one provider where people worry
			// most about something being sent on their behalf.
			chips.push({ kind: "writes", variant: "drafts" });
		} else {
			chips.push({ kind: "writes", variant: "confirm" });
		}
	}

	return chips;
}
