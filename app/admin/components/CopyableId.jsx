import { useState } from "react";

/**
 * Reusable CopyableId component
 * Truncates long IDs to save table space, shows full ID on hover tooltip,
 * and provides a 1-click copy icon button with instant visual confirmation.
 */
export function CopyableId({
  id,
  prefix = "",
  maxWidth = 150,
  mono = true,
  className = "",
  style = {},
}) {
  const [copied, setCopied] = useState(false);

  if (!id || String(id).trim() === "") {
    return <span style={{ color: "var(--text-dim)", fontSize: "0.8rem" }}>—</span>;
  }

  const rawId = String(id).trim();
  // Strip common verbose prefixes like gid://shopify/ for clean table view
  const displayId = rawId.replace(/^gid:\/\/shopify\//, "");

  const handleCopy = (e) => {
    e.stopPropagation();
    e.preventDefault();

    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(rawId).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }).catch(() => {
        // Fallback for non-HTTPS or permission denied
        fallbackCopy(rawId);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      });
    } else {
      fallbackCopy(rawId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  const fallbackCopy = (text) => {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-9999px";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
    } catch (err) {
      console.warn("Copy fallback failed:", err);
    }
  };

  return (
    <span
      className={`copyable-id-badge ${className}`}
      title={`${rawId} (Click to copy ID)`}
      onClick={handleCopy}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          handleCopy(e);
        }
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
        maxWidth: typeof maxWidth === "number" ? `${maxWidth}px` : maxWidth,
        boxSizing: "border-box",
        minWidth: 0,
        transition: "all 0.18s ease",
        verticalAlign: "middle",
        userSelect: "none",
        ...style,
      }}
    >
      {prefix && (
        <span style={{ fontSize: "0.74rem", color: "var(--text-dim)", flexShrink: 0 }}>
          {prefix}
        </span>
      )}

      <span
        style={{
          fontFamily: mono ? "var(--font-mono, monospace)" : "inherit",
          fontSize: "0.8rem",
          fontWeight: 500,
          color: copied ? "var(--accent-emerald)" : "var(--text-main)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          flex: 1,
          minWidth: 0,
        }}
      >
        {copied ? "Copied!" : displayId}
      </span>

      <span
        aria-hidden="true"
        style={{
          background: "none",
          border: "none",
          padding: 0,
          fontSize: "0.74rem",
          lineHeight: 1,
          color: copied ? "#10b981" : "var(--text-dim)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          transition: "color 0.15s ease",
        }}
      >
        {copied ? (
          <span style={{ color: "#10b981", fontWeight: 700 }}>✓</span>
        ) : (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        )}
      </span>
    </span>
  );
}

export default CopyableId;
