export const GMAIL_READ_SCOPE =
	"https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_MODIFY_SCOPE =
	"https://www.googleapis.com/auth/gmail.modify";
export function gmailReadGranted(scopes: readonly string[]): boolean {
	return (
		scopes.includes(GMAIL_READ_SCOPE) || scopes.includes(GMAIL_MODIFY_SCOPE)
	);
}
