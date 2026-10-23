import { useState, useRef, useEffect } from "react";

/**
 * Shared AdminPagination Component
 * Implements the exact pagination design:
 * Show [ 20 ^ ] ... [ < ] [ 1 ] [ 2 ] [ 3 ] [ 4 ] [ ... ] [ 9 ] [ > ] of 9
 */
export default function AdminPagination({
  page = 1,
  totalPages = 1,
  total = 0,
  limit = 20,
  limitOptions = [10, 20, 50, 100],
  onPageChange,
  onLimitChange,
  itemLabel = "items",
  compact = false,
  className = "",
  style = {},
}) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsDropdownOpen(false);
      }
    }
    if (isDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isDropdownOpen]);

  // Compute page numbers array matching screenshot (e.g. 1, 2, 3, 4, '...', 9)
  const getPageNumbers = () => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    if (page <= 4) {
      return [1, 2, 3, 4, 5, "...", totalPages];
    }
    if (page >= totalPages - 3) {
      return [1, "...", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    }
    return [1, "...", page - 1, page, page + 1, "...", totalPages];
  };

  const pages = getPageNumbers();

  return (
    <div className={`admin-pagination-container ${className}`} style={style}>
      {/* Left: Show Dropdown */}
      <div className="admin-pagination-left">
        {onLimitChange && (
          <>
            <span className="admin-pagination-label">Show</span>
            <div className="admin-pagination-limit-wrap" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setIsDropdownOpen((prev) => !prev)}
                className="admin-pagination-limit-btn"
                title="Select rows per page"
              >
                <span>{limit}</span>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    transform: isDropdownOpen ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.15s ease",
                  }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {isDropdownOpen && (
                <div className="admin-pagination-limit-menu">
                  {limitOptions.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => {
                        setIsDropdownOpen(false);
                        onLimitChange(opt);
                      }}
                      className={`admin-pagination-limit-item ${limit === opt ? "active" : ""}`}
                    >
                      <span>{opt}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Right: Page Navigation Box Buttons */}
      <div className="admin-pagination-right" style={compact ? { gap: 6 } : {}}>
        {/* Previous Button */}
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="admin-pagination-box"
          title="Previous Page"
          aria-label="Previous Page"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        {compact ? (
          <span
            style={{
              fontSize: "0.78rem",
              fontWeight: 600,
              color: "var(--text-muted)",
              padding: "0 6px",
              whiteSpace: "nowrap",
              userSelect: "none",
            }}
          >
            Page {page} of {totalPages}
          </span>
        ) : (
          pages.map((p, idx) => {
            if (p === "...") {
              return (
                <span key={`ellipsis-${idx}`} className="admin-pagination-ellipsis">
                  ...
                </span>
              );
            }
            const isActive = p === page;
            return (
              <button
                key={p}
                type="button"
                onClick={() => onPageChange(p)}
                className={`admin-pagination-box ${isActive ? "active" : ""}`}
                style={{
                  fontWeight: isActive ? 700 : 500,
                  color: isActive ? "var(--text-main)" : "var(--text-muted)",
                }}
              >
                {p}
              </button>
            );
          })
        )}

        {/* Next Button */}
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="admin-pagination-box"
          title="Next Page"
          aria-label="Next Page"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        {!compact && (
          <span className="admin-pagination-total-text">
            of {totalPages}
          </span>
        )}
      </div>
    </div>
  );
}
