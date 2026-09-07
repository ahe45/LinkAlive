-- CreateTable
CREATE TABLE `login_sessions` (
    `id` CHAR(36) NOT NULL,
    `account_id` CHAR(36) NOT NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(512) NULL,
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `login_sessions_account_active_idx`(`account_id`, `revoked_at`, `expires_at`),
    INDEX `login_sessions_active_idx`(`revoked_at`, `expires_at`),
    PRIMARY KEY (`id`),
    CONSTRAINT `login_sessions_account_id_fkey`
      FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
      ON DELETE CASCADE ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
