-- Drop the "conversation:" prefix; use raw conversation id as shopperKey fallback.
-- Example: conversation:1787547406172 -> 1787547406172

UPDATE "ShopperCart"
SET "shopperKey" = substr("shopperKey", 14)
WHERE "shopperKey" LIKE 'conversation:%';

UPDATE "Conversation"
SET "shopperKey" = substr("shopperKey", 14)
WHERE "shopperKey" LIKE 'conversation:%';
