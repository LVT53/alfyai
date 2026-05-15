ALTER TABLE `inference_providers` ADD COLUMN `rate_limit_fallback_enabled` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `inference_providers` ADD COLUMN `rate_limit_fallback_base_url` text;
--> statement-breakpoint
ALTER TABLE `inference_providers` ADD COLUMN `rate_limit_fallback_api_key_encrypted` text;
--> statement-breakpoint
ALTER TABLE `inference_providers` ADD COLUMN `rate_limit_fallback_api_key_iv` text;
--> statement-breakpoint
ALTER TABLE `inference_providers` ADD COLUMN `rate_limit_fallback_model_name` text;
--> statement-breakpoint
ALTER TABLE `inference_providers` ADD COLUMN `rate_limit_fallback_timeout_ms` integer DEFAULT 10000 NOT NULL;
