import { useState, useMemo } from "react";
import JsonViewer, { smartUnwrapJson } from "./JsonViewer";
import {
  SparkleIcon,
  ChatBubbleIcon,
  WrenchIcon,
  UserIcon,
  ZapIcon,
  CopyIcon,
  CheckIcon,
  DevToolsIcon,
  FileDocumentIcon,
  LayersIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  SearchIcon,
  CloseIcon,
  HashIcon,
} from "./ChatIcons";

/**
 * Parses raw system prompts into structured, readable guideline sections.
 */
function parseSystemPromptSections(text) {
  if (!text) return [];
  // Split on double newlines or lines starting with ALL CAPS directives (e.g. CUSTOMER REPLY STYLE:)
  const rawSections = text.split(/\n(?=[A-Z0-9_\-\s]{3,40}:)/);
  if (rawSections.length <= 1) {
    const mdSections = text.split(/\n(?=#{1,3}\s)/);
    if (mdSections.length > 1) {
      return mdSections.map((sec, idx) => {
        const lines = sec.trim().split("\n");
        const title = lines[0].replace(/^#{1,3}\s*/, "").trim();
        const body = lines.slice(1).join("\n").trim();
        return { title: title || `Section ${idx + 1}`, body: body || lines[0] };
      });
    }
    return [{ title: "System Guidelines", body: text.trim() }];
  }

  return rawSections.map((sec, idx) => {
    const colonIdx = sec.indexOf(":");
    const newlineIdx = sec.indexOf("\n");
    let title = "";
    let body = "";

    if (colonIdx !== -1 && (newlineIdx === -1 || colonIdx < newlineIdx)) {
      title = sec.slice(0, colonIdx).trim();
      body = sec.slice(colonIdx + 1).trim();
    } else {
      const lines = sec.trim().split("\n");
      title = lines[0].trim();
      body = lines.slice(1).join("\n").trim();
    }

    return {
      title: title || `Directive ${idx + 1}`,
      body: body || sec.trim(),
    };
  });
}

/**
 * Detects whether a message is an internal session context injection
 * (e.g. customer name/login status, active cart, critical search rules)
 * rather than an actual user chat message.
 */
export function parseSessionContextInjection(text) {
  if (!text || typeof text !== "string") return null;

  const isContext =
    text.includes("The customer is logged into their Shopify account") ||
    text.includes("The customer is a guest") ||
    text.includes("Customer first name:") ||
    text.includes("Customer last name:") ||
    text.includes("First name:") ||
    text.includes("Last name:") ||
    text.includes("CRITICAL RULE:") ||
    text.includes("This conversation has an active cart") ||
    text.includes("Previous search memory:") ||
    text.includes("Generate the opening welcome message");

  if (!isContext) return null;

  // Extract customer info
  const firstNameMatch = text.match(/(?:Customer )?[Ff]irst name:\s*([A-Za-z0-9_\-\s]+?)(?:\.|\n|$)/);
  const lastNameMatch = text.match(/(?:Customer )?[Ll]ast name:\s*([A-Za-z0-9_\-\s]+?)(?:\.|\n|$)/);
  const isLoggedIn = text.includes("logged into their Shopify account");
  const isGuest = text.includes("The customer is a guest") || text.includes("Guest customer");

  const firstName = firstNameMatch ? firstNameMatch[1].trim() : null;
  const lastName = lastNameMatch ? lastNameMatch[1].trim() : null;
  const fullName = [firstName, lastName].filter(Boolean).join(" ");

  const badges = [];
  if (fullName) {
    badges.push({ label: fullName, type: "name", icon: "user" });
  }
  if (isLoggedIn) {
    badges.push({ label: "Logged In Customer", type: "success" });
  } else if (isGuest) {
    badges.push({ label: "Guest Session", type: "neutral" });
  }
  if (text.includes("CRITICAL RULE:")) {
    badges.push({ label: "Vehicle / Search Rules", type: "amber" });
  }
  if (text.includes("active cart")) {
    badges.push({ label: "Active Cart", type: "cyan" });
  }

  return {
    isContextInjection: true,
    fullName,
    isLoggedIn,
    isGuest,
    badges,
  };
}

/**
 * Reusable Copy Button with fallback and temporary confirmation state
 */
export function CopyButton({ text, label = "Copy", style }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e) => {
    e.stopPropagation();
    const str = typeof text === "string" ? text : JSON.stringify(text, null, 2);
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(str)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        })
        .catch(() => {
          fallbackCopy(str);
        });
    } else {
      fallbackCopy(str);
    }
  };

  const fallbackCopy = (str) => {
    try {
      const ta = document.createElement("textarea");
      ta.value = str;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="filter-btn"
      style={{
        padding: "2px 8px",
        fontSize: "0.72rem",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        ...style,
      }}
    >
      {copied ? (
        <>
          <CheckIcon size={12} style={{ color: "var(--accent-emerald)" }} />
          <span>Copied</span>
        </>
      ) : (
        <>
          <CopyIcon size={12} />
          <span>{label}</span>
        </>
      )}
    </button>
  );
}

/**
 * Beautified System Prompt Card
 * Collapsed by default into a sleek directive tag bar.
 * Expands into structured guideline cards or raw monospace text.
 */
function SystemPromptCard({ content, index, isExpanded, onToggle }) {
  const [viewFormat, setViewFormat] = useState("formatted"); // 'formatted' | 'raw'
  const lines = useMemo(() => content.split("\n"), [content]);
  const sections = useMemo(() => parseSystemPromptSections(content), [content]);

  return (
    <div className="llm-system-card">
      <div className="llm-system-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="badge badge-purple" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 700 }}>
            <DevToolsIcon size={12} />
            <span>SYSTEM PROMPT</span>
          </span>
          <span style={{ fontSize: "0.74rem", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            Turn #{index + 1} · {lines.length} lines · {content.length.toLocaleString()} chars
          </span>
          <span className="badge" style={{ background: "rgba(139, 92, 246, 0.12)", color: "var(--accent-purple)", fontSize: "0.7rem", fontWeight: 600 }}>
            {sections.length} Directives
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {isExpanded && (
            <div style={{ display: "inline-flex", gap: 3 }}>
              <button
                type="button"
                onClick={() => setViewFormat("formatted")}
                className={`filter-btn ${viewFormat === "formatted" ? "active" : ""}`}
                style={{ padding: "3px 8px", fontSize: "0.7rem" }}
              >
                Structured Directives
              </button>
              <button
                type="button"
                onClick={() => setViewFormat("raw")}
                className={`filter-btn ${viewFormat === "raw" ? "active" : ""}`}
                style={{ padding: "3px 8px", fontSize: "0.7rem" }}
              >
                Raw Monospace
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={onToggle}
            className="filter-btn"
            style={{
              padding: "3px 10px",
              fontSize: "0.74rem",
              background: "rgba(139, 92, 246, 0.18)",
              color: "var(--accent-purple)",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontWeight: 600,
            }}
          >
            {isExpanded ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
            <span>{isExpanded ? "Collapse" : `View Directives (${sections.length})`}</span>
          </button>
          <CopyButton text={content} label="Copy Prompt" />
        </div>
      </div>

      {!isExpanded ? (
        <div className="llm-system-summary-bar">
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flex: 1 }}>
            <span style={{ fontSize: "0.72rem", color: "var(--text-dim)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Directives:
            </span>
            {sections.slice(0, 8).map((sec, sIdx) => (
              <span key={sIdx} className="system-prompt-summary-tag">
                {sec.title}
              </span>
            ))}
            {sections.length > 8 && (
              <span style={{ fontSize: "0.72rem", color: "var(--text-dim)", fontWeight: 600 }}>
                +{sections.length - 8} more
              </span>
            )}
          </div>
          <span style={{ fontSize: "0.72rem", color: "var(--text-dim)", whiteSpace: "nowrap" }}>
            Collapsed to keep conversation turns focused
          </span>
        </div>
      ) : (
        <div className="llm-system-content">
          {viewFormat === "formatted" ? (
            <div className="system-prompt-guide-container" style={{ maxHeight: "550px", overflowY: "auto", paddingRight: 6 }}>
              {sections.map((sec, secIdx) => (
                <div key={secIdx} className="system-prompt-section-card">
                  <div className="system-prompt-section-title">
                    <span>{sec.title}</span>
                  </div>
                  <div className="system-prompt-section-body">
                    {sec.body}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <JsonViewer
              raw={content}
              title="System Prompt (Raw Text)"
              maxHeight="520px"
              defaultUnpack={false}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * User Turn Card
 * Separates backend session context injections from real user inquiries.
 */
function UserTurnCard({ content, index, isExpanded, onToggle }) {
  const contextMeta = useMemo(() => parseSessionContextInjection(content), [content]);

  if (contextMeta) {
    return (
      <div className="llm-context-injection-card">
        <div className="llm-context-injection-header" onClick={onToggle}>
          <div className="llm-context-header-left">
            <span className="badge badge-amber" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 700 }}>
              <ZapIcon size={12} />
              <span>SESSION CONTEXT INJECTION</span>
            </span>
            <span style={{ fontSize: "0.74rem", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              Turn #{index + 1}
            </span>
            {contextMeta.badges.map((b, i) => (
              <span
                key={i}
                className={`badge ${
                  b.type === "success"
                    ? "badge-customer"
                    : b.type === "name"
                    ? "badge-cyan"
                    : b.type === "cyan"
                    ? "badge-cyan"
                    : "badge-amber"
                }`}
                style={{ fontSize: "0.7rem", display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                {b.icon === "user" && <UserIcon size={11} />}
                <span>{b.label}</span>
              </span>
            ))}
          </div>

          <div className="llm-context-header-right">
            <button
              type="button"
              className="llm-toggle-link"
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
            >
              {isExpanded ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
              <span>{isExpanded ? "Collapse" : `Inspect Context (${content.length.toLocaleString()} chars)`}</span>
            </button>
            <CopyButton text={content} label="Copy" />
          </div>
        </div>

        {isExpanded && (
          <div className="llm-context-injection-body">
            <div className="context-injection-terminal">
              <div className="context-injection-terminal-bar">
                <div style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#ef4444", display: "inline-block" }} />
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#f59e0b", display: "inline-block" }} />
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#10b981", display: "inline-block" }} />
                </div>
                <span style={{ fontSize: "0.72rem", color: "#94a3b8", fontFamily: "var(--font-mono)", fontWeight: 500 }}>
                  Injected Session Context · {content.length.toLocaleString()} chars
                </span>
                <span style={{ fontSize: "0.68rem", color: "#f59e0b", fontFamily: "var(--font-mono)", background: "rgba(245, 158, 11, 0.15)", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>
                  SYSTEM INJECTION
                </span>
              </div>
              <pre className="context-injection-text-box">
                {content}
              </pre>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Real user chat turn
  return (
    <div className="llm-user-turn-card">
      <div className="llm-user-turn-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="llm-avatar user-avatar">
            <UserIcon size={13} />
          </div>
          <span className="badge badge-cyan" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 700 }}>
            <span>USER MESSAGE</span>
          </span>
          <span style={{ fontSize: "0.75rem", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            Turn #{index + 1}
          </span>
        </div>
        <CopyButton text={content} label="Copy Message" />
      </div>

      <div className="llm-user-turn-body">
        {content}
      </div>
    </div>
  );
}

/**
 * Assistant Turn Card
 * Displays the Perfumania Assistant's message and tool invocations.
 */
function AssistantTurnCard({ msg, index }) {
  const content = msg.content || "";
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const hasToolCalls = toolCalls.length > 0;

  return (
    <div className="llm-assistant-turn-card">
      <div className="llm-assistant-turn-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div className="llm-avatar assistant-avatar">
            <SparkleIcon size={13} />
          </div>
          <span className="badge badge-customer" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 700 }}>
            <span>ASSISTANT (Perfumania)</span>
          </span>
          <span style={{ fontSize: "0.75rem", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            Turn #{index + 1}
          </span>
          {hasToolCalls && (
            <span className="badge badge-amber" style={{ fontSize: "0.7rem", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <WrenchIcon size={11} />
              <span>Invoked {toolCalls.length} Tool{toolCalls.length > 1 ? "s" : ""}</span>
            </span>
          )}
        </div>
        <CopyButton
          text={content || JSON.stringify(toolCalls, null, 2)}
          label="Copy Turn"
        />
      </div>

      {content && (
        <div className="llm-assistant-message-bubble">
          {content}
        </div>
      )}

      {hasToolCalls && (
        <div className="llm-assistant-tool-calls-container">
          {toolCalls.map((tc, tcIdx) => {
            let parsedArgs = tc.function?.arguments || "";
            try {
              parsedArgs = JSON.parse(parsedArgs);
            } catch {}

            return (
              <div key={tc.id || tcIdx} style={{ minWidth: 0 }}>
                <JsonViewer
                  data={parsedArgs}
                  raw={tc.function?.arguments}
                  title={`⚡ Tool Call: ${tc.function?.name || "tool"}`}
                  maxHeight="280px"
                  defaultUnpack={true}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Tool Result Card
 * Displays the output returned by MCP / server tools with smart JSON unwrapping.
 */
function ToolResultCard({ msg, index, toolName, isExpanded, onToggle }) {
  const unwrapped = useMemo(() => {
    return smartUnwrapJson(msg.content);
  }, [msg.content]);

  return (
    <div className="llm-tool-result-card">
      <div className="llm-tool-result-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="badge badge-amber" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 700 }}>
            <WrenchIcon size={12} />
            <span>TOOL RESULT</span>
          </span>
          {toolName && (
            <span
              style={{
                fontWeight: 700,
                color: "var(--text-main)",
                fontSize: "0.85rem",
                fontFamily: "var(--font-mono)",
                background: "rgba(245, 158, 11, 0.12)",
                padding: "2px 8px",
                borderRadius: "4px",
                border: "1px solid rgba(245, 158, 11, 0.25)",
              }}
            >
              {toolName}
            </span>
          )}
          <span style={{ fontSize: "0.72rem", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            Turn #{index + 1} · ID: {msg.tool_call_id}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <CopyButton text={msg.content} label="Copy Output" />
        </div>
      </div>

      <div style={{ padding: "10px 12px" }}>
        <JsonViewer
          data={typeof unwrapped === "object" ? unwrapped : undefined}
          raw={typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped, null, 2)}
          title={`Tool Output (${toolName || "Result"})`}
          maxHeight={isExpanded ? "550px" : "300px"}
          defaultUnpack={true}
        />
      </div>
    </div>
  );
}

/**
 * Model Completion Output Card
 * Displays the final response returned by the LLM API for this execution step.
 */
function CompletionOutputCard({ responseData, statusCode }) {
  if (!responseData) return null;

  return (
    <div className="llm-completion-output-card">
      <div className="llm-completion-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="badge badge-cyan" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 700 }}>
            <SparkleIcon size={12} />
            <span>MODEL COMPLETION OUTPUT</span>
          </span>
          <span style={{ fontSize: "0.75rem", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            HTTP {statusCode}
          </span>
          {responseData.stopReason && (
            <span
              className="badge"
              style={{
                background: "rgba(255, 255, 255, 0.06)",
                color: "var(--text-muted)",
                fontSize: "0.68rem",
              }}
            >
              stop_reason: {responseData.stopReason}
            </span>
          )}
        </div>
        <CopyButton
          text={
            responseData.text || JSON.stringify(responseData.tool_calls, null, 2)
          }
          label="Copy Completion"
        />
      </div>

      <div style={{ padding: 14 }}>
        {responseData.text && (
          <div className="llm-completion-bubble">
            {responseData.text}
          </div>
        )}

        {responseData.tool_calls && Array.isArray(responseData.tool_calls) && (
          <div
            style={{
              marginTop: responseData.text ? 12 : 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {responseData.tool_calls.map((tc, idx) => (
              <div
                key={idx}
                style={{
                  background: "var(--bg-surface-elevated, #f8fafc)",
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid rgba(245, 158, 11, 0.25)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span className="badge badge-amber" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <ZapIcon size={11} />
                    <span>Next Tool Call: {tc.function?.name || tc.name}</span>
                  </span>
                </div>
                <JsonViewer
                  data={
                    typeof tc.function?.arguments === "string"
                      ? (() => {
                          try {
                            return JSON.parse(tc.function.arguments);
                          } catch {
                            return tc.function.arguments;
                          }
                        })()
                      : tc.function?.arguments || tc.input
                  }
                  raw={tc.function?.arguments}
                  title={`Arguments (${tc.function?.name || tc.name})`}
                  maxHeight="200px"
                  defaultUnpack={true}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * LlmLogInspector
 * Parses the raw OpenAI/Claude JSON payload (model, messages, tools, response)
 * and displays an intuitive, turn-by-turn debug viewer organized by role:
 *  - ⚙️ System Prompt (collapsible)
 *  - 👤 User message / Context Injection
 *  - 🤖 Perfumania Assistant (including highlighted tool calls & arguments)
 *  - 🛠️ Tool Result (parsed JSON output, linked to tool name)
 *  - ✨ Model Completion Output
 * Also provides a toggle to view the raw JSON payloads whenever needed.
 */
export default function LlmLogInspector({ log }) {
  const [viewMode, setViewMode] = useState("sequence"); // 'sequence' | 'rawReq' | 'rawRes'
  const [roleFilter, setRoleFilter] = useState("all"); // 'all' | 'system' | 'user' | 'assistant' | 'tool'
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedCards, setExpandedCards] = useState({});

  const toggleCard = (key) => {
    setExpandedCards((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Safely parse request and response payloads
  const parsed = useMemo(() => {
    let req = null;
    let res = null;

    if (typeof log.request === "string") {
      try {
        req = JSON.parse(log.request);
      } catch {
        req = null;
      }
    } else if (log.request && typeof log.request === "object") {
      req = log.request;
    }

    if (typeof log.response === "string") {
      try {
        res = JSON.parse(log.response);
      } catch {
        res = log.response;
      }
    } else if (log.response && typeof log.response === "object") {
      res = log.response;
    }

    return { req, res };
  }, [log.request, log.response]);

  const messages = Array.isArray(parsed.req?.messages) ? parsed.req.messages : null;
  const modelName = parsed.req?.model || log.provider || "LLM";
  const toolsList = Array.isArray(parsed.req?.tools) ? parsed.req.tools : [];
  const maxTokens = parsed.req?.max_tokens;

  // Build a lookup map from tool_call_id to tool_name from assistant tool calls
  const toolCallMap = useMemo(() => {
    const map = {};
    if (messages) {
      for (const m of messages) {
        if (m.tool_calls && Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            if (tc.id && tc.function?.name) {
              map[tc.id] = tc.function.name;
            }
          }
        }
      }
    }
    return map;
  }, [messages]);

  // Count turns per role
  const counts = useMemo(() => {
    if (!messages) return { total: 0, system: 0, user: 0, assistant: 0, tool: 0 };
    return {
      total: messages.length,
      system: messages.filter((m) => m.role === "system").length,
      user: messages.filter((m) => m.role === "user").length,
      assistant: messages.filter((m) => m.role === "assistant").length,
      tool: messages.filter((m) => m.role === "tool" || m.role === "tool_result").length,
    };
  }, [messages]);

  // Filter messages by role and search query
  const filteredMessages = useMemo(() => {
    if (!messages) return [];
    return messages
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => {
        if (roleFilter !== "all") {
          if (roleFilter === "tool") {
            if (msg.role !== "tool" && msg.role !== "tool_result") return false;
          } else if (msg.role !== roleFilter) {
            return false;
          }
        }
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const contentStr =
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content || "");
          const toolsStr = msg.tool_calls ? JSON.stringify(msg.tool_calls) : "";
          if (!contentStr.toLowerCase().includes(q) && !toolsStr.toLowerCase().includes(q)) {
            return false;
          }
        }
        return true;
      });
  }, [messages, roleFilter, searchQuery]);

  // Extract model completion output
  const responseData = useMemo(() => {
    if (!parsed.res) return null;
    if (parsed.res.finalMessage) {
      const fm = parsed.res.finalMessage;
      let text = "";
      if (typeof fm.content === "string") text = fm.content;
      else if (Array.isArray(fm.content)) {
        text = fm.content.map((c) => (c.text ? c.text : JSON.stringify(c))).join("\n");
      }
      return {
        role: fm.role || "assistant",
        text,
        tool_calls: fm.tool_calls || null,
        stopReason: fm.stop_reason || null,
      };
    }
    if (parsed.res.choices && parsed.res.choices[0]?.message) {
      const msg = parsed.res.choices[0].message;
      return {
        role: msg.role || "assistant",
        text: msg.content || "",
        tool_calls: msg.tool_calls || null,
        stopReason: parsed.res.choices[0].finish_reason || null,
      };
    }
    return null;
  }, [parsed.res]);

  return (
    <div
      className="llm-inspector-root"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: "16px 20px 32px 20px",
        minWidth: 0,
      }}
    >
      {/* Top Meta Bar & View Switcher */}
      <div
        className="llm-inspector-toolbar"
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          paddingBottom: 12,
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        {messages && (
          <button
            type="button"
            onClick={() => setViewMode("sequence")}
            className={`filter-btn ${viewMode === "sequence" ? "active" : ""}`}
            style={{ fontSize: "0.78rem", padding: "5px 12px", display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 700 }}
          >
            <ChatBubbleIcon size={13} />
            <span>Turn-by-Turn View ({counts.total})</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => setViewMode("rawReq")}
          className={`filter-btn ${viewMode === "rawReq" ? "active" : ""}`}
          style={{ fontSize: "0.78rem", padding: "5px 12px", display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <FileDocumentIcon size={13} />
          <span>Raw Request JSON</span>
        </button>
        <button
          type="button"
          onClick={() => setViewMode("rawRes")}
          className={`filter-btn ${viewMode === "rawRes" ? "active" : ""}`}
          style={{ fontSize: "0.78rem", padding: "5px 12px", display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <LayersIcon size={13} />
          <span>Raw Response JSON</span>
        </button>

        {/* Model badge */}
        <span className="badge badge-cyan" style={{ fontSize: "0.74rem", display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 8px" }}>
          <SparkleIcon size={11} />
          <span>{modelName}</span>
        </span>

        {/* Status badge */}
        <span
          className={`mcp-status-pill ${
            log.statusCode >= 200 && log.statusCode < 300
              ? "status-success"
              : "status-error"
          }`}
          style={{ fontSize: "0.72rem", padding: "3px 8px" }}
        >
          HTTP {log.statusCode}
        </span>

        {toolsList.length > 0 && (
          <span
            className="badge badge-amber"
            style={{ fontSize: "0.72rem", display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 8px" }}
          >
            <WrenchIcon size={11} />
            <span>{toolsList.length} tools declared</span>
          </span>
        )}
        {maxTokens && (
          <span
            className="badge"
            style={{
              background: "var(--bg-card-subtle, rgba(148, 163, 184, 0.12))",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-secondary, var(--text-main))",
              fontSize: "0.72rem",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 8px",
            }}
          >
            <HashIcon size={11} />
            <span>max_tokens: {maxTokens}</span>
          </span>
        )}

        {/* Copy Buttons right beside max_tokens */}
        <CopyButton text={log.request} label="Copy Request" />
        <CopyButton text={log.response} label="Copy Response" />
      </div>

      {/* RAW REQUEST JSON VIEW */}
      {viewMode === "rawReq" && (
        <JsonViewer
          raw={log.request}
          title={`Raw Request Payload (${modelName})`}
          maxHeight="550px"
          defaultUnpack={true}
        />
      )}

      {/* RAW RESPONSE JSON VIEW */}
      {viewMode === "rawRes" && (
        <JsonViewer
          raw={log.response}
          title={`Raw Response Payload (HTTP ${log.statusCode})`}
          maxHeight="550px"
          defaultUnpack={true}
        />
      )}

      {/* TURN-BY-TURN VISUAL DEBUG VIEW */}
      {viewMode === "sequence" && messages && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Filter & Search Bar */}
          <div className="llm-filter-bar">
            {/* Search Input */}
            <div className="llm-search-input-wrap">
              <SearchIcon size={14} style={{ color: "var(--text-dim)", flexShrink: 0 }} />
              <input
                type="text"
                placeholder="Search prompt, user messages, tool calls..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="llm-search-input"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  style={{
                    background: "rgba(148, 163, 184, 0.2)",
                    border: "none",
                    borderRadius: "50%",
                    width: 18,
                    height: 18,
                    cursor: "pointer",
                    padding: 0,
                    color: "var(--text-dim)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    transition: "all 0.15s ease",
                  }}
                  title="Clear search"
                >
                  <CloseIcon size={11} />
                </button>
              )}
            </div>

            {/* Role Filter Pills */}
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => setRoleFilter("all")}
                className={`filter-btn ${roleFilter === "all" ? "active" : ""}`}
                style={{ fontSize: "0.72rem", padding: "3px 9px" }}
              >
                All ({counts.total})
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter("system")}
                className={`filter-btn ${roleFilter === "system" ? "active" : ""}`}
                style={{
                  fontSize: "0.72rem",
                  padding: "3px 9px",
                  borderColor: roleFilter === "system" ? "var(--accent-purple)" : "",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <DevToolsIcon size={11} />
                <span>System ({counts.system})</span>
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter("user")}
                className={`filter-btn ${roleFilter === "user" ? "active" : ""}`}
                style={{
                  fontSize: "0.72rem",
                  padding: "3px 9px",
                  borderColor: roleFilter === "user" ? "var(--accent-cyan)" : "",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <UserIcon size={11} />
                <span>User ({counts.user})</span>
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter("assistant")}
                className={`filter-btn ${roleFilter === "assistant" ? "active" : ""}`}
                style={{
                  fontSize: "0.72rem",
                  padding: "3px 9px",
                  borderColor: roleFilter === "assistant" ? "var(--accent-emerald)" : "",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <SparkleIcon size={11} />
                <span>Assistant ({counts.assistant})</span>
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter("tool")}
                className={`filter-btn ${roleFilter === "tool" ? "active" : ""}`}
                style={{
                  fontSize: "0.72rem",
                  padding: "3px 9px",
                  borderColor: roleFilter === "tool" ? "var(--accent-amber)" : "",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <WrenchIcon size={11} />
                <span>Tools ({counts.tool})</span>
              </button>
            </div>
          </div>

          {/* List of Messages */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {filteredMessages.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: 24,
                  color: "var(--text-dim)",
                  fontSize: "0.82rem",
                }}
              >
                No messages match the current filter "{searchQuery || roleFilter}".
              </div>
            ) : (
              filteredMessages.map((item) => {
                const { msg, index } = item;
                const role = msg.role;

                // 1. SYSTEM PROMPT
                if (role === "system") {
                  const content =
                    typeof msg.content === "string"
                      ? msg.content
                      : JSON.stringify(msg.content, null, 2);
                  const isExpanded = expandedCards[`sys-${index}`] ?? false;

                  return (
                    <SystemPromptCard
                      key={`msg-${index}`}
                      content={content}
                      index={index}
                      isExpanded={isExpanded}
                      onToggle={() => toggleCard(`sys-${index}`)}
                    />
                  );
                }

                // 2. USER MESSAGE OR CONTEXT INJECTION
                if (role === "user") {
                  const content =
                    typeof msg.content === "string"
                      ? msg.content
                      : JSON.stringify(msg.content, null, 2);
                  const isExpanded = expandedCards[`user-${index}`] ?? false;

                  return (
                    <UserTurnCard
                      key={`msg-${index}`}
                      content={content}
                      index={index}
                      isExpanded={isExpanded}
                      onToggle={() => toggleCard(`user-${index}`)}
                    />
                  );
                }

                // 3. ASSISTANT MESSAGE
                if (role === "assistant") {
                  return (
                    <AssistantTurnCard
                      key={`msg-${index}`}
                      msg={msg}
                      index={index}
                    />
                  );
                }

                // 4. TOOL RESULT
                if (role === "tool" || role === "tool_result") {
                  const toolName = toolCallMap[msg.tool_call_id] || "";
                  const isExpanded = expandedCards[`tool-${index}`] ?? false;

                  return (
                    <ToolResultCard
                      key={`msg-${index}`}
                      msg={msg}
                      index={index}
                      toolName={toolName}
                      isExpanded={isExpanded}
                      onToggle={() => toggleCard(`tool-${index}`)}
                    />
                  );
                }

                // Fallback for unexpected role
                return (
                  <div
                    key={`msg-${index}`}
                    style={{
                      background: "var(--bg-surface)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "var(--radius-sm)",
                      padding: 10,
                    }}
                  >
                    <div style={{ fontWeight: 700, color: "var(--text-muted)", marginBottom: 4 }}>
                      Role: {role}
                    </div>
                    <pre style={{ margin: 0, fontSize: "0.78rem", whiteSpace: "pre-wrap" }}>
                      {typeof msg.content === "string"
                        ? msg.content
                        : JSON.stringify(msg.content, null, 2)}
                    </pre>
                  </div>
                );
              })
            )}
          </div>

          {/* Model Completion Output Box */}
          <CompletionOutputCard
            responseData={responseData}
            statusCode={log.statusCode}
          />
        </div>
      )}
    </div>
  );
}
