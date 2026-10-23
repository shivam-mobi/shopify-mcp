import { useState, useEffect, useMemo } from "react";
import { useLoaderData, useSearchParams, useNavigate, Link, Form } from "react-router";
import { requireAdminUser } from "../admin/auth.server";
import { useDevMode } from "../admin/components/AdminLayout";
import { getShoppersPaginated, getShopperDetails } from "../admin/queries.server";
import CopyableId from "../admin/components/CopyableId";
import FormattedDate from "../admin/components/FormattedDate";
import AdminPagination from "../admin/components/AdminPagination";
import DateRangeFilter from "../admin/components/DateRangeFilter";
import ShopperInspectView from "../admin/components/ShopperInspectView";
import {
  ArrowLeftIcon,
  ShoppingBagIcon,
  CreditCardIcon,
  ExternalLinkIcon,
  CloseIcon,
  ChatBubbleIcon,
  SparkleIcon,
  FolderIcon,
  SearchIcon,
  ClockIcon,
  ChatMessageIcon,
} from "../admin/components/ChatIcons.jsx";

function FormattedShippingAddress({ address, devMode }) {
  if (!address) return null;
  let parsed = address;
  if (typeof address === "string") {
    try {
      parsed = JSON.parse(address);
    } catch {
      try {
        parsed = JSON.parse(address + "}");
      } catch {
        return (
          <div style={{ marginTop: 6 }}>
            <div
              style={{
                background: "var(--bg-surface-elevated)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-sm)",
                padding: 14,
                fontSize: "0.85rem",
                color: "var(--text-main)",
              }}
            >
              {address}
            </div>
          </div>
        );
      }
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return (
      <div style={{ marginTop: 6 }}>
        <div
          style={{
            background: "var(--bg-surface-elevated)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-sm)",
            padding: 14,
            fontSize: "0.85rem",
            color: "var(--text-main)",
          }}
        >
          {String(parsed)}
        </div>
      </div>
    );
  }

  const firstName = parsed.first_name || parsed.firstName || "";
  const lastName = parsed.last_name || parsed.lastName || "";
  const fullName =
    parsed.name ||
    parsed.fullName ||
    [firstName, lastName].filter(Boolean).join(" ");
  const company = parsed.company || "";

  const street1 =
    parsed.street_address ||
    parsed.streetAddress ||
    parsed.address1 ||
    parsed.address_1 ||
    "";
  const street2 =
    parsed.extended_address ||
    parsed.extendedAddress ||
    parsed.address2 ||
    parsed.address_2 ||
    "";
  const street = [street1, street2].filter(Boolean).join(", ");

  const city =
    parsed.address_locality ||
    parsed.addressLocality ||
    parsed.city ||
    "";
  const state =
    parsed.address_region ||
    parsed.addressRegion ||
    parsed.province ||
    parsed.provinceCode ||
    parsed.state ||
    "";
  const zip =
    parsed.postal_code ||
    parsed.postalCode ||
    parsed.zip ||
    parsed.zipCode ||
    "";
  const region = [city, state, zip].filter(Boolean).join(", ");

  const cName =
    parsed.address_country ||
    parsed.addressCountry ||
    parsed.country ||
    parsed.countryCode ||
    "";
  const phone =
    parsed.phone_number ||
    parsed.phoneNumber ||
    parsed.phone ||
    "";

  const hasStructuredFields = Boolean(
    fullName || company || street || region || cName || phone
  );

  return (
    <div style={{ marginTop: 6 }}>
      <div
        style={{
          background: "var(--bg-surface-elevated)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-sm)",
          padding: 14,
        }}
      >
        {fullName && (
          <div style={{ fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>
            {fullName} {company && <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>({company})</span>}
          </div>
        )}
        {!fullName && company && (
          <div style={{ fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>
            {company}
          </div>
        )}
        {street && (
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
            {street}
          </div>
        )}
        {region && (
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
            {region}
          </div>
        )}
        {cName && (
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
            {cName}
          </div>
        )}
        {phone && (
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: 6 }}>
            📞 {phone}
          </div>
        )}

        {!hasStructuredFields && (
          <div style={{ fontSize: "0.85rem", color: "var(--text-main)", lineHeight: 1.5 }}>
            {parsed.formatted_address ||
              parsed.formattedAddress ||
              parsed.address ||
              parsed.destination ||
              JSON.stringify(parsed)}
          </div>
        )}
      </div>
      {devMode && (
        <pre className="code-block" style={{ marginTop: 8, fontSize: "0.75rem" }}>
          {JSON.stringify(parsed, null, 2)}
        </pre>
      )}
    </div>
  );
}

export const loader = async ({ request }) => {
  await requireAdminUser(request);

  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const filter = url.searchParams.get("filter") || "all";
  const sortOrder = url.searchParams.get("sortOrder") === "asc" ? "asc" : "desc";
  const startDate = url.searchParams.get("startDate") || "";
  const endDate = url.searchParams.get("endDate") || "";
  const shopperId = url.searchParams.get("shopperId") || "";
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const rawLimit = parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = [10, 20, 50, 100].includes(rawLimit) ? rawLimit : 20;

  const [result, selectedShopperDetails] = await Promise.all([
    getShoppersPaginated({ search, filter, sortOrder, page, limit, startDate, endDate }),
    shopperId ? getShopperDetails(shopperId) : Promise.resolve(null),
  ]);

  return { ...result, search, filter, sortOrder, limit, startDate, endDate, selectedShopperId: shopperId, selectedShopperDetails };
};

export default function AdminCustomersRoute() {
  const { shoppers, total, page, totalPages, limit = 20, search, filter, sortOrder = "desc", startDate = "", endDate = "", selectedShopperDetails } = useLoaderData();
  const { devMode } = useDevMode();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filterSearch, setFilterSearch] = useState(search || "");
  const [filterType, setFilterType] = useState(filter || "all");

  useEffect(() => {
    setFilterSearch(search || "");
    setFilterType(filter || "all");
  }, [search, filter]);

  const [activeTab, setActiveTab] = useState("conversations"); // 'conversations' | 'addresses' | 'memory' | 'cart'
  const [dismissedShopperId, setDismissedShopperId] = useState(null);
  const [threadSearch, setThreadSearch] = useState("");
  const [threadPage, setThreadPage] = useState(1);
  const THREADS_PER_PAGE = 15;

  useEffect(() => {
    if (selectedShopperDetails) {
      setDismissedShopperId(null);
      setThreadSearch("");
      setThreadPage(1);
      setActiveTab("conversations");
    }
  }, [selectedShopperDetails?.id]);

  const activeShopperDetails =
    selectedShopperDetails &&
    selectedShopperDetails.id !== dismissedShopperId
      ? selectedShopperDetails
      : null;
  const selectedShopper = activeShopperDetails;

  const shopperConversations = selectedShopper?.conversations || [];

  const filteredConversations = useMemo(() => {
    if (!threadSearch.trim()) return shopperConversations;
    const q = threadSearch.trim().toLowerCase().replace(/^#/, "");
    return shopperConversations.filter((c) => {
      return (
        String(c.id).toLowerCase().includes(q) ||
        String(c.firstMessage || "").toLowerCase().includes(q) ||
        String(c.snippet || "").toLowerCase().includes(q)
      );
    });
  }, [shopperConversations, threadSearch]);

  const totalThreadPages = Math.ceil(filteredConversations.length / THREADS_PER_PAGE) || 1;
  const paginatedThreads = useMemo(() => {
    const start = (threadPage - 1) * THREADS_PER_PAGE;
    return filteredConversations.slice(start, start + THREADS_PER_PAGE);
  }, [filteredConversations, threadPage]);

  const totalMessagesAcrossThreads = useMemo(() => {
    return shopperConversations.reduce((acc, c) => acc + (c.messageCount || 0), 0);
  }, [shopperConversations]);

  const handleOpenShopper = (id) => {
    setDismissedShopperId(null);
    setActiveTab("conversations");
    const params = new URLSearchParams(searchParams);
    params.set("shopperId", id);
    setSearchParams(params, { preventScrollReset: true });
  };

  const handleCloseShopper = () => {
    // 1. Immediately dismiss modal locally (instant 0ms close!)
    setDismissedShopperId(selectedShopperDetails?.id || "dismissed");
    // 2. Remove query param in background
    const params = new URLSearchParams(searchParams);
    params.delete("shopperId");
    setSearchParams(params, { preventScrollReset: true });
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && activeShopperDetails) {
        handleCloseShopper();
      }
    };
    if (activeShopperDetails) {
      window.addEventListener("keydown", handleKeyDown);
      return () => {
        window.removeEventListener("keydown", handleKeyDown);
      };
    }
  }, [activeShopperDetails]);

  const handlePageChange = (newPage) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(newPage));
    if (sortOrder === "asc") {
      params.set("sortOrder", "asc");
    } else {
      params.delete("sortOrder");
    }
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

  const handleToggleSort = () => {
    const nextOrder = sortOrder === "asc" ? "desc" : "asc";
    const params = new URLSearchParams(searchParams);
    if (nextOrder === "asc") {
      params.set("sortOrder", "asc");
    } else {
      params.delete("sortOrder");
    }
    if (limit !== 20) {
      params.set("limit", String(limit));
    }
    params.set("page", "1");
    setSearchParams(params);
  };

  const handleClearAll = () => {
    navigate("/admin/customers");
  };

  const hasActiveFilters = Boolean(search || filter !== "all" || startDate || endDate || sortOrder === "asc");

  const sortParam = sortOrder === "asc" ? "&sortOrder=asc" : "";
  const limitParam = limit && limit !== 20 ? `&limit=${limit}` : "";

  if (activeShopperDetails) {
    return (
      <ShopperInspectView
        shopper={activeShopperDetails}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onBack={handleCloseShopper}
        threadSearch={threadSearch}
        setThreadSearch={setThreadSearch}
        threadPage={threadPage}
        setThreadPage={setThreadPage}
        filteredConversations={filteredConversations}
        paginatedThreads={paginatedThreads}
        totalThreadPages={totalThreadPages}
        totalMessagesAcrossThreads={totalMessagesAcrossThreads}
        devMode={devMode}
        searchParams={searchParams}
      />
    );
  }

  if (selectedShopperDetails === null && searchParams.get("shopperId") && !dismissedShopperId) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <button
          type="button"
          onClick={handleCloseShopper}
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
          }}
        >
          <ArrowLeftIcon size={14} />
          <span>Back to Shoppers</span>
        </button>
        <div className="glass-panel" style={{ padding: "40px 24px", textAlign: "center" }}>
          <div style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: 8, color: "var(--text-main)" }}>Shopper Not Found</div>
          <div style={{ fontSize: "0.85rem", color: "var(--text-dim)", marginBottom: 16 }}>
            The requested shopper could not be found or has no recorded activity.
          </div>
          <button type="button" onClick={handleCloseShopper} className="filter-btn">
            Return to Shoppers & Customers
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="glass-panel">
        <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--text-main)" }}>Shoppers & Customers</span>
            <span className="badge badge-cyan">{total} total</span>
          </div>

          {/* Search Box, Dropdown Filter & Date Filters */}
          <Form
            key={`customers-filter-${filter}-${search}-${startDate}-${endDate}-${sortOrder}`}
            method="get"
            className="controls-bar"
            style={{ margin: 0, flexWrap: "wrap", gap: 10, alignItems: "center" }}
          >
            {sortOrder === "asc" && <input type="hidden" name="sortOrder" value="asc" />}
            {limit !== 20 && <input type="hidden" name="limit" value={limit} />}
            <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
              <input
                type="text"
                name="search"
                value={filterSearch}
                onChange={(e) => setFilterSearch(e.target.value)}
                placeholder="Search name, email, shopper ID..."
                className="search-input"
                style={{ paddingLeft: "32px", width: "230px" }}
              />
              <span style={{ position: "absolute", left: "10px", display: "flex", alignItems: "center", pointerEvents: "none", color: "var(--text-dim)" }}>
                <SearchIcon size={14} />
              </span>
            </div>

            <div style={{ minWidth: 170 }}>
              <select
                name="filter"
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="admin-select"
                style={{ width: "100%", cursor: "pointer", height: 38 }}
              >
                <option value="all">All Shoppers</option>
                <option value="guest">Guests Only</option>
                <option value="customer">Registered Customers</option>
              </select>
            </div>

            <DateRangeFilter startDate={startDate} endDate={endDate} />

            <button type="submit" className="admin-btn admin-btn-primary" style={{ height: 38 }}>
              Filter
            </button>
            <Link
              to="/admin/customers"
              onClick={() => {
                setFilterSearch("");
                setFilterType("all");
              }}
              className={`filter-clear-btn ${hasActiveFilters ? "active" : ""}`}
              title="Reset all filters"
            >
              <CloseIcon size={12} />
              <span>Clear</span>
            </Link>
          </Form>
        </div>


        {/* Shoppers Table */}
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th style={{ minWidth: 200, width: "22%" }}>Shopper / Customer</th>
                <th>Email</th>
                <th>Type</th>
                <th>Part Searches</th>
                <th>Conversations</th>
                <th>
                  <button
                    type="button"
                    onClick={handleToggleSort}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      font: "inherit",
                      fontSize: "inherit",
                      fontWeight: "inherit",
                      color: "inherit",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      textTransform: "inherit",
                      letterSpacing: "inherit",
                      userSelect: "none",
                    }}
                    title={`Sorted by Last Active (${sortOrder === "asc" ? "Ascending - Oldest First" : "Descending - Newest First"}). Click to sort ${sortOrder === "asc" ? "Descending (Newest First)" : "Ascending (Oldest First)"}.`}
                  >
                    <span>Last Active</span>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        background: sortOrder === "asc" ? "rgba(0, 188, 242, 0.15)" : "var(--bg-surface-elevated)",
                        border: sortOrder === "asc" ? "1px solid rgba(0, 188, 242, 0.3)" : "1px solid var(--border-subtle)",
                        color: sortOrder === "asc" ? "var(--accent-cyan)" : "var(--text-main)",
                        fontSize: "0.75rem",
                        fontWeight: 700,
                      }}
                    >
                      {sortOrder === "asc" ? "↑" : "↓"}
                    </span>
                  </button>
                </th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {shoppers.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", color: "var(--text-dim)", padding: 40 }}>
                    No shoppers found matching your criteria.
                  </td>
                </tr>
              ) : (
                shoppers.map((shopper) => (
                  <tr key={shopper.id}>
                    <td style={{ minWidth: 200, whiteSpace: "nowrap" }}>
                      <div style={{ fontWeight: 700, color: "var(--text-main)", whiteSpace: "nowrap" }}>
                        {shopper.displayName}
                      </div>
                    </td>

                    <td style={{ fontSize: "0.82rem" }}>
                      {shopper.email ? (
                        <a
                          href={`mailto:${shopper.email}`}
                          style={{
                            color: "var(--accent-cyan)",
                            textDecoration: "none",
                            fontWeight: 500,
                          }}
                          title={`Email ${shopper.email}`}
                        >
                          {shopper.email}
                        </a>
                      ) : (
                        <span style={{ color: "var(--text-dim)", fontSize: "0.8rem" }}>—</span>
                      )}
                    </td>

                    <td style={{ whiteSpace: "nowrap" }}>
                      {shopper.isGuest ? (
                        <span className="badge badge-guest">Guest</span>
                      ) : (
                        <span className="badge badge-customer">
                          {shopper.customerLoggedIn ? "Logged In" : "Customer"}
                        </span>
                      )}
                    </td>

                    <td style={{ whiteSpace: "nowrap" }}>
                      {shopper.searchMemoryCount > 0 ? (
                        <span className="badge badge-amber">
                          {shopper.searchMemoryCount} Search{shopper.searchMemoryCount > 1 ? "es" : ""}
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-dim)", fontSize: "0.8rem" }}>0</span>
                      )}
                    </td>

                    <td>
                      {shopper.conversationCount > 0 ? (
                        <Link
                          to={`/admin/conversations?${
                            shopper.shopifyCustomerId
                              ? `user=${encodeURIComponent(`customer:${shopper.shopifyCustomerId}`)}`
                              : shopper.displayName && !shopper.displayName.toLowerCase().startsWith("guest")
                              ? `user=${encodeURIComponent(`name:${shopper.displayName.toLowerCase()}`)}`
                              : shopper.id
                              ? `user=${encodeURIComponent(`shopper:${shopper.id}`)}`
                              : `search=${encodeURIComponent(shopper.id)}`
                          }`}
                          style={{
                            color: "var(--accent-blue)",
                            textDecoration: "none",
                            fontSize: "0.82rem",
                            fontWeight: 600,
                          }}
                        >
                          {shopper.conversationCount} chat{shopper.conversationCount > 1 ? "s" : ""} →
                        </Link>
                      ) : (
                        <span style={{ color: "var(--text-dim)", fontSize: "0.8rem" }}>0 chats</span>
                      )}
                    </td>

                    <td style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                      <FormattedDate date={shopper.updatedAtDate} format="datetime" />
                    </td>

                    <td style={{ whiteSpace: "nowrap" }}>
                      <Link
                        to={`/admin/customers?${(() => {
                          const p = new URLSearchParams(searchParams);
                          p.set("shopperId", shopper.id);
                          return p.toString();
                        })()}`}
                        onClick={(e) => {
                          if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
                            e.preventDefault();
                            handleOpenShopper(shopper.id);
                            setActiveTab("conversations");
                          }
                        }}
                        className="filter-btn"
                        style={{
                          padding: "5px 12px",
                          fontSize: "0.78rem",
                          whiteSpace: "nowrap",
                          textDecoration: "none",
                          display: "inline-block",
                        }}
                      >
                        Inspect
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

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
    </div>
  );
}
