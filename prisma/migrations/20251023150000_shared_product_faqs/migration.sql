-- Shared FAQs: one question/answer row, many products via product_faq_products.

CREATE TABLE `product_faqs_new` (
    `id` VARCHAR(191) NOT NULL,
    `shopify_metaobject_id` VARCHAR(191) NULL,
    `question` TEXT NOT NULL,
    `answer` TEXT NOT NULL,
    `embedding_content` TEXT NULL,
    `embedding` VECTOR(1536) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `product_faqs_shopify_metaobject_id_idx`(`shopify_metaobject_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `product_faqs_new` (`id`, `shopify_metaobject_id`, `question`, `answer`, `embedding_content`, `created_at`, `updated_at`)
SELECT UUID(), ANY_VALUE(`shopify_metaobject_id`), `question`, `answer`, ANY_VALUE(`embedding_content`), MIN(`created_at`), MAX(`updated_at`)
FROM `product_faqs`
GROUP BY `question`, `answer`;

CREATE TABLE `product_faq_products` (
    `id` VARCHAR(191) NOT NULL,
    `product_id` VARCHAR(191) NOT NULL,
    `product_faq_id` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `product_faq_products_product_id_product_faq_id_key`(`product_id`, `product_faq_id`),
    INDEX `product_faq_products_product_faq_id_idx`(`product_faq_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `product_faq_products` (`id`, `product_id`, `product_faq_id`, `position`, `created_at`, `updated_at`)
SELECT UUID(), `p`.`id`, `n`.`id`, MIN(`old`.`position`), MIN(`old`.`created_at`), MAX(`old`.`updated_at`)
FROM `product_faqs` `old`
INNER JOIN `products` `p` ON `p`.`shopify_product_id` = `old`.`shopify_product_id`
INNER JOIN `product_faqs_new` `n` ON `n`.`question` = `old`.`question` AND `n`.`answer` = `old`.`answer`
GROUP BY `p`.`id`, `n`.`id`;

ALTER TABLE `product_faqs` DROP FOREIGN KEY `product_faqs_shopify_product_id_fkey`;
DROP TABLE `product_faqs`;
RENAME TABLE `product_faqs_new` TO `product_faqs`;

ALTER TABLE `product_faq_products` ADD CONSTRAINT `product_faq_products_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `product_faq_products` ADD CONSTRAINT `product_faq_products_product_faq_id_fkey` FOREIGN KEY (`product_faq_id`) REFERENCES `product_faqs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
