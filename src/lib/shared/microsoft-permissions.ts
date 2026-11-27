export const MICROSOFT_READ_SCOPES = {
	files: "Files.Read",
	calendar: "Calendars.ReadBasic",
	email: "Mail.Read",
	contacts: "Contacts.Read",
	teams_chat: "Chat.Read",
	teams_channels: "ChannelMessage.Read.All",
	teams_files: "Files.Read.All",
} as const;

export const MICROSOFT_WRITE_SCOPES = {
	files: "Files.ReadWrite",
	calendar: "Calendars.ReadWrite",
	email: "Mail.ReadWrite",
	send: "Mail.Send",
	teams_chat: "ChatMessage.Send",
	teams_channels: "ChannelMessage.Send",
	teams_files: "Files.ReadWrite.All",
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

export function isTeamsCapability(
	value: string,
): value is "teams_chat" | "teams_channels" | "teams_files" {
	return (
		value === "teams_chat" ||
		value === "teams_channels" ||
		value === "teams_files"
	);
}
export const TEAMS_DISCOVERY_SCOPES = [
	"Team.ReadBasic.All",
	"Channel.ReadBasic.All",
] as const;
export function microsoftReadGranted(
	scopes: readonly string[],
	capability: MicrosoftReadCapability,
): boolean {
	if (isTeamsCapability(capability)) {
		if (
			capability !== "teams_chat" &&
			!TEAMS_DISCOVERY_SCOPES.every((scope) => scopes.includes(scope))
		)
			return false;
		return (
			scopes.includes(MICROSOFT_READ_SCOPES[capability]) ||
			(capability === "teams_files" &&
				scopes.includes(MICROSOFT_WRITE_SCOPES.teams_files))
		);
	}
	return (
		scopes.includes(MICROSOFT_READ_SCOPES[capability]) ||
		(capability !== "contacts" &&
			scopes.includes(MICROSOFT_WRITE_SCOPES[capability]))
	);
}

export function microsoftCanWrite(
	connection: {
		provider: string;
		config?: Record<string, unknown>;
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
		(!isTeamsCapability(capability) ||
			(connection.config?.microsoftOrganizationAccount === true &&
				microsoftReadGranted(connection.oauthScopes, capability))) &&
		connection.capabilities.includes(capability) &&
		connection.oauthScopes.includes(MICROSOFT_WRITE_SCOPES[permission])
	);
}
