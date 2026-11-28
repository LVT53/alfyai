import { drivePilotEnabled, gmailPilotEnabled } from "$lib/server/env";
import {
	GMAIL_MODIFY_SCOPE,
	GMAIL_READ_SCOPE,
	gmailReadGranted,
} from "$lib/shared/gmail-scopes";
import {
	DRIVE_MODIFY_SCOPE,
	DRIVE_READ_SCOPE,
	driveReadGranted,
} from "$lib/shared/google-drive-scopes";
import {
	TASKS_MODIFY_SCOPE,
	TASKS_READ_SCOPE,
	tasksReadGranted,
} from "$lib/shared/google-tasks-scopes";
export const optionalGoogleServices = {
	tasks: {
		enabled: () => true,
		readScope: TASKS_READ_SCOPE,
		writeScope: TASKS_MODIFY_SCOPE,
		canRead: tasksReadGranted,
		writeOption: "requestTasksEditing",
	},
	email: {
		enabled: gmailPilotEnabled,
		readScope: GMAIL_READ_SCOPE,
		writeScope: GMAIL_MODIFY_SCOPE,
		canRead: gmailReadGranted,
		writeOption: "requestGmailEditing",
	},
	files: {
		enabled: drivePilotEnabled,
		readScope: DRIVE_READ_SCOPE,
		writeScope: DRIVE_MODIFY_SCOPE,
		canRead: driveReadGranted,
		writeOption: "requestDriveEditing",
	},
} as const;
export type OptionalGoogleCapability = keyof typeof optionalGoogleServices;
export function isOptionalGoogleCapability(
	cap: string,
): cap is OptionalGoogleCapability {
	return Object.hasOwn(optionalGoogleServices, cap);
}
export function googleScopeGranted(
	scope: string,
	grants: readonly string[],
): boolean {
	if (grants.includes(scope)) return true;
	return Object.values(optionalGoogleServices).some(
		(service) => service.readScope === scope && service.canRead(grants),
	);
}
