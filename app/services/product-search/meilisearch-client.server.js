import { Meilisearch } from "meilisearch";
import { PRODUCTS_INDEX_UID } from "./products-index.config.js";

let client = null;

export function getMeiliClient() {
  if (!client) {
    const host = process.env.MEILI_HOST || "http://127.0.0.1:7700";
    client = new Meilisearch({ host, apiKey: process.env.MEILI_MASTER_KEY || undefined });
  }
  return client;
}

export function getProductsIndex() {
  return getMeiliClient().index(PRODUCTS_INDEX_UID);
}

/** Waits for a Meilisearch task and throws if it failed. */
export async function waitForTask(enqueued, timeout = 10 * 60 * 1000) {
  const task = await enqueued.waitTask({ timeout, interval: 250 });
  if (task.status !== "succeeded") {
    const reason = task.error ? `${task.error.code}: ${task.error.message}` : task.status;
    throw new Error(`Meilisearch task ${task.uid} (${task.type}) ${reason}`);
  }
  return task;
}
