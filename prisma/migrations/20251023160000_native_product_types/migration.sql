-- Rebuild product_types from native Shopify product.productType (products.shopify_product_type),
-- then drop the duplicated text column.

UPDATE `products` SET `product_type_id` = NULL;

DELETE FROM `product_types`;

INSERT INTO `product_types` (`id`, `name`, `created_at`, `updated_at`)
SELECT UUID(), `shopify_product_type`, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `products`
WHERE `shopify_product_type` IS NOT NULL AND TRIM(`shopify_product_type`) <> ''
GROUP BY `shopify_product_type`;

UPDATE `products` `p`
INNER JOIN `product_types` `pt` ON `pt`.`name` = `p`.`shopify_product_type`
SET `p`.`product_type_id` = `pt`.`id`;

ALTER TABLE `products` DROP COLUMN `shopify_product_type`;
