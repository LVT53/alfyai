import { drivePilotEnabled, gmailPilotEnabled } from "$lib/server/env";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => ({
	drivePilotEnabled: !!locals.user && drivePilotEnabled(locals.user.id),
	gmailPilotEnabled: !!locals.user && gmailPilotEnabled(locals.user.id),
});
