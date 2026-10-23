import { useState, useMemo } from "react";
import {
  CopyIcon,
  CheckIcon,
  SearchIcon,
  CloseIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  SparkleIcon,
} from "./ChatIcons";

/**
 * Recursively unwraps stringified JSON inside objects, arrays, and MCP text blocks.
 * Turns impenetrable escaped strings like "{\"ucp\":{\"version\":\"2026-04-08\"...}}"
 * into real, structured, syntax-highlightable objects!
 */
export function smartUnwrapJson(val, depth = 0, maxDepth = 6) {
  if (depth >= maxDepth || val === null || val === undefined) return val;

  // 1. Strings: attempt JSON parse if it looks like JSON
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        return smartUnwrapJson(parsed, depth + 1, maxDepth);
      } catch {
        return val;
      }
    }
    return val;
  }

  // 2. Arrays: map each element
  if (Array.isArray(val)) {
    return val.map((item) => smartUnwrapJson(item, depth + 1, maxDepth));
  }

  // 3. Objects: handle MCP content blocks and standard object keys
  if (typeof val === "object") {
    // Special MCP content array item: { type: "text", text: "..." }
    if (val.type === "text" && typeof val.text === "string") {
      const trimmedText = val.text.trim();
      if (
        (trimmedText.startsWith("{") && trimmedText.endsWith("}")) ||
        (trimmedText.startsWith("[") && trimmedText.endsWith("]"))
      ) {
        try {
          const parsedInner = JSON.parse(trimmedText);
          return {
            ...val,
            text: smartUnwrapJson(parsedInner, depth + 1, maxDepth),
          };
        } catch {
          // keep as is
        }
      }
    }

    const unwrappedObj = {};
    for (const [key, value] of Object.entries(val)) {
      unwrappedObj[key] = smartUnwrapJson(value, depth + 1, maxDepth);
    }
    return unwrappedObj;
  }

  return val;
}

/**
 * Calculate matching block pairs (e.g. line 2 `{` -> line 38 `}`) for folding.
 */
function computeFoldRanges(lines) {
  const stack = [];
  const ranges = {}; // openLineIndex -> closeLineIndex
  const closeToOpen = {};

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Check if line opens an object or array
    if (trimmed.endsWith("{") || trimmed.endsWith("[")) {
      stack.push({ index: i, char: trimmed[trimmed.length - 1] });
    } else if (trimmed.startsWith("}") || trimmed.startsWith("]")) {
      const closingChar = trimmed[0];
      const expectedChar = closingChar === "}" ? "{" : "[";
      if (stack.length > 0 && stack[stack.length - 1].char === expectedChar) {
        const open = stack.pop();
        if (i > open.index) {
          ranges[open.index] = i;
          closeToOpen[i] = open.index;
        }
      }
    }
  }

  return { ranges, closeToOpen };
}

/**
 * Tokenize a single line of JSON and highlight keys, strings, numbers, booleans, and search hits.
 */
function renderHighlightedLine(lineText, searchQuery = "") {
  if (!lineText) return <span>&nbsp;</span>;

  // Regex tokenizing JSON components:
  // 1: Keys ("key":)
  // 2: String values ("...")
  // 3: Numbers (-?123.45)
  // 4: Booleans (true|false)
  // 5: Null (null)
  // 6: Punctuation ([{}[],:])
  const tokenRegex = /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|[{}[\],:])/g;

  const elements = [];
  let lastIndex = 0;
  let match;

  const highlightSearch = (text, keyPrefix) => {
    if (!searchQuery || !searchQuery.trim()) return text;
    const q = searchQuery.toLowerCase();
    const parts = [];
    let start = 0;
    const lower = text.toLowerCase();
    let idx = lower.indexOf(q, start);

    if (idx === -1) return text;

    while (idx !== -1) {
      if (idx > start) {
        parts.push(text.slice(start, idx));
      }
      parts.push(
        <mark key={`${keyPrefix}-${idx}`} className="json-search-hit">
          {text.slice(idx, idx + q.length)}
        </mark>
      );
      start = idx + q.length;
      idx = lower.indexOf(q, start);
    }
    if (start < text.length) {
      parts.push(text.slice(start));
    }
    return parts;
  };

  while ((match = tokenRegex.exec(lineText)) !== null) {
    if (match.index > lastIndex) {
      const whitespace = lineText.slice(lastIndex, match.index);
      elements.push(whitespace);
    }

    const token = match[0];
    const key = `tok-${match.index}`;

    if (token.startsWith('"') && token.endsWith(":")) {
      // Key with colon
      const keyName = token.slice(0, token.lastIndexOf(":"));
      elements.push(
        <span key={key} className="json-token-key">
          {highlightSearch(keyName, key)}
        </span>
      );
      elements.push(
        <span key={`${key}-colon`} className="json-token-colon">
          :{" "}
        </span>
      );
    } else if (token.startsWith('"')) {
      // String value
      const isUrl =
        token.startsWith('"http://') ||
        token.startsWith('"https://') ||
        token.startsWith('"gid://');
      elements.push(
        <span
          key={key}
          className={`json-token-string ${isUrl ? "json-token-url" : ""}`}
        >
          {highlightSearch(token, key)}
        </span>
      );
    } else if (token === "true" || token === "false") {
      // Boolean
      elements.push(
        <span key={key} className="json-token-boolean">
          {highlightSearch(token, key)}
        </span>
      );
    } else if (token === "null") {
      // Null
      elements.push(
        <span key={key} className="json-token-null">
          {highlightSearch(token, key)}
        </span>
      );
    } else if (!isNaN(Number(token))) {
      // Number
      elements.push(
        <span key={key} className="json-token-number">
          {highlightSearch(token, key)}
        </span>
      );
    } else {
      // Punctuation
      elements.push(
        <span key={key} className="json-token-punct">
          {token}
        </span>
      );
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < lineText.length) {
    elements.push(lineText.slice(lastIndex));
  }

  return elements;
}

/**
 * JsonViewer Component
 * Premium Developer-Grade JSON Inspector with:
 * - Smart recursive unpacking of escaped JSON strings
 * - Full syntax highlighting (keys, strings, numbers, booleans, nulls)
 * - Line numbers gutter with code folding chevrons
 * - Real-time in-payload search & hit highlighting
 * - Copy Formatted & Copy Minified buttons
 * - Line wrapping toggle
 * - macOS terminal window aesthetic
 */
export default function JsonViewer({
  raw,
  data,
  title = "JSON Payload",
  defaultUnpack = true,
  maxHeight = "450px",
  collapsible = true,
  showLineNumbers = true,
  showToolbar = true,
  className = "",
  style = {},
}) {
  const [smartUnpack, setSmartUnpack] = useState(defaultUnpack);
  const [copied, setCopied] = useState(false);
  const [copiedMin, setCopiedMin] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedBlocks, setCollapsedBlocks] = useState({});
  const [wrapLines, setWrapLines] = useState(false);

  // 1. Resolve raw input into parsed object
  const resolvedObject = useMemo(() => {
    let source = data !== undefined ? data : raw;
    if (source === null || source === undefined) return null;
    if (typeof source === "object") return source;
    if (typeof source === "string") {
      const trimmed = source.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return source;
        }
      }
      return source;
    }
    return source;
  }, [data, raw]);

  // 2. Apply smart unwrapping if enabled
  const processedData = useMemo(() => {
    if (!smartUnpack || resolvedObject === null || typeof resolvedObject !== "object") {
      return resolvedObject;
    }
    return smartUnwrapJson(resolvedObject);
  }, [resolvedObject, smartUnpack]);

  // 3. Stringify pretty JSON
  const formattedJson = useMemo(() => {
    if (processedData === null || processedData === undefined) return "null";
    if (typeof processedData === "string") {
      try {
        const parsed = JSON.parse(processedData);
        return JSON.stringify(parsed, null, 2);
      } catch {
        return processedData;
      }
    }
    try {
      return JSON.stringify(processedData, null, 2);
    } catch {
      return String(processedData);
    }
  }, [processedData]);

  // 4. Split into lines
  const lines = useMemo(() => {
    return formattedJson.split("\n");
  }, [formattedJson]);

  // 5. Compute fold ranges
  const { ranges } = useMemo(() => {
    return computeFoldRanges(lines);
  }, [lines]);

  // 6. Search match count
  const searchMatchesCount = useMemo(() => {
    if (!searchQuery.trim()) return 0;
    const q = searchQuery.toLowerCase();
    let count = 0;
    for (const l of lines) {
      const lower = l.toLowerCase();
      let pos = lower.indexOf(q);
      while (pos !== -1) {
        count++;
        pos = lower.indexOf(q, pos + q.length);
      }
    }
    return count;
  }, [lines, searchQuery]);

  // Copy handler
  const handleCopy = (minified = false) => {
    let textToCopy = formattedJson;
    if (minified) {
      try {
        textToCopy = JSON.stringify(
          typeof processedData === "object" ? processedData : JSON.parse(formattedJson)
        );
      } catch {
        textToCopy = formattedJson.replace(/\s+/g, " ");
      }
    }

    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(textToCopy);
      if (minified) {
        setCopiedMin(true);
        setTimeout(() => setCopiedMin(false), 1800);
      } else {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    }
  };

  // Toggle fold for a block
  const toggleFold = (openIndex) => {
    setCollapsedBlocks((prev) => ({
      ...prev,
      [openIndex]: !prev[openIndex],
    }));
  };

  const collapseAll = () => {
    const all = {};
    Object.keys(ranges).forEach((k) => {
      all[k] = true;
    });
    setCollapsedBlocks(all);
  };

  const expandAll = () => {
    setCollapsedBlocks({});
  };

  // Determine line visibility based on active collapsed blocks
  const hiddenLinesMap = useMemo(() => {
    const hidden = new Set();
    for (const [openStr, isCollapsed] of Object.entries(collapsedBlocks)) {
      if (isCollapsed) {
        const openIdx = parseInt(openStr, 10);
        const closeIdx = ranges[openIdx];
        if (closeIdx !== undefined) {
          for (let i = openIdx + 1; i <= closeIdx; i++) {
            hidden.add(i);
          }
        }
      }
    }
    return hidden;
  }, [collapsedBlocks, ranges]);

  const payloadSizeKb = useMemo(() => {
    const bytes = new Blob([formattedJson]).size;
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }, [formattedJson]);

  return (
    <div
      className={`json-viewer-container ${className}`}
      style={{
        display: "flex",
        flexDirection: "column",
        background: "#0c101b",
        border: "1px solid rgba(255, 255, 255, 0.09)",
        borderRadius: "10px",
        overflow: "hidden",
        boxShadow: "0 4px 20px rgba(0, 0, 0, 0.35)",
        minWidth: 0,
        ...style,
      }}
    >
      {/* 1. TOP HEADER / TITLEBAR */}
      {showToolbar && (
        <div
          className="json-viewer-header"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 12px",
            background: "rgba(255, 255, 255, 0.03)",
            borderBottom: "1px solid rgba(255, 255, 255, 0.07)",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          {/* Left: Window Dots + Title + Stats */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {/* Mac OS Window Dots */}
            <div style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#ef4444", opacity: 0.8 }} />
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#f59e0b", opacity: 0.8 }} />
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#10b981", opacity: 0.8 }} />
            </div>

            <span
              style={{
                fontSize: "0.74rem",
                fontWeight: 700,
                color: "#e2e8f0",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              {title}
            </span>

            <span
              style={{
                fontSize: "0.68rem",
                color: "#64748b",
                background: "rgba(255, 255, 255, 0.05)",
                padding: "1px 6px",
                borderRadius: "4px",
                fontFamily: "var(--font-mono)",
              }}
            >
              {lines.length} lines · {payloadSizeKb}
            </span>

            {/* Smart Unpack Status Toggle */}
            <button
              type="button"
              onClick={() => setSmartUnpack(!smartUnpack)}
              title={
                smartUnpack
                  ? "Smart Unpack is ON: Recursively parses stringified JSON strings into formatted tree objects. Click to view raw escaped string."
                  : "Click to enable Smart Unpack and auto-format nested stringified JSON"
              }
              style={{
                border: "none",
                background: smartUnpack ? "rgba(0, 188, 242, 0.15)" : "rgba(255, 255, 255, 0.06)",
                color: smartUnpack ? "var(--accent-cyan, #00bcf2)" : "#94a3b8",
                fontSize: "0.68rem",
                fontWeight: 700,
                padding: "2px 7px",
                borderRadius: "999px",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                transition: "all 0.15s ease",
              }}
            >
              <SparkleIcon size={10} />
              <span>{smartUnpack ? "Smart Unpacked" : "Raw Escaped"}</span>
            </button>
          </div>

          {/* Right: Search + Controls + Copy Buttons */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {/* Quick in-payload search input */}
            <div
              style={{
                position: "relative",
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 6,
                  color: "#64748b",
                  pointerEvents: "none",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <SearchIcon size={11} />
              </span>
              <input
                type="text"
                placeholder="Find in JSON..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  background: "rgba(0, 0, 0, 0.35)",
                  border: "1px solid rgba(255, 255, 255, 0.09)",
                  borderRadius: "5px",
                  color: "#f1f5f9",
                  padding: "3px 20px 3px 22px",
                  fontSize: "0.72rem",
                  width: "115px",
                  outline: "none",
                  fontFamily: "var(--font-mono)",
                  transition: "width 0.15s ease, border-color 0.15s ease",
                }}
                onFocus={(e) => (e.target.style.width = "160px")}
                onBlur={(e) => {
                  if (!searchQuery) e.target.style.width = "115px";
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  style={{
                    position: "absolute",
                    right: 4,
                    background: "transparent",
                    border: "none",
                    color: "#94a3b8",
                    cursor: "pointer",
                    padding: 0,
                    display: "flex",
                    alignItems: "center",
                  }}
                  title="Clear search"
                >
                  <CloseIcon size={11} />
                </button>
              )}
            </div>

            {searchQuery && (
              <span
                style={{
                  fontSize: "0.68rem",
                  color: searchMatchesCount > 0 ? "#fbbf24" : "#f87171",
                  fontWeight: 600,
                }}
              >
                {searchMatchesCount} hit{searchMatchesCount !== 1 ? "s" : ""}
              </span>
            )}

            {/* Fold / Unfold buttons */}
            {collapsible && Object.keys(ranges).length > 0 && (
              <div style={{ display: "inline-flex", gap: 3 }}>
                <button
                  type="button"
                  onClick={collapseAll}
                  className="filter-btn"
                  style={{ padding: "2px 6px", fontSize: "0.68rem" }}
                  title="Collapse all objects and arrays"
                >
                  Fold All
                </button>
                <button
                  type="button"
                  onClick={expandAll}
                  className="filter-btn"
                  style={{ padding: "2px 6px", fontSize: "0.68rem" }}
                  title="Expand all"
                >
                  Unfold
                </button>
              </div>
            )}

            {/* Line Wrap Toggle */}
            <button
              type="button"
              onClick={() => setWrapLines(!wrapLines)}
              className={`filter-btn ${wrapLines ? "active" : ""}`}
              style={{ padding: "2px 6px", fontSize: "0.68rem" }}
              title="Toggle line wrapping"
            >
              {wrapLines ? "Wrap: ON" : "Wrap: OFF"}
            </button>

            {/* Copy Minified Button */}
            <button
              type="button"
              onClick={() => handleCopy(true)}
              className="filter-btn"
              style={{ padding: "2px 7px", fontSize: "0.68rem" }}
              title="Copy single-line minified JSON"
            >
              {copiedMin ? "Copied Min!" : "Minify"}
            </button>

            {/* Copy Formatted Button */}
            <button
              type="button"
              onClick={() => handleCopy(false)}
              className="filter-btn"
              style={{
                padding: "3px 9px",
                fontSize: "0.72rem",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                background: "rgba(0, 188, 242, 0.12)",
                borderColor: "rgba(0, 188, 242, 0.3)",
                color: "#38bdf8",
              }}
              title="Copy pretty formatted JSON"
            >
              {copied ? (
                <>
                  <CheckIcon size={12} style={{ color: "var(--accent-emerald, #10b981)" }} />
                  <span style={{ color: "#34d399", fontWeight: 700 }}>Copied!</span>
                </>
              ) : (
                <>
                  <CopyIcon size={12} />
                  <span>Copy JSON</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* 2. VIEWER BODY: LINE GUTTER + SYNTAX HIGHLIGHTED CODE */}
      <div
        className="json-viewer-body"
        style={{
          maxHeight,
          overflowY: "auto",
          overflowX: wrapLines ? "hidden" : "auto",
          display: "flex",
          fontFamily:
            'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          fontSize: "0.78rem",
          lineHeight: "1.55",
          padding: "6px 0",
        }}
      >
        <div style={{ display: "flex", width: "100%", minWidth: "fit-content" }}>
          {/* A. Line Numbers Gutter */}
          {showLineNumbers && (
            <div
              className="json-viewer-gutter"
              style={{
                display: "flex",
                flexDirection: "column",
                userSelect: "none",
                textAlign: "right",
                padding: "0 8px 0 10px",
                color: "#475569",
                borderRight: "1px solid rgba(255, 255, 255, 0.06)",
                background: "rgba(0, 0, 0, 0.2)",
                flexShrink: 0,
              }}
            >
              {lines.map((_, idx) => {
                if (hiddenLinesMap.has(idx)) return null;
                const hasFold = collapsible && ranges[idx] !== undefined;
                const isFolded = collapsedBlocks[idx];

                return (
                  <div
                    key={`gutter-${idx}`}
                    style={{
                      height: "22px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      gap: 4,
                    }}
                  >
                    {hasFold ? (
                      <span
                        onClick={() => toggleFold(idx)}
                        style={{
                          cursor: "pointer",
                          color: isFolded ? "#38bdf8" : "#64748b",
                          display: "inline-flex",
                          alignItems: "center",
                          transform: isFolded ? "rotate(-90deg)" : "none",
                          transition: "transform 0.15s ease",
                        }}
                        title={isFolded ? "Expand block" : "Collapse block"}
                      >
                        <ChevronDownIcon size={11} />
                      </span>
                    ) : (
                      <span style={{ width: 11 }} />
                    )}
                    <span style={{ minWidth: "24px" }}>{idx + 1}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* B. Code Lines Container */}
          <div
            className="json-viewer-code"
            style={{
              flex: 1,
              padding: "0 14px",
              whiteSpace: wrapLines ? "pre-wrap" : "pre",
              wordBreak: wrapLines ? "break-word" : "normal",
            }}
          >
            {lines.map((line, idx) => {
              if (hiddenLinesMap.has(idx)) return null;
              const isFolded = collapsedBlocks[idx];
              const closeIdx = ranges[idx];

              return (
                <div
                  key={`line-${idx}`}
                  style={{
                    height: isFolded ? "22px" : wrapLines ? "auto" : "22px",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <div style={{ flex: 1 }}>
                    {renderHighlightedLine(line, searchQuery)}
                    {isFolded && (
                      <span
                        onClick={() => toggleFold(idx)}
                        style={{
                          cursor: "pointer",
                          background: "rgba(56, 189, 248, 0.15)",
                          color: "#38bdf8",
                          borderRadius: "4px",
                          padding: "1px 6px",
                          marginLeft: "6px",
                          fontSize: "0.72rem",
                          fontWeight: 700,
                          border: "1px solid rgba(56, 189, 248, 0.3)",
                        }}
                        title="Click to unfold"
                      >
                        ... {closeIdx ? `${closeIdx - idx} lines` : ""} {line.trim().endsWith("[") ? "]" : "}"}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
