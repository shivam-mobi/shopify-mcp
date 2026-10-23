-- CreateTable
CREATE TABLE "StoreCustomer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyCustomerId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "email" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StoreCustomerAddress" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "shopifyAddressId" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "company" TEXT,
    "streetAddress" TEXT NOT NULL,
    "extendedAddress" TEXT,
    "addressLocality" TEXT,
    "addressRegion" TEXT,
    "postalCode" TEXT,
    "addressCountry" TEXT,
    "phoneNumber" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoreCustomerAddress_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "StoreCustomer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "StoreCustomer_shopDomain_idx" ON "StoreCustomer"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "StoreCustomer_shopifyCustomerId_shopDomain_key" ON "StoreCustomer"("shopifyCustomerId", "shopDomain");

-- CreateIndex
CREATE INDEX "StoreCustomerAddress_customerId_idx" ON "StoreCustomerAddress"("customerId");

-- CreateIndex
CREATE INDEX "StoreCustomerAddress_shopifyAddressId_idx" ON "StoreCustomerAddress"("shopifyAddressId");
