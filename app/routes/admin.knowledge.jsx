import { useState, useEffect, useRef } from "react";
import { useLoaderData, useActionData, useNavigation, useSearchParams, Link, Form, redirect } from "react-router";
import { requireAdminUser } from "../admin/auth.server";
import { useDevMode } from "../admin/components/AdminLayout";
import { getKnowledgeDocumentsList, getKnowledgeDocumentDetails } from "../admin/queries.server";
import { rechunkSingleDocument, rechunkAllDocuments } from "../admin/chunker.server";
import CopyableId from "../admin/components/CopyableId";
import FormattedDate from "../admin/components/FormattedDate";
import AdminPagination from "../admin/components/AdminPagination";
import DateRangeFilter from "../admin/components/DateRangeFilter";
import {
  ArrowLeftIcon,
  FileDocumentIcon,
  TrashIcon,
  UploadCloudIcon,
  DownloadIcon,
  ZapIcon,
  SpreadsheetIcon,
  EyeIcon,
  FolderIcon,
  LinkIcon,
  GlobeIcon,
  CloseIcon,
  PaperclipIcon,
  CheckIcon,
  CopyIcon,
  SearchIcon,
  EditPencilIcon,
  LayersIcon,
  CalendarIcon,
  ClockIcon,
  HashIcon,
  AlignLeftIcon,
  ExternalLinkIcon,
} from "../admin/components/ChatIcons.jsx";

export const loader = async ({ request }) => {
  await requireAdminUser(request);

  const url = new URL(request.url);

  // If downloaded via query param, redirect cleanly to dedicated resource route
  if (url.searchParams.get("download") === "sample_excel") {
    return redirect("/admin/knowledge/template");
  }

  const search = url.searchParams.get("search") || "";
  const sourceId = url.searchParams.get("sourceId") || "";
  const fileType = url.searchParams.get("fileType") || "";
  const docId = url.searchParams.get("docId") || "";
  const startDate = url.searchParams.get("startDate") || "";
  const endDate = url.searchParams.get("endDate") || "";
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const rawLimit = parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = [10, 20, 50, 100].includes(rawLimit) ? rawLimit : 20;

  const [data, selectedDocDetails] = await Promise.all([
    getKnowledgeDocumentsList({ search, sourceId, fileType, page, limit, startDate, endDate }),
    docId ? getKnowledgeDocumentDetails(docId) : Promise.resolve(null),
  ]);

  return {
    ...data,
    limit,
    search,
    sourceId,
    fileType,
    startDate,
    endDate,
    selectedDocId: docId,
    selectedDocDetails,
  };
};

export const action = async ({ request }) => {
  await requireAdminUser(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "upload_file") {
    const file = formData.get("file");
    if (!file || typeof file === "string" || file.size === 0) {
      return {
        success: false,
        error: "Please select a valid Word (.docx, .doc), PDF (.pdf), or Excel (.xlsx, .xls, .csv) file to upload.",
        intent: "upload_file",
      };
    }

    const filename = file.name || "uploaded_file";
    const customTitle = formData.get("customTitle") || "";
    const chunkSize = parseInt(formData.get("chunkSize") || "2000", 10);
    const overlap = parseInt(formData.get("overlap") || "500", 10);
    const generateEmbeddings = formData.get("generateEmbeddings") === "on";

    try {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const { processUploadedFile } = await import("../services/file-knowledge.server.js");
      const result = await processUploadedFile({
        buffer,
        filename,
        customTitle,
        chunkSize,
        overlap,
        generateEmbeddings,
      });

      return { ...result, intent: "upload_file" };
    } catch (err) {
      console.error("[AdminKnowledge] File upload error:", err);
      return {
        success: false,
        error: err.message || "Failed to process uploaded file.",
        intent: "upload_file",
      };
    }
  }

  if (intent === "delete_document") {
    const documentId = formData.get("documentId");
    const { deleteKnowledgeDocument } = await import("../admin/queries.server.js");
    const result = await deleteKnowledgeDocument(documentId);
    const url = new URL(request.url);
    if (url.searchParams.get("docId") === documentId) {
      return redirect("/admin/knowledge");
    }
    return { ...result, documentId, intent: "delete_document" };
  }

  if (intent === "rechunk_single") {
    const documentId = formData.get("documentId");
    const chunkSize = parseInt(formData.get("chunkSize") || "2000", 10);
    const overlap = parseInt(formData.get("overlap") || "500", 10);
    const generateEmbeddings = formData.get("generateEmbeddings") === "on";

    const result = await rechunkSingleDocument(documentId, {
      chunkSize,
      overlap,
      generateEmbeddings,
    });

    return { ...result, intent: "rechunk_single" };
  }

  if (intent === "rechunk_all") {
    const sourceId = formData.get("sourceId") || "";
    const chunkSize = parseInt(formData.get("chunkSize") || "2000", 10);
    const overlap = parseInt(formData.get("overlap") || "500", 10);
    const generateEmbeddings = formData.get("generateEmbeddings") === "on";

    const result = await rechunkAllDocuments({
      sourceId,
      chunkSize,
      overlap,
      generateEmbeddings,
    });

    return { ...result, intent: "rechunk_all" };
  }

  return { success: false, error: "Unknown action intent." };
};

export default function AdminKnowledgeRoute() {
  const loaderData = useLoaderData() || {};
  const {
    documents = [],
    total = 0,
    page = 1,
    totalPages = 1,
    limit = 20,
    sources = [],
    search = "",
    sourceId = "",
    fileType = "",
    startDate = "",
    endDate = "",
    selectedDocDetails: rawSelectedDocDetails = null,
  } = loaderData;
  const { devMode } = useDevMode();

  const hasActiveFilters = Boolean(search || sourceId || fileType || startDate || endDate);

  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [searchParams, setSearchParams] = useSearchParams();
  const [filterSearch, setFilterSearch] = useState(search || "");
  const [filterSourceId, setFilterSourceId] = useState(sourceId || "");
  const [filterFileType, setFilterFileType] = useState(fileType || "");

  useEffect(() => {
    setFilterSearch(search || "");
    setFilterSourceId(sourceId || "");
    setFilterFileType(fileType || "");
  }, [search, sourceId, fileType]);

  const [activeChunkFilter, setActiveChunkFilter] = useState("");
  const [activeModalTab, setActiveModalTab] = useState(devMode ? "chunks" : "content"); // "chunks" | "content" | "rechunk"
  const [showRechunkAllModal, setShowRechunkAllModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [dismissedDocId, setDismissedDocId] = useState(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [optimisticDeletedIds, setOptimisticDeletedIds] = useState(() => new Set());
  const [copiedContent, setCopiedContent] = useState(false);
  const [copiedChunkId, setCopiedChunkId] = useState(null);
  const [copiedOrigin, setCopiedOrigin] = useState(false);

  const handleCopyContent = (text) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text || "").then(() => {
        setCopiedContent(true);
        setTimeout(() => setCopiedContent(false), 1600);
      });
    }
  };

  const handleCopyChunk = (chunkId, text) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text || "").then(() => {
        setCopiedChunkId(chunkId);
        setTimeout(() => setCopiedChunkId(null), 1600);
      });
    }
  };

  const handleCopyOrigin = (text) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text || "").then(() => {
        setCopiedOrigin(true);
        setTimeout(() => setCopiedOrigin(false), 1600);
      });
    }
  };

  // Detect any deletion currently in-flight from form submission
  const pendingDeleteId =
    navigation.formData?.get("intent") === "delete_document"
      ? String(navigation.formData.get("documentId"))
      : null;

  // Clean up optimistic deleted IDs once loaderData updates without them
  useEffect(() => {
    setOptimisticDeletedIds((prev) => {
      if (!prev || prev.size === 0) return prev;
      const currentDocIds = new Set(documents.map((d) => d.id));
      let changed = false;
      const next = new Set();
      for (const id of prev) {
        if (currentDocIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [documents]);

  // Rollback optimistic delete if server reported failure
  useEffect(() => {
    if (actionData?.intent === "delete_document" && !actionData.success && actionData.documentId) {
      setOptimisticDeletedIds((prev) => {
        const next = new Set(prev);
        next.delete(actionData.documentId);
        return next;
      });
    }
  }, [actionData]);

  // Instantly exclude deleted or deleting documents from view (0ms latency)
  const visibleDocuments = documents.filter(
    (doc) => !optimisticDeletedIds.has(doc.id) && doc.id !== pendingDeleteId
  );
  const displayedTotal = Math.max(0, total - optimisticDeletedIds.size);

  useEffect(() => {
    if (rawSelectedDocDetails) {
      setDismissedDocId(null);
    }
  }, [rawSelectedDocDetails?.id]);

  const selectedDocDetails =
    rawSelectedDocDetails &&
    rawSelectedDocDetails.id !== dismissedDocId &&
    !optimisticDeletedIds.has(rawSelectedDocDetails.id) &&
    rawSelectedDocDetails.id !== pendingDeleteId
      ? rawSelectedDocDetails
      : null;

  // Drag and drop file upload state
  const [selectedUploadFile, setSelectedUploadFile] = useState(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const fileInputRef = useRef(null);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedUploadFile(file);
    }
  };

  const handleClearFile = (e) => {
    e?.stopPropagation?.();
    setSelectedUploadFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDraggingFile(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      setSelectedUploadFile(file);
      if (fileInputRef.current) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInputRef.current.files = dt.files;
        } catch {
          // Fallback if DataTransfer not supported
        }
      }
    }
  };

  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const handleOpenDoc = (id) => {
    setDismissedDocId(null);
    const params = new URLSearchParams(searchParams);
    params.set("docId", id);
    setSearchParams(params, { preventScrollReset: true });
    setActiveModalTab(devMode ? "chunks" : "content");
  };

  const handleCloseDoc = () => {
    // 1. Immediately dismiss modal locally (instant 0ms close!)
    setDismissedDocId(rawSelectedDocDetails?.id || "dismissed");
    // 2. Remove query param in background
    const params = new URLSearchParams(searchParams);
    params.delete("docId");
    setSearchParams(params, { preventScrollReset: true });
  };

  useEffect(() => {
    if (actionData) {
      setBannerDismissed(false);
      if (actionData.success && actionData.intent === "upload_file") {
        setShowUploadModal(false);
        setSelectedUploadFile(null);
      }
    }
  }, [actionData]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        if (showRechunkAllModal) setShowRechunkAllModal(false);
        if (showUploadModal) {
          setShowUploadModal(false);
          setSelectedUploadFile(null);
        }
      }
    };
    if (showRechunkAllModal || showUploadModal) {
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
      return () => {
        document.body.style.overflow = "unset";
        window.removeEventListener("keydown", handleKeyDown);
      };
    }
  }, [showRechunkAllModal, showUploadModal]);

  const handlePageChange = (newPage) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(newPage));
    if (limit !== 20) {
      params.set("limit", String(limit));
    }
    setSearchParams(params);
  };

  const handleLimitChange = (newLimit) => {
    const params = new URLSearchParams(searchParams);
    if (newLimit === 20) {
      params.delete("limit");
    } else {
      params.set("limit", String(newLimit));
    }
    params.set("page", "1");
    setSearchParams(params);
  };

  const filteredChunks = selectedDocDetails?.chunks?.filter((c) => {
    if (!activeChunkFilter) return true;
    return c.content.toLowerCase().includes(activeChunkFilter.toLowerCase());
  }) || [];

  if (selectedDocDetails) {
    return (
      <div className="knowledge-inspect-page">
        {/* Top Back Navigation Bar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <Link
            to={`/admin/knowledge?${(() => {
              const p = new URLSearchParams(searchParams);
              p.delete("docId");
              return p.toString();
            })()}`}
            className="filter-btn"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 16px",
              fontSize: "0.82rem",
              fontWeight: 600,
              cursor: "pointer",
              textDecoration: "none",
              color: "var(--text-main)",
            }}
            title="Return to Knowledge Documents list"
          >
            <ArrowLeftIcon size={14} />
            <span>Back to Documents</span>
          </Link>

          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.8rem", color: "var(--text-dim)" }}>
            <Link
              to={`/admin/knowledge?${(() => {
                const p = new URLSearchParams(searchParams);
                p.delete("docId");
                return p.toString();
              })()}`}
              style={{
                textDecoration: "none",
                color: "var(--text-dim)",
              }}
            >
              Knowledge Base
            </Link>
            <span>/</span>
            <span style={{ color: "var(--text-main)", fontWeight: 600, maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {selectedDocDetails.title}
            </span>
          </div>
        </div>

        {/* Action Notification Banner */}
        {actionData && !bannerDismissed && (
          <div
            className={`admin-alert ${actionData.success ? "admin-alert-success" : "admin-alert-error"}`}
            role="status"
          >
            <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0, flex: 1 }}>
              <div className="admin-alert-icon-wrapper">
                {actionData.success ? <CheckIcon size={14} /> : <CloseIcon size={14} />}
              </div>
              <div className="admin-alert-content">
                {actionData.success ? (
                  actionData.intent === "rechunk_single" ? (
                    <span>
                      <strong>Re-chunked:</strong> Document successfully re-split into {actionData.chunkCount} vector chunks ({actionData.totalTokens?.toLocaleString()} tokens).
                    </span>
                  ) : (
                    <span>Action completed successfully.</span>
                  )
                ) : (
                  <span>
                    <strong>Error:</strong> {actionData.error || "An unexpected error occurred."}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setBannerDismissed(true)}
              className="admin-alert-dismiss"
              title="Dismiss"
            >
              <CloseIcon size={14} />
            </button>
          </div>
        )}

        {/* Main Document Inspector Card */}
        <div className="glass-panel knowledge-inspect-card">
          {/* Header */}
          <div className="knowledge-modal-header" style={{ paddingBottom: "14px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
                <span className="admin-badge admin-badge-cyan">
                  {selectedDocDetails.source?.name || "Document"}
                </span>
                {selectedDocDetails.source?.code === "file_upload" &&
                  (selectedDocDetails.baseUrl?.startsWith("file:pdf:") ||
                    selectedDocDetails.shopifyGraphqlId?.startsWith("file:pdf:") ||
                    selectedDocDetails.title?.toLowerCase().endsWith(".pdf")) && (
                    <span
                      className="badge"
                      style={{
                        background: "rgba(244, 63, 94, 0.15)",
                        color: "#fb7185",
                        border: "1px solid rgba(244, 63, 94, 0.3)",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      <FileDocumentIcon size={12} /> PDF Document
                    </span>
                  )}
                {selectedDocDetails.source?.code === "file_upload" &&
                  (selectedDocDetails.baseUrl?.startsWith("file:excel:") ||
                    selectedDocDetails.shopifyGraphqlId?.startsWith("file:excel:") ||
                    selectedDocDetails.title?.toLowerCase().endsWith(".xlsx") ||
                    selectedDocDetails.title?.toLowerCase().endsWith(".xls") ||
                    selectedDocDetails.title?.toLowerCase().endsWith(".csv")) && (
                    <span
                      className="badge"
                      style={{
                        background: "rgba(16, 185, 129, 0.15)",
                        color: "#34d399",
                        border: "1px solid rgba(16, 185, 129, 0.3)",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      <SpreadsheetIcon size={12} /> Excel Spreadsheet
                    </span>
                  )}
                {selectedDocDetails.source?.code === "file_upload" &&
                  (selectedDocDetails.baseUrl?.startsWith("file:doc:") ||
                    selectedDocDetails.baseUrl?.startsWith("file:docx:") ||
                    selectedDocDetails.filePath?.toLowerCase().endsWith(".docx") ||
                    selectedDocDetails.filePath?.toLowerCase().endsWith(".doc") ||
                    selectedDocDetails.title?.toLowerCase().endsWith(".docx") ||
                    selectedDocDetails.title?.toLowerCase().endsWith(".doc")) && (
                    <span
                      className="badge"
                      style={{
                        background: "rgba(59, 130, 246, 0.15)",
                        color: "#60a5fa",
                        border: "1px solid rgba(59, 130, 246, 0.3)",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      <FileDocumentIcon size={12} /> Word Document
                    </span>
                  )}
                <span className="admin-badge admin-badge-purple">
                  {selectedDocDetails.chunks?.length || 0} Chunks
                </span>
              </div>
              <h1 className="knowledge-modal-title" style={{ fontSize: "1.35rem", margin: "6px 0 0 0" }}>
                {selectedDocDetails.title}
              </h1>
              <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", marginTop: "8px" }}>
                {selectedDocDetails.shopifyGraphqlId && (
                  <CopyableId id={selectedDocDetails.shopifyGraphqlId} prefix="Identifier: " maxWidth={380} />
                )}
                {selectedDocDetails.filePath && (
                  <CopyableId id={selectedDocDetails.filePath} prefix="Storage Path: " maxWidth={380} />
                )}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
              {selectedDocDetails.filePath && (
                <a
                  href={`/admin/knowledge/download?docId=${selectedDocDetails.id}`}
                  download
                  className="filter-btn"
                  style={{
                    padding: "6px 14px",
                    fontSize: "0.78rem",
                    color: "var(--accent-cyan)",
                    borderColor: "rgba(0, 188, 242, 0.35)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    textDecoration: "none",
                  }}
                  title="Download uploaded file from server storage"
                >
                  <DownloadIcon size={14} />
                  <span>Download File</span>
                </a>
              )}
              <Form
                method="post"
                style={{ display: "inline", margin: 0 }}
                onSubmit={(e) => {
                  if (!confirm(`Delete "${selectedDocDetails.title}" and all its vector chunks?`)) {
                    e.preventDefault();
                  } else {
                    setOptimisticDeletedIds((prev) => new Set(prev).add(selectedDocDetails.id));
                  }
                }}
              >
                <input type="hidden" name="intent" value="delete_document" />
                <input type="hidden" name="documentId" value={selectedDocDetails.id} />
                <button
                  type="submit"
                  className="filter-btn"
                  style={{
                    padding: "6px 12px",
                    fontSize: "0.78rem",
                    color: "var(--accent-rose)",
                    borderColor: "rgba(244, 63, 94, 0.3)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                  }}
                  title="Delete document"
                >
                  <TrashIcon size={13} />
                  <span>Delete</span>
                </button>
              </Form>
            </div>
          </div>

          {/* Document Metadata Summary - 4 Responsive Metric Cards */}
          <div className="knowledge-stats-ribbon">
            <div className="knowledge-stat-card">
              <div className="knowledge-stat-icon-wrap" style={{ background: "rgba(99, 102, 241, 0.12)", color: "#818cf8" }}>
                <CalendarIcon size={16} />
              </div>
              <div style={{ minWidth: 0 }}>
                <span className="knowledge-stat-label">Created At</span>
                <span className="knowledge-stat-value">
                  <FormattedDate date={selectedDocDetails.createdAt} format="datetime" />
                </span>
              </div>
            </div>

            <div className="knowledge-stat-card">
              <div className="knowledge-stat-icon-wrap" style={{ background: "rgba(0, 188, 242, 0.12)", color: "var(--accent-cyan)" }}>
                <ClockIcon size={16} />
              </div>
              <div style={{ minWidth: 0 }}>
                <span className="knowledge-stat-label">Last Updated</span>
                <span className="knowledge-stat-value" style={{ color: "var(--accent-cyan)" }}>
                  <FormattedDate date={selectedDocDetails.updatedAt} format="datetime" />
                </span>
              </div>
            </div>

            <div className="knowledge-stat-card">
              <div className="knowledge-stat-icon-wrap" style={{ background: "rgba(168, 85, 247, 0.12)", color: "#c084fc" }}>
                <HashIcon size={16} />
              </div>
              <div style={{ minWidth: 0 }}>
                <span className="knowledge-stat-label">Total Tokens</span>
                <span className="knowledge-stat-value mono">
                  {(selectedDocDetails.tokenCount || 0).toLocaleString()}
                </span>
              </div>
            </div>

            <div className="knowledge-stat-card">
              <div className="knowledge-stat-icon-wrap" style={{ background: "rgba(16, 185, 129, 0.12)", color: "#34d399" }}>
                <AlignLeftIcon size={16} />
              </div>
              <div style={{ minWidth: 0 }}>
                <span className="knowledge-stat-label">Content Length</span>
                <span className="knowledge-stat-value mono">
                  {(selectedDocDetails.content?.length || 0).toLocaleString()} chars
                </span>
              </div>
            </div>
          </div>

          {selectedDocDetails.baseUrl && (
            <div className="knowledge-origin-bar">
              <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: "5px" }}>
                  <LinkIcon size={13} style={{ color: "var(--text-dim)" }} />
                  <span>Origin / Reference:</span>
                </span>
                <span
                  style={{
                    fontSize: "0.8rem",
                    fontFamily: "var(--font-mono)",
                    color: "var(--accent-cyan)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: "520px",
                  }}
                  title={selectedDocDetails.baseUrl}
                >
                  {selectedDocDetails.baseUrl}
                </span>
                <button
                  type="button"
                  onClick={() => handleCopyOrigin(selectedDocDetails.baseUrl)}
                  className="filter-btn"
                  style={{ padding: "2px 8px", fontSize: "0.7rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
                  title="Copy Origin"
                >
                  {copiedOrigin ? <CheckIcon size={11} style={{ color: "var(--accent-emerald)" }} /> : <CopyIcon size={11} />}
                  <span>{copiedOrigin ? "Copied" : "Copy"}</span>
                </button>
              </div>
              {Boolean(
                (selectedDocDetails.source?.code === "page" ||
                  selectedDocDetails.source?.code === "blog" ||
                  selectedDocDetails.source?.sourceType === "page" ||
                  selectedDocDetails.source?.sourceType === "blog" ||
                  selectedDocDetails.shopifyGraphqlId?.includes("/Page/") ||
                  selectedDocDetails.shopifyGraphqlId?.includes("/Article/")) &&
                selectedDocDetails.baseUrl.startsWith("http")
              ) && (
                <a
                  href={selectedDocDetails.baseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="filter-btn"
                  style={{ fontSize: "0.74rem", padding: "3px 9px", display: "inline-flex", alignItems: "center", gap: "5px" }}
                >
                  <span>Open Link</span>
                  <ExternalLinkIcon size={11} />
                </a>
              )}
            </div>
          )}

          {/* Modern Segmented Tab Bar */}
          <div className="knowledge-tab-bar">
            <button
              type="button"
              onClick={() => setActiveModalTab("content")}
              className={`knowledge-tab-btn ${activeModalTab === "content" ? "active" : ""}`}
            >
              <FileDocumentIcon size={14} />
              <span>{devMode ? "Raw Full Content" : "Document Content"}</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveModalTab("chunks")}
              className={`knowledge-tab-btn ${activeModalTab === "chunks" ? "active" : ""}`}
            >
              <SpreadsheetIcon size={14} />
              <span>Chunks Breakdown</span>
              <span className="knowledge-tab-pill">{selectedDocDetails.chunks?.length || 0}</span>
            </button>
            {devMode && (
              <button
                type="button"
                onClick={() => setActiveModalTab("rechunk")}
                className={`knowledge-tab-btn ${activeModalTab === "rechunk" ? "active" : ""}`}
              >
                <ZapIcon size={14} />
                <span>Re-chunk Parameters</span>
              </button>
            )}
          </div>

          {/* Inspector Body Content */}
          <div className="knowledge-modal-body">
            {activeModalTab === "chunks" && (
              <div className="knowledge-tab-pane">
                <div className="knowledge-chunks-toolbar">
                  <span style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
                    Showing <strong>{filteredChunks.length}</strong> of <strong>{selectedDocDetails.chunks?.length || 0}</strong> chunks
                  </span>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <div style={{ position: "relative" }}>
                      <input
                        type="text"
                        placeholder="Search within chunks text..."
                        value={activeChunkFilter}
                        onChange={(e) => setActiveChunkFilter(e.target.value)}
                        className="search-input"
                        style={{ width: "230px", padding: "6px 28px 6px 12px", fontSize: "0.8rem", minWidth: "unset" }}
                      />
                      {activeChunkFilter && (
                        <button
                          type="button"
                          onClick={() => setActiveChunkFilter("")}
                          style={{
                            position: "absolute",
                            right: "8px",
                            top: "50%",
                            transform: "translateY(-50%)",
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            color: "var(--text-dim)",
                            padding: 0,
                          }}
                        >
                          <CloseIcon size={12} />
                        </button>
                      )}
                    </div>
                    {devMode && (
                      <button
                        type="button"
                        onClick={() => setActiveModalTab("rechunk")}
                        className="filter-btn"
                        style={{
                          fontSize: "0.78rem",
                          padding: "6px 12px",
                          background: "rgba(0, 188, 242, 0.1)",
                          color: "var(--accent-cyan)",
                          borderColor: "rgba(0, 188, 242, 0.3)",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                        }}
                      >
                        <ZapIcon size={13} />
                        <span>Re-chunk Settings</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="knowledge-chunks-scroll">
                  {filteredChunks.length === 0 ? (
                    <div className="admin-empty" style={{ padding: "40px 0", textAlign: "center" }}>
                      No chunks match your search query.
                    </div>
                  ) : (
                    <div className="knowledge-chunks-list">
                      {filteredChunks.map((chunk) => (
                        <div key={chunk.id} className="knowledge-chunk-card">
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              marginBottom: "10px",
                              flexWrap: "wrap",
                              gap: "8px",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                              <span
                                style={{
                                  background: "rgba(0, 188, 242, 0.12)",
                                  color: "var(--accent-cyan)",
                                  border: "1px solid rgba(0, 188, 242, 0.25)",
                                  padding: "2px 8px",
                                  borderRadius: "6px",
                                  fontSize: "0.75rem",
                                  fontWeight: "700",
                                }}
                              >
                                Chunk #{chunk.chunkIndex}
                              </span>
                              <CopyableId id={chunk.id} prefix="ID: " maxWidth={140} />
                              <span
                                style={{
                                  fontSize: "0.72rem",
                                  color: "var(--text-dim)",
                                  fontFamily: "var(--font-mono)",
                                  background: "var(--bg-surface)",
                                  padding: "2px 7px",
                                  borderRadius: "4px",
                                  border: "1px solid var(--border-subtle)",
                                }}
                              >
                                {chunk.tokenCount ? `${chunk.tokenCount} tokens` : "Tokens parsed"}
                              </span>
                            </div>

                            <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "0.74rem" }}>
                              <button
                                type="button"
                                onClick={() => handleCopyChunk(chunk.id, chunk.content)}
                                className="filter-btn"
                                style={{ padding: "2px 8px", fontSize: "0.72rem", display: "inline-flex", alignItems: "center", gap: "4px" }}
                                title="Copy chunk text"
                              >
                                {copiedChunkId === chunk.id ? (
                                  <CheckIcon size={12} style={{ color: "var(--accent-emerald)" }} />
                                ) : (
                                  <CopyIcon size={12} />
                                )}
                                <span>{copiedChunkId === chunk.id ? "Copied" : "Copy"}</span>
                              </button>
                              <div>
                                <span style={{ color: "var(--text-dim)" }}>Created: </span>
                                <span style={{ color: "var(--text-main)", fontWeight: 500 }}>
                                  <FormattedDate date={chunk.createdAt} format="datetime" />
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="knowledge-chunk-body">
                            {chunk.content}
                          </div>

                          {chunk.metadata && (
                            <div style={{ marginTop: "8px" }}>
                              <details style={{ fontSize: "0.74rem" }}>
                                <summary style={{ cursor: "pointer", color: "var(--text-dim)", userSelect: "none" }}>
                                  Chunk Metadata JSON
                                </summary>
                                <pre
                                  style={{
                                    background: "var(--bg-surface)",
                                    border: "1px solid var(--border-subtle)",
                                    padding: "8px 12px",
                                    borderRadius: "6px",
                                    color: "var(--accent-cyan)",
                                    marginTop: "6px",
                                    overflowX: "auto",
                                    fontSize: "0.73rem",
                                    fontFamily: "var(--font-mono)",
                                  }}
                                >
                                  {typeof chunk.metadata === "string"
                                    ? chunk.metadata
                                    : JSON.stringify(chunk.metadata, null, 2)}
                                </pre>
                              </details>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeModalTab === "content" && (
              <div className="knowledge-tab-pane">
                <div className="knowledge-content-toolbar">
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-main)" }}>
                      Full Document Text Content
                    </span>
                    <span className="admin-badge admin-badge-cyan" style={{ fontSize: "0.72rem" }}>
                      {selectedDocDetails.content ? `${selectedDocDetails.content.split(/\s+/).filter(Boolean).length.toLocaleString()} words` : "0 words"}
                    </span>
                    <span className="admin-badge admin-badge-purple" style={{ fontSize: "0.72rem" }}>
                      {(selectedDocDetails.content?.length || 0).toLocaleString()} chars
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopyContent(selectedDocDetails.content || "")}
                    className="admin-btn admin-btn-sm admin-btn-outline"
                    style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                  >
                    {copiedContent ? <CheckIcon size={13} style={{ color: "var(--accent-emerald)" }} /> : <CopyIcon size={13} />}
                    <span>{copiedContent ? "Copied to Clipboard!" : "Copy Full Content"}</span>
                  </button>
                </div>
                <div className="knowledge-content-scroll">
                  <pre className="knowledge-content-pre">
                    {selectedDocDetails.content || "(No document content stored)"}
                  </pre>
                </div>
              </div>
            )}

            {activeModalTab === "rechunk" && (
              <div className="knowledge-tab-pane">
                <div className="knowledge-rechunk-scroll">
                  <div className="knowledge-rechunk-container">
                    <div className="knowledge-rechunk-banner">
                      <div className="knowledge-rechunk-banner-icon">
                        <ZapIcon size={18} />
                      </div>
                      <div>
                        <div className="knowledge-rechunk-banner-title">
                          Re-chunk Document: "{selectedDocDetails.title}"
                        </div>
                        <p className="knowledge-rechunk-banner-desc">
                          This operation re-splits this document's text body into overlapping text segments, replaces old chunks, generates new IDs, and optionally regenerates OpenAI vector embeddings.
                        </p>
                      </div>
                    </div>

                    <Form method="post">
                      <input type="hidden" name="intent" value="rechunk_single" />
                      <input type="hidden" name="documentId" value={selectedDocDetails.id} />

                      <div className="chunking-panel" style={{ marginBottom: "16px" }}>
                        <div className="chunking-panel-header">
                          <div className="chunking-panel-title">
                            <LayersIcon size={16} style={{ color: "var(--accent-cyan)" }} />
                            <span>Vector Chunking Parameters</span>
                          </div>
                          <span className="modern-form-badge">OpenAI text-embedding-3</span>
                        </div>

                        <div className="chunking-grid">
                          <div className="chunking-field">
                            <label className="chunking-field-label">
                              <span>Chunk Size</span>
                              <span style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontWeight: "normal" }}>Max slice</span>
                            </label>
                            <div className="chunking-input-container">
                              <input
                                type="number"
                                name="chunkSize"
                                defaultValue={2000}
                                min={200}
                                max={10000}
                                step={100}
                                className="chunking-number-input"
                              />
                              <span className="chunking-unit-badge">chars</span>
                            </div>
                            <div className="chunking-subtext">Recommended: 1,500 – 2,500 chars (~500 tokens)</div>
                          </div>

                          <div className="chunking-field">
                            <label className="chunking-field-label">
                              <span>Chunk Overlap</span>
                              <span style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontWeight: "normal" }}>Boundary context</span>
                            </label>
                            <div className="chunking-input-container">
                              <input
                                type="number"
                                name="overlap"
                                defaultValue={500}
                                min={0}
                                max={2000}
                                step={50}
                                className="chunking-number-input"
                              />
                              <span className="chunking-unit-badge">chars</span>
                            </div>
                            <div className="chunking-subtext">Preserves semantic context across chunk edges (0 – 2,000)</div>
                          </div>
                        </div>
                      </div>

                      <label htmlFor="genEmbedSingle" className="modern-checkbox-card" style={{ marginBottom: "20px" }}>
                        <input
                          type="checkbox"
                          id="genEmbedSingle"
                          name="generateEmbeddings"
                          defaultChecked={true}
                        />
                        <div className="modern-checkbox-label">
                          <span className="modern-checkbox-title">
                            Generate OpenAI vector embeddings for new chunks
                          </span>
                          <span className="modern-checkbox-desc">
                            Immediately synchronizes vectors with semantic search for accurate AI assistant answers.
                          </span>
                        </div>
                      </label>

                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="admin-btn admin-btn-primary"
                        style={{
                          width: "100%",
                          justifyContent: "center",
                          padding: "12px 20px",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "8px",
                          fontWeight: 700,
                          fontSize: "0.92rem",
                        }}
                      >
                        <ZapIcon size={16} />
                        <span>{isSubmitting ? "Processing Chunks..." : "Execute Re-chunk Now"}</span>
                      </button>
                    </Form>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (searchParams.get("docId") && !selectedDocDetails) {
    return (
      <div className="knowledge-inspect-page">
        <Link
          to={`/admin/knowledge?${(() => {
            const p = new URLSearchParams(searchParams);
            p.delete("docId");
            return p.toString();
          })()}`}
          className="filter-btn"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 16px",
            fontSize: "0.82rem",
            fontWeight: 600,
            cursor: "pointer",
            width: "fit-content",
            textDecoration: "none",
            color: "var(--text-main)",
          }}
        >
          <ArrowLeftIcon size={14} />
          <span>Back to Documents</span>
        </Link>
        <div className="glass-panel" style={{ padding: "40px 24px", textAlign: "center" }}>
          <div style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: 8, color: "var(--text-main)" }}>
            Document Not Found
          </div>
          <div style={{ fontSize: "0.85rem", color: "var(--text-dim)", marginBottom: 16 }}>
            The requested knowledge document could not be found or has been deleted.
          </div>
          <Link
            to={`/admin/knowledge?${(() => {
              const p = new URLSearchParams(searchParams);
              p.delete("docId");
              return p.toString();
            })()}`}
            className="filter-btn"
            style={{ textDecoration: "none" }}
          >
            Return to Knowledge Base
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Action Notification Banner */}
      {actionData && !bannerDismissed && (
        <div
          className={`admin-alert ${actionData.success ? "admin-alert-success" : "admin-alert-error"}`}
          role="status"
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0, flex: 1 }}>
            <div className="admin-alert-icon-wrapper">
              {actionData.success ? <CheckIcon size={14} /> : <CloseIcon size={14} />}
            </div>
            <div className="admin-alert-content">
              {actionData.success ? (
                actionData.intent === "upload_file" ? (
                  <span>
                    <strong>File Uploaded:</strong> Successfully indexed <strong>{actionData.filename}</strong> ({actionData.fileType?.toUpperCase()}). Created <strong>{actionData.documentsCreated}</strong> document{actionData.documentsCreated === 1 ? "" : "s"} and <strong>{actionData.totalChunksCreated}</strong> vector chunk{actionData.totalChunksCreated === 1 ? "" : "s"} ({actionData.totalTokens?.toLocaleString()} tokens).
                  </span>
                ) : actionData.intent === "delete_document" ? (
                  <span>
                    <strong>Deleted:</strong> Successfully deleted document "{actionData.title}" and its vector chunks.
                  </span>
                ) : actionData.intent === "rechunk_all" ? (
                  <span>
                    <strong>Re-chunk Complete:</strong> Processed {actionData.processedDocuments} of {actionData.totalDocuments} documents, creating {actionData.totalChunksCreated} chunks.
                  </span>
                ) : (
                  <span>
                    <strong>Re-chunked:</strong> Generated {actionData.chunkCount} chunks ({actionData.totalTokens?.toLocaleString()} tokens) for "{actionData.title}".
                  </span>
                )
              ) : (
                <span>
                  <strong>Operation Failed:</strong> {actionData.error}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setBannerDismissed(true)}
            className="admin-alert-close"
            title="Dismiss notification"
          >
            <CloseIcon size={15} />
          </button>
        </div>
      )}

      {/* Main Glass Panel */}
      <div className="glass-panel" style={{ minHeight: "480px", overflow: "visible" }}>
        <div className="panel-header" style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "stretch" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--text-main)" }}>
                {devMode ? "Documents & Chunks Directory" : "Documents Directory"}
              </span>
              <span className="badge badge-cyan">{displayedTotal} total</span>
              <span style={{ fontSize: "0.8rem", color: "var(--text-dim)", marginLeft: 4 }}>
                Page {page} of {totalPages}
              </span>
            </div>

            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              {/* Download Sample Excel */}
              <a
                href="/admin/knowledge/template"
                download="perfumania_knowledge_template.xlsx"
                className="admin-btn"
                style={{
                  background: "rgba(16, 185, 129, 0.12)",
                  color: "var(--accent-emerald, #10b981)",
                  border: "1px solid rgba(16, 185, 129, 0.35)",
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "6px 12px",
                  fontSize: "0.82rem",
                  fontWeight: "600",
                  borderRadius: "var(--radius-sm)",
                  whiteSpace: "nowrap",
                }}
                title="Download sample Excel spreadsheet template (.xlsx)"
              >
                <DownloadIcon size={14} />
                <span>Download Sample Excel</span>
              </a>

              {/* Upload File Button */}
              <button
                type="button"
                onClick={() => {
                  setSelectedUploadFile(null);
                  setShowUploadModal(true);
                }}
                className="admin-btn admin-btn-primary"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "6px 14px",
                  fontSize: "0.82rem",
                  fontWeight: "600",
                  whiteSpace: "nowrap",
                }}
              >
                <UploadCloudIcon size={14} />
                <span>Upload File (PDF / Excel)</span>
              </button>

              {devMode && (
                <button
                  type="button"
                  onClick={() => setShowRechunkAllModal(true)}
                  className="admin-btn admin-btn-outline"
                  style={{
                    whiteSpace: "nowrap",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "6px 12px",
                    fontSize: "0.82rem",
                  }}
                >
                  <ZapIcon size={13} />
                  <span>Re-chunk All</span>
                </button>
              )}
            </div>
          </div>

          <Form
            key={`knowledge-filter-${sourceId}-${fileType}-${startDate}-${endDate}-${search}`}
            method="get"
            style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", width: "100%" }}
          >
            <div style={{ flex: "1 1 220px", minWidth: 180 }}>
              <input
                type="text"
                name="search"
                value={filterSearch}
                onChange={(e) => setFilterSearch(e.target.value)}
                placeholder="Search documents by title, URL or ID..."
                className="search-input"
                style={{ width: "100%", minWidth: "unset" }}
              />
            </div>

            <div style={{ flex: "0 1 180px", minWidth: 150 }}>
              <select
                name="sourceId"
                value={filterSourceId}
                onChange={(e) => setFilterSourceId(e.target.value)}
                className="admin-select"
                style={{ width: "100%", cursor: "pointer" }}
              >
                <option value="">All Sources ({sources.length})</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </div>

            <div style={{ flex: "0 1 180px", minWidth: 150 }}>
              <select
                name="fileType"
                value={filterFileType}
                onChange={(e) => setFilterFileType(e.target.value)}
                className="admin-select"
                style={{ width: "100%", cursor: "pointer" }}
              >
                <option value="">All Formats / Types</option>
                <option value="word">Word Documents (.docx, .doc)</option>
                <option value="pdf">PDF Documents (.pdf)</option>
                <option value="excel">Excel Spreadsheets (.xlsx, .csv)</option>
                <option value="file_upload">All Uploaded Files</option>
                <option value="shopify">Shopify Synced Resources</option>
              </select>
            </div>

            <DateRangeFilter startDate={startDate} endDate={endDate} />

            <button type="submit" className="admin-btn admin-btn-primary" style={{ height: 38 }}>
              Filter
            </button>

            <Link
              to="/admin/knowledge"
              onClick={() => {
                setFilterSearch("");
                setFilterSourceId("");
                setFilterFileType("");
              }}
              className={`filter-clear-btn ${hasActiveFilters ? "active" : ""}`}
              title="Reset all filters"
            >
              <CloseIcon size={12} />
              <span>Clear</span>
            </Link>
          </Form>
        </div>

        {/* Documents Table */}
        {visibleDocuments.length === 0 ? (
          <div
            style={{
              padding: "54px 24px",
              minHeight: "340px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
            }}
          >
            <div style={{ marginBottom: "12px", display: "flex", justifyContent: "center" }}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: "14px",
                  background: "rgba(0, 188, 242, 0.08)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--accent-cyan)",
                }}
              >
                <FileDocumentIcon size={28} />
              </div>
            </div>
            <div style={{ fontWeight: 600, fontSize: "1.05rem", color: "var(--text-main)" }}>
              No Knowledge Documents Found
            </div>
            <div style={{ fontSize: "13px", color: "var(--text-dim)", marginTop: "6px", maxWidth: "420px" }}>
              {hasActiveFilters
                ? "Try modifying or clearing your search filters to find documents."
                : "Documents will appear once synchronized or uploaded."}
            </div>
            {hasActiveFilters && (
              <div style={{ marginTop: "16px" }}>
                <Link
                  to="/admin/knowledge"
                  onClick={() => {
                    setFilterSearch("");
                    setFilterSourceId("");
                    setFilterFileType("");
                  }}
                  className="admin-btn admin-btn-outline"
                  style={{ fontSize: "0.82rem" }}
                >
                  Clear All Filters
                </Link>
              </div>
            )}
          </div>
        ) : (
          <div className="admin-table-wrapper">
            <table className="admin-table">
              <thead>
                <tr>
                  <th style={{ minWidth: "260px" }}>Title</th>
                  <th style={{ minWidth: "240px" }}>Source</th>
                  <th style={{ width: "95px", textAlign: "center" }}>Chunks</th>
                  <th style={{ width: "100px" }}>Tokens</th>
                  <th style={{ width: "120px" }}>Created At</th>
                  <th style={{ width: "120px" }}>Last Updated</th>
                  <th style={{ width: "110px", textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {visibleDocuments.map((doc) => {
                  const isPdf =
                    doc.source?.code === "file_upload" &&
                    (doc.baseUrl?.startsWith("file:pdf:") ||
                      doc.shopifyGraphqlId?.startsWith("file:pdf:") ||
                      doc.filePath?.toLowerCase().endsWith(".pdf") ||
                      doc.title?.toLowerCase().endsWith(".pdf"));
                  const isWord =
                    doc.source?.code === "file_upload" &&
                    (doc.baseUrl?.startsWith("file:doc:") ||
                      doc.baseUrl?.startsWith("file:docx:") ||
                      doc.shopifyGraphqlId?.startsWith("file:doc:") ||
                      doc.shopifyGraphqlId?.startsWith("file:docx:") ||
                      doc.filePath?.toLowerCase().endsWith(".docx") ||
                      doc.filePath?.toLowerCase().endsWith(".doc") ||
                      doc.title?.toLowerCase().endsWith(".docx") ||
                      doc.title?.toLowerCase().endsWith(".doc"));
                  const isExcel =
                    doc.source?.code === "file_upload" &&
                    (doc.baseUrl?.startsWith("file:excel:") ||
                      doc.shopifyGraphqlId?.startsWith("file:excel:") ||
                      doc.filePath?.toLowerCase().endsWith(".xlsx") ||
                      doc.filePath?.toLowerCase().endsWith(".xls") ||
                      doc.filePath?.toLowerCase().endsWith(".csv") ||
                      doc.title?.toLowerCase().endsWith(".xlsx") ||
                      doc.title?.toLowerCase().endsWith(".xls") ||
                      doc.title?.toLowerCase().endsWith(".csv"));
                  const isUploadedFile = doc.source?.code === "file_upload" || isPdf || isWord || isExcel;
                  const isPageOrArticle =
                    doc.source?.code === "page" ||
                    doc.source?.code === "blog" ||
                    doc.source?.sourceType === "page" ||
                    doc.source?.sourceType === "blog" ||
                    doc.shopifyGraphqlId?.includes("/Page/") ||
                    doc.shopifyGraphqlId?.includes("/Article/");

                  const rawFileRef =
                    doc.filePath ||
                    (doc.baseUrl && doc.baseUrl.startsWith("file:")
                      ? doc.baseUrl.replace(/^file:(?:pdf|doc|docx|excel):/i, "").split("#")[0]
                      : "") ||
                    "";

                  const displayFileName = rawFileRef
                    ? rawFileRef.split("/").pop().split("\\").pop().replace(/^\d+_/, "")
                    : (isUploadedFile ? doc.title : "");

                  const hasDownloadableFile = Boolean(rawFileRef || doc.filePath || (doc.baseUrl && doc.baseUrl.startsWith("file:")));

                  return (
                    <tr key={doc.id}>
                      <td>
                        <Link
                          to={`/admin/knowledge?${(() => {
                            const p = new URLSearchParams(searchParams);
                            p.set("docId", doc.id);
                            return p.toString();
                          })()}`}
                          onClick={() => {
                            setDismissedDocId(null);
                            setActiveModalTab(devMode ? "chunks" : "content");
                          }}
                          style={{
                            fontWeight: 700,
                            color: "var(--text-main)",
                            textDecoration: "none",
                            transition: "color 0.15s ease",
                            display: "inline-block",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--pf-brand)")}
                          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-main)")}
                          title="Click to view document details & chunks"
                        >
                          {doc.title}
                        </Link>
                      </td>

                      <td>
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-start" }}>
                          {/* Only show the Source Type */}
                          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                            {isWord ? (
                              <span
                                className="badge"
                                style={{
                                  background: "rgba(59, 130, 246, 0.15)",
                                  color: "#60a5fa",
                                  border: "1px solid rgba(59, 130, 246, 0.3)",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "4px",
                                  fontWeight: "600",
                                  fontSize: "0.75rem",
                                }}
                              >
                                <FileDocumentIcon size={12} /> Word Document
                              </span>
                            ) : isPdf ? (
                              <span
                                className="badge"
                                style={{
                                  background: "rgba(244, 63, 94, 0.15)",
                                  color: "#fb7185",
                                  border: "1px solid rgba(244, 63, 94, 0.3)",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "4px",
                                  fontWeight: "600",
                                  fontSize: "0.75rem",
                                }}
                              >
                                <FileDocumentIcon size={12} /> PDF Document
                              </span>
                            ) : isExcel ? (
                              <span
                                className="badge"
                                style={{
                                  background: "rgba(16, 185, 129, 0.15)",
                                  color: "#34d399",
                                  border: "1px solid rgba(16, 185, 129, 0.3)",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "4px",
                                  fontWeight: "600",
                                  fontSize: "0.75rem",
                                }}
                              >
                                <SpreadsheetIcon size={12} /> Excel Sheet
                              </span>
                            ) : (
                              <span className="badge badge-cyan" style={{ fontSize: "0.75rem" }}>
                                {doc.source?.name || doc.source?.code || "Shopify Store"}
                              </span>
                            )}
                          </div>

                          {/* If file exists, show file download button */}
                          {hasDownloadableFile ? (
                            <a
                              href={`/admin/knowledge/download?docId=${doc.id}`}
                              download={displayFileName}
                              className="source-file-download-btn"
                              title={`Click to download "${displayFileName}"`}
                            >
                              <DownloadIcon size={12} style={{ flexShrink: 0 }} />
                              <span>Download ({displayFileName})</span>
                            </a>
                          ) : isPageOrArticle && doc.baseUrl && doc.baseUrl.startsWith("http") ? (
                            <a
                              href={doc.baseUrl}
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                fontSize: "0.74rem",
                                color: "var(--accent-blue)",
                                textDecoration: "none",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                              }}
                            >
                              <LinkIcon size={12} /> View Web Page ↗
                            </a>
                          ) : null}
                        </div>
                      </td>

                      <td style={{ textAlign: "center", whiteSpace: "nowrap" }}>
                        <span className="badge badge-purple">
                          {doc._count?.chunks || doc.chunkCount || 0} chunks
                        </span>
                      </td>

                      <td style={{ whiteSpace: "nowrap" }}>
                        <span style={{ fontSize: "0.84rem", color: "var(--text-main)", fontWeight: 600 }}>
                          {(doc.tokenCount || 0).toLocaleString()}
                        </span>
                        {doc.embeddingCostUsd > 0 && (
                          <div style={{ fontSize: "0.7rem", color: "var(--accent-emerald)" }}>
                            ${doc.embeddingCostUsd.toFixed(5)}
                          </div>
                        )}
                      </td>

                      <td style={{ whiteSpace: "nowrap", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                        <FormattedDate date={doc.createdAt} format="both" />
                      </td>

                      <td style={{ whiteSpace: "nowrap", fontSize: "0.8rem", color: "var(--accent-cyan)" }}>
                        <FormattedDate date={doc.updatedAt} format="both" />
                      </td>

                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <div style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
                          <Link
                            to={`/admin/knowledge?${(() => {
                              const p = new URLSearchParams(searchParams);
                              p.set("docId", doc.id);
                              return p.toString();
                            })()}`}
                            onClick={() => {
                              setDismissedDocId(null);
                              setActiveModalTab(devMode ? "chunks" : "content");
                            }}
                            className="filter-btn"
                            style={{
                              padding: "6px 9px",
                              fontSize: "0.78rem",
                              color: "var(--accent-cyan)",
                              borderColor: "rgba(0, 188, 242, 0.3)",
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                            title="Inspect document details & chunks"
                          >
                            <EyeIcon size={14} />
                          </Link>

                          <Form
                            method="post"
                            style={{ display: "inline", margin: 0 }}
                            onSubmit={(e) => {
                              if (!confirm(`Delete "${doc.title}" and all its vector chunks?`)) {
                                e.preventDefault();
                              } else {
                                setOptimisticDeletedIds((prev) => new Set(prev).add(doc.id));
                                if (doc.id === rawSelectedDocDetails?.id) {
                                  handleCloseDoc();
                                }
                              }
                            }}
                          >
                            <input type="hidden" name="intent" value="delete_document" />
                            <input type="hidden" name="documentId" value={doc.id} />
                            <button
                              type="submit"
                              className="filter-btn"
                              style={{
                                padding: "6px 9px",
                                fontSize: "0.78rem",
                                color: "var(--accent-rose)",
                                borderColor: "rgba(244, 63, 94, 0.3)",
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                              title="Delete document"
                            >
                              <TrashIcon size={13} />
                            </button>
                          </Form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Footer */}
        {total > 0 && (
          <AdminPagination
            page={page}
            totalPages={totalPages}
            total={displayedTotal}
            limit={limit}
            onPageChange={handlePageChange}
            onLimitChange={handleLimitChange}
          />
        )}
      </div>

      {/* Re-chunk All Data Modal */}
      {showRechunkAllModal && (
        <div className="admin-modal-backdrop" onClick={() => setShowRechunkAllModal(false)}>
          <div
            className="admin-modal-content"
            style={{ maxWidth: "580px", padding: "24px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="admin-modal-header" style={{ padding: "0 0 16px 0", marginBottom: "16px", borderBottom: "1px solid var(--border-subtle)" }}>
              <div>
                <h2 style={{ fontSize: "18px", fontWeight: "700", color: "var(--text-main)", margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
                  <ZapIcon size={18} style={{ color: "var(--accent-cyan)" }} />
                  <span>Re-chunk All Knowledge Data</span>
                </h2>
                <div style={{ fontSize: "12px", color: "var(--text-dim)", marginTop: "4px" }}>
                  Process all {total} knowledge documents across your store
                </div>
              </div>
              <button onClick={() => setShowRechunkAllModal(false)} className="admin-btn-close" title="Close">
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="knowledge-rechunk-banner" style={{ marginBottom: "16px" }}>
              <div className="knowledge-rechunk-banner-icon">
                <ZapIcon size={18} />
              </div>
              <div>
                <div className="knowledge-rechunk-banner-title">
                  Storewide Vector Chunk Synchronization
                </div>
                <p className="knowledge-rechunk-banner-desc">
                  This operation will iterate through all {total} knowledge documents, re-split their content into chunks, delete outdated chunks, and synchronize vector embeddings.
                </p>
              </div>
            </div>

            <Form
              method="post"
              onSubmit={() => setShowRechunkAllModal(false)}
            >
              <input type="hidden" name="intent" value="rechunk_all" />

              <div className="modern-form-group">
                <div className="modern-form-label">
                  <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <FolderIcon size={14} style={{ color: "var(--pf-brand)" }} />
                    <span>Knowledge Source Filter</span>
                  </span>
                  <span className="modern-form-badge">Target Scope</span>
                </div>
                <select name="sourceId" defaultValue="" className="admin-select" style={{ width: "100%" }}>
                  <option value="">All Knowledge Sources ({total} docs)</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.code})
                    </option>
                  ))}
                </select>
              </div>

              <div className="chunking-panel" style={{ marginBottom: "16px" }}>
                <div className="chunking-panel-header">
                  <div className="chunking-panel-title">
                    <LayersIcon size={16} style={{ color: "var(--accent-cyan)" }} />
                    <span>Vector Chunking Parameters</span>
                  </div>
                  <span className="modern-form-badge">OpenAI text-embedding-3</span>
                </div>

                <div className="chunking-grid">
                  <div className="chunking-field">
                    <label className="chunking-field-label">
                      <span>Chunk Size</span>
                      <span style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontWeight: "normal" }}>Max slice</span>
                    </label>
                    <div className="chunking-input-container">
                      <input
                        type="number"
                        name="chunkSize"
                        defaultValue={2000}
                        min={200}
                        max={10000}
                        step={100}
                        className="chunking-number-input"
                      />
                      <span className="chunking-unit-badge">chars</span>
                    </div>
                  </div>

                  <div className="chunking-field">
                    <label className="chunking-field-label">
                      <span>Chunk Overlap</span>
                      <span style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontWeight: "normal" }}>Boundary context</span>
                    </label>
                    <div className="chunking-input-container">
                      <input
                        type="number"
                        name="overlap"
                        defaultValue={500}
                        min={0}
                        max={2000}
                        step={50}
                        className="chunking-number-input"
                      />
                      <span className="chunking-unit-badge">chars</span>
                    </div>
                  </div>
                </div>
              </div>

              <label htmlFor="genEmbedAll" className="modern-checkbox-card" style={{ marginBottom: "20px" }}>
                <input
                  type="checkbox"
                  id="genEmbedAll"
                  name="generateEmbeddings"
                  defaultChecked={true}
                />
                <div className="modern-checkbox-label">
                  <span className="modern-checkbox-title">
                    Generate vector embeddings for newly produced chunks
                  </span>
                  <span className="modern-checkbox-desc">
                    Re-generates vector embeddings for all newly split chunks using OpenAI.
                  </span>
                </div>
              </label>

              <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => setShowRechunkAllModal(false)}
                  className="admin-btn admin-btn-outline"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="admin-btn admin-btn-primary"
                  style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}
                >
                  <ZapIcon size={15} />
                  <span>{isSubmitting ? "Starting..." : "Start Re-chunking All Data"}</span>
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Upload Document (PDF / Excel) Modal */}
      {showUploadModal && (
        <div
          className="admin-modal-backdrop"
          onClick={() => {
            if (!isSubmitting) {
              setShowUploadModal(false);
              setSelectedUploadFile(null);
            }
          }}
        >
          <div
            className="admin-modal-content"
            style={{ maxWidth: "620px" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="admin-modal-header" style={{ padding: "0 0 16px 0", marginBottom: "20px", borderBottom: "1px solid var(--border-subtle)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: "10px",
                    background: "rgba(0, 188, 242, 0.12)",
                    color: "var(--accent-cyan)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <UploadCloudIcon size={22} />
                </div>
                <div>
                  <h2 style={{ fontSize: "1.1rem", fontWeight: "700", color: "var(--text-main)", margin: 0 }}>
                    Upload Knowledge Document
                  </h2>
                  <div style={{ fontSize: "0.78rem", color: "var(--text-dim)", marginTop: "2px" }}>
                    Upload Word documents, PDF documents, or Excel spreadsheets to vectorize for AI search.
                  </div>
                </div>
              </div>
              <button
                onClick={() => {
                  setShowUploadModal(false);
                  setSelectedUploadFile(null);
                }}
                disabled={isSubmitting}
                className="admin-btn-close"
                title="Close"
              >
                <CloseIcon size={16} />
              </button>
            </div>

            <Form
              method="post"
              encType="multipart/form-data"
            >
              <input type="hidden" name="intent" value="upload_file" />

              {/* Hidden Real File Input */}
              <input
                ref={fileInputRef}
                type="file"
                name="file"
                required
                accept=".pdf,.xlsx,.xls,.csv,.doc,.docx"
                onChange={handleFileChange}
                style={{ display: "none" }}
              />

              {/* Modern File Dropzone & Selection Area */}
              <div style={{ marginBottom: "18px" }}>
                <label style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "var(--text-main)", marginBottom: "8px" }}>
                  Document File <span style={{ color: "var(--accent-rose)" }}>*</span>
                </label>

                {!selectedUploadFile ? (
                  <div
                    className={`upload-dropzone ${isDraggingFile ? "is-dragging" : ""}`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDraggingFile(true);
                    }}
                    onDragLeave={() => setIsDraggingFile(false)}
                    onDrop={handleDrop}
                  >
                    <div className="upload-dropzone-icon-wrap">
                      <UploadCloudIcon size={26} />
                    </div>
                    <div className="upload-dropzone-title">
                      Choose a file or drag & drop here
                    </div>
                    <div className="upload-dropzone-subtitle">
                      Supports Word (.docx, .doc), PDF (.pdf), and Excel (.xlsx, .xls, .csv) documents (up to 25MB)
                    </div>
                    <div className="upload-format-badges">
                      <span className="upload-format-badge word">DOCX</span>
                      <span className="upload-format-badge word">DOC</span>
                      <span className="upload-format-badge pdf">PDF</span>
                      <span className="upload-format-badge excel">XLSX</span>
                      <span className="upload-format-badge excel">XLS</span>
                      <span className="upload-format-badge csv">CSV</span>
                    </div>
                    <div style={{ marginTop: "14px", fontSize: "0.76rem", color: "var(--text-dim)" }}>
                      Need dummy spreadsheet format?{" "}
                      <a
                        href="/admin/knowledge/template"
                        download="perfumania_knowledge_template.xlsx"
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          color: "var(--accent-cyan)",
                          textDecoration: "underline",
                          fontWeight: "600",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        <DownloadIcon size={12} /> Download Sample Excel
                      </a>
                    </div>
                  </div>
                ) : (
                  <div className="upload-file-card">
                    <div className="upload-file-card-info">
                      <div
                        className={`upload-file-card-icon ${
                          selectedUploadFile.name.toLowerCase().endsWith(".pdf")
                            ? "pdf"
                            : selectedUploadFile.name.toLowerCase().endsWith(".docx") || selectedUploadFile.name.toLowerCase().endsWith(".doc")
                            ? "word"
                            : "excel"
                        }`}
                      >
                        {selectedUploadFile.name.toLowerCase().endsWith(".pdf") ||
                        selectedUploadFile.name.toLowerCase().endsWith(".docx") ||
                        selectedUploadFile.name.toLowerCase().endsWith(".doc") ? (
                          <FileDocumentIcon size={22} />
                        ) : (
                          <SpreadsheetIcon size={22} />
                        )}
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="upload-file-card-name" title={selectedUploadFile.name}>
                          {selectedUploadFile.name}
                        </div>
                        <div className="upload-file-card-meta">
                          <span>{formatBytes(selectedUploadFile.size)}</span>
                          <span>•</span>
                          <span style={{ textTransform: "uppercase", fontWeight: 600 }}>
                            {selectedUploadFile.name.split(".").pop()}
                          </span>
                          <span style={{ color: "var(--accent-emerald)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 3 }}>
                            <CheckIcon size={12} /> Selected
                          </span>
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleClearFile}
                      className="filter-btn"
                      style={{
                        padding: "6px 12px",
                        fontSize: "0.78rem",
                        color: "var(--text-muted)",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                      title="Choose a different file"
                    >
                      <CloseIcon size={13} />
                      <span>Change</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Custom Document Title Field */}
              <div className="modern-form-group">
                <div className="modern-form-label">
                  <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <EditPencilIcon size={14} style={{ color: "var(--pf-brand)" }} />
                    <span>Custom Document Title</span>
                  </span>
                  <span className="modern-form-badge">Optional Override</span>
                </div>
                <div className="modern-input-wrap">
                  <span className="modern-input-icon">
                    <FileDocumentIcon size={16} />
                  </span>
                  <input
                    type="text"
                    name="customTitle"
                    placeholder="e.g., Perfumania Fragrance Concentrations & Authenticity Guide"
                    className="modern-input has-icon"
                  />
                </div>
                <div className="modern-input-hint">
                  <span>ℹ️</span>
                  <span>For spreadsheets, each row is imported as its own document using its Title column. If left blank for PDFs, the title is extracted from the filename.</span>
                </div>
              </div>

              {/* Chunking & Vector Splitting Configuration Panel (Visible only when DEV OPTION is ON) */}
              {devMode ? (
                <div className="chunking-panel">
                  <div className="chunking-panel-header">
                    <div className="chunking-panel-title">
                      <LayersIcon size={16} style={{ color: "var(--accent-cyan)" }} />
                      <span>Vector Chunking Parameters</span>
                    </div>
                    <span className="modern-form-badge">OpenAI text-embedding-3</span>
                  </div>

                  <div className="chunking-grid">
                    <div className="chunking-field">
                      <label className="chunking-field-label">
                        <span>Chunk Size</span>
                        <span style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontWeight: "normal" }}>Max slice</span>
                      </label>
                      <div className="chunking-input-container">
                        <input
                          type="number"
                          name="chunkSize"
                          defaultValue={2000}
                          min={200}
                          max={10000}
                          step={100}
                          className="chunking-number-input"
                        />
                        <span className="chunking-unit-badge">chars</span>
                      </div>
                      <div className="chunking-subtext">~500 tokens / chunk (200 – 10,000)</div>
                    </div>

                    <div className="chunking-field">
                      <label className="chunking-field-label">
                        <span>Chunk Overlap</span>
                        <span style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontWeight: "normal" }}>Context preservation</span>
                      </label>
                      <div className="chunking-input-container">
                        <input
                          type="number"
                          name="overlap"
                          defaultValue={500}
                          min={0}
                          max={2000}
                          step={50}
                          className="chunking-number-input"
                        />
                        <span className="chunking-unit-badge">chars</span>
                      </div>
                      <div className="chunking-subtext">Context overlap between slices (0 – 2,000)</div>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <input type="hidden" name="chunkSize" value={2000} />
                  <input type="hidden" name="overlap" value={500} />
                </>
              )}

              {/* Modern Embeddings Checkbox Card */}
              <label htmlFor="genEmbedUpload" className="modern-checkbox-card">
                <input
                  type="checkbox"
                  id="genEmbedUpload"
                  name="generateEmbeddings"
                  defaultChecked={true}
                />
                <div className="modern-checkbox-label">
                  <span className="modern-checkbox-title">
                    Generate OpenAI vector embeddings for immediate chatbot retrieval
                  </span>
                  <span className="modern-checkbox-desc">
                    Generates 1536-dimensional semantic vectors so customers can immediately query this document.
                  </span>
                </div>
              </label>

              <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => {
                    setShowUploadModal(false);
                    setSelectedUploadFile(null);
                  }}
                  className="admin-btn admin-btn-outline"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !selectedUploadFile}
                  className="admin-btn admin-btn-primary"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "7px",
                    opacity: isSubmitting || !selectedUploadFile ? 0.6 : 1,
                    cursor: isSubmitting || !selectedUploadFile ? "not-allowed" : "pointer",
                  }}
                >
                  <UploadCloudIcon size={16} />
                  <span>{isSubmitting ? "Uploading & Processing..." : "Upload & Process Document"}</span>
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary() {
  return (
    <div className="glass-panel" style={{ padding: "40px 24px", textAlign: "center", maxWidth: 640, margin: "40px auto" }}>
      <div style={{ fontSize: "2rem", marginBottom: 12 }}>⚠️</div>
      <h2 style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>
        Knowledge Docs Temporarily Unavailable
      </h2>
      <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 20 }}>
        An unexpected error occurred while loading knowledge documents. Please retry or refresh.
      </p>
      <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="admin-btn admin-btn-primary"
          style={{ padding: "8px 18px", fontSize: "0.85rem" }}
        >
          Reload Page
        </button>
        <Link
          to="/admin/knowledge"
          className="admin-btn admin-btn-outline"
          style={{ padding: "8px 18px", fontSize: "0.85rem", textDecoration: "none" }}
        >
          Reset Filters
        </Link>
      </div>
    </div>
  );
}
