import fs from "fs";
import path from "path";
import * as xlsx from "xlsx";
import { PDFParse } from "pdf-parse";
import prisma from "../db.server.js";
import { chunkText, generateEmbeddingsForChunks } from "./knowledge-sync.server.js";

/**
 * Ensure the KnowledgeSource record for file uploads exists in the database.
 */
export async function getOrCreateFileUploadSource() {
  return await prisma.knowledgeSource.upsert({
    where: { code: "file_upload" },
    update: {
      name: "Uploaded Files (PDF, Word & Excel)",
      sourceType: "file_upload",
    },
    create: {
      code: "file_upload",
      name: "Uploaded Files (PDF, Word & Excel)",
      sourceType: "file_upload",
      baseUrl: null,
    },
  });
}

/**
 * Persists an uploaded binary buffer to a dedicated folder on disk.
 * @param {Buffer} buffer
 * @param {string} originalFilename
 * @returns {Promise<{ relativePath: string, absolutePath: string, diskFilename: string }>}
 */
export async function saveUploadedFileToDisk(buffer, originalFilename) {
  const uploadDir = path.join(process.cwd(), "uploads", "knowledge");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const ext = path.extname(originalFilename).toLowerCase();
  const rawBase = path.basename(originalFilename, ext);
  const safeBase = rawBase.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
  const diskFilename = `${Date.now()}_${safeBase || "uploaded_file"}${ext}`;

  const relativePath = path.join("uploads", "knowledge", diskFilename);
  const absolutePath = path.join(process.cwd(), relativePath);

  await fs.promises.writeFile(absolutePath, buffer);

  return {
    relativePath,
    absolutePath,
    diskFilename,
  };
}

/**
 * Generate a professional sample Excel template buffer with instructions and realistic sample rows.
 * @returns {Buffer}
 */
export function generateSampleExcelTemplate() {
  const wb = xlsx.utils.book_new();

  // Sheet 1: Knowledge Data (Sample content for Perfumania)
  const sampleKnowledgeData = [
    {
      Title: "Perfumania 100% Authenticity Guarantee",
      Content:
        "Perfumania guarantees that 100% of the fragrances sold are authentic designer originals. We source directly from authorized fragrance houses and verified distributors. We strictly never sell imitations, knockoffs, refurbished perfumes, or expired items.",
    },
    {
      Title: "Fragrance Concentrations & Longevity (EDT vs EDP vs Parfum)",
      Content:
        "Fragrance longevity depends on oil concentration: Eau de Cologne (EDC) contains 2-4% fragrance oils and lasts 2-3 hours; Eau de Toilette (EDT) contains 5-15% oils and lasts 4-7 hours; Eau de Parfum (EDP) contains 15-20% oils and lasts 8-12 hours; Pure Parfum/Extrait contains 20-40% oils and lasts 12-24+ hours on skin and clothes.",
    },
    {
      Title: "Perfumania Shipping Rates and Delivery Timelines",
      Content:
        "Perfumania ships across the contiguous 48 US states. Standard ground shipping is FREE on orders with a subtotal over $59, or $7.50 flat rate for orders under $59. Estimated delivery is 3-5 business days. Express 2-Day delivery is available for $14.99 on select items. Orders to Alaska and Hawaii have a standard shipping fee of $29.00.",
    },
    {
      Title: "Perfumania 30-Day Return & Refund Policy",
      Content:
        "Unopened and unused merchandise in its original packaging with original cellowrap may be returned within 30 days of delivery for a full refund. Cosmetics, hair care, and skincare items are final sale for hygiene reasons. Returns must be shipped to the online distribution center; retail store locations cannot accept online order returns.",
    },
    {
      Title: "Perf Perks Loyalty Rewards Program",
      Content:
        "Perf Perks allows members to earn rewards points on every in-store and online purchase. Every 100 points can be redeemed for $1 off your order. Membership tiers: Bronze (0-749 points) earns 3 points per $1; Silver (750-5,999 points) earns 6 points per $1; and Gold (6,000+ points) earns 8 points per $1.",
    },
  ];

  const wsData = xlsx.utils.json_to_sheet(sampleKnowledgeData);
  // Auto-fit column widths (Title, Content)
  wsData["!cols"] = [
    { wch: 45 }, // Title
    { wch: 100 }, // Content
  ];
  xlsx.utils.book_append_sheet(wb, wsData, "Knowledge Data");

  // Sheet 2: Instructions and formatting guidelines
  const instructions = [
    {
      Field: "Title",
      Required: "Yes",
      Description: "The title, headline, or question for this knowledge document. Each row in this Excel file is imported as an individual document in the knowledge base.",
      Example: "Perfumania 100% Authenticity Guarantee",
    },
    {
      Field: "Content",
      Required: "Yes",
      Description: "The full explanatory text, fragrance description, or policy answer used for AI semantic retrieval and chunking.",
      Example: "Perfumania guarantees that 100% of the fragrances sold are authentic designer originals...",
    },
  ];

  const wsInst = xlsx.utils.json_to_sheet(instructions);
  wsInst["!cols"] = [
    { wch: 18 },
    { wch: 12 },
    { wch: 80 },
    { wch: 55 },
  ];
  xlsx.utils.book_append_sheet(wb, wsInst, "Instructions");

  return xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
}

/**
 * Extract clean text content from a PDF Buffer.
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<{ text: string, numPages: number }>}
 */
export async function parsePdfBuffer(buffer, filename) {
  if (!buffer || buffer.length === 0) {
    throw new Error("Uploaded PDF file is empty.");
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const rawText = (result.text || "").trim();

    if (!rawText) {
      throw new Error(`No extractable text found in PDF "${filename}". The PDF may contain scanned images or be password protected.`);
    }

    // Clean whitespace and line endings while preserving paragraphs
    const cleanedText = rawText
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+/g, " ")
      .trim();

    return {
      text: cleanedText,
      numPages: result.total || 1,
    };
  } finally {
    if (typeof parser.destroy === "function") {
      try {
        await parser.destroy();
      } catch (_) {}
    }
  }
}

/**
 * Extract clean text content from a Word .docx Buffer.
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<{ text: string }>}
 */
export async function parseDocxBuffer(buffer, filename) {
  if (!buffer || buffer.length === 0) {
    throw new Error("Uploaded Word document is empty.");
  }

  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  const rawText = (result.value || "").trim();

  if (!rawText) {
    throw new Error(
      `No extractable text found in Word document "${filename}". The document may contain only images or be empty.`
    );
  }

  const cleanedText = rawText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  return { text: cleanedText };
}

/**
 * Extract clean text content from a legacy Word .doc Buffer.
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<{ text: string }>}
 */
export async function parseDocBuffer(buffer, filename) {
  if (!buffer || buffer.length === 0) {
    throw new Error("Uploaded Word document is empty.");
  }

  const WordExtractorMod = await import("word-extractor");
  const WordExtractor = WordExtractorMod.default || WordExtractorMod;
  const extractor = new WordExtractor();
  const extracted = await extractor.extract(buffer);
  const rawText = (extracted.getBody() || "").trim();

  if (!rawText) {
    throw new Error(
      `No extractable text found in Word document "${filename}".`
    );
  }

  const cleanedText = rawText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  return { text: cleanedText };
}

/**
 * Helper to find column value case-insensitively
 */
function getRowValue(row, possibleKeys) {
  const rowKeys = Object.keys(row);
  for (const pattern of possibleKeys) {
    const matchedKey = rowKeys.find((k) => k.trim().toLowerCase() === pattern.toLowerCase());
    if (matchedKey && row[matchedKey] !== undefined && row[matchedKey] !== null) {
      const val = String(row[matchedKey]).trim();
      if (val) return val;
    }
  }
  return "";
}

/**
 * Extract structured knowledge items from an Excel Buffer (.xlsx, .xls, .csv).
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Array<{ title: string, content: string, category: string, referenceUrl: string, sheetName: string, rowIndex: number }>}
 */
export function parseExcelBuffer(buffer, filename) {
  if (!buffer || buffer.length === 0) {
    throw new Error("Uploaded Excel file is empty.");
  }

  const workbook = xlsx.read(buffer, { type: "buffer" });
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error(`No sheets found in Excel file "${filename}".`);
  }

  const items = [];
  const cleanFilename = filename.replace(/\.(xlsx|xls|csv)$/i, "").replace(/[_-]/g, " ");

  // Filter out instruction sheets if multiple sheets exist
  let targetSheetNames = workbook.SheetNames;
  if (workbook.SheetNames.length > 1) {
    const dataSheets = workbook.SheetNames.filter(
      (name) => !/^(instructions|readme|help|notes|about)$/i.test(name.trim())
    );
    if (dataSheets.length > 0) {
      targetSheetNames = dataSheets;
    }
  }

  for (const sheetName of targetSheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
    if (!rows || rows.length === 0) continue;

    const firstRow = rows[0];
    const rowKeys = Object.keys(firstRow);

    // Check if the sheet has recognizable Title or Content columns
    const hasTitleCol = rowKeys.some((k) =>
      /^(title|name|headline|question|topic|subject|item)$/i.test(k.trim())
    );
    const hasContentCol = rowKeys.some((k) =>
      /^(content|body|description|text|answer|details|information|specs|notes)$/i.test(k.trim())
    );

    if (hasTitleCol || hasContentCol) {
      // Process each row as an individual Knowledge Item
      for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx];
        const rowTitle = getRowValue(row, ["Title", "Name", "Headline", "Question", "Topic", "Subject", "Item"]);
        const rowContent = getRowValue(row, ["Content", "Body", "Description", "Text", "Answer", "Details", "Information", "Notes", "Specs"]);
        const rowCategory = getRowValue(row, ["Category", "Section", "Topic", "Type", "Department"]);
        const rowKeywords = getRowValue(row, ["Keywords", "Tags", "Key Words"]);
        const rowUrl = getRowValue(row, ["Reference URL", "Reference", "URL", "Link", "Source URL", "Page URL"]);

        if (!rowTitle && !rowContent) continue; // Skip empty row

        const title = rowTitle || `${cleanFilename} (${sheetName}) - Row ${idx + 1}`;

        // Build composite readable text representation
        let fullContent = "";
        if (rowCategory) fullContent += `[Category: ${rowCategory}]\n\n`;
        fullContent += rowContent || rowTitle;
        if (rowKeywords) fullContent += `\n\nKeywords: ${rowKeywords}`;
        if (rowUrl) fullContent += `\n\nReference URL: ${rowUrl}`;

        items.push({
          title,
          content: fullContent.trim(),
          category: rowCategory,
          referenceUrl: rowUrl,
          sheetName,
          rowIndex: idx + 1,
        });
      }
    } else {
      // General tabular data: convert entire sheet into readable structured Markdown table
      const headerLine = `| ${rowKeys.join(" | ")} |`;
      const dividerLine = `| ${rowKeys.map(() => "---").join(" | ")} |`;
      const dataLines = rows.map((r) => {
        const values = rowKeys.map((k) => String(r[k] || "").replace(/\|/g, "\\|"));
        return `| ${values.join(" | ")} |`;
      });

      const tableContent = [
        `# Spreadsheet Table: ${sheetName} (${cleanFilename})`,
        "",
        headerLine,
        dividerLine,
        ...dataLines,
      ].join("\n");

      items.push({
        title: targetSheetNames.length === 1 ? cleanFilename : `${cleanFilename} - ${sheetName}`,
        content: tableContent,
        category: "Spreadsheet Data",
        referenceUrl: "",
        sheetName,
        rowIndex: 1,
      });
    }
  }

  if (items.length === 0) {
    throw new Error(`No data rows could be extracted from Excel file "${filename}".`);
  }

  return items;
}

/**
 * Slugify a string for safe ID construction
 */
function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 50);
}

/**
 * Process an uploaded PDF or Excel file into KnowledgeDocuments and KnowledgeChunks with vector embeddings.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer - Uploaded file binary buffer
 * @param {string} params.filename - Original uploaded file name
 * @param {string} [params.customTitle] - Optional user override title
 * @param {number} [params.chunkSize=2000] - Character chunk size
 * @param {number} [params.overlap=500] - Chunk overlap in characters
 * @param {boolean} [params.generateEmbeddings=true] - Whether to generate vector embeddings
 * @returns {Promise<{ success: boolean, fileType: "pdf" | "excel", filename: string, documentsCreated: number, totalChunksCreated: number, totalTokens: number }>}
 */
export async function processUploadedFile({
  buffer,
  filename,
  customTitle = "",
  chunkSize = 2000,
  overlap = 500,
  generateEmbeddings = true,
}) {
  if (!buffer || buffer.length === 0) {
    throw new Error("No file content received.");
  }
  if (!filename) {
    throw new Error("File name is missing.");
  }

  const ext = filename.split(".").pop().toLowerCase();
  const isPdf = ext === "pdf";
  const isWord = ["docx", "doc"].includes(ext);
  const isExcel = ["xlsx", "xls", "csv"].includes(ext);

  if (!isPdf && !isWord && !isExcel) {
    throw new Error(`Unsupported file format ".${ext}". Please upload a Word (.docx, .doc), PDF (.pdf), or Excel (.xlsx, .xls, .csv) file.`);
  }

  // 1. Persist uploaded file to server storage directory
  const savedFile = await saveUploadedFileToDisk(buffer, filename);

  // Ensure file_upload KnowledgeSource exists
  const source = await getOrCreateFileUploadSource();
  const now = Date.now();
  const fileType = isPdf ? "pdf" : isWord ? "word" : "excel";

  let createdDocuments = [];
  let totalChunksCreated = 0;
  let totalTokens = 0;
  const chunksToEmbed = [];

  if (isPdf) {
    // 2. Parse PDF
    const { text, numPages } = await parsePdfBuffer(buffer, filename);
    const cleanName = filename.replace(/\.pdf$/i, "").replace(/[_-]/g, " ");
    const docTitle = customTitle.trim() || cleanName;

    // Create KnowledgeDocument
    const doc = await prisma.knowledgeDocument.create({
      data: {
        sourceId: source.id,
        title: docTitle,
        baseUrl: `file:pdf:${filename}`,
        filePath: savedFile.relativePath,
        shopifyGraphqlId: `file:pdf:${now}-${slugify(filename)}`,
        content: text,
        version: 1,
      },
    });

    // Chunk text
    const chunks = chunkText(text, Number(chunkSize) || 2000, Number(overlap) || 500);
    const createdChunks = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkContent = chunks[i];
      const approxTokens = Math.ceil(chunkContent.length / 4);

      const chunk = await prisma.knowledgeChunk.create({
        data: {
          documentId: doc.id,
          chunkIndex: i + 1,
          content: chunkContent,
          tokenCount: approxTokens,
          metadata: JSON.stringify({
            source: "file_upload",
            file_type: "pdf",
            file_name: filename,
            file_path: savedFile.relativePath,
            document_title: docTitle,
            chunk_index: i + 1,
            total_chunks: chunks.length,
            page_count: numPages,
          }),
        },
      });

      createdChunks.push(chunk);
      chunksToEmbed.push(chunk);
    }

    const docTokens = createdChunks.reduce((acc, c) => acc + (c.tokenCount || 0), 0);
    await prisma.knowledgeDocument.update({
      where: { id: doc.id },
      data: {
        chunkCount: createdChunks.length,
        tokenCount: docTokens,
        updatedAt: new Date(),
      },
    });

    createdDocuments.push(doc);
    totalChunksCreated += createdChunks.length;
    totalTokens += docTokens;
  } else if (isWord) {
    // 3. Parse Word Document (.docx or legacy .doc)
    const { text } = ext === "docx"
      ? await parseDocxBuffer(buffer, filename)
      : await parseDocBuffer(buffer, filename);

    const cleanName = filename.replace(/\.(docx|doc)$/i, "").replace(/[_-]/g, " ");
    const docTitle = customTitle.trim() || cleanName;

    // Create KnowledgeDocument
    const doc = await prisma.knowledgeDocument.create({
      data: {
        sourceId: source.id,
        title: docTitle,
        baseUrl: `file:doc:${filename}`,
        filePath: savedFile.relativePath,
        shopifyGraphqlId: `file:doc:${now}-${slugify(filename)}`,
        content: text,
        version: 1,
      },
    });

    // Chunk text
    const chunks = chunkText(text, Number(chunkSize) || 2000, Number(overlap) || 500);
    const createdChunks = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkContent = chunks[i];
      const approxTokens = Math.ceil(chunkContent.length / 4);

      const chunk = await prisma.knowledgeChunk.create({
        data: {
          documentId: doc.id,
          chunkIndex: i + 1,
          content: chunkContent,
          tokenCount: approxTokens,
          metadata: JSON.stringify({
            source: "file_upload",
            file_type: ext,
            file_name: filename,
            file_path: savedFile.relativePath,
            document_title: docTitle,
            chunk_index: i + 1,
            total_chunks: chunks.length,
          }),
        },
      });

      createdChunks.push(chunk);
      chunksToEmbed.push(chunk);
    }

    const docTokens = createdChunks.reduce((acc, c) => acc + (c.tokenCount || 0), 0);
    await prisma.knowledgeDocument.update({
      where: { id: doc.id },
      data: {
        chunkCount: createdChunks.length,
        tokenCount: docTokens,
        updatedAt: new Date(),
      },
    });

    createdDocuments.push(doc);
    totalChunksCreated += createdChunks.length;
    totalTokens += docTokens;
  } else {
    // 4. Parse Excel
    const items = parseExcelBuffer(buffer, filename);

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const itemTitle =
        items.length === 1 && customTitle.trim() ? customTitle.trim() : item.title;

      const doc = await prisma.knowledgeDocument.create({
        data: {
          sourceId: source.id,
          title: itemTitle,
          baseUrl:
            item.referenceUrl ||
            `file:excel:${filename}#sheet=${encodeURIComponent(item.sheetName)}&row=${item.rowIndex}`,
          filePath: savedFile.relativePath,
          shopifyGraphqlId: `file:excel:${now}-${slugify(filename)}-${idx + 1}`,
          content: item.content,
          version: 1,
        },
      });

      const chunks = chunkText(item.content, Number(chunkSize) || 2000, Number(overlap) || 500);
      const createdChunks = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunkContent = chunks[i];
        const approxTokens = Math.ceil(chunkContent.length / 4);

        const chunk = await prisma.knowledgeChunk.create({
          data: {
            documentId: doc.id,
            chunkIndex: i + 1,
            content: chunkContent,
            tokenCount: approxTokens,
            metadata: JSON.stringify({
              source: "file_upload",
              file_type: "excel",
              file_name: filename,
              file_path: savedFile.relativePath,
              sheet_name: item.sheetName,
              row_index: item.rowIndex,
              category: item.category || null,
              document_title: itemTitle,
              chunk_index: i + 1,
              total_chunks: chunks.length,
            }),
          },
        });

        createdChunks.push(chunk);
        chunksToEmbed.push(chunk);
      }

      const docTokens = createdChunks.reduce((acc, c) => acc + (c.tokenCount || 0), 0);
      await prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: {
          chunkCount: createdChunks.length,
          tokenCount: docTokens,
          updatedAt: new Date(),
        },
      });

      createdDocuments.push(doc);
      totalChunksCreated += createdChunks.length;
      totalTokens += docTokens;
    }
  }

  // Generate vector embeddings if enabled
  if (generateEmbeddings && chunksToEmbed.length > 0) {
    generateEmbeddingsForChunks(chunksToEmbed).catch((err) => {
      console.error(`[FileKnowledge] Error generating embeddings for uploaded file ${filename}:`, err);
    });
  }

  return {
    success: true,
    fileType,
    filename,
    documentsCreated: createdDocuments.length,
    totalChunksCreated,
    totalTokens,
  };
}
