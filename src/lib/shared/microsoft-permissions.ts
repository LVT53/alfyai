export const MICROSOFT_READ_SCOPES = {
	files: "Files.Read",
	calendar: "Calendars.ReadBasic",
	email: "Mail.Read",
	contacts: "Contacts.Read",
} as const;

export const MICROSOFT_WRITE_SCOPES = {
	files: "Files.ReadWrite",
	calendar: "Calendars.ReadWrite",
	email: "Mail.ReadWrite",
	send: "Mail.Send",
} as const;

export type MicrosoftReadCapability = keyof typeof MICROSOFT_READ_SCOPES;
export type MicrosoftWritePermission = keyof typeof MICROSOFT_WRITE_SCOPES;

export function isMicrosoftReadCapability(
	value: unknown,
): value is MicrosoftReadCapability {
	return (
		typeof value === "string" && Object.hasOwn(MICROSOFT_READ_SCOPES, value)
	);
}

export function isMicrosoftWritePermission(
	value: unknown,
): value is MicrosoftWritePermission {
	return (
		typeof value === "string" && Object.hasOwn(MICROSOFT_WRITE_SCOPES, value)
	);
}

export function microsoftWriteCapability(
	permission: MicrosoftWritePermission,
): MicrosoftReadCapability {
	return permission === "send" ? "email" : permission;
}

export function microsoftReadGranted(
	scopes: readonly string[],
	capability: MicrosoftReadCapability,
): boolean {
	return (
		scopes.includes(MICROSOFT_READ_SCOPES[capability]) ||
		(capability !== "contacts" &&
			scopes.includes(MICROSOFT_WRITE_SCOPES[capability]))
	);
}

export function microsoftCanWrite(
	connection: {
		provider: string;
		allowWrites: boolean;
		capabilities: readonly string[];
		oauthScopes: readonly string[];
	},
	permission: MicrosoftWritePermission,
): boolean {
	const capability = microsoftWriteCapability(permission);
	return (
		connection.provider === "onedrive" &&
		connection.allowWrites &&
		connection.capabilities.includes(capability) &&
		connection.oauthScopes.includes(MICROSOFT_WRITE_SCOPES[permission])
	);
}
