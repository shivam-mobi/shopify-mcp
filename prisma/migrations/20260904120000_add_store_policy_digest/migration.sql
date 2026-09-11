-- CreateTable
CREATE TABLE "StorePolicyDigest" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "title" TEXT NOT NULL,
    "note" TEXT,
    "digest" TEXT NOT NULL,
    "contentDate" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed default manishclothes policy digest
INSERT INTO "StorePolicyDigest" ("id", "title", "note", "digest", "contentDate", "createdAt", "updatedAt")
VALUES (
  'default',
  'manishclothes store policy cheat sheet',
  'Returned when Shopify search_shop_policies_and_faqs is empty. Prefer these quick facts; do not invent policy details.',
  'manishclothes quick facts — use these before inventing anything. Store: https://manishclothes.myshopify.com/

CONTACT: No public support email or phone is published on the storefront. Direct customers to https://manishclothes.myshopify.com/ or their Shopify account. Do not invent an email or phone number.

PRODUCTS: Online shop named manishclothes. Navigation: Home, Catalog, Search By Make. Published products include clothing (e.g. tshirt for men with color/size variants) and gift cards. Search the live catalog for what is in stock — do not invent product names, prices, or categories.

CURRENCY: Storefront shows INR (₹) as the selected currency, with GBP and USD also available in the currency selector.

PAYMENTS: Footer lists Visa, Mastercard, American Express, PayPal, Diners Club, and Discover.

SHIPPING / WHERE WE DELIVER: No shipping policy page is published. Do NOT invent countries, transit times, P.O. Box rules, or exclusions. Do NOT say the store does not ship to India or Asia. If asked where you ship, say availability and cost are shown at checkout, and you do not have a published country list.

CANCEL ORDER: No cancel policy is published. Do not invent a before-dispatch rule. If asked, say they should check their order status in their account or contact the store through the website.

RETURNS / REFUNDS: A Return Order page exists at https://manishclothes.myshopify.com/pages/return-order but it has no published policy text. Do NOT invent a 30-day window, prepaid labels, or country-specific refund rules.

WARRANTY: No warranty page is published. Do not invent product warranties.

PRIVACY: No privacy policy page is published. Do not invent privacy/legal details.

TERMS: No terms of service page is published. Do not invent terms, company legal names, or subscription-cancel rules.',
  '2026-09-11',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
