import { requireAdminUser } from "../admin/auth.server";
import { getConversationUserFilters } from "../admin/queries.server";

/**
 * API Resource route for asynchronous user search & lazy loading in conversations filter
 * GET /admin/conversations/users?search=...&page=1&limit=25
 */
export async function loader({ request }) {
  await requireAdminUser(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const limit = parseInt(url.searchParams.get("limit") || "25", 10);
  const selectedUser = url.searchParams.get("selectedUser") || "";

  const data = await getConversationUserFilters({ search, page, limit, selectedUser });
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=5",
    },
  });
}
