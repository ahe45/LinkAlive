-- AlterTable
ALTER TABLE `monitors` ADD COLUMN `network_unknown_since` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `notification_outbox` MODIFY `monitor_id` CHAR(36) NULL,
    MODIFY `event_type` ENUM('DOWN', 'RECOVERY', 'RESOLVED_SUMMARY', 'TEST', 'NETWORK_RECOVERY') NOT NULL;

-- CreateTable
CREATE TABLE `network_settings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `urls` JSON NOT NULL,
    `channel_ids` JSON NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `network_observers` (
    `id` VARCHAR(160) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'UNKNOWN',
    `checked_at` DATETIME(3) NULL,
    `probe_results` JSON NULL,
    `active_outage_id` CHAR(36) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `network_outages` (
    `id` CHAR(36) NOT NULL,
    `observer_id` VARCHAR(160) NOT NULL,
    `started_at` DATETIME(3) NOT NULL,
    `recovered_at` DATETIME(3) NULL,
    `canceled_at` DATETIME(3) NULL,
    `summarized_at` DATETIME(3) NULL,
    `channel_ids` JSON NOT NULL,

    INDEX `network_outages_observer_started_idx`(`observer_id`, `started_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `network_observations` (
    `outage_id` CHAR(36) NOT NULL,
    `monitor_id` CHAR(36) NOT NULL,
    `config_version` INTEGER NOT NULL,
    `rechecked_at` DATETIME(3) NULL,
    `outcome` VARCHAR(32) NULL,

    INDEX `network_observations_monitor_idx`(`monitor_id`, `rechecked_at`),
    PRIMARY KEY (`outage_id`, `monitor_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `network_outages` ADD CONSTRAINT `network_outages_observer_id_fkey` FOREIGN KEY (`observer_id`) REFERENCES `network_observers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `network_observations` ADD CONSTRAINT `network_observations_outage_id_fkey` FOREIGN KEY (`outage_id`) REFERENCES `network_outages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `network_observations` ADD CONSTRAINT `network_observations_monitor_id_fkey` FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
