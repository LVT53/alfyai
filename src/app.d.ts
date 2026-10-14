declare global {
	namespace App {
		interface Locals {
			user: import("$lib/server/services/auth-types").SessionUser | null;
		}
		/** What a history entry remembers (SvelteKit's shallow routing): which layer of the chat's panel it shows. */
		interface PageState {
			alfyPanel?: import("$lib/client/panel-history").PanelEntry;
		}
	}
}

export {};
