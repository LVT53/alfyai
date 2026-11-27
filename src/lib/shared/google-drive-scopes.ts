export const DRIVE_READ_SCOPE =
	"https://www.googleapis.com/auth/drive.readonly";
export const DRIVE_MODIFY_SCOPE = "https://www.googleapis.com/auth/drive";
export function driveReadGranted(scopes: readonly string[]): boolean {
	return (
		scopes.includes(DRIVE_READ_SCOPE) || scopes.includes(DRIVE_MODIFY_SCOPE)
	);
}
