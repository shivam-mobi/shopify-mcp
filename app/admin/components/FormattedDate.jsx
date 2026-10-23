import { useState, useEffect } from "react";

/**
 * SSR-safe Date formatting component to eliminate React #423 hydration mismatches.
 *
 * During SSR and initial client hydration render:
 * Renders a consistent, deterministic UTC representation.
 *
 * Once mounted on the client:
 * Re-renders using the user's localized browser format and timezone.
 */
export function FormattedDate({
  date,
  format = "datetime", // "date" | "time" | "datetime" | "both"
  className = "",
  style = {},
  fallback = "—",
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!date) {
    return (
      <span className={className} style={{ color: "var(--text-dim)", ...style }}>
        {fallback}
      </span>
    );
  }

  const d = new Date(date);
  if (isNaN(d.getTime())) {
    return (
      <span className={className} style={{ color: "var(--text-dim)", ...style }}>
        {fallback}
      </span>
    );
  }

  const pad = (n) => String(n).padStart(2, "0");
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());

  // Deterministic SSR string
  const ssrDateStr = `${year}-${month}-${day}`;
  const ssrTimeStr = `${hours}:${minutes} UTC`;
  const ssrFullStr = `${ssrDateStr} ${ssrTimeStr}`;

  if (!mounted) {
    if (format === "date") {
      return (
        <span className={className} style={style} suppressHydrationWarning>
          {ssrDateStr}
        </span>
      );
    }
    if (format === "time" || format === "whatsapp") {
      return (
        <span className={className} style={style} suppressHydrationWarning>
          {ssrTimeStr}
        </span>
      );
    }
    if (format === "both") {
      return (
        <span className={className} style={{ display: "inline-block", ...style }} suppressHydrationWarning>
          <div>{ssrDateStr}</div>
          <div style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>{ssrTimeStr}</div>
        </span>
      );
    }
    return (
      <span className={className} style={style} suppressHydrationWarning>
        {ssrFullStr}
      </span>
    );
  }

  // Client mounted - format using user's local timezone
  if (format === "whatsapp") {
    const now = new Date();
    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
      d.getDate() === yesterday.getDate() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getFullYear() === yesterday.getFullYear();

    const isCurrentYear = d.getFullYear() === now.getFullYear();
    const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    // 1. Today: show "Today" + time e.g. "Today 12:39"
    if (isToday) {
      return (
        <span
          className={className}
          style={{ display: "inline-flex", alignItems: "center", gap: 5, ...style }}
          title={`Today, ${d.toLocaleString()}`}
          suppressHydrationWarning
        >
          <span style={{ fontWeight: 600, color: "var(--accent-cyan)" }}>Today</span>
          <span style={{ fontSize: "0.76rem", color: "var(--text-dim)" }}>{timeStr}</span>
        </span>
      );
    }

    // 2. Yesterday: show "Yesterday" + time e.g. "Yesterday 12:28"
    if (isYesterday) {
      return (
        <span
          className={className}
          style={{ display: "inline-flex", alignItems: "center", gap: 5, ...style }}
          title={`Yesterday, ${d.toLocaleString()}`}
          suppressHydrationWarning
        >
          <span style={{ fontWeight: 600, color: "var(--accent-amber)" }}>Yesterday</span>
          <span style={{ fontSize: "0.76rem", color: "var(--text-dim)" }}>{timeStr}</span>
        </span>
      );
    }

    // 3. Within the past 6 days: show weekday + time e.g. "Mon 17:26"
    const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays >= 0 && diffDays < 7) {
      const weekday = d.toLocaleDateString([], { weekday: "short" });
      return (
        <span
          className={className}
          style={{ display: "inline-flex", alignItems: "center", gap: 5, ...style }}
          title={d.toLocaleString()}
          suppressHydrationWarning
        >
          <span style={{ fontWeight: 600, color: "var(--text-muted)" }}>{weekday}</span>
          <span style={{ fontSize: "0.76rem", color: "var(--text-dim)" }}>{timeStr}</span>
        </span>
      );
    }

    // 4. Older: show date + time e.g. "12 Oct 13:25" or with year if different year
    const dateOptions = isCurrentYear
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "2-digit" };
    const dateStr = d.toLocaleDateString([], dateOptions);
    return (
      <span
        className={className}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, ...style }}
        title={d.toLocaleString()}
        suppressHydrationWarning
      >
        <span style={{ fontWeight: 600, color: "var(--text-muted)" }}>{dateStr}</span>
        <span style={{ fontSize: "0.76rem", color: "var(--text-dim)" }}>{timeStr}</span>
      </span>
    );
  }

  if (format === "date") {
    return (
      <span className={className} style={style} suppressHydrationWarning>
        {d.toLocaleDateString()}
      </span>
    );
  }
  if (format === "time") {
    return (
      <span className={className} style={style} suppressHydrationWarning>
        {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
    );
  }
  if (format === "both") {
    return (
      <span className={className} style={{ display: "inline-block", ...style }} suppressHydrationWarning>
        <div>{d.toLocaleDateString()}</div>
        <div style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>
          {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      </span>
    );
  }
  return (
    <span className={className} style={style} suppressHydrationWarning>
      {d.toLocaleString()}
    </span>
  );
}

export default FormattedDate;
