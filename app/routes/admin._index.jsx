import { Link, useLoaderData } from "react-router";
import { requireAdminUser } from "../admin/auth.server";
import { useDevMode } from "../admin/components/AdminLayout";
import {
  getAdminOverviewStats,
  getShoppersList,
  getShopifyEventsList,
} from "../admin/queries.server";
import CopyableId from "../admin/components/CopyableId";
import FormattedDate from "../admin/components/FormattedDate";
import { UsersIcon, ZapIcon } from "../admin/components/ChatIcons.jsx";

export const loader = async ({ request }) => {
  await requireAdminUser(request);

  const [stats, recentShoppers, recentEventsData] = await Promise.all([
    getAdminOverviewStats(),
    getShoppersList({ limit: 6 }),
    getShopifyEventsList({ limit: 6 }),
  ]);

  return {
    stats,
    recentShoppers,
    recentEvents: recentEventsData.events || [],
  };
};

export default function AdminDashboardRoute() {
  const { stats, recentShoppers, recentEvents } = useLoaderData();
  const { devMode } = useDevMode();

  return (
    <div>
      {/* Metric Cards - Simplified in Client Mode */}
      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">Total Shoppers</span>
          <span className="stat-value" style={{ color: "var(--accent-cyan)" }}>
            {stats.totalShoppers.toLocaleString()}
          </span>
          <span className="stat-sub">
            {stats.guestShoppers} Guests · {stats.identifiedShoppers} Registered
          </span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Conversations</span>
          <span className="stat-value" style={{ color: "var(--accent-blue)" }}>
            {stats.totalConversations.toLocaleString()}
          </span>
          <span className="stat-sub">{stats.totalMessages.toLocaleString()} Total Messages</span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Store Customers</span>
          <span className="stat-value" style={{ color: "var(--accent-emerald)" }}>
            {stats.totalCustomers.toLocaleString()}
          </span>
          <span className="stat-sub">Customer Profiles Saved</span>
        </div>

        {devMode ? (
          <>
            <div className="stat-card">
              <span className="stat-label">Knowledge Base</span>
              <span className="stat-value" style={{ color: "var(--accent-purple)" }}>
                {stats.totalKnowledgeDocs.toLocaleString()}
              </span>
              <span className="stat-sub">{stats.totalKnowledgeChunks.toLocaleString()} Vector Chunks</span>
            </div>

            <div className="stat-card">
              <span className="stat-label">Shopify Events</span>
              <span className="stat-value" style={{ color: "var(--accent-emerald)" }}>
                {stats.totalShopifyEvents.toLocaleString()}
              </span>
              <span className="stat-sub">Incoming Webhook Deliveries</span>
            </div>

            <div className="stat-card">
              <span className="stat-label">LLM AI Requests</span>
              <span className="stat-value" style={{ color: "var(--accent-cyan)" }}>
                {stats.totalLlmLogs.toLocaleString()}
              </span>
              <span className="stat-sub">Prompt & Completion Logs</span>
            </div>

            <div className="stat-card">
              <span className="stat-label">MCP Tool Calls</span>
              <span className="stat-value" style={{ color: "var(--accent-amber)" }}>
                {stats.totalMcpLogs.toLocaleString()}
              </span>
              <span className="stat-sub">Storefront, UCP, Customer & Admin</span>
            </div>
          </>
        ) : (
          <div className="stat-card">
            <span className="stat-label">Knowledge Docs</span>
            <span className="stat-value" style={{ color: "var(--accent-purple)" }}>
              {stats.totalKnowledgeDocs.toLocaleString()}
            </span>
            <span className="stat-sub">Synced Product & Store Docs</span>
          </div>
        )}
      </div>

      {/* Recent Shoppers Panel */}
      <div className="glass-panel">
        <div className="panel-header">
          <h2 className="panel-title">
            <UsersIcon size={18} style={{ color: "var(--accent-cyan)" }} />
            <span>Recent Shoppers & Carts</span>
          </h2>
          <Link to="/admin/customers" className="filter-btn">
            View All →
          </Link>
        </div>
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Shopper / Customer</th>
                <th>Type</th>
                <th>Cart / Checkout</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {recentShoppers.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", color: "var(--text-dim)", padding: 32 }}>
                    No shopper carts recorded yet
                  </td>
                </tr>
              ) : (
                recentShoppers.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link
                        to={`/admin/customers?shopperId=${s.id}`}
                        className="shopper-name-link"
                        title="Open in Customers & Guests"
                        style={{
                          fontWeight: 600,
                          fontSize: "0.88rem",
                          color: "var(--text-main)",
                          textDecoration: "none",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span>{s.displayName}</span>
                        <span
                          className="shopper-link-arrow"
                          style={{ fontSize: "0.76rem", color: "var(--accent-cyan)", opacity: 0.8 }}
                        >
                          ↗
                        </span>
                      </Link>
                    </td>
                    <td>
                      {s.isGuest ? (
                        <span className="badge badge-guest">Guest</span>
                      ) : (
                        <span className="badge badge-customer">Customer</span>
                      )}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {s.activeCartId ? (
                        <span className="badge badge-cyan">Cart</span>
                      ) : (
                        <span style={{ color: "var(--text-dim)", fontSize: "0.8rem" }}>Empty</span>
                      )}
                    </td>
                    <td style={{ fontSize: "0.82rem", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      <FormattedDate date={s.updatedAtDate} format="whatsapp" />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Shopify Events Panel - Developer Mode Only */}
      {devMode && (
        <div className="glass-panel" style={{ marginTop: "24px" }}>
          <div className="panel-header">
            <h2 className="panel-title">
              <ZapIcon size={18} style={{ color: "var(--accent-cyan)" }} />
              <span>Recent Shopify Event Deliveries (Dev Mode)</span>
            </h2>
            <Link to="/admin/events" className="filter-btn">
              View All Events →
            </Link>
          </div>
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Topic & Action</th>
                <th>Status</th>
                <th>Entity ID</th>
                <th>Event ID</th>
                <th>Received</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {recentEvents.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", color: "var(--text-dim)", padding: 32 }}>
                    No Shopify webhook events logged yet
                  </td>
                </tr>
              ) : (
                recentEvents.map((ev) => (
                  <tr key={ev.id}>
                    <td>
                      <span style={{ fontWeight: 600 }}>{ev.topic}</span>
                      {ev.actionType && (
                        <span className="badge badge-cyan" style={{ marginLeft: "8px" }}>
                          {ev.actionType}
                        </span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          ev.status === "processed"
                            ? "badge-customer"
                            : ev.status === "error"
                            ? "badge-guest"
                            : "badge-cyan"
                        }`}
                      >
                        {ev.status}
                      </span>
                    </td>
                    <td style={{ width: "160px" }}>
                      <CopyableId id={ev.entityId} maxWidth={140} />
                    </td>
                    <td style={{ width: "160px" }}>
                      <CopyableId id={ev.eventId || ev.id} maxWidth={140} />
                    </td>
                    <td style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                      <FormattedDate date={ev.createdAt} format="time" />
                    </td>
                    <td>
                      <Link to={`/admin/events?eventId=${ev.id}`} className="filter-btn" style={{ padding: "4px 8px", fontSize: "0.75rem" }}>
                        Inspect Chunks →
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}
    </div>
  );
}
