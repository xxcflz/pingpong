CREATE TABLE `matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` text NOT NULL,
	`player_a_id` integer NOT NULL,
	`player_b_id` integer NOT NULL,
	`winner_id` integer,
	`score_a` integer DEFAULT 0 NOT NULL,
	`score_b` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text CHECK(`end_reason` IN ('score','forfeit_dc','forfeit_afk')),
	`rally_count_max` integer,
	FOREIGN KEY (`player_a_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_b_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`winner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `matches_players_idx` ON `matches` (`player_a_id`,`player_b_id`);--> statement-breakpoint
CREATE INDEX `matches_started_at_idx` ON `matches` (`started_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`discord_id` text NOT NULL,
	`username` text NOT NULL,
	`avatar` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_discord_id_idx` ON `users` (`discord_id`);