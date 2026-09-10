// Connections redesign — which connect-wizard variant a provider gets.
//
// Previously this was a nested ternary inside ConnectWizardModal.svelte that
// mixed two different questions: "what connect METHOD does the catalogue
// declare?" and "which of those methods actually needs its own screen?"
// (OwnTracks is catalogued "password-key" but is really a device picker;
// Immich, Plex, GitHub, Apple and CalDAV all share "password-key"/
// "app-password" but ask for completely different things). Pulling it out
// makes the mapping one table that a test can walk, and gives the wizard a
// single exhaustive switch instead of a chain of `initialProvider === '…'`
// branches.
import {
	type ConnectionProvider,
	getProviderCatalogEntry,
} from "./provider-catalog";

export type ConnectWizardVariant =
	/** Hand off to the provider's own consent screen (Google, OneDrive). */
	| "oauth"
	/** Nextcloud Login Flow v2: open a tab, then poll for approval. */
	| "nextcloud"
	/** Mail: pick where the mailbox lives, then one form per answer. */
	| "mail"
	/** Claim one device off the OwnTracks recorder. */
	| "owntracks"
	| "immich"
	| "plex"
	| "github"
	| "apple"
	| "caldav"
	/** Catalogued but with no connect route of its own (CardDAV contacts). */
	| "unavailable";

const EXPLICIT_VARIANTS: Partial<
	Record<ConnectionProvider, ConnectWizardVariant>
> = {
	nextcloud: "nextcloud",
	imap: "mail",
	owntracks: "owntracks",
	immich: "immich",
	plex: "plex",
	github: "github",
	apple: "apple",
	caldav: "caldav",
	contacts: "unavailable",
};

export function connectWizardVariant(
	provider: ConnectionProvider | null,
): ConnectWizardVariant | null {
	if (!provider) return null;
	const explicit = EXPLICIT_VARIANTS[provider];
	if (explicit) return explicit;
	// Everything left is decided by the catalogue's connect method. OAuth is
	// the only one that survives to here; anything else is a provider added to
	// the catalogue without a screen, which reads better as "not available yet"
	// than as a blank dialog.
	return getProviderCatalogEntry(provider).connectMethod === "oauth"
		? "oauth"
		: "unavailable";
}

/**
 * Which mail form to open first. Reconnect always skips the "where is your
 * mailbox?" question: the saved config already holds whatever host and port
 * worked last time, so re-deriving them from the address' domain would be a
 * regression for any mailbox that turned out to need a custom host.
 */
export type MailPath = "alfy" | "gmail" | "other";

export function initialMailStep(isReconnect: boolean): "choose" | MailPath {
	return isReconnect ? "other" : "choose";
}

/**
 * Where the settings-provided integration keys live, so a "not set up on this
 * server yet" state can name the exact page and offer to open it instead of
 * telling a single-user server's owner to ask their administrator — who is
 * the same person.
 *
 * Deep-linked through the settings page's existing `?section=` handler (the
 * same mechanism the tool-health banner uses), not a pane/group query the
 * Administration tab doesn't have.
 */
export const ADMIN_INTEGRATIONS_HREF = "/settings?section=integrations";
