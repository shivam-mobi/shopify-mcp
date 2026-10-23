-- CreateTable
CREATE TABLE `CodeVerifier` (
    `id` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NOT NULL,
    `verifier` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `CodeVerifier_state_idx`(`state` ASC),
    UNIQUE INDEX `CodeVerifier_state_key`(`state` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Conversation` (
    `id` VARCHAR(191) NOT NULL,
    `shopperId` VARCHAR(191) NULL,
    `catalogPaginationCursor` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Conversation_shopperId_idx`(`shopperId` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomerAccountUrls` (
    `id` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NOT NULL,
    `mcpApiUrl` VARCHAR(191) NULL,
    `authorizationUrl` VARCHAR(191) NULL,
    `tokenUrl` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CustomerAccountUrls_conversationId_key`(`conversationId` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomerToken` (
    `id` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NOT NULL,
    `accessToken` TEXT NOT NULL,
    `refreshToken` TEXT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CustomerToken_conversationId_idx`(`conversationId` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LlmRequestLog` (
    `id` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NULL,
    `request` LONGTEXT NOT NULL,
    `response` LONGTEXT NOT NULL,
    `statusCode` INTEGER NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LlmRequestLog_conversationId_idx`(`conversationId` ASC),
    INDEX `LlmRequestLog_createdAt_idx`(`createdAt` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `McpCallLog` (
    `id` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NULL,
    `server` VARCHAR(191) NOT NULL,
    `method` VARCHAR(191) NOT NULL,
    `toolName` VARCHAR(191) NULL,
    `endpoint` VARCHAR(191) NOT NULL,
    `request` LONGTEXT NOT NULL,
    `response` LONGTEXT NOT NULL,
    `statusCode` INTEGER NOT NULL,
    `durationMs` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `McpCallLog_conversationId_idx`(`conversationId` ASC),
    INDEX `McpCallLog_createdAt_idx`(`createdAt` ASC),
    INDEX `McpCallLog_server_idx`(`server` ASC),
    INDEX `McpCallLog_toolName_idx`(`toolName` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Message` (
    `id` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `content` LONGTEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Message_conversationId_idx`(`conversationId` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NOT NULL,
    `isOnline` BOOLEAN NOT NULL DEFAULT false,
    `scope` TEXT NULL,
    `expires` DATETIME(3) NULL,
    `accessToken` VARCHAR(191) NOT NULL,
    `userId` BIGINT NULL,
    `firstName` VARCHAR(191) NULL,
    `lastName` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `accountOwner` BOOLEAN NOT NULL DEFAULT false,
    `locale` VARCHAR(191) NULL,
    `collaborator` BOOLEAN NULL DEFAULT false,
    `emailVerified` BOOLEAN NULL DEFAULT false,

    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShopperCart` (
    `id` VARCHAR(191) NOT NULL,
    `shopifyCustomerId` VARCHAR(191) NULL,
    `customerFirstName` VARCHAR(191) NULL,
    `customerLastName` VARCHAR(191) NULL,
    `customerLoggedIn` BOOLEAN NOT NULL DEFAULT false,
    `activeConversationId` VARCHAR(191) NULL,
    `activeCartId` VARCHAR(191) NULL,
    `activeCheckoutId` VARCHAR(191) NULL,
    `checkoutUrl` TEXT NULL,
    `shippingAddress` TEXT NULL,
    `createdAt` INTEGER NOT NULL,
    `updatedAt` INTEGER NOT NULL,

    INDEX `ShopperCart_activeConversationId_idx`(`activeConversationId` ASC),
    INDEX `ShopperCart_shopifyCustomerId_idx`(`shopifyCustomerId` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShopperSearchMemory` (
    `id` VARCHAR(191) NOT NULL,
    `shopperId` VARCHAR(191) NOT NULL,
    `intent` VARCHAR(191) NOT NULL,
    `vehicleYear` INTEGER NULL,
    `vehicleMake` VARCHAR(191) NULL,
    `vehicleModel` VARCHAR(191) NULL,
    `vehicleEngine` VARCHAR(191) NULL,
    `homeFilterSize` VARCHAR(191) NULL,
    `homeMerv` VARCHAR(191) NULL,
    `useCount` INTEGER NOT NULL DEFAULT 1,
    `lastUsedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ShopperSearchMemory_shopperId_intent_lastUsedAt_idx`(`shopperId` ASC, `intent` ASC, `lastUsedAt` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StoreCustomer` (
    `id` VARCHAR(191) NOT NULL,
    `shopifyCustomerId` VARCHAR(191) NOT NULL,
    `shopDomain` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `firstName` VARCHAR(191) NULL,
    `lastName` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `StoreCustomer_shopDomain_idx`(`shopDomain` ASC),
    UNIQUE INDEX `StoreCustomer_shopifyCustomerId_shopDomain_key`(`shopifyCustomerId` ASC, `shopDomain` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StoreCustomerAddress` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `shopifyAddressId` VARCHAR(191) NULL,
    `firstName` VARCHAR(191) NULL,
    `lastName` VARCHAR(191) NULL,
    `company` VARCHAR(191) NULL,
    `streetAddress` TEXT NOT NULL,
    `extendedAddress` TEXT NULL,
    `addressLocality` TEXT NULL,
    `addressRegion` VARCHAR(191) NULL,
    `postalCode` VARCHAR(191) NULL,
    `addressCountry` VARCHAR(191) NULL,
    `phoneNumber` VARCHAR(191) NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `StoreCustomerAddress_customerId_idx`(`customerId` ASC),
    INDEX `StoreCustomerAddress_shopifyAddressId_idx`(`shopifyAddressId` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StorePolicyDigest` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'default',
    `title` VARCHAR(191) NOT NULL,
    `note` TEXT NULL,
    `digest` LONGTEXT NOT NULL,
    `contentDate` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ToolEmptyResultLog` (
    `id` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NULL,
    `shop` VARCHAR(191) NULL,
    `userQuery` TEXT NOT NULL,
    `toolName` VARCHAR(191) NOT NULL,
    `toolArgs` TEXT NULL,
    `response` TEXT NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ToolEmptyResultLog_conversationId_idx`(`conversationId` ASC),
    INDEX `ToolEmptyResultLog_createdAt_idx`(`createdAt` ASC),
    INDEX `ToolEmptyResultLog_reason_idx`(`reason` ASC),
    INDEX `ToolEmptyResultLog_toolName_idx`(`toolName` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `adminUsers` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `password_hash` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `role` VARCHAR(191) NOT NULL DEFAULT 'admin',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `adminUsers_email_key`(`email` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledgeChunks` (
    `id` VARCHAR(191) NOT NULL,
    `document_id` VARCHAR(191) NOT NULL,
    `chunk_index` INTEGER NOT NULL,
    `content` TEXT NOT NULL,
    `embedding_content` TEXT NULL,
    `token_count` INTEGER NOT NULL DEFAULT 0,
    `embedding` vector(1536) NULL,
    `metadata` JSON NULL,
    `llm_cost` DOUBLE NULL,
    `llm_pricing_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `knowledgeChunks_document_id_fkey`(`document_id` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledgeDocuments` (
    `id` VARCHAR(191) NOT NULL,
    `shopify_graphql_id` VARCHAR(191) NULL,
    `source_id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `base_url` VARCHAR(191) NULL,
    `file_path` VARCHAR(191) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `content` LONGTEXT NOT NULL,
    `chunk_count` INTEGER NOT NULL DEFAULT 0,
    `token_count` INTEGER NOT NULL DEFAULT 0,
    `embedding_tokens` INTEGER NOT NULL DEFAULT 0,
    `embedding_cost_usd` DOUBLE NOT NULL DEFAULT 0,
    `processing_ms` INTEGER NULL,
    `error_message` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `knowledgeDocuments_shopify_graphql_id_key`(`shopify_graphql_id` ASC),
    INDEX `knowledgeDocuments_source_id_fkey`(`source_id` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledgeProcessingLogs` (
    `id` VARCHAR(191) NOT NULL,
    `knowledge_chunk_id` VARCHAR(191) NULL,
    `request` LONGTEXT NOT NULL,
    `response` LONGTEXT NOT NULL,
    `headers` LONGTEXT NULL,
    `status_code` INTEGER NOT NULL,
    `duration_ms` INTEGER NOT NULL,
    `tokens_used` INTEGER NOT NULL DEFAULT 0,
    `cost_usd` DOUBLE NOT NULL DEFAULT 0,
    `llm_pricing_id` VARCHAR(191) NULL,
    `error_message` LONGTEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `knowledgeProcessingLogs_knowledge_chunk_id_fkey`(`knowledge_chunk_id` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledgeSearchResults` (
    `id` VARCHAR(191) NOT NULL,
    `conversation_id` VARCHAR(191) NULL,
    `message_id` VARCHAR(191) NULL,
    `chunk_id` VARCHAR(191) NULL,
    `similarity` DOUBLE NULL,
    `query_text` LONGTEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `knowledgeSearchResults_chunk_id_fkey`(`chunk_id` ASC),
    INDEX `knowledgeSearchResults_conversation_id_idx`(`conversation_id` ASC),
    INDEX `knowledgeSearchResults_message_id_idx`(`message_id` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledgeSources` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `source_type` VARCHAR(191) NOT NULL,
    `base_url` VARCHAR(191) NULL,
    `last_synced_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `knowledgeSources_code_key`(`code` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shopifyEventLogs` (
    `id` VARCHAR(191) NOT NULL,
    `topic` VARCHAR(191) NOT NULL,
    `event_id` VARCHAR(191) NULL,
    `api_version` VARCHAR(191) NULL,
    `payload` LONGTEXT NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'processed',
    `error_message` LONGTEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `shopifyEventLogs_created_at_idx`(`created_at` ASC),
    INDEX `shopifyEventLogs_status_idx`(`status` ASC),
    INDEX `shopifyEventLogs_topic_idx`(`topic` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StoreCustomerAddress` ADD CONSTRAINT `StoreCustomerAddress_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `StoreCustomer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledgeChunks` ADD CONSTRAINT `knowledgeChunks_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `knowledgeDocuments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledgeDocuments` ADD CONSTRAINT `knowledgeDocuments_source_id_fkey` FOREIGN KEY (`source_id`) REFERENCES `knowledgeSources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledgeProcessingLogs` ADD CONSTRAINT `knowledgeProcessingLogs_knowledge_chunk_id_fkey` FOREIGN KEY (`knowledge_chunk_id`) REFERENCES `knowledgeChunks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledgeSearchResults` ADD CONSTRAINT `knowledgeSearchResults_chunk_id_fkey` FOREIGN KEY (`chunk_id`) REFERENCES `knowledgeChunks`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `knowledgeSearchResults` ADD CONSTRAINT `knowledgeSearchResults_message_id_fkey` FOREIGN KEY (`message_id`) REFERENCES `Message`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

