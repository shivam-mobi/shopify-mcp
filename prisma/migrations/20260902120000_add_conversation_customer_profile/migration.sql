-- Persist storefront customer name per conversation for LLM context.
ALTER TABLE "Conversation" ADD COLUMN "customerFirstName" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "customerLastName" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "customerLoggedIn" BOOLEAN NOT NULL DEFAULT false;
