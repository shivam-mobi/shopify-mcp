import { useState, useEffect } from "react";
import { useLoaderData, useSearchParams, Link, Form } from "react-router";
import { requireAdminUser } from "../admin/auth.server";
import { useDevMode } from "../admin/components/AdminLayout";
import { getShopifyEventsList, getShopifyEventDetails } from "../admin/queries.server";
import CopyableId from "../admin/components/CopyableId";
import FormattedDate from "../admin/components/FormattedDate";
import AdminPagination from "../admin/components/AdminPagination";
import DateRangeFilter from "../admin/components/DateRangeFilter";
import { CloseIcon, LayersIcon, DevToolsIcon, ZapIcon } from "../admin/components/ChatIcons";

export const loader = async ({ request }) => {
  await requireAdminUser(request);

  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const topic = url.searchParams.get("topic") || "";
  const status = url.searchParams.get("status") || "";
  const eventId = url.searchParams.get("eventId") || "";
  const startDate = url.searchParams.get("startDate") || "";
  const endDate = url.searchParams.get("endDate") || "";
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const rawLimit = parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = [10, 20, 50, 100].includes(rawLimit) ? rawLimit : 20;

  const [data, selectedEventDetails] = await Promise.all([
    getShopifyEventsList({ search, topic, status, page, limit, startDate, endDate }),
    eventId ? getShopifyEventDetails(eventId) : Promise.resolve(null),
  ]);

  return {
    ...data,
    limit,
    search,
    topic,
    status,
    startDate,
    endDate,
    selectedEventId: eventId,
    selectedEventDetails,
  };
};

export default function AdminEventsRoute() {
  const {
    events,
    total,
    page,
    totalPages,
    limit = 20,
    topics,
    search,
    topic,
    status,
    startDate = "",
    endDate = "",
    selectedEventDetails,
  } = useLoaderData();
  const { devMode, toggleDevMode } = useDevMode();
  const hasActiveFilters = Boolean(search || topic || status || startDate || endDate);

  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState("chunks"); // "chunks" | "payload"
  const [dismissedEventId, setDismissedEventId] = useState(null);

  // If a new event detail loads from the server, clear dismiss state
  useEffect(() => {
    if (selectedEventDetails) {
      setDismissedEventId(null);
    }
  }, [selectedEventDetails?.event?.id, selectedEventDetails?.event?.eventId]);

  const isDismissed =
    dismissedEventId &&
    (dismissedEventId === selectedEventDetails?.event?.id ||
      dismissedEventId === selectedEventDetails?.event?.eventId ||
      dismissedEventId === "dismissed");

  const activeEventDetails =
    selectedEventDetails && !isDismissed ? selectedEventDetails : null;

  const handleOpenEvent = (id) => {
    setDismissedEventId(null);
    const params = new URLSearchParams(searchParams);
    params.set("eventId", id);
    setSearchParams(params, { preventScrollReset: true });
  };

  const handleCloseEvent = () => {
    // 1. Immediately dismiss locally (instant 0ms close!)
    setDismissedEventId(
      selectedEventDetails?.event?.id || selectedEventDetails?.event?.eventId || "dismissed"
    );
    // 2. Remove query param in background
    const params = new URLSearchParams(searchParams);
    params.delete("eventId");
    setSearchParams(params, { preventScrollReset: true });
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && activeEventDetails) {
        handleCloseEvent();
      }
    };
    if (activeEventDetails) {
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
      return () => {
        document.body.style.overflow = "unset";
        window.removeEventListener("keydown", handleKeyDown);
      };
    }
  }, [activeEventDetails]);

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

  if (!devMode) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h1 className="page-title">Developer Tool · Shopify Event Logs</h1>
            <p className="page-subtitle">
              Raw incoming Shopify webhook deliveries, payloads, and processing logs
            </p>
          </div>
        </div>
        <div className="glass-panel" style={{ textAlign: "center", padding: "64px 24px" }}>
          <div style={{ fontSize: "3rem", marginBottom: 16 }}>⚡ 🛠️</div>
          <h2 style={{ fontSize: "1.3rem", fontWeight: 700, color: "var(--text-main)", marginBottom: 8 }}>
            Shopify Event Logs is a Developer Feature
          </h2>
          <p style={{ maxWidth: 540, margin: "0 auto 24px auto", color: "var(--text-muted)", fontSize: "0.92rem", lineHeight: 1.5 }}>
            This section logs raw Shopify webhook deliveries and JSON payloads for engineers to inspect event webhooks. It is hidden in Client View to keep the dashboard simple and clean.
          </p>
          <button
            type="button"
            onClick={() => toggleDevMode(true)}
            className="submit-btn"
            style={{ maxWidth: 220, margin: "0 auto", display: "inline-block" }}
          >
            Enable Dev Mode
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Main Glass Panel */}
      <div className="glass-panel">
        <div className="panel-header" style={{ display: "flex", flexDirection: "column", gap: 14, alignItems: "stretch" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "1rem", fontWeight: 700, color: "var(--text-main)" }}>Webhook Events</span>
              <span className="badge badge-amber">{total} total</span>
            </div>
            <div style={{ fontSize: "0.82rem", color: "var(--text-dim)" }}>
              Page {page} of {totalPages} ({total} events)
            </div>
          </div>

          <Form method="get" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", width: "100%" }}>
            <div style={{ flex: "1 1 220px", minWidth: 180 }}>
              <input
                type="text"
                name="search"
                defaultValue={search}
                placeholder="Search payload content, error message, or event ID..."
                className="search-input"
                style={{ width: "100%", minWidth: "unset" }}
              />
            </div>

            <div style={{ flex: "0 1 180px", minWidth: 150 }}>
              <select
                name="topic"
                defaultValue={topic}
                className="admin-select"
                style={{ width: "100%", cursor: "pointer" }}
              >
                <option value="">All Topics ({topics.length})</option>
                {topics.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ flex: "0 1 150px", minWidth: 130 }}>
              <select
                name="status"
                defaultValue={status}
                className="admin-select"
                style={{ width: "100%", cursor: "pointer" }}
              >
                <option value="">All Statuses</option>
                <option value="processed">Processed</option>
                <option value="error">Error</option>
                <option value="unhandled">Unhandled</option>
              </select>
            </div>

            <DateRangeFilter startDate={startDate} endDate={endDate} />

            <button type="submit" className="admin-btn admin-btn-primary" style={{ height: 38 }}>
              Filter
            </button>

            <Link
              to="/admin/events"
              className={`filter-clear-btn ${hasActiveFilters ? "active" : ""}`}
              title="Reset all filters"
            >
              <CloseIcon size={12} />
              <span>Clear</span>
            </Link>
          </Form>
        </div>

        {/* Events Table */}
        {events.length === 0 ? (
          <div style={{ padding: "48px 24px", textAlign: "center" }}>
            <div style={{ fontSize: "36px", marginBottom: "8px" }}>⚡</div>
            <div style={{ fontWeight: 600, color: "#f8fafc" }}>No Shopify Event Logs Found</div>
            <div style={{ fontSize: "13px", color: "var(--text-dim)", marginTop: "4px" }}>
              {search || topic || status
                ? "Try adjusting your filter parameters."
                : "Shopify webhook events will appear here once received."}
            </div>
          </div>
        ) : (
          <div className="admin-table-wrapper">
            <table className="admin-table">
              <thead>
                <tr>
                  <th style={{ minWidth: "220px" }}>Topic & Action</th>
                  <th style={{ width: "120px" }}>Status</th>
                  <th style={{ width: "170px" }}>Shopify Entity ID</th>
                  <th style={{ width: "170px" }}>Event ID / Webhook</th>
                  <th style={{ width: "130px" }}>Received At</th>
                  <th style={{ width: "150px", textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id}>
                    <td>
                      <div style={{ fontWeight: 700, color: "var(--text-main)", marginBottom: "4px" }}>
                        {ev.topic}
                      </div>
                      {ev.actionType && (
                        <span className="badge badge-cyan">
                          action: {ev.actionType}
                        </span>
                      )}
                    </td>

                    <td style={{ whiteSpace: "nowrap" }}>
                      <span
                        className={`badge ${
                          ev.status === "processed"
                            ? "badge-customer"
                            : ev.status === "error"
                            ? "badge-rose"
                            : "badge-amber"
                        }`}
                      >
                        {ev.status}
                      </span>
                      {ev.errorMessage && (
                        <div
                          style={{
                            fontSize: "11px",
                            color: "#f87171",
                            marginTop: "4px",
                            maxWidth: "180px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={ev.errorMessage}
                        >
                          {ev.errorMessage}
                        </div>
                      )}
                    </td>

                    <td style={{ width: "170px", whiteSpace: "nowrap" }}>
                      <CopyableId id={ev.entityId} maxWidth={150} />
                    </td>

                    <td style={{ width: "170px", whiteSpace: "nowrap" }}>
                      <CopyableId id={ev.eventId || ev.id} maxWidth={150} />
                      {ev.apiVersion && (
                        <div style={{ fontSize: "10px", color: "var(--text-dim)", marginTop: 2 }}>
                          v{ev.apiVersion}
                        </div>
                      )}
                    </td>

                    <td style={{ whiteSpace: "nowrap", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                      <FormattedDate date={ev.createdAt} format="both" />
                    </td>

                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        onClick={() => handleOpenEvent(ev.id)}
                        className="filter-btn"
                        style={{ padding: "6px 12px", fontSize: "0.78rem", display: "inline-flex", alignItems: "center", gap: 5 }}
                      >
                        <ZapIcon size={12} />
                        <span>Inspect Event</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Footer */}
        {total > 0 && (
          <AdminPagination
            page={page}
            totalPages={totalPages}
            total={total}
            limit={limit}
            onPageChange={handlePageChange}
            onLimitChange={handleLimitChange}
          />
        )}
      </div>

      {/* Event Details & Chunks Inspector Modal */}
      {activeEventDetails && (
        <div className="admin-modal-backdrop" onClick={handleCloseEvent}>
          <div
            className="admin-modal-content"
            style={{
              maxWidth: "920px",
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
              padding: "24px 28px",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: "0 0 16px 0",
                borderBottom: "1px solid var(--border-subtle)",
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 16,
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
                  <span
                    className={`admin-badge ${
                      activeEventDetails.event.status === "processed"
                        ? "admin-badge-emerald"
                        : "admin-badge-rose"
                    }`}
                  >
                    {activeEventDetails.event.status}
                  </span>
                  <span className="admin-badge admin-badge-cyan">
                    {activeEventDetails.event.topic}
                  </span>
                  {activeEventDetails.eventChunks.length > 0 && (
                    <span className="admin-badge admin-badge-purple">
                      {activeEventDetails.eventChunks.length} Linked Chunks
                    </span>
                  )}
                </div>
                <h2 style={{ fontSize: "19px", fontWeight: "700", color: "var(--text-main)", margin: "0 0 6px 0" }}>
                  Shopify Event: {activeEventDetails.event.topic}
                </h2>
                <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                  <CopyableId id={activeEventDetails.event.eventId || activeEventDetails.event.id} prefix="Event ID: " maxWidth={260} />
                  <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                    Received at: <FormattedDate date={activeEventDetails.event.createdAt} format="datetime" />
                  </span>
                </div>
              </div>
              <button
                onClick={handleCloseEvent}
                className="admin-btn-close"
                title="Close"
                style={{ marginTop: 2 }}
              >
                <CloseIcon size={14} />
              </button>
            </div>

            {/* Error Message banner if any */}
            {activeEventDetails.event.errorMessage && (
              <div
                style={{
                  background: "rgba(244, 63, 94, 0.15)",
                  border: "1px solid rgba(244, 63, 94, 0.3)",
                  color: "#fca5a5",
                  padding: "12px 16px",
                  borderRadius: "8px",
                  margin: "14px 0 0 0",
                  fontSize: "13px",
                }}
              >
                <strong>Error: </strong> {activeEventDetails.event.errorMessage}
              </div>
            )}

            {/* Navigation Tabs */}
            <div
              style={{
                display: "flex",
                gap: "10px",
                margin: "16px 0 14px 0",
                borderBottom: "1px solid var(--border-subtle)",
                paddingBottom: "10px",
              }}
            >
              <button
                onClick={() => setActiveTab("chunks")}
                className={`admin-btn admin-btn-sm ${activeTab === "chunks" ? "admin-btn-primary" : "admin-btn-outline"}`}
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <LayersIcon size={14} />
                <span>Event Chunks ({activeEventDetails.eventChunks.length})</span>
              </button>
              <button
                onClick={() => setActiveTab("payload")}
                className={`admin-btn admin-btn-sm ${activeTab === "payload" ? "admin-btn-primary" : "admin-btn-outline"}`}
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <DevToolsIcon size={14} />
                <span>Raw Payload JSON</span>
              </button>
            </div>

            {/* Content body */}
            <div style={{ overflowY: "auto", flex: 1, paddingRight: "10px" }}>
              {activeTab === "chunks" ? (
                <div>
                  {activeEventDetails.linkedDocument ? (
                    <div>
                      {/* Linked Document Card */}
                      <div
                        style={{
                          background: "var(--bg-surface-elevated)",
                          border: "1px solid var(--border-subtle)",
                          borderRadius: "10px",
                          padding: "16px 18px",
                          marginBottom: "18px",
                        }}
                      >
                        <div style={{ fontSize: "11px", color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, marginBottom: "4px" }}>
                          Synchronized Knowledge Document
                        </div>
                        <div style={{ fontSize: "15px", fontWeight: "600", color: "var(--text-main)", marginBottom: "12px" }}>
                          {activeEventDetails.linkedDocument.title}
                        </div>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                            gap: "10px",
                            fontSize: "12px",
                          }}
                        >
                          <div style={{ background: "var(--bg-surface)", padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--border-subtle)" }}>
                            <div style={{ color: "var(--text-dim)", fontSize: "11px", marginBottom: 2 }}>Source</div>
                            <div style={{ color: "var(--accent-cyan)", fontWeight: 600 }}>{activeEventDetails.linkedDocument.source?.name || "Default"}</div>
                          </div>
                          <div style={{ background: "var(--bg-surface)", padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--border-subtle)", minWidth: 0 }}>
                            <div style={{ color: "var(--text-dim)", fontSize: "11px", marginBottom: 2 }}>Shopify GID</div>
                            <div style={{ color: "var(--text-main)", fontFamily: "monospace", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={activeEventDetails.linkedDocument.shopifyGraphqlId}>
                              {activeEventDetails.linkedDocument.shopifyGraphqlId || "—"}
                            </div>
                          </div>
                          <div style={{ background: "var(--bg-surface)", padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--border-subtle)" }}>
                            <div style={{ color: "var(--text-dim)", fontSize: "11px", marginBottom: 2 }}>Doc Created</div>
                            <div style={{ color: "var(--text-main)" }}><FormattedDate date={activeEventDetails.linkedDocument.createdAt} format="datetime" /></div>
                          </div>
                          <div style={{ background: "var(--bg-surface)", padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--border-subtle)" }}>
                            <div style={{ color: "var(--text-dim)", fontSize: "11px", marginBottom: 2 }}>Doc Last Updated</div>
                            <div style={{ color: "var(--accent-cyan)", fontWeight: 600 }}><FormattedDate date={activeEventDetails.linkedDocument.updatedAt} format="datetime" /></div>
                          </div>
                        </div>
                      </div>

                      {/* Event Chunks list */}
                      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <div style={{ fontSize: "14px", fontWeight: "600", color: "var(--text-main)" }}>
                          Event Chunks ({activeEventDetails.eventChunks.length})
                        </div>

                        {activeEventDetails.eventChunks.map((chunk) => (
                          <div
                            key={chunk.id}
                            style={{
                              background: "rgba(15, 23, 42, 0.6)",
                              border: "1px solid rgba(255, 255, 255, 0.08)",
                              borderRadius: "8px",
                              padding: "14px",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginBottom: "8px",
                                flexWrap: "wrap",
                                gap: "8px",
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <span
                                  style={{
                                    background: "rgba(99, 102, 241, 0.2)",
                                    color: "#a5b4fc",
                                    padding: "2px 8px",
                                    borderRadius: "6px",
                                    fontSize: "12px",
                                    fontWeight: "600",
                                  }}
                                >
                                  Chunk #{chunk.chunkIndex}
                                </span>
                                <CopyableId id={chunk.id} prefix="ID: " maxWidth={140} />
                                <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                                  {chunk.tokenCount ? `${chunk.tokenCount} tokens` : "Chunk vector"}
                                </span>
                              </div>

                              {/* Timestamps */}
                              <div style={{ display: "flex", gap: "16px", fontSize: "11px" }}>
                                <div>
                                  <span style={{ color: "#64748b" }}>Created At: </span>
                                  <span style={{ color: "#cbd5e1" }}>
                                    <FormattedDate date={chunk.createdAt} format="datetime" />
                                  </span>
                                </div>
                                <div>
                                  <span style={{ color: "#64748b" }}>Last Updated At: </span>
                                  <span style={{ color: "#38bdf8", fontWeight: "600" }}>
                                    <FormattedDate date={chunk.updatedAt} format="datetime" />
                                  </span>
                                </div>
                              </div>
                            </div>

                            {/* Chunk content */}
                            <div
                              style={{
                                background: "rgba(2, 6, 23, 0.6)",
                                padding: "12px",
                                borderRadius: "6px",
                                fontSize: "13px",
                                lineHeight: "1.6",
                                color: "#e2e8f0",
                                whiteSpace: "pre-wrap",
                                border: "1px solid rgba(255, 255, 255, 0.04)",
                              }}
                            >
                              {chunk.content}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="admin-empty" style={{ padding: "40px 0" }}>
                      <div style={{ fontSize: "32px", marginBottom: "8px" }}>ℹ️</div>
                      <div style={{ fontWeight: "600", color: "#f8fafc" }}>No Knowledge Document Linked</div>
                      <div style={{ fontSize: "13px", color: "#64748b", maxWidth: "420px", margin: "8px auto 0" }}>
                        {activeEventDetails.entityId
                          ? `Entity ID "${activeEventDetails.entityId}" was found in payload, but no matching KnowledgeDocument was synced in the database.`
                          : "This event payload did not include an article, page, or product identifier."}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <pre
                    style={{
                      background: "rgba(2, 6, 23, 0.9)",
                      border: "1px solid rgba(255, 255, 255, 0.08)",
                      borderRadius: "8px",
                      padding: "16px",
                      fontSize: "12px",
                      color: "#38bdf8",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      overflowWrap: "anywhere",
                      maxHeight: "500px",
                      overflowY: "auto",
                    }}
                  >
                    {typeof activeEventDetails.parsedPayload === "object"
                      ? JSON.stringify(activeEventDetails.parsedPayload, null, 2)
                      : String(activeEventDetails.parsedPayload)}
                  </pre>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end" }}>
              <button onClick={handleCloseEvent} className="admin-btn admin-btn-outline">
                Close Inspector
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
