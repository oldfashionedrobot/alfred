-- Ownership: users, and a user_id on the two tables that hold personal data.
--
-- HAND-WRITTEN over the generated version, which could not run. drizzle-kit
-- emitted `SELECT "user_id" ... FROM days` for a table that has no such column
-- yet, and `ALTER TABLE tasks ADD user_id integer NOT NULL` — which SQLite
-- refuses whatever the row count, because a NOT NULL column needs a default it
-- was not given. Both tables are rebuilt below with the value supplied by the
-- SELECT instead.
--
-- `completions` is untouched: a completion belongs to whoever owns its task.
-- `moods` is untouched: a vocabulary, not anybody's data.

CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
-- id 1 explicitly. It is who the app resolves to when auth is off — development
-- and the whole test suite — and it is who inherits every row written before
-- there were users at all, which is why this runs before the rebuilds.
--
-- The empty hash never verifies, so this account cannot be logged into until
-- `bun run user:add owner` gives it a password.
INSERT INTO `users` (`id`, `username`, `password_hash`, `active`) VALUES (1, 'owner', '', 1);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_days` (
	`user_id` integer NOT NULL,
	`date` text NOT NULL,
	`mood` text,
	`log` text,
	`task_order` text,
	PRIMARY KEY(`user_id`, `date`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mood`) REFERENCES `moods`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_days`("user_id", "date", "mood", "log", "task_order") SELECT 1, "date", "mood", "log", "task_order" FROM `days`;--> statement-breakpoint
DROP TABLE `days`;--> statement-breakpoint
ALTER TABLE `__new_days` RENAME TO `days`;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`is_baseline` integer DEFAULT false NOT NULL,
	`cadence` text,
	`planned_date` text,
	`color` text,
	`category` text,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Ids are copied rather than reassigned: completions reference them, and this
-- runs with foreign_keys off, so a renumber here would silently orphan history.
INSERT INTO `__new_tasks`("id", "user_id", "name", "is_baseline", "cadence", "planned_date", "color", "category", "active") SELECT "id", 1, "name", "is_baseline", "cadence", "planned_date", "color", "category", "active" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tasks_user_id_idx` ON `tasks` (`user_id`);
