import { gmailPilotEnabled } from "$lib/server/env";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => ({
	gmailPilotEnabled: !!locals.user && gmailPilotEnabled(locals.user.id),
});
