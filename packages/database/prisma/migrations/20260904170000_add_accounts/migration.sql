-- CreateTable
CREATE TABLE `accounts` (
    `id` CHAR(36) NOT NULL,
    `username` VARCHAR(160) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `role` ENUM('ADMIN', 'USER') NOT NULL DEFAULT 'USER',
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `last_login_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `accounts_username_key`(`username`),
    INDEX `accounts_role_enabled_idx`(`role`, `enabled`),
    PRIMARY KEY (`id`),
    CONSTRAINT `accounts_username_required_check` CHECK (CHAR_LENGTH(TRIM(`username`)) > 0),
    CONSTRAINT `accounts_password_hash_required_check` CHECK (CHAR_LENGTH(`password_hash`) > 0)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
