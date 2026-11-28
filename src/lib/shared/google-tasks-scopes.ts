export const TASKS_READ_SCOPE =
	"https://www.googleapis.com/auth/tasks.readonly";
export const TASKS_MODIFY_SCOPE = "https://www.googleapis.com/auth/tasks";
export function tasksReadGranted(scopes: readonly string[]): boolean {
	return (
		scopes.includes(TASKS_READ_SCOPE) || scopes.includes(TASKS_MODIFY_SCOPE)
	);
}
