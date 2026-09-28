// The App panel's status-row verify-line text, by verdict (redesign §6.2) —
// shared so `AppBody.svelte`'s own status row and `ToolActivityRow.svelte`'s
// in-chat card fact-check line (Wave 2.5 Step 13) read the exact same
// sentence for the exact same verdict, rather than each keeping its own copy.
//
// `AppVerificationVerdict` is a type-only import from a `$lib/server/*`
// module: erased at build time, so it never puts server runtime code in a
// browser bundle — the same established pattern `client/api/artifacts.ts`
// already uses for this exact type.

import type { I18nKey } from "$lib/i18n";
import type { AppVerificationVerdict } from "$lib/server/services/artifacts/app/verify";

export const APP_VERIFY_LINE_KEYS: Record<AppVerificationVerdict, I18nKey> = {
	clean: "artifacts.app.verify.clean",
	repaired: "artifacts.app.verify.repaired",
	uncertain: "artifacts.app.verify.uncertain",
	unavailable: "artifacts.app.verify.unavailable",
};
