-- CreateTable
CREATE TABLE `note_types` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `note_types_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `note_types` (`id`, `code`, `name`, `position`, `created_at`, `updated_at`) VALUES
(UUID(), 'key', 'Key', 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
(UUID(), 'top', 'Top', 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
(UUID(), 'middle', 'Middle', 2, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
(UUID(), 'base', 'Base', 3, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

ALTER TABLE `product_notes` ADD COLUMN `type_id` VARCHAR(191) NULL;

UPDATE `product_notes` pn
INNER JOIN `note_types` nt ON nt.code = pn.type
SET pn.type_id = nt.id;

DELETE FROM `product_notes` WHERE `type_id` IS NULL;

CREATE UNIQUE INDEX `product_notes_product_id_note_id_type_id_key` ON `product_notes`(`product_id`, `note_id`, `type_id`);
CREATE INDEX `product_notes_product_id_type_id_idx` ON `product_notes`(`product_id`, `type_id`);
CREATE INDEX `product_notes_type_id_idx` ON `product_notes`(`type_id`);

ALTER TABLE `product_notes` DROP INDEX `product_notes_product_id_note_id_type_key`;
ALTER TABLE `product_notes` DROP INDEX `product_notes_type_idx`;
ALTER TABLE `product_notes` DROP INDEX `product_notes_product_id_type_idx`;
ALTER TABLE `product_notes` DROP COLUMN `type`;
ALTER TABLE `product_notes` MODIFY `type_id` VARCHAR(191) NOT NULL;

ALTER TABLE `product_notes` ADD CONSTRAINT `product_notes_type_id_fkey` FOREIGN KEY (`type_id`) REFERENCES `note_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE `shopifyGraphqlLogs` (
    `id` VARCHAR(191) NOT NULL,
    `base_url` TEXT NOT NULL,
    `operation` VARCHAR(191) NULL,
    `request` LONGTEXT NOT NULL,
    `response` LONGTEXT NOT NULL,
    `status_code` INTEGER NOT NULL,
    `duration_ms` INTEGER NOT NULL,
    `error_message` LONGTEXT NULL,
    `file_path` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `shopifyGraphqlLogs_operation_idx`(`operation`),
    INDEX `shopifyGraphqlLogs_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
