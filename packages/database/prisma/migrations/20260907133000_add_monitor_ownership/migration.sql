-- AlterTable
ALTER TABLE `monitors` ADD COLUMN `owner_account_id` CHAR(36) NULL;

-- Existing monitors become owned by the oldest active administrator when one exists.
UPDATE `monitors`
SET `owner_account_id` = (
    SELECT `id`
    FROM `accounts`
    WHERE `role` = 'ADMIN' AND `enabled` = true
    ORDER BY `created_at` ASC, `id` ASC
    LIMIT 1
)
WHERE `owner_account_id` IS NULL;

-- CreateIndex
CREATE INDEX `monitors_owner_account_idx` ON `monitors`(`owner_account_id`);

-- AddForeignKey
ALTER TABLE `monitors`
ADD CONSTRAINT `monitors_owner_account_id_fkey`
FOREIGN KEY (`owner_account_id`) REFERENCES `accounts`(`id`)
ON DELETE SET NULL ON UPDATE RESTRICT;
