-- "Send with Enter" (Settings > Profile, Preferences): a person's own switch for
-- what Enter does in the message box. Off by default, which is what every
-- account did before the switch existed (Enter writes a new line and
-- Ctrl/Cmd+Enter sends), so an account that is already here keeps its keys.
-- Expand-only: one column, so undoing it is a drop.
ALTER TABLE `users` ADD `send_with_enter` integer DEFAULT false NOT NULL;
