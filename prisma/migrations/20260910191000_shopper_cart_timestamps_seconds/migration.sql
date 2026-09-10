-- Normalize ShopperCart timestamps to unix epoch seconds (plain Int).
-- Previous migration may have left millisecond values that overflow Int.

UPDATE "ShopperCart"
SET
  "createdAt" = CASE
    WHEN "createdAt" > 100000000000 THEN "createdAt" / 1000
    ELSE "createdAt"
  END,
  "updatedAt" = CASE
    WHEN "updatedAt" > 100000000000 THEN "updatedAt" / 1000
    ELSE "updatedAt"
  END;
