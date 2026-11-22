CREATE TABLE image_search_measurement (
  id INTEGER PRIMARY KEY NOT NULL,
  started_at INTEGER NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
INSERT INTO image_search_measurement(id) VALUES (1);
--> statement-breakpoint
CREATE TABLE image_search_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  is_extra INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX image_search_attempts_turn_idx ON image_search_attempts(conversation_id, turn_id);
--> statement-breakpoint
ALTER TABLE usage_events ADD COLUMN parallel_image_extra INTEGER;
