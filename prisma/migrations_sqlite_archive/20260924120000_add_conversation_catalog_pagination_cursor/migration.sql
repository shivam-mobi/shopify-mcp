-- Persist catalog search pagination cursor per conversation (LLM cursor rewrite on "show more").
ALTER TABLE "Conversation" ADD COLUMN "catalogPaginationCursor" TEXT;
