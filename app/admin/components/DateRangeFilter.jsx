import { useState, useRef, useEffect, useMemo } from "react";
import { CalendarIcon, CloseIcon } from "./ChatIcons";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const MONTH_NAMES_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

const WEEKDAY_NAMES = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function toIsoDate(year, month, day) {
  const m = String(month + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

function parseIsoParts(isoStr) {
  if (!isoStr || typeof isoStr !== "string") return null;
  const parts = isoStr.trim().split("-");
  if (parts.length !== 3) return null;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  return { year: y, month: m, day: d };
}

function formatDisplayDate(isoStr) {
  const parts = parseIsoParts(isoStr);
  if (!parts) return "";
  return `${parts.day} ${MONTH_NAMES_SHORT[parts.month]} ${parts.year}`;
}

function formatRangeSummary(startIso, endIso) {
  if (!startIso) return "Select a range";
  if (!endIso || startIso === endIso) return formatDisplayDate(startIso);
  const s = startIso <= endIso ? startIso : endIso;
  const e = startIso <= endIso ? endIso : startIso;
  const startParts = parseIsoParts(s);
  const endParts = parseIsoParts(e);
  if (!startParts || !endParts) return `${s} – ${e}`;

  // If same year and month: "8 – 21 Oct 2026"
  if (startParts.year === endParts.year && startParts.month === endParts.month) {
    return `${startParts.day} – ${endParts.day} ${MONTH_NAMES_SHORT[startParts.month]} ${startParts.year}`;
  }
  // If same year: "28 Sep – 14 Oct 2026"
  if (startParts.year === endParts.year) {
    return `${startParts.day} ${MONTH_NAMES_SHORT[startParts.month]} – ${endParts.day} ${MONTH_NAMES_SHORT[endParts.month]} ${startParts.year}`;
  }
  return `${formatDisplayDate(s)} – ${formatDisplayDate(e)}`;
}

function getPresetRange(type) {
  const now = new Date();
  const todayIso = toIsoDate(now.getFullYear(), now.getMonth(), now.getDate());

  if (type === "today") {
    return { start: todayIso, end: todayIso };
  }
  if (type === "yesterday") {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    const yIso = toIsoDate(y.getFullYear(), y.getMonth(), y.getDate());
    return { start: yIso, end: yIso };
  }
  if (type === "7days") {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    return { start: toIsoDate(d.getFullYear(), d.getMonth(), d.getDate()), end: todayIso };
  }
  if (type === "30days") {
    const d = new Date(now);
    d.setDate(d.getDate() - 29);
    return { start: toIsoDate(d.getFullYear(), d.getMonth(), d.getDate()), end: todayIso };
  }
  if (type === "thisMonth") {
    const firstDay = toIsoDate(now.getFullYear(), now.getMonth(), 1);
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return { start: firstDay, end: toIsoDate(now.getFullYear(), now.getMonth(), lastDayOfMonth) };
  }
  if (type === "lastMonth") {
    const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const year = prevMonthDate.getFullYear();
    const month = prevMonthDate.getMonth();
    const lastDay = new Date(year, month + 1, 0).getDate();
    return {
      start: toIsoDate(year, month, 1),
      end: toIsoDate(year, month, lastDay),
    };
  }
  return { start: "", end: "" };
}

/**
 * Modern Custom Date Range Picker for Admin Listing Pages
 */
export default function DateRangeFilter({
  startDate = "",
  endDate = "",
  compact = false,
  className = "",
  style = {},
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);
  const [popoverAlign, setPopoverAlign] = useState("left");
  const [popoverPlacement, setPopoverPlacement] = useState("bottom");

  // Applied values (submitted with form)
  const [appliedStart, setAppliedStart] = useState(startDate || "");
  const [appliedEnd, setAppliedEnd] = useState(endDate || "");

  // Interactive selection state inside popover
  const [tempStart, setTempStart] = useState(startDate || "");
  const [tempEnd, setTempEnd] = useState(endDate || "");
  const [hoverDate, setHoverDate] = useState("");

  // Current calendar view month & year
  const initialView = useMemo(() => {
    const parsed = parseIsoParts(startDate) || parseIsoParts(endDate);
    if (parsed) return { year: parsed.year, month: parsed.month };
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  }, [startDate, endDate]);

  const [viewYear, setViewYear] = useState(initialView.year);
  const [viewMonth, setViewMonth] = useState(initialView.month);

  // Sync external props if they change
  useEffect(() => {
    setAppliedStart(startDate || "");
    setAppliedEnd(endDate || "");
    setTempStart(startDate || "");
    setTempEnd(endDate || "");
    const parsed = parseIsoParts(startDate) || parseIsoParts(endDate);
    if (parsed) {
      setViewYear(parsed.year);
      setViewMonth(parsed.month);
    }
  }, [startDate, endDate]);

  // Determine if popover should align left or right, and flip top or bottom based on viewport space
  useEffect(() => {
    if (isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const popoverWidth = compact ? rect.width : 315;
      if (rect.left + popoverWidth > window.innerWidth - 12 && rect.right - popoverWidth >= 12) {
        setPopoverAlign("right");
      } else {
        setPopoverAlign("left");
      }

      // Check vertical space (approx 390px popover height)
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      if (spaceBelow < 390 && spaceAbove > spaceBelow) {
        setPopoverPlacement("top");
      } else {
        setPopoverPlacement("bottom");
      }
    }
  }, [isOpen, compact]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
        setTempStart(appliedStart);
        setTempEnd(appliedEnd);
        setHoverDate("");
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [isOpen, appliedStart, appliedEnd]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        setTempStart(appliedStart);
        setTempEnd(appliedEnd);
        setHoverDate("");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, appliedStart, appliedEnd]);

  const handlePrevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  // Generate 42 days grid for current viewMonth / viewYear
  const calendarDays = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1);
    const startWeekday = firstDay.getDay(); // 0 is Sunday
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

    const days = [];

    // Prev month padding days
    for (let i = startWeekday - 1; i >= 0; i--) {
      const d = daysInPrevMonth - i;
      const m = viewMonth === 0 ? 11 : viewMonth - 1;
      const y = viewMonth === 0 ? viewYear - 1 : viewYear;
      days.push({
        day: d,
        month: m,
        year: y,
        iso: toIsoDate(y, m, d),
        isCurrentMonth: false,
      });
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      days.push({
        day: d,
        month: viewMonth,
        year: viewYear,
        iso: toIsoDate(viewYear, viewMonth, d),
        isCurrentMonth: true,
      });
    }

    // Next month padding days
    const remaining = 42 - days.length;
    for (let d = 1; d <= remaining; d++) {
      const m = viewMonth === 11 ? 0 : viewMonth + 1;
      const y = viewMonth === 11 ? viewYear + 1 : viewYear;
      days.push({
        day: d,
        month: m,
        year: y,
        iso: toIsoDate(y, m, d),
        isCurrentMonth: false,
      });
    }

    return days;
  }, [viewYear, viewMonth]);

  const now = new Date();
  const todayIso = toIsoDate(now.getFullYear(), now.getMonth(), now.getDate());

  const handleDayClick = (iso) => {
    if (!tempStart || (tempStart && tempEnd)) {
      // First click: start new range
      setTempStart(iso);
      setTempEnd("");
      setHoverDate("");
    } else {
      // Second click: complete range (always normalize earlier date to start, later to end)
      const s = iso < tempStart ? iso : tempStart;
      const e = iso < tempStart ? tempStart : iso;
      setTempStart(s);
      setTempEnd(e);
      setHoverDate("");
      handleApply(s, e);
    }
  };

  const handleApply = (newStart = tempStart, newEnd = tempEnd) => {
    let finalStart = newStart;
    let finalEnd = newEnd || newStart;
    if (finalStart && finalEnd && finalStart > finalEnd) {
      const temp = finalStart;
      finalStart = finalEnd;
      finalEnd = temp;
    }
    setAppliedStart(finalStart);
    setAppliedEnd(finalEnd);
    setIsOpen(false);

    // Auto-submit enclosing form so filter applies instantly
    setTimeout(() => {
      const form = containerRef.current?.closest("form");
      if (form) {
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else {
          form.submit();
        }
      }
    }, 20);
  };

  const handleApplyPreset = (type) => {
    const range = getPresetRange(type);
    setTempStart(range.start);
    setTempEnd(range.end);
    if (range.start) {
      const parts = parseIsoParts(range.start);
      if (parts) {
        setViewYear(parts.year);
        setViewMonth(parts.month);
      }
    }
    handleApply(range.start, range.end);
  };

  const handleClear = (e) => {
    e?.stopPropagation();
    e?.preventDefault();
    setTempStart("");
    setTempEnd("");
    setAppliedStart("");
    setAppliedEnd("");
    setIsOpen(false);

    setTimeout(() => {
      const form = containerRef.current?.closest("form");
      if (form) {
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else {
          form.submit();
        }
      }
    }, 20);
  };

  // Determine current active range for styling day cells (supporting forward AND reverse selection/hover)
  const [rangeStart, rangeEnd] = useMemo(() => {
    if (tempStart && tempEnd) {
      return tempStart <= tempEnd ? [tempStart, tempEnd] : [tempEnd, tempStart];
    }
    if (tempStart && hoverDate) {
      return tempStart <= hoverDate ? [tempStart, hoverDate] : [hoverDate, tempStart];
    }
    if (tempStart) {
      return [tempStart, tempStart];
    }
    return ["", ""];
  }, [tempStart, tempEnd, hoverDate]);

  const hasFilterActive = Boolean(appliedStart || appliedEnd);

  // Label for trigger button
  const triggerLabel = useMemo(() => {
    if (appliedStart && appliedEnd) {
      return formatRangeSummary(appliedStart, appliedEnd);
    }
    if (appliedStart) return `From: ${formatDisplayDate(appliedStart)}`;
    if (appliedEnd) return `Until: ${formatDisplayDate(appliedEnd)}`;
    return compact ? "Filter by Date" : "Date Range: All Time";
  }, [appliedStart, appliedEnd, compact]);

  return (
    <div
      ref={containerRef}
      className={`custom-date-range-container ${className}`.trim()}
      style={{
        position: "relative",
        display: compact ? "block" : "inline-block",
        width: compact ? "100%" : "auto",
        ...style,
      }}
    >
      {/* Hidden inputs to submit seamlessly with the standard form */}
      <input type="hidden" name="startDate" value={appliedStart} />
      <input type="hidden" name="endDate" value={appliedEnd} />

      {/* Trigger Button Row */}
      <div
        style={{
          display: compact ? "flex" : "inline-flex",
          alignItems: "center",
          gap: 4,
          width: compact ? "100%" : "auto",
        }}
      >
        <button
          type="button"
          onClick={() => {
            setIsOpen((prev) => !prev);
            setTempStart(appliedStart);
            setTempEnd(appliedEnd);
          }}
          className={`filter-date-custom-trigger ${hasFilterActive ? "is-active" : ""}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: compact ? "space-between" : "flex-start",
            gap: 8,
            height: compact ? 34 : 38,
            padding: compact ? "0 10px" : "0 14px",
            background: hasFilterActive
              ? "var(--pf-brand-soft, rgba(0, 188, 242, 0.12))"
              : "var(--bg-surface-elevated, #1e293b)",
            border: `1px solid ${
              hasFilterActive
                ? "var(--pf-brand, #00bcf2)"
                : "var(--border-subtle, rgba(255, 255, 255, 0.12))"
            }`,
            borderRadius: "8px",
            color: hasFilterActive ? "var(--accent-cyan, #00bcf2)" : "var(--text-main, #f1f5f9)",
            fontSize: compact ? "0.76rem" : "0.82rem",
            fontWeight: hasFilterActive ? 600 : 500,
            cursor: "pointer",
            flex: compact ? 1 : "initial",
            width: compact ? "100%" : "auto",
            minWidth: compact ? 0 : 190,
            transition: "all 0.15s ease",
            userSelect: "none",
            boxSizing: "border-box",
          }}
          title={hasFilterActive ? `${triggerLabel} (Click to change)` : "Select date range"}
        >
          <div style={{ display: "inline-flex", alignItems: "center", gap: 7, overflow: "hidden", minWidth: 0 }}>
            <CalendarIcon size={14} style={{ color: "var(--accent-cyan, #00bcf2)", flexShrink: 0 }} />
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {triggerLabel}
            </span>
          </div>
          <span style={{ fontSize: "0.65rem", color: "var(--text-dim, #94a3b8)", flexShrink: 0, marginLeft: 2 }}>
            {isOpen ? "▲" : "▼"}
          </span>
        </button>
      </div>

      {/* Custom Modern Calendar Popover */}
      {isOpen && (
        <div
          className="custom-calendar-popover"
          style={{
            position: "absolute",
            top: popoverPlacement === "top" ? "auto" : "calc(100% + 6px)",
            bottom: popoverPlacement === "top" ? "calc(100% + 6px)" : "auto",
            left: compact ? 0 : popoverAlign === "right" ? "auto" : 0,
            right: compact ? 0 : popoverAlign === "right" ? 0 : "auto",
            zIndex: 9999,
            background: "var(--bg-surface, #ffffff)",
            border: "1px solid var(--border-subtle, rgba(0, 0, 0, 0.12))",
            borderRadius: "14px",
            boxShadow: "0 18px 40px -6px rgba(0, 0, 0, 0.28), 0 6px 16px -3px rgba(0, 0, 0, 0.16)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            userSelect: "none",
            width: compact ? "100%" : "315px",
            minWidth: compact ? 0 : "285px",
            maxWidth: "min(380px, calc(100vw - 20px))",
            boxSizing: "border-box",
          }}
        >
          {/* Quick Presets Pills */}
          <div
            style={{
              padding: "10px 10px 8px",
              background: "var(--bg-surface-elevated, #f8fafc)",
              borderBottom: "1px solid var(--border-subtle, rgba(0, 0, 0, 0.08))",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(75px, 1fr))",
              gap: 5,
            }}
          >
            {[
              { id: "today", label: "Today" },
              { id: "yesterday", label: "Yesterday" },
              { id: "7days", label: "7 Days" },
              { id: "30days", label: "30 Days" },
              { id: "thisMonth", label: "This Month" },
              { id: "lastMonth", label: "Last Month" },
            ].map((preset) => {
              const range = getPresetRange(preset.id);
              const isSelected = tempStart === range.start && tempEnd === range.end;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => handleApplyPreset(preset.id)}
                  style={{
                    background: isSelected ? "var(--pf-brand, #00bcf2)" : "var(--bg-surface, #ffffff)",
                    border: `1px solid ${
                      isSelected ? "var(--pf-brand, #00bcf2)" : "var(--border-subtle, rgba(0, 0, 0, 0.1))"
                    }`,
                    borderRadius: "6px",
                    padding: "5px 6px",
                    fontSize: "0.72rem",
                    color: isSelected ? "#ffffff" : "var(--text-main, #334155)",
                    fontWeight: isSelected ? 600 : 500,
                    cursor: "pointer",
                    textAlign: "center",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    transition: "all 0.12s ease",
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.borderColor = "var(--pf-brand, #00bcf2)";
                      e.currentTarget.style.color = "var(--pf-brand, #00bcf2)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.borderColor = "var(--border-subtle, rgba(0, 0, 0, 0.1))";
                      e.currentTarget.style.color = "var(--text-main, #334155)";
                    }
                  }}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          {/* Interactive Month Calendar */}
          <div style={{ padding: "12px 14px 10px", display: "flex", flexDirection: "column", minWidth: 0 }}>
            {/* Month & Year Navigation Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <button
                type="button"
                onClick={handlePrevMonth}
                className="filter-btn"
                style={{
                  width: 28,
                  height: 28,
                  padding: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "1.1rem",
                  lineHeight: 1,
                  color: "var(--text-main, #334155)",
                }}
                title="Previous month"
              >
                ‹
              </button>

              <div style={{ fontSize: "0.86rem", fontWeight: 700, color: "var(--text-main, #0f172a)" }}>
                {MONTH_NAMES[viewMonth]} {viewYear}
              </div>

              <button
                type="button"
                onClick={handleNextMonth}
                className="filter-btn"
                style={{
                  width: 28,
                  height: 28,
                  padding: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "1.1rem",
                  lineHeight: 1,
                  color: "var(--text-main, #334155)",
                }}
                title="Next month"
              >
                ›
              </button>
            </div>

            {/* Weekday Row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(7, 1fr)",
                textAlign: "center",
                marginBottom: 6,
              }}
            >
              {WEEKDAY_NAMES.map((w, idx) => (
                <div
                  key={idx}
                  style={{
                    fontSize: "0.68rem",
                    fontWeight: 700,
                    color: "var(--text-dim, #64748b)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    padding: "2px 0",
                  }}
                >
                  {w}
                </div>
              ))}
            </div>

            {/* 42 Days Grid */}
            <div
              onMouseLeave={() => {
                if (tempStart && !tempEnd) setHoverDate("");
              }}
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(7, 1fr)",
                rowGap: 2,
                marginBottom: 10,
              }}
            >
              {calendarDays.map((cell) => {
                const isToday = cell.iso === todayIso;
                const isStart = rangeStart === cell.iso;
                const isEnd = rangeEnd === cell.iso;
                const isInRange = rangeStart && rangeEnd && cell.iso > rangeStart && cell.iso < rangeEnd;
                const isEndpoint = isStart || isEnd;

                // Border radius shaping for continuous range visual strip
                let borderRadius = "6px";
                if (isStart && isEnd) {
                  borderRadius = "8px";
                } else if (isStart) {
                  borderRadius = "8px 0 0 8px";
                } else if (isEnd) {
                  borderRadius = "0 8px 8px 0";
                } else if (isInRange) {
                  borderRadius = "0";
                }

                let bg = "transparent";
                let color = cell.isCurrentMonth ? "var(--text-main, #0f172a)" : "var(--text-dim, #94a3b8)";

                if (isEndpoint) {
                  bg = "var(--pf-brand, #00bcf2)";
                  color = "#ffffff";
                } else if (isInRange) {
                  bg = "var(--pf-brand-soft, rgba(0, 188, 242, 0.16))";
                  color = "var(--accent-cyan, #00bcf2)";
                }

                return (
                  <button
                    key={cell.iso}
                    type="button"
                    onClick={() => handleDayClick(cell.iso)}
                    onMouseEnter={() => {
                      if (tempStart && !tempEnd) setHoverDate(cell.iso);
                    }}
                    style={{
                      height: 30,
                      width: "100%",
                      padding: 0,
                      border: "none",
                      background: bg,
                      color,
                      fontSize: "0.78rem",
                      fontWeight: isEndpoint || isToday ? 700 : 500,
                      borderRadius,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      position: "relative",
                      transition: "background 0.1s ease",
                      opacity: cell.isCurrentMonth ? 1 : 0.38,
                    }}
                  >
                    <span>{cell.day}</span>
                    {isToday && !isEndpoint && (
                      <span
                        style={{
                          position: "absolute",
                          bottom: 2,
                          width: 4,
                          height: 4,
                          borderRadius: "50%",
                          background: "var(--accent-cyan, #00bcf2)",
                        }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Range Selection Preview & Clear */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingTop: 8,
                borderTop: "1px solid var(--border-subtle, rgba(0, 0, 0, 0.08))",
                gap: 8,
              }}
            >
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-dim, #64748b)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {rangeStart && rangeEnd && rangeStart !== rangeEnd ? (
                  <span>
                    <strong style={{ color: "var(--text-main, #0f172a)" }}>
                      {formatRangeSummary(rangeStart, rangeEnd)}
                    </strong>
                  </span>
                ) : tempStart ? (
                  <span>
                    From: <strong style={{ color: "var(--text-main, #0f172a)" }}>{formatDisplayDate(tempStart)}</strong> (pick end date)
                  </span>
                ) : (
                  <span>Select a date range</span>
                )}
              </div>

              {(tempStart || tempEnd || appliedStart) && (
                <button
                  type="button"
                  onClick={handleClear}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--accent-rose, #f43f5e)",
                    fontSize: "0.74rem",
                    cursor: "pointer",
                    padding: "2px 6px",
                    borderRadius: "4px",
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                  title="Clear date filter"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

