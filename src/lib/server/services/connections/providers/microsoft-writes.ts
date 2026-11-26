import { registerWriteExecutor } from "../write-executors";
import { executeOneDriveFileWrite } from "./onedrive-file-writes";
import { executeOutlookCalendarWrite } from "./outlook-calendar-writes";
import { executeOutlookMailWrite } from "./outlook-mail-writes";

registerWriteExecutor({
	provider: "onedrive",
	execute(userId, connectionId, op, content, opts) {
		if (op.action.startsWith("files."))
			return executeOneDriveFileWrite(userId, connectionId, op, content, opts);
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
