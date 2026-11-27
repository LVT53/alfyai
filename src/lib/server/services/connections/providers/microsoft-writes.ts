import { registerWriteExecutor } from "../write-executors";
import { executeOneDriveFileWrite } from "./onedrive-file-writes";
import { executeOutlookCalendarWrite } from "./outlook-calendar-writes";
import { executeOutlookMailWrite } from "./outlook-mail-writes";
import { executeTeamsChannelFileWrite } from "./teams-channel-files";

import { executeTeamsWrite } from "./teams-messaging";

registerWriteExecutor({
	provider: "onedrive",
	execute(userId, connectionId, op, content, opts) {
		if (op.action.startsWith("files.") && op.target?.teamsChannel)
			return executeTeamsChannelFileWrite(
				userId,
				connectionId,
				op,
				content,
				opts,
			);
		if (op.action.startsWith("files."))
			return executeOneDriveFileWrite(userId, connectionId, op, content, opts);
		if (op.action.startsWith("teams."))
			return executeTeamsWrite(userId, connectionId, op, content, opts);
		if (op.action.startsWith("calendar."))
			return executeOutlookCalendarWrite(
				userId,
				connectionId,
				op,
				content,
				opts,
			);
		if (op.action.startsWith("email."))
			return executeOutlookMailWrite(userId, connectionId, op, content, opts);
		return Promise.resolve({ ok: false, reason: "unsupported_operation" });
	},
});
