import fs from "fs";
import path from "path";
import { requireAdminUser } from "../admin/auth.server.js";
import prisma from "../db.server.js";

/**
 * Resource Route: GET /admin/knowledge/download?docId=...
 * Serves the original uploaded file (PDF, Word doc/docx, Excel) from server storage for downloading.
 */
export async function loader({ request }) {
  await requireAdminUser(request);

  const url = new URL(request.url);
  const docId = url.searchParams.get("docId");

  if (!docId) {
    return new Response("Missing document ID parameter.", { status: 400 });
  }

  const doc = await prisma.knowledgeDocument.findUnique({
    where: { id: docId },
    select: { id: true, title: true, baseUrl: true, filePath: true, content: true },
  });

  if (!doc) {
    return new Response("Knowledge document not found.", { status: 404 });
  }

  let relativePath = doc.filePath;
  if (!relativePath && doc.baseUrl && doc.baseUrl.startsWith("file:")) {
    const match = doc.baseUrl.match(/^file:(?:pdf|doc|docx|excel):([^#]+)/);
    if (match) {
      const filename = match[1];
      const candidate = path.join("uploads", "knowledge", filename);
      relativePath = candidate;
    }
  }

  if (!relativePath) {
    return new Response("No uploaded physical file stored for this document.", { status: 404 });
  }

  const absolutePath = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(process.cwd(), relativePath);

  if (!fs.existsSync(absolutePath)) {
    // If physical file missing but content exists, auto-recreate file on disk
    if (doc.content) {
      const parentDir = path.dirname(absolutePath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      await fs.promises.writeFile(absolutePath, doc.content);
    } else {
      return new Response("Uploaded file could not be found on server disk.", { status: 404 });
    }
  }

  const fileBuffer = await fs.promises.readFile(absolutePath);
  const ext = path.extname(absolutePath).toLowerCase();

  let contentType = "application/octet-stream";
  if (ext === ".pdf") {
    contentType = "application/pdf";
  } else if (ext === ".docx") {
    contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  } else if (ext === ".doc") {
    contentType = "application/msword";
  } else if (ext === ".xlsx") {
    contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  } else if (ext === ".xls") {
    contentType = "application/vnd.ms-excel";
  } else if (ext === ".csv") {
    contentType = "text/csv; charset=utf-8";
  }

  // Strip timestamp prefix for a user-friendly download filename (e.g. 1728900000_my_file.docx -> my_file.docx)
  const diskBasename = path.basename(absolutePath);
  const cleanDownloadName = diskBasename.replace(/^\d+_/, "") || `${doc.title}${ext}`;

  return new Response(fileBuffer, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${cleanDownloadName.replace(/"/g, "")}"`,
      "Content-Length": String(fileBuffer.length),
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
    },
  });
}
