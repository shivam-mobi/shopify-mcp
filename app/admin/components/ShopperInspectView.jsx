import { useState } from "react";
import { Link } from "react-router";
import CopyableId from "./CopyableId";
import FormattedDate from "./FormattedDate";
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
  ChatMessageIcon,
  MailIcon,
  MapPinIcon,
} from "./ChatIcons.jsx";

export function parseShippingAddress(address) {
  if (!address) return null;
  let parsed = address;
  if (typeof address === "string") {
    try {
      parsed = JSON.parse(address);
    } catch {
      try {
        parsed = JSON.parse(address + "}");
      } catch {
        return null;
      }
    }
  }
  if (!parsed || typeof parsed !== "object") return null;

  const name =
    parsed.name ||
    [parsed.firstName || parsed.first_name, parsed.lastName || parsed.last_name]
      .filter(Boolean)
      .join(" ");

  const street =
    [parsed.address1, parsed.address2].filter(Boolean).join(", ") ||
    parsed.street_address ||
    parsed.streetAddress ||
    "";

  const city = parsed.city || parsed.address_locality || parsed.addressLocality || "";
  const region =
    parsed.provinceCode ||
    parsed.province ||
    parsed.address_region ||
    parsed.addressRegion ||
    parsed.state ||
    "";
  const zip = parsed.zip || parsed.postal_code || parsed.postalCode || "";
  const cityLine = [city, region, zip].filter(Boolean).join(", ");
  const country =
    parsed.country ||
    parsed.countryCode ||
    parsed.address_country ||
    parsed.addressCountry ||
    "";
  const phone = parsed.phone || parsed.phone_number || parsed.phoneNumber || "";

  if (!name && !street && !cityLine && !country && !phone) {
    return null;
  }

  return { name, street, cityLine, country, phone, raw: parsed };
}

export function FormattedShippingAddress({ address, devMode }) {
  const parsed = parseShippingAddress(address);
  if (!parsed) return null;

  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          background: "var(--bg-surface-elevated)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-sm)",
          padding: 16,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
          {parsed.name && (
            <div style={{ fontWeight: 700, color: "var(--text-main)", fontSize: "0.92rem" }}>
              {parsed.name}
            </div>
          )}
          {parsed.country && (
            <span className="badge badge-cyan" style={{ fontSize: "0.7rem", padding: "2px 8px" }}>
              {parsed.country}
            </span>
          )}
        </div>

        <div style={{ fontSize: "0.86rem", color: "var(--text-muted)", lineHeight: 1.55 }}>
          {parsed.street && <div>{parsed.street}</div>}
          {parsed.cityLine && <div>{parsed.cityLine}</div>}
          {parsed.phone && (
            <div style={{ marginTop: 6, color: "var(--text-dim)", fontSize: "0.82rem" }}>
              📞 {parsed.phone}
            </div>
          )}
        </div>

        {devMode && (
          <pre className="code-block" style={{ marginTop: 10, fontSize: "0.72rem" }}>
            {JSON.stringify(parsed.raw, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

export function CopyableEmail({ email }) {
  const [copied, setCopied] = useState(false);

  if (!email || String(email).trim() === "") return null;

  const rawEmail = String(email).trim();

  const handleCopy = (e) => {
    e.stopPropagation();
    e.preventDefault();

    const doCopy = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    };

    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(rawEmail).then(doCopy).catch(doCopy);
    } else {
      doCopy();
    }
  };

  return (
    <span
      className="copyable-id-badge"
      title={`${rawEmail} (Click to copy email)`}
      onClick={handleCopy}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") handleCopy(e);
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "7px",
        background: copied ? "rgba(16, 185, 129, 0.16)" : "var(--bg-surface-elevated)",
        border: `1px solid ${copied ? "rgba(16, 185, 129, 0.45)" : "var(--border-subtle)"}`,
        borderRadius: "8px",
        padding: "5px 10px",
        cursor: "pointer",
        boxSizing: "border-box",
        minWidth: 0,
        transition: "all 0.18s ease",
        verticalAlign: "middle",
        userSelect: "none",
      }}
    >
      <MailIcon
        size={13}
        style={{
          color: copied ? "var(--accent-emerald)" : "var(--accent-cyan)",
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: "0.74rem", color: "var(--text-dim)", flexShrink: 0 }}>
        Email:
      </span>
      <span
        style={{
          fontSize: "0.82rem",
          fontWeight: 600,
          color: "var(--text-main)",
          whiteSpace: "nowrap",
        }}
      >
        {rawEmail}
      </span>
      {copied ? (
        <span
          style={{
            fontSize: "0.72rem",
            color: "var(--accent-emerald)",
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
            marginLeft: 2,
          }}
        >
          ✓ Copied
        </span>
      ) : (
        <a
          href={`mailto:${rawEmail}`}
          onClick={(e) => e.stopPropagation()}
          title={`Compose email to ${rawEmail}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            color: "var(--text-dim)",
            textDecoration: "none",
            marginLeft: 2,
            opacity: 0.7,
            transition: "opacity 0.15s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = "1";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = "0.7";
          }}
        >
          <ExternalLinkIcon size={10} />
        </a>
      )}
    </span>
  );
}

export default function ShopperInspectView({
  shopper,
  activeTab,
  setActiveTab,
  onBack,
  threadSearch,
  setThreadSearch,
  threadPage,
  setThreadPage,
  filteredConversations = [],
  paginatedThreads = [],
  totalThreadPages = 1,
  totalMessagesAcrossThreads = 0,
  devMode = false,
  searchParams,
}) {
  const THREADS_PER_PAGE = 15;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 32 }}>
      {/* Top Back Navigation Bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <button
          type="button"
          onClick={onBack}
          className="filter-btn"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 16px",
            fontSize: "0.82rem",
            fontWeight: 600,
            cursor: "pointer",
          }}
          title="Return to Shoppers & Customers list"
        >
          <ArrowLeftIcon size={14} />
          <span>Back to Shoppers</span>
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.8rem", color: "var(--text-dim)" }}>
          <button
            type="button"
            onClick={onBack}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: "inherit",
              textDecoration: "underline",
            }}
          >
            Shoppers & Customers
          </button>
          <span>/</span>
          <span style={{ color: "var(--text-main)", fontWeight: 600 }}>{shopper.displayName}</span>
        </div>
      </div>

      {/* Main Dedicated Shopper Inspection Card */}
      <div className="shopper-inspect-page">
        {/* Page Header */}
        <div className="modal-header" style={{ padding: "20px 24px", borderBottom: "1px solid var(--border-subtle)" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h2 style={{ fontSize: "1.35rem", fontWeight: 800, color: "var(--text-main)", margin: 0 }}>
                {shopper.displayName}
              </h2>
              <span className={`badge ${shopper.isGuest ? "badge-guest" : "badge-customer"}`}>
                {shopper.isGuest ? "Guest Shopper" : "Verified Customer"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
              <CopyableId id={shopper.id} prefix="Shopper ID: " maxWidth={240} />
              {shopper.email && <CopyableEmail email={shopper.email} />}
            </div>
          </div>
        </div>

        {/* Sub-tab navigation: Chats, Addresses, Part Searches, Shopper Cart */}
        <div className="shopper-modal-nav">
          {[
            { id: "conversations", label: "Chats", icon: <ChatBubbleIcon size={14} />, count: shopper.conversationCount || (shopper.conversations || []).length || 0 },
            { id: "addresses", label: "Addresses", icon: <FolderIcon size={14} />, count: shopper.addresses?.length || 0 },
            { id: "memory", label: "Searches", icon: <SparkleIcon size={14} />, count: shopper.searchMemories?.length || 0 },
            { id: "cart", label: "Shopper Cart", icon: <ShoppingBagIcon size={14} />, count: shopper.activeCartId ? 1 : 0 },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`shopper-tab-btn ${activeTab === tab.id ? "active" : ""}`}
            >
              <span style={{ display: "inline-flex", alignItems: "center" }}>{tab.icon}</span>
              <span>{tab.label}</span>
              {tab.count > 0 && <span className="shopper-tab-pill">{tab.count}</span>}
            </button>
          ))}
        </div>

        {/* Page Body */}
        <div className="modal-body">
          {/* TAB 1: CONVERSATIONS / CHATS */}
          {activeTab === "conversations" && (
            <div className="shopper-threads-container">
              <div className="shopper-threads-header">
                <div className="shopper-threads-title-wrap">
                  <div className="shopper-threads-icon-badge">
                    <ChatBubbleIcon size={18} />
                  </div>
                  <div>
                    <h3 className="shopper-threads-title">
                      <span>Linked AI Conversations</span>
                      <span className="shopper-threads-pill">
                        {(shopper.conversations || []).length} {(shopper.conversations || []).length === 1 ? "Chat" : "Chats"}
                      </span>
                    </h3>
                    <div className="shopper-threads-subtitle">
                      {totalMessagesAcrossThreads.toLocaleString()} total messages recorded across assistant sessions
                    </div>
                  </div>
                </div>

                <div className="shopper-threads-controls">
                  <div className="shopper-threads-search-wrap">
                    <span className="shopper-threads-search-icon">
                      <SearchIcon size={14} />
                    </span>
                    <input
                      type="text"
                      placeholder="Search chat #"
                      value={threadSearch}
                      onChange={(e) => {
                        setThreadSearch(e.target.value);
                        setThreadPage(1);
                      }}
                      className="shopper-threads-search-input"
                    />
                    {threadSearch && (
                      <button
                        type="button"
                        onClick={() => {
                          setThreadSearch("");
                          setThreadPage(1);
                        }}
                        className="shopper-threads-search-clear"
                        title="Clear search"
                      >
                        <CloseIcon size={12} />
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {filteredConversations.length === 0 ? (
                <div className="admin-empty" style={{ padding: 36, textAlign: "center" }}>
                  {threadSearch ? (
                    <div>
                      <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>
                        No chats matching "{threadSearch}"
                      </div>
                      <div style={{ fontSize: "0.8rem", color: "var(--text-dim)", marginBottom: 12 }}>
                        Try searching for another keyword or chat identifier.
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setThreadSearch("");
                          setThreadPage(1);
                        }}
                        className="filter-btn"
                      >
                        Clear Filter
                      </button>
                    </div>
                  ) : (
                    "No chats recorded for this shopper yet."
                  )}
                </div>
              ) : (
                <>
                  <div className="shopper-threads-list">
                    {paginatedThreads.map((c) => (
                      <div
                        key={c.id}
                        className={`shopper-thread-card ${c.isActive ? "is-active" : ""}`}
                      >
                        <div className="shopper-thread-left">
                          <div className="shopper-thread-icon">
                            <ChatBubbleIcon size={14} />
                          </div>
                          <div className="shopper-thread-info">
                            <div className="shopper-thread-title-area">
                              <span
                                className="shopper-thread-first-message"
                                title={c.firstMessage || `Chat #${c.id}`}
                              >
                                {c.firstMessage || `Chat #${c.id}`}
                              </span>
                              {c.isActive && (
                                <span className="shopper-thread-active-badge">
                                  <span className="shopper-thread-pulse-dot" />
                                  <span>Active Session</span>
                                </span>
                              )}
                            </div>
                            <div className="shopper-thread-row-meta">
                              <CopyableId id={c.id} prefix="Chat #" maxWidth={220} />
                              <span className="shopper-thread-meta-dot">•</span>
                              <span className="shopper-thread-count-badge">
                                <ChatMessageIcon size={12} />
                                <span>{c.messageCount || c._count?.messages || 0} messages</span>
                              </span>
                              <span className="shopper-thread-meta-dot">•</span>
                              <span className="shopper-thread-time">
                                Last updated <FormattedDate date={c.updatedAt} format="datetime" />
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="shopper-thread-actions">
                          {(() => {
                            const userFilterKey = shopper?.shopifyCustomerId
                              ? `customer:${shopper.shopifyCustomerId}`
                              : shopper?.id
                              ? `shopper:${shopper.id}`
                              : "";
                            return (
                              <Link
                                to={`/admin/conversations?id=${c.id}${userFilterKey ? `&user=${encodeURIComponent(userFilterKey)}` : ""}`}
                                className="shopper-thread-open-btn"
                                title="Open in Conversations Inspector"
                              >
                                <span>Open Conversation</span>
                                <ExternalLinkIcon size={12} />
                              </Link>
                            );
                          })()}
                        </div>
                      </div>
                    ))}
                  </div>

                  {totalThreadPages > 1 && (
                    <div className="shopper-threads-pagination">
                      <div>
                        Showing <strong>{((threadPage - 1) * THREADS_PER_PAGE) + 1}</strong> –{" "}
                        <strong>{Math.min(threadPage * THREADS_PER_PAGE, filteredConversations.length)}</strong> of{" "}
                        <strong>{filteredConversations.length}</strong> chats
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <button
                          type="button"
                          disabled={threadPage <= 1}
                          onClick={() => setThreadPage((p) => Math.max(p - 1, 1))}
                          className="filter-btn"
                          style={{
                            padding: "4px 10px",
                            fontSize: "0.78rem",
                            opacity: threadPage <= 1 ? 0.5 : 1,
                            cursor: threadPage <= 1 ? "not-allowed" : "pointer",
                          }}
                        >
                          ← Prev
                        </button>
                        <span style={{ fontSize: "0.78rem", fontWeight: 600, padding: "0 6px" }}>
                          {threadPage} / {totalThreadPages}
                        </span>
                        <button
                          type="button"
                          disabled={threadPage >= totalThreadPages}
                          onClick={() => setThreadPage((p) => Math.min(p + 1, totalThreadPages))}
                          className="filter-btn"
                          style={{
                            padding: "4px 10px",
                            fontSize: "0.78rem",
                            opacity: threadPage >= totalThreadPages ? 0.5 : 1,
                            cursor: threadPage >= totalThreadPages ? "not-allowed" : "pointer",
                          }}
                        >
                          Next →
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* TAB 2: ADDRESSES */}
          {activeTab === "addresses" && (
            <div>
              <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: 14 }}>
                Customer Delivery Addresses
              </h3>
              {(!shopper.addresses || shopper.addresses.length === 0) ? (
                parseShippingAddress(shopper.shippingAddress) ? (
                  <div>
                    <div style={{ fontSize: "0.82rem", color: "var(--text-dim)", marginBottom: 12 }}>
                      No Shopify customer profile addresses found. Showing destination address captured during checkout/cart session:
                    </div>
                    <FormattedShippingAddress address={shopper.shippingAddress} devMode={devMode} />
                  </div>
                ) : (
                  <div style={{ color: "var(--text-dim)", padding: 20, textAlign: "center" }}>
                    No profile addresses recorded.
                  </div>
                )
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
                  {shopper.addresses.map((addr) => (
                    <div
                      key={addr.id}
                      style={{
                        background: "var(--bg-surface-elevated)",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: "var(--radius-sm)",
                        padding: 16,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <div style={{ fontWeight: 700, color: "var(--text-main)" }}>
                          {addr.firstName} {addr.lastName} {addr.company && `(${addr.company})`}
                        </div>
                        {addr.isDefault && <span className="badge badge-emerald">Default</span>}
                      </div>
                      <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
                        {addr.streetAddress}
                        {addr.extendedAddress && `, ${addr.extendedAddress}`}
                        <br />
                        {addr.addressLocality}, {addr.addressRegion} {addr.postalCode},{" "}
                        {addr.addressCountry}
                        {addr.phoneNumber && <br />}
                        {addr.phoneNumber && `📞 ${addr.phoneNumber}`}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: PART SEARCHES */}
          {activeTab === "memory" && (
            <div>
              <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: 14 }}>
                Recent Searches
              </h3>
              {(!shopper.searchMemories || shopper.searchMemories.length === 0) ? (
                <div style={{ color: "var(--text-dim)", padding: 20, textAlign: "center" }}>
                  No search history recorded for this shopper.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {shopper.searchMemories.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        background: "var(--bg-surface-elevated)",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: "var(--radius-sm)",
                        padding: 14,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <div>
                        <span className="badge badge-cyan" style={{ marginRight: 8 }}>
                          {m.intent}
                        </span>
                        <span style={{ fontWeight: 600, color: "var(--text-main)", fontSize: "0.9rem" }}>
                          {m.vehicleYear && `${m.vehicleYear} `}
                          {m.vehicleMake && `${m.vehicleMake} `}
                          {m.vehicleModel && `${m.vehicleModel} `}
                          {m.vehicleEngine && `(${m.vehicleEngine})`}
                          {m.homeFilterSize && `Size: ${m.homeFilterSize} `}
                          {m.homeMerv && `MERV: ${m.homeMerv}`}
                        </span>
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", textAlign: "right" }}>
                        Used {m.useCount} time{m.useCount > 1 ? "s" : ""}
                        <br />
                        <FormattedDate date={m.lastUsedAt} format="date" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: SHOPPER CART & CHECKOUT STATE */}
          {activeTab === "cart" && (
            <div>
              <div className="cart-checkout-container">
                <div className="cart-checkout-header">
                  <div className="cart-checkout-title-wrap">
                    <div className="cart-checkout-icon-badge">
                      <ShoppingBagIcon size={16} />
                    </div>
                    <div>
                      <div className="cart-checkout-title">
                        Shopper Cart & Checkout State
                      </div>
                      <div className="cart-checkout-subtitle">
                        Shopify Storefront session identifiers
                      </div>
                    </div>
                  </div>
                  {shopper.activeCartId && (
                    <span className="badge badge-emerald">
                      ● Active Session
                    </span>
                  )}
                </div>

                <div className="cart-checkout-grid">
                  {/* Cart ID Card */}
                  <div className="cart-id-card">
                    <div className="cart-id-card-top">
                      <span className="cart-id-card-label">
                        <span style={{ color: "var(--pf-brand)" }}>🛍️</span>
                        <span>Cart ID</span>
                      </span>
                      <span
                        className={`cart-id-card-status ${
                          shopper.activeCartId ? "connected" : "empty"
                        }`}
                      >
                        {shopper.activeCartId ? "Connected" : "Empty"}
                      </span>
                    </div>
                    <div>
                      {shopper.activeCartId ? (
                        <CopyableId
                          id={shopper.activeCartId}
                          maxWidth="100%"
                          style={{ width: "100%", justifyContent: "space-between" }}
                        />
                      ) : (
                        <div style={{ fontSize: "0.82rem", color: "var(--text-dim)", fontStyle: "italic", padding: "4px 0" }}>
                          No active cart created
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Checkout ID Card */}
                  <div className="cart-id-card">
                    <div className="cart-id-card-top">
                      <span className="cart-id-card-label">
                        <CreditCardIcon size={13} style={{ color: "var(--accent-emerald)" }} />
                        <span>Checkout ID</span>
                      </span>
                      <span
                        className={`cart-id-card-status ${
                          shopper.activeCheckoutId ? "active" : "empty"
                        }`}
                      >
                        {shopper.activeCheckoutId ? "Active" : "Pending"}
                      </span>
                    </div>
                    <div>
                      {shopper.activeCheckoutId ? (
                        <CopyableId
                          id={shopper.activeCheckoutId}
                          maxWidth="100%"
                          style={{ width: "100%", justifyContent: "space-between" }}
                        />
                      ) : (
                        <div style={{ fontSize: "0.82rem", color: "var(--text-dim)", fontStyle: "italic", padding: "4px 0" }}>
                          No active checkout started
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {shopper.checkoutUrl && (
                  <div className="cart-url-row">
                    <div>
                      <div className="cart-url-label">Storefront Checkout</div>
                      <div className="cart-url-desc">
                        Direct customer checkout link generated for this cart
                      </div>
                    </div>
                    <a
                      href={shopper.checkoutUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="cart-checkout-btn"
                    >
                      <span>Open Checkout Link</span>
                      <ExternalLinkIcon size={12} />
                    </a>
                  </div>
                )}
              </div>

              {parseShippingAddress(shopper.shippingAddress) && (
                <div style={{ marginTop: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <MapPinIcon size={14} style={{ color: "var(--accent-emerald)" }} />
                    <span
                      style={{
                        fontSize: "0.75rem",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        color: "var(--text-dim)",
                      }}
                    >
                      Cart Shipping Destination
                    </span>
                    <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
                      • Attached to this cart session for shipping rates & checkout
                    </span>
                  </div>
                  <FormattedShippingAddress address={shopper.shippingAddress} devMode={devMode} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
