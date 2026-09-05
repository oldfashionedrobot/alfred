CREATE TABLE `completions` (
	`task_id` integer NOT NULL,
	`completed_on` text NOT NULL,
	PRIMARY KEY(`task_id`, `completed_on`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `completions_completed_on_idx` ON `completions` (`completed_on`);--> statement-breakpoint
CREATE TABLE `days` (
	`date` text PRIMARY KEY NOT NULL,
	`mood` text,
	`log` text,
	`task_order` text,
	FOREIGN KEY (`mood`) REFERENCES `moods`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `moods` (
	`slug` text PRIMARY KEY NOT NULL,
	`emoji` text NOT NULL,
	`label` text NOT NULL,
	`sort_order` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_baseline` integer DEFAULT false NOT NULL,
	`cadence` text,
	`planned_date` text,
	`active` integer DEFAULT true NOT NULL
);
