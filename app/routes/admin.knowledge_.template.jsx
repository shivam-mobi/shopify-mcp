import { requireAdminUser } from "../admin/auth.server.js";
import { generateSampleExcelTemplate } from "../services/file-knowledge.server.js";

/**
 * Resource Route: GET /admin/knowledge/template
 * Generates and downloads a dummy sample Excel spreadsheet template (.xlsx)
 * for uploading knowledge base documents.
 *
 * Has NO default export component so React Router treats it as a pure
 * binary resource route, bypassing SSR and avoiding any component rendering errors.
 */
export async function loader({ request }) {
  await requireAdminUser(request);

  const buffer = generateSampleExcelTemplate();

  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="perfumania_knowledge_template.xlsx"',
      "Content-Length": String(buffer.length),
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });
}
