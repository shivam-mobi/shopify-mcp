import { useState, useMemo, useEffect, useRef } from "react";
import { useLoaderData, useSearchParams, Link, Form } from "react-router";
import { requireAdminUser } from "../admin/auth.server";
import { useDevMode } from "../admin/components/AdminLayout";
import {
  getConversationsPaginated,
  getConversationDetails,
  getConversationUserFilters,
} from "../admin/queries.server";
import CopyableId from "../admin/components/CopyableId";
import FormattedDate from "../admin/components/FormattedDate";
import AdminPagination from "../admin/components/AdminPagination";
import DateRangeFilter from "../admin/components/DateRangeFilter";
import LlmLogInspector, { CopyButton } from "../admin/components/LlmLogInspector";
import JsonViewer from "../admin/components/JsonViewer";
import {
  SparkleIcon,
  CopyIcon,
  SpeakerIcon,
  StopSpeakerIcon,
  CheckIcon,
  ShoppingBagIcon,
  ExternalLinkIcon,
  ChatMessageIcon,
  DevToolsIcon,
  SearchIcon,
  ChatBubbleIcon,
  WrenchIcon,
  ZapIcon,
  UserIcon,
  ClockIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  CloseIcon,
  BookOpenIcon,
} from "../admin/components/ChatIcons";

function parsePartialJson(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {}

  const s = str.trim();
  const lastComma = s.lastIndexOf(",");
  if (lastComma > 0) {
    const candidateArray = s.substring(0, lastComma) + "}]}]";
    try {
      return JSON.parse(candidateArray);
    } catch {}
    const candidateObj = s.substring(0, lastComma) + "}]";
    try {
      return JSON.parse(candidateObj);
    } catch {}
  }
  return null;
}

function cleanMarkdownHref(url) {
  return String(url || "")
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/[.,;:!?'"”)\]\s]+$/g, "");
}

function toAbsoluteUrl(url) {
  if (!url || url === "#" || url === "#auth") return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return "https://perfumania.com" + url;
  if (url.startsWith("mailto:") || url.startsWith("tel:")) return url;
  return url;
}

function cleanAssistantRawText(rawText) {
  if (!rawText) return "";
  let processed = String(rawText);
  // Remove markdown images entirely (LLM often emits ![alt](image_url))
  processed = processed.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
  // Remove stock quantity lines from assistant text (cards show stock status)
  processed = processed.replace(/^\s*Stock:\s*.*$/gim, "");
  processed = processed.replace(/^\s*Variant ID:\s*.*$/gim, "");
  processed = processed.replace(/gid:\/\/shopify\/ProductVariant\/\d+/gi, "");
  // Fix placeholder storefront hosts
  processed = processed.replace(
    /https?:\/\/(?:www\.)?yourstore\.com/gi,
    "https://perfumania.com"
  );
  // Normalize excessive newlines
  processed = processed.replace(/\n{3,}/g, "\n\n").trim();
  return processed;
}

function parseInlineSegments(text) {
  if (!text) return [];

  // Match:
  // 1. Well-formed markdown link: [label](url)
  // 2. Malformed / truncated markdown link: [label](https://... (missing closing paren)
  // 3. Standalone checkout/cart URL
  const linkRegex =
    /\[([^\]]+)\]\(([^)\s]+)\)|\[([^\]]+)\]\((https?:\/\/[^\s<\]]+)|(?<=^|\s|<)(https?:\/\/[^\s<>"')]+(?:\/cart|\/checkouts?|\/c\/)[^\s<>"')]*)/gi;

  const rawSegments = [];
  let lastIndex = 0;
  let match;

  while ((match = linkRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      rawSegments.push({ type: "text", content: text.substring(lastIndex, match.index) });
    }

    if (match[1] && match[2]) {
      const label = match[1];
      const url = match[2];
      const cleanHref = toAbsoluteUrl(cleanMarkdownHref(url));
      const isCheckout = cleanHref.includes("/cart") || cleanHref.includes("checkout");
      rawSegments.push({
        type: "link",
        label: isCheckout ? "click here to proceed to checkout" : label,
        url: cleanHref,
        isCheckout,
      });
    } else if (match[3] && match[4]) {
      const label = match[3];
      const url = match[4];
      const cleanHref = toAbsoluteUrl(cleanMarkdownHref(url));
      const isCheckout = cleanHref.includes("/cart") || cleanHref.includes("checkout");
      rawSegments.push({
        type: "link",
        label: isCheckout ? "click here to proceed to checkout" : label,
        url: cleanHref,
        isCheckout,
      });
    } else if (match[5]) {
      const url = match[5];
      const cleanHref = toAbsoluteUrl(cleanMarkdownHref(url));
      rawSegments.push({
        type: "link",
        label: "click here to proceed to checkout",
        url: cleanHref,
        isCheckout: true,
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    rawSegments.push({ type: "text", content: text.substring(lastIndex) });
  }

  // Parse bold formatting (**text** or __text__) inside text segments
  const finalSegments = [];
  for (const seg of rawSegments) {
    if (seg.type !== "text") {
      finalSegments.push(seg);
      continue;
    }
    const boldRegex = /(\*\*|__)(.*?)\1/g;
    let bLast = 0;
    let bMatch;
    while ((bMatch = boldRegex.exec(seg.content)) !== null) {
      if (bMatch.index > bLast) {
        finalSegments.push({ type: "text", content: seg.content.substring(bLast, bMatch.index) });
      }
      finalSegments.push({ type: "bold", content: bMatch[2] });
      bLast = bMatch.index + bMatch[0].length;
    }
    if (bLast < seg.content.length) {
      finalSegments.push({ type: "text", content: seg.content.substring(bLast) });
    }
  }

  return finalSegments;
}

function parseMarkdownBlocks(text) {
  if (!text) return [];

  const cleaned = cleanAssistantRawText(text);
  const lines = cleaned.split("\n");
  const blocks = [];
  let currentList = null;

  const flushList = () => {
    if (currentList) {
      blocks.push(currentList);
      currentList = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const unorderedMatch = line.match(/^\s*([-*])\s+(.*)/);
    const orderedMatch = line.match(/^\s*(\d+)[\.)]\s+(.*)/);

    if (unorderedMatch) {
      if (!currentList || currentList.type !== "ul") {
        flushList();
        currentList = { type: "ul", items: [] };
      }
      currentList.items.push(parseInlineSegments(unorderedMatch[2]));
    } else if (orderedMatch) {
      if (!currentList || currentList.type !== "ol") {
        flushList();
        currentList = { type: "ol", start: parseInt(orderedMatch[1], 10) || 1, items: [] };
      }
      currentList.items.push(parseInlineSegments(orderedMatch[2]));
    } else {
      flushList();
      if (line.trim() === "") {
        blocks.push({ type: "spacer" });
      } else {
        blocks.push({ type: "p", segments: parseInlineSegments(line) });
      }
    }
  }

  flushList();
  return blocks;
}

function parseStorefrontAssistantMessage(content) {
  let cleanText = "";
  let products = [];

  if (!content) return { cleanText: "", products: [] };
  if (typeof content !== "string") {
    return { cleanText: cleanAssistantRawText(String(content)), products: [] };
  }

  const trimmed = content.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = parsePartialJson(trimmed);
    if (parsed) {
      const items = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of items) {
        if (!item) continue;
        if (item.type === "text" && item.text) {
          cleanText = cleanText ? `${cleanText}\n\n${item.text.trim()}` : item.text.trim();
        } else if (item.type === "product_results" && Array.isArray(item.products)) {
          products.push(...item.products);
        }
      }

      // If this message contains only system/tools/product_results/fitment blocks
      const onlyInternalBlocks = items.every(
        (item) =>
          item?.type === "tool_use" ||
          item?.type === "tool_result" ||
          item?.type === "product_results" ||
          item?.type === "fitment_options" ||
          item?.type === "customer_addresses" ||
          item?.type === "install_resources"
      );

      if (onlyInternalBlocks && !cleanText) {
        return { cleanText: "", products };
      }

      if (cleanText || products.length > 0) {
        return { cleanText: cleanAssistantRawText(cleanText), products };
      }
    }
  }

  // Safety check: if raw content contains JSON markers for internal payloads, hide them completely!
  if (
    trimmed.includes('"type":"product_results"') ||
    trimmed.includes('"type":"tool_result"') ||
    trimmed.includes('"type":"tool_use"') ||
    trimmed.includes("gid://shopify/ProductVariant") ||
    trimmed.startsWith('[{"type":') ||
    trimmed.startsWith('{"type":')
  ) {
    return { cleanText: "", products: [] };
  }

  return { cleanText: cleanAssistantRawText(content), products: [] };
}

function getVisibleMessageText(cleanText) {
  if (!cleanText) return "";
  const blocks = parseMarkdownBlocks(cleanText);
  const pieces = [];

  for (const block of blocks) {
    if (block.type === "p") {
      for (const seg of block.segments) {
        pieces.push(seg.content || seg.label || "");
      }
      pieces.push("\n");
    } else if (block.type === "ul" || block.type === "ol") {
      for (const item of block.items) {
        for (const seg of item) {
          pieces.push(seg.content || seg.label || "");
        }
        pieces.push("\n");
      }
    } else if (block.type === "spacer") {
      pieces.push("\n");
    }
  }

  return pieces.join("");
}

function renderHighlightedText(text, searchQuery, startIndex = 0, activeIndex = -1) {
  if (!text) return null;
  if (!searchQuery || !searchQuery.trim() || activeIndex < 0) {
    return text;
  }

  const query = searchQuery.trim();
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = String(text).split(regex);
  let localOffset = startIndex;

  return parts.map((part, i) => {
    if (part.toLowerCase() === query.toLowerCase()) {
      const matchIndex = localOffset++;
      const isActive = matchIndex === activeIndex;
      return (
        <mark
          key={`m-${matchIndex}-${i}`}
          id={`chat-match-${matchIndex}`}
          className={`chat-highlight-mark ${isActive ? "is-active" : ""}`}
        >
          {part}
        </mark>
      );
    }
    return part;
  });
}

function renderFormattedMessage(text, searchQuery = "", startIndex = 0, activeIndex = -1) {
  if (!text) return null;
  const blocks = parseMarkdownBlocks(text);
  const hasSearch = Boolean(searchQuery && searchQuery.trim() && activeIndex >= 0);

  let currentOffset = startIndex;

  const highlightText = (content) => {
    if (!hasSearch || !content) return content;
    const query = searchQuery.trim();
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(${escaped})`, "gi");
    const chunks = String(content).split(regex);

    return chunks.map((sub, i) => {
      if (sub.toLowerCase() === query.toLowerCase()) {
        const matchIndex = currentOffset++;
        const isActive = matchIndex === activeIndex;
        return (
          <mark
            key={`m-${matchIndex}-${i}`}
            id={`chat-match-${matchIndex}`}
            className={`chat-highlight-mark ${isActive ? "is-active" : ""}`}
          >
            {sub}
          </mark>
        );
      }
      return sub;
    });
  };

  const renderSegments = (segments) => {
    return segments.map((seg, i) => {
      if (seg.type === "bold") {
        return <strong key={i}>{highlightText(seg.content)}</strong>;
      }
      if (seg.type === "link") {
        return (
          <a
            key={i}
            href={seg.url}
            target="_blank"
            rel="noopener noreferrer"
            className={seg.isCheckout ? "checkout-link" : ""}
          >
            {highlightText(seg.label)}
            {!seg.isCheckout && " ↗"}
          </a>
        );
      }
      return <span key={i}>{highlightText(seg.content)}</span>;
    });
  };

  return (
    <div className="storefront-assistant-content">
      {blocks.map((block, bIdx) => {
        if (block.type === "spacer") {
          return <div key={bIdx} className="storefront-assistant-spacer" />;
        }
        if (block.type === "ul") {
          return (
            <ul key={bIdx}>
              {block.items.map((item, itemIdx) => (
                <li key={itemIdx}>{renderSegments(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "ol") {
          return (
            <ol key={bIdx} start={block.start}>
              {block.items.map((item, itemIdx) => (
                <li key={itemIdx}>{renderSegments(item)}</li>
              ))}
            </ol>
          );
        }
        return <p key={bIdx}>{renderSegments(block.segments)}</p>;
      })}
    </div>
  );
}

function StorefrontComparisonTable({ products }) {
  if (!Array.isArray(products) || products.length <= 1) return null;

  const isHomeFilter = (product) => {
    if (!product) return false;
    const category = String(product.productCategory || "").toLowerCase();
    if (category === "home_filter" || category === "home") return true;
    const type = String(product.productType || product.product_type || "");
    if (/home furnace air filter|home air filter/i.test(type)) return true;
    const title = String(product.title || "");
    return /home air filter|furnace filter/i.test(title) && !/cabin/i.test(title);
  };
  const isHomeCompare = products.length > 0 && products.every(isHomeFilter);

  const mervLabel = (product) => {
    const direct = String(product.merv || product.mervRating || "").trim();
    if (direct) {
      const level = direct.match(/(\d{1,2})/);
      return level ? `MERV ${level[1]}` : direct;
    }
    const tags = Array.isArray(product.tags) ? product.tags : [];
    const tag = tags.find((item) => /^merv-\d+/i.test(String(item || "")));
    if (tag) return String(tag).replace(/^merv-/i, "MERV ");
    const fromTitle = String(product.title || "").match(/\bMERV\s*(\d{1,2})\b/i);
    return fromTitle ? `MERV ${fromTitle[1]}` : "—";
  };

  const getIsHepa = (p) => {
    if (p.isHepa != null) return Boolean(p.isHepa);
    return /hepa/i.test(p.title || "") || /hepa/i.test(p.filterType || "");
  };

  const getHasAntibacterial = (p) => {
    if (p.hasAntibacterial != null) return Boolean(p.hasAntibacterial);
    return /antibacterial|anti-microbial|antimicrobial/i.test(p.title || "");
  };

  const getHasCharcoal = (p) => {
    if (p.hasCharcoal != null) return Boolean(p.hasCharcoal);
    return /charcoal|carbon|odor/i.test(p.title || "") || /charcoal/i.test(p.filterType || "");
  };

  const productName = (product) => {
    const full = String(product.title || product.sku || product.partNumber || "Product").trim();
    if (full.length <= 36) return full;
    return `${full.slice(0, 33).trim()}…`;
  };

  const rows = isHomeCompare
    ? [
        { label: "MERV", getValue: (p) => mervLabel(p), isBoolean: false },
        { label: "Charcoal / odor", getValue: (p) => getHasCharcoal(p), isBoolean: true },
        {
          label: "Price",
          getValue: (p) =>
            p.price || (typeof p.priceAmount === "number" ? `$${p.priceAmount.toFixed(2)}` : "—"),
          isBoolean: false
        },
        {
          label: "Stock",
          getValue: (p) =>
            p.inStock !== false && p.availableForSale !== false ? "In stock" : "Out of stock",
          isStock: true
        }
      ]
    : [
        { label: "HEPA", getValue: (p) => getIsHepa(p), isBoolean: true },
        { label: "Antibacterial", getValue: (p) => getHasAntibacterial(p), isBoolean: true },
        { label: "Charcoal / odor", getValue: (p) => getHasCharcoal(p), isBoolean: true },
        {
          label: "Price",
          getValue: (p) =>
            p.price || (typeof p.priceAmount === "number" ? `$${p.priceAmount.toFixed(2)}` : "—"),
          isBoolean: false
        },
        {
          label: "Stock",
          getValue: (p) =>
            p.inStock !== false && p.availableForSale !== false ? "In stock" : "Out of stock",
          isStock: true
        }
      ];

  return (
    <div className="storefront-compare">
      <h5 className="storefront-compare-title">Quick comparison</h5>
      <div className="storefront-compare-scroll">
        <table className="storefront-compare-table">
          <thead>
            <tr>
              <th>Feature</th>
              {products.map((p, idx) => {
                const key = p.id || p.variantId || idx;
                const isBest = Boolean(p.isBest);
                return (
                  <th
                    key={key}
                    className={isBest ? "is-best" : ""}
                    title={p.title || ""}
                  >
                    <span className="storefront-compare-product-head">
                      {productName(p)}
                    </span>
                    {isBest && <span className="storefront-compare-best-tag">Best pick</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                {products.map((p, idx) => {
                  const key = p.id || p.variantId || idx;
                  const isBest = Boolean(p.isBest);
                  const rawVal = row.getValue(p);
                  let displayVal = rawVal;
                  if (row.isBoolean) {
                    displayVal = rawVal ? (
                      <span className="yes-badge">Yes</span>
                    ) : (
                      <span className="no-badge">No</span>
                    );
                  } else if (row.isStock) {
                    displayVal =
                      rawVal === "In stock" ? (
                        <span className="stock-in" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                          <CheckIcon size={12} /> In stock
                        </span>
                      ) : (
                        <span className="stock-out" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                          <CloseIcon size={10} /> Out
                        </span>
                      );
                  }
                  return (
                    <td
                      key={key}
                      className={isBest ? "is-best" : ""}
                    >
                      {displayVal}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StorefrontBestProductSection({ product }) {
  if (!product) return null;
  const isFreshener =
    product.productCategory === "freshener" ||
    product.filterType === "freshener" ||
    /\bfreshener|freshers/i.test(String(product.title || "")) ||
    /\bfreshener|freshers/i.test(String(product.productType || product.product_type || ""));
  if (isFreshener) return null;

  const title = product.title || "Best Matching Cabin Filter";
  const imageUrl =
    product.image_url ||
    product.imageUrl ||
    (Array.isArray(product.images) && product.images[0]) ||
    "https://cdn.shopify.com/s/files/1/0445/2817/3216/products/AB071504-leading.jpg";
  const inStock = product.inStock !== false && product.availableForSale !== false;
  const price =
    product.price || (typeof product.priceAmount === "number" ? `$${product.priceAmount.toFixed(2)}` : "$24.99");
  const productUrl = product.url
    ? product.url.startsWith("http")
      ? product.url
      : `https://perfumania.com${product.url}`
    : "https://perfumania.com";

  return (
    <div className="storefront-best-section">
      <h5 className="storefront-best-section-title">Best product</h5>
      <div className="storefront-best-highlight">
        <div className="storefront-best-highlight-image">
          <img
            src={imageUrl}
            alt={title}
            onError={(e) => {
              e.currentTarget.src =
                "https://cdn.shopify.com/s/files/1/0445/2817/3216/products/AB071504-leading.jpg";
            }}
          />
          <span className="storefront-product-best-badge">Best pick</span>
        </div>
        <div className="storefront-best-highlight-info">
          <a
            href={productUrl}
            target="_blank"
            rel="noreferrer"
            className="storefront-best-highlight-title"
            title={title}
          >
            {title}
          </a>
          <div className="storefront-best-highlight-meta">
            <span className="storefront-product-price">{price}</span>
            <span
              className={`storefront-product-stock-badge ${
                inStock ? "in-stock" : "out-of-stock"
              }`}
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              {inStock ? (
                <>
                  <CheckIcon size={12} /> In stock
                </>
              ) : (
                <>
                  <CloseIcon size={10} /> Out of stock
                </>
              )}
            </span>
          </div>
          {product.bestReason && (
            <div className="storefront-best-reason">{product.bestReason}</div>
          )}
          <a
            href={productUrl}
            target="_blank"
            rel="noreferrer"
            className="storefront-product-link-btn"
            style={{ alignSelf: "flex-start", marginTop: "6px", width: "auto", padding: "5px 12px", display: "inline-flex", alignItems: "center", gap: 5 }}
          >
            <span>View Product</span>
            <ExternalLinkIcon size={12} />
          </a>
        </div>
      </div>
    </div>
  );
}

function StorefrontProductSection({ products }) {
  if (!Array.isArray(products) || products.length === 0) return null;

  const hasFreshener = products.some(
    (p) =>
      p &&
      (p.productCategory === "freshener" ||
        p.filterType === "freshener" ||
        /\bfreshener|freshers/i.test(String(p.title || "")) ||
        /\bfreshener|freshers/i.test(String(p.productType || p.product_type || "")))
  );

  const bestProduct = !hasFreshener
    ? products.find((p) => p && p.isBest) || null
    : null;

  return (
    <div className="storefront-product-section">
      <div className="storefront-product-header">
        <ShoppingBagIcon size={16} style={{ color: "var(--pf-brand)" }} />
        <span>Top Matching Products ({products.length})</span>
      </div>
      <div className="storefront-product-carousel">
        <div className="storefront-product-grid">
          {products.map((p, idx) => {
            const key = p.id || p.variantId || p.sku || `prod-${idx}`;
            const title =
              p.title ||
              (p.variantId
                ? `Perfumania Fragrance (${String(p.variantId).split("/").pop()})`
                : "Perfumania Product");
            const imageUrl =
              p.image_url ||
              p.imageUrl ||
              (Array.isArray(p.images) && p.images[0]) ||
              "https://cdn.shopify.com/s/files/1/0445/2817/3216/products/AB071504-leading.jpg";
            const inStock = p.inStock !== false && p.availableForSale !== false;
            const price =
              p.price || (typeof p.priceAmount === "number" ? `$${p.priceAmount.toFixed(2)}` : "$24.99");
            const productUrl = p.url
              ? p.url.startsWith("http")
                ? p.url
                : `https://perfumania.com${p.url}`
              : "https://perfumania.com";

            const isFreshener =
              p.productCategory === "freshener" ||
              p.filterType === "freshener" ||
              /\bfreshener|freshers/i.test(String(p.title || "")) ||
              /\bfreshener|freshers/i.test(String(p.productType || p.product_type || ""));
            const showBestBadge = Boolean(p.isBest && !isFreshener);

            return (
              <div
                key={key}
                className={`storefront-product-card ${showBestBadge ? "is-best" : ""}`}
              >
                {showBestBadge && (
                  <span className="storefront-product-best-badge">
                    Best pick
                  </span>
                )}
                <div className="storefront-product-image-wrap">
                  <img
                    src={imageUrl}
                    alt={title}
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.src =
                        "https://cdn.shopify.com/s/files/1/0445/2817/3216/products/AB071504-leading.jpg";
                    }}
                  />
                </div>
                <div className="storefront-product-info">
                  <h3 className="storefront-product-title" title={title}>
                    {title}
                  </h3>
                  <div className="storefront-product-price-row">
                    <span className="storefront-product-price">{price}</span>
                    {p.compareAtPrice && (
                      <span className="storefront-product-compare-price">
                        {p.compareAtPrice}
                      </span>
                    )}
                  </div>
                  <div
                    className={`storefront-product-stock-badge ${
                      inStock ? "in-stock" : "out-of-stock"
                    }`}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    {inStock ? (
                      <>
                        <CheckIcon size={12} /> In stock
                      </>
                    ) : (
                      <>
                        <CloseIcon size={10} /> Out of stock
                      </>
                    )}
                  </div>
                  <a
                    href={productUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="storefront-product-link-btn"
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5 }}
                  >
                    <span>View Product</span>
                    <ExternalLinkIcon size={12} />
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {products.length > 1 && !hasFreshener && (
        <StorefrontComparisonTable products={products} />
      )}
      {bestProduct && (
        <StorefrontBestProductSection product={bestProduct} />
      )}
    </div>
  );
}

function AssistantMessageCard({
  msg,
  searchQuery = "",
  startIndex = 0,
  activeMatchIndex = -1,
}) {
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const hasText = Boolean(msg.cleanText && msg.cleanText.trim());
  const hasProducts = Array.isArray(msg.products) && msg.products.length > 0;

  // Extract knowledge match info if vector search was used in this turn
  const knowledgeMatch = useMemo(() => {
    if (!Array.isArray(msg.searchResults) || msg.searchResults.length === 0) {
      return null;
    }
    const validResults = msg.searchResults.filter(
      (r) => typeof r.similarity === "number" && !isNaN(r.similarity) && r.similarity > 0
    );
    if (validResults.length === 0) return null;

    validResults.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    const topResult = validResults[0];
    const topScore = topResult.similarity;
    const matchPct = Math.round(topScore * 100);
    const docTitle = topResult.chunk?.document?.title || "Knowledge Document";
    const docId = topResult.chunk?.document?.id;
    const chunkCount = validResults.length;

    return {
      topScore,
      matchPct,
      docTitle,
      docId,
      chunkCount,
    };
  }, [msg.searchResults]);

  const handleCopy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard && msg.cleanText) {
      const copyContent = getVisibleMessageText(msg.cleanText) || msg.cleanText;
      navigator.clipboard.writeText(copyContent).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      });
    }
  };

  const handleSpeak = () => {
    if (typeof window !== "undefined" && "speechSynthesis" in window && msg.cleanText) {
      if (speaking) {
        window.speechSynthesis.cancel();
        setSpeaking(false);
      } else {
        window.speechSynthesis.cancel();
        const speakContent = getVisibleMessageText(msg.cleanText) || msg.cleanText;
        const utterance = new SpeechSynthesisUtterance(speakContent);
        utterance.rate = 1.0;
        utterance.onend = () => setSpeaking(false);
        utterance.onerror = () => setSpeaking(false);
        setSpeaking(true);
        window.speechSynthesis.speak(utterance);
      }
    }
  };

  return (
    <div className="storefront-message-row is-assistant">
      {hasText && (
        <>
          <div className="storefront-assistant-bubble">
            {renderFormattedMessage(msg.cleanText, searchQuery, startIndex, activeMatchIndex)}
          </div>
          <div className="storefront-bubble-meta">
            <button
              type="button"
              onClick={handleCopy}
              className="storefront-meta-btn"
              title="Copy response text"
            >
              {copied ? (
                <>
                  <CheckIcon size={13} style={{ color: "var(--accent-emerald)" }} /> Copied
                </>
              ) : (
                <>
                  <CopyIcon size={13} /> Copy
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleSpeak}
              className="storefront-meta-btn"
              title={speaking ? "Stop speaking" : "Read aloud"}
            >
              {speaking ? (
                <>
                  <StopSpeakerIcon size={13} style={{ color: "var(--accent-cyan)" }} /> Stop
                </>
              ) : (
                <>
                  <SpeakerIcon size={13} /> Listen
                </>
              )}
            </button>
            {knowledgeMatch && (
              knowledgeMatch.docId ? (
                <Link
                  to={`/admin/knowledge?docId=${encodeURIComponent(knowledgeMatch.docId)}`}
                  className="storefront-knowledge-badge is-link"
                  title={`Source: "${knowledgeMatch.docTitle}" · Match Score: ${(knowledgeMatch.topScore * 100).toFixed(1)}% (${knowledgeMatch.topScore.toFixed(4)})${knowledgeMatch.chunkCount > 1 ? ` · ${knowledgeMatch.chunkCount} chunks matched` : ""}\nClick to view document in Knowledge Base`}
                >
                  <BookOpenIcon size={12} className="storefront-knowledge-badge-icon" />
                  <span>Knowledge Base ({knowledgeMatch.matchPct}% match)</span>
                </Link>
              ) : (
                <span
                  className="storefront-knowledge-badge"
                  title={`Source: "${knowledgeMatch.docTitle}" · Match Score: ${(knowledgeMatch.topScore * 100).toFixed(1)}% (${knowledgeMatch.topScore.toFixed(4)})${knowledgeMatch.chunkCount > 1 ? ` · ${knowledgeMatch.chunkCount} chunks matched` : ""}`}
                >
                  <BookOpenIcon size={12} className="storefront-knowledge-badge-icon" />
                  <span>Knowledge Base ({knowledgeMatch.matchPct}% match)</span>
                </span>
              )
            )}
            <span>
              <FormattedDate date={msg.createdAt} format="time" />
            </span>
          </div>
        </>
      )}

      {hasProducts && (
        <StorefrontProductSection products={msg.products} />
      )}

      {!hasText && hasProducts && (
        <div className="storefront-bubble-meta" style={{ marginTop: 2 }}>
          {knowledgeMatch && (
            knowledgeMatch.docId ? (
              <Link
                to={`/admin/knowledge?docId=${encodeURIComponent(knowledgeMatch.docId)}`}
                className="storefront-knowledge-badge is-link"
                title={`Source: "${knowledgeMatch.docTitle}" · Match Score: ${(knowledgeMatch.topScore * 100).toFixed(1)}% (${knowledgeMatch.topScore.toFixed(4)})${knowledgeMatch.chunkCount > 1 ? ` · ${knowledgeMatch.chunkCount} chunks matched` : ""}\nClick to view document in Knowledge Base`}
              >
                <BookOpenIcon size={12} className="storefront-knowledge-badge-icon" />
                <span>Knowledge Base ({knowledgeMatch.matchPct}% match)</span>
              </Link>
            ) : (
              <span
                className="storefront-knowledge-badge"
                title={`Source: "${knowledgeMatch.docTitle}" · Match Score: ${(knowledgeMatch.topScore * 100).toFixed(1)}% (${knowledgeMatch.topScore.toFixed(4)})${knowledgeMatch.chunkCount > 1 ? ` · ${knowledgeMatch.chunkCount} chunks matched` : ""}`}
              >
                <BookOpenIcon size={12} className="storefront-knowledge-badge-icon" />
                <span>Knowledge Base ({knowledgeMatch.matchPct}% match)</span>
              </span>
            )
          )}
          <span>
            <FormattedDate date={msg.createdAt} format="time" />
          </span>
        </div>
      )}
    </div>
  );
}

function StorefrontChatView({
  details,
  devMode = false,
  activeTab: propActiveTab = "chat",
  setActiveTab,
  expandedLogId,
  setExpandedLogId,
}) {
  // If devMode is OFF, enforce that activeTab always falls back to "chat"
  const activeTab = !devMode && propActiveTab !== "chat" ? "chat" : propActiveTab;

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchInputRef = useRef(null);

  const [selectedLlmLogId, setSelectedLlmLogId] = useState(expandedLogId || null);
  const [selectedMcpLogId, setSelectedMcpLogId] = useState(expandedLogId || null);

  useEffect(() => {
    if (expandedLogId) {
      if (details?.llmLogs?.some((l) => l.id === expandedLogId)) {
        setSelectedLlmLogId(expandedLogId);
      }
      if (details?.mcpLogs?.some((l) => l.id === expandedLogId)) {
        setSelectedMcpLogId(expandedLogId);
      }
    }
  }, [expandedLogId, details?.llmLogs, details?.mcpLogs]);

  const activeLlmLog = useMemo(() => {
    if (!details?.llmLogs || details.llmLogs.length === 0) return null;
    return (
      details.llmLogs.find((l) => l.id === (selectedLlmLogId || expandedLogId)) ||
      details.llmLogs[0]
    );
  }, [details?.llmLogs, selectedLlmLogId, expandedLogId]);

  const activeMcpLog = useMemo(() => {
    if (!details?.mcpLogs || details.mcpLogs.length === 0) return null;
    return (
      details.mcpLogs.find((l) => l.id === (selectedMcpLogId || expandedLogId)) ||
      details.mcpLogs[0]
    );
  }, [details?.mcpLogs, selectedMcpLogId, expandedLogId]);

  const userInfo = useMemo(() => {
    if (!details) return null;
    const { shopperCart, storeCustomer, conversation, isGuest } = details;

    const registeredName = storeCustomer
      ? [storeCustomer.firstName, storeCustomer.lastName].filter(Boolean).join(" ")
      : [shopperCart?.customerFirstName, shopperCart?.customerLastName].filter(Boolean).join(" ") ||
        shopperCart?.displayName;

    const guestName =
      [shopperCart?.customerFirstName, shopperCart?.customerLastName].filter(Boolean).join(" ") ||
      (shopperCart?.displayName && !shopperCart.displayName.toLowerCase().startsWith("guest")
        ? shopperCart.displayName
        : "");

    const shopperId = conversation?.shopperId || shopperCart?.id || "";
    const shortShopperId = shopperId ? shopperId.replace(/[-_]/g, "").substring(0, 8) : "";
    const defaultGuestLabel = shortShopperId ? `Guest-${shortShopperId}` : `Guest #${String(conversation?.id || "").slice(-6)}`;

    const displayName = isGuest
      ? guestName || defaultGuestLabel
      : registeredName || storeCustomer?.email || "Registered Customer";

    const email =
      storeCustomer?.email ||
      shopperCart?.customerEmail ||
      shopperCart?.email ||
      "";

    const initials = isGuest && !guestName
      ? "G"
      : displayName
          .split(" ")
          .filter(Boolean)
          .map((n) => n[0])
          .slice(0, 2)
          .join("")
          .toUpperCase() || (isGuest ? "G" : "U");

    const customerLink = shopperId
      ? `/admin/customers?shopperId=${encodeURIComponent(shopperId)}`
      : email
      ? `/admin/customers?search=${encodeURIComponent(email)}`
      : displayName && !displayName.toLowerCase().startsWith("guest")
      ? `/admin/customers?search=${encodeURIComponent(displayName)}`
      : `/admin/customers`;

    return {
      isGuest,
      displayName,
      email,
      initials,
      shopperId,
      customerId: storeCustomer?.shopifyCustomerId || shopperCart?.shopifyCustomerId,
      customerLink,
    };
  }, [details]);

  const visibleMessages = useMemo(() => {
    if (!details?.messages) return [];

    const result = [];
    let currentAssistant = null;
    let turnSearchResults = [];

    const flushAssistant = () => {
      if (currentAssistant) {
        if (Array.isArray(currentAssistant.searchResults)) {
          const seen = new Set();
          currentAssistant.searchResults = currentAssistant.searchResults.filter((r) => {
            const key = r.id || `${r.chunkId}-${r.similarity}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        if (
          currentAssistant.cleanText ||
          (Array.isArray(currentAssistant.products) && currentAssistant.products.length > 0)
        ) {
          result.push(currentAssistant);
        }
        currentAssistant = null;
      }
    };

    for (const msg of details.messages) {
      if (Array.isArray(msg.searchResults) && msg.searchResults.length > 0) {
        turnSearchResults.push(...msg.searchResults);
      }

      if (isToolMessage(msg)) continue;

      if (msg.role === "user") {
        flushAssistant();
        turnSearchResults = Array.isArray(msg.searchResults) ? [...msg.searchResults] : [];
        result.push({
          ...msg,
          cleanText: msg.content,
          products: [],
        });
        continue;
      }

      if (msg.role === "assistant") {
        const parsed = parseStorefrontAssistantMessage(msg.content);
        if (!parsed.cleanText && (!parsed.products || parsed.products.length === 0)) {
          continue;
        }

        if (!currentAssistant) {
          currentAssistant = {
            ...msg,
            cleanText: parsed.cleanText || "",
            products: Array.isArray(parsed.products) ? [...parsed.products] : [],
            searchResults: [...turnSearchResults, ...(Array.isArray(msg.searchResults) ? msg.searchResults : [])],
          };
        } else {
          // Merge assistant response parts for the same turn (text + products)
          if (parsed.cleanText) {
            currentAssistant.cleanText = currentAssistant.cleanText
              ? `${currentAssistant.cleanText}\n\n${parsed.cleanText}`
              : parsed.cleanText;
          }
          if (Array.isArray(parsed.products) && parsed.products.length > 0) {
            const existingKeys = new Set(
              currentAssistant.products.map((p) => String(p.id || p.variantId || p.sku || ""))
            );
            for (const p of parsed.products) {
              const k = String(p.id || p.variantId || p.sku || "");
              if (!k || !existingKeys.has(k)) {
                currentAssistant.products.push(p);
                if (k) existingKeys.add(k);
              }
            }
          }
          if (turnSearchResults.length > 0 || (Array.isArray(msg.searchResults) && msg.searchResults.length > 0)) {
            currentAssistant.searchResults = [
              ...(currentAssistant.searchResults || []),
              ...turnSearchResults,
              ...(Array.isArray(msg.searchResults) ? msg.searchResults : []),
            ];
          }
          if (msg.createdAt) {
            currentAssistant.createdAt = msg.createdAt;
          }
        }
      }
    }

    flushAssistant();
    return result;
  }, [details?.messages]);

  // Reset search when switching conversation
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [details?.conversation?.id]);

  // Keyboard shortcut Ctrl+F / Cmd+F to open search
  useEffect(() => {
    const handleGlobalKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setIsSearchOpen(true);
        setTimeout(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }, 40);
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  // Auto focus input when search opened
  useEffect(() => {
    if (isSearchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    } else {
      setSearchQuery("");
      setCurrentMatchIndex(0);
    }
  }, [isSearchOpen]);

  // Pre-calculate total matches and per-message start indices deterministically
  const searchIndexData = useMemo(() => {
    if (!searchQuery.trim() || !visibleMessages) {
      return { total: 0, messageIndexMap: new Map() };
    }
    const escaped = searchQuery.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    let runningIndex = 0;
    const messageIndexMap = new Map();

    for (const msg of visibleMessages) {
      const visible = getVisibleMessageText(msg.cleanText);
      if (visible) {
        const matches = visible.match(regex);
        const count = matches ? matches.length : 0;
        messageIndexMap.set(msg.id, {
          startIndex: runningIndex,
          count,
        });
        runningIndex += count;
      } else {
        messageIndexMap.set(msg.id, {
          startIndex: runningIndex,
          count: 0,
        });
      }
    }
    return { total: runningIndex, messageIndexMap };
  }, [visibleMessages, searchQuery]);

  const totalMatches = searchIndexData.total;

  // Clamp currentMatchIndex when totalMatches changes
  useEffect(() => {
    if (totalMatches === 0) {
      setCurrentMatchIndex(0);
    } else if (currentMatchIndex >= totalMatches) {
      setCurrentMatchIndex(0);
    }
  }, [totalMatches, currentMatchIndex]);

  // Scroll active match into view smoothly
  useEffect(() => {
    if (totalMatches > 0 && isSearchOpen) {
      const timer = setTimeout(() => {
        const el = document.getElementById(`chat-match-${currentMatchIndex}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [currentMatchIndex, searchQuery, totalMatches, isSearchOpen]);

  const handleNextMatch = () => {
    if (totalMatches <= 1) return;
    setCurrentMatchIndex((prev) => (prev + 1) % totalMatches);
  };

  const handlePrevMatch = () => {
    if (totalMatches <= 1) return;
    setCurrentMatchIndex((prev) => (prev - 1 + totalMatches) % totalMatches);
  };

  const handleSearchKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        handlePrevMatch();
      } else {
        handleNextMatch();
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      handleNextMatch();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      handlePrevMatch();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setIsSearchOpen(false);
    }
  };

  return (
    <div className="storefront-chat-container">
      {/* Widget Header - Clean Shopper Context & Controls (Single Slim Row) */}
      <div className="storefront-chat-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
          {/* Avatar circle matching UserFilterSelect */}
          <Link
            to={userInfo?.customerLink || "/admin/customers"}
            className="user-avatar-link"
            style={{ textDecoration: "none", display: "inline-flex", flexShrink: 0 }}
            title={
              userInfo?.email
                ? `Open ${userInfo.displayName} (${userInfo.email}) in Customers & Guests`
                : `Open ${userInfo?.displayName || "Shopper"} in Customers & Guests`
            }
          >
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: userInfo?.isGuest
                  ? "rgba(245, 158, 11, 0.15)"
                  : "rgba(0, 188, 242, 0.15)",
                color: userInfo?.isGuest
                  ? "rgb(245, 158, 11)"
                  : "var(--accent-cyan)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.76rem",
                fontWeight: 700,
                flexShrink: 0,
                cursor: "pointer",
                transition: "transform 0.15s ease, box-shadow 0.15s ease",
              }}
            >
              {userInfo?.initials || "U"}
            </span>
          </Link>

          {/* User Name & Info (Single clean row without email) */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "nowrap" }}>
            <Link
              to={userInfo?.customerLink || "/admin/customers"}
              className="customer-header-name-link"
              style={{
                fontSize: "0.88rem",
                fontWeight: 700,
                color: "var(--text-main)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                textDecoration: "none",
                cursor: "pointer",
              }}
              title={
                userInfo?.email
                  ? `Open in Customers & Guests: ${userInfo.displayName} (${userInfo.email})`
                  : `Open in Customers & Guests: ${userInfo?.displayName || "Shopper"}`
              }
            >
              {userInfo?.displayName}
            </Link>

            <span
              className={`badge ${userInfo?.isGuest ? "badge-guest" : "badge-customer"}`}
              style={{ flexShrink: 0, padding: "1px 6px", fontSize: "0.66rem", fontWeight: 700 }}
            >
              {userInfo?.isGuest ? "Guest" : "Customer"}
            </span>
          </div>
        </div>

        <div
          className="storefront-header-actions"
          style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, flexWrap: "nowrap" }}
        >
          {/* WhatsApp-Style Search in Chat Button */}
          {activeTab === "chat" && (
            <button
              type="button"
              onClick={() => setIsSearchOpen((prev) => !prev)}
              className={`filter-btn ${isSearchOpen ? "active" : ""}`}
              style={{
                padding: "5px 10px",
                fontSize: "0.75rem",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                background: isSearchOpen ? "var(--pf-brand-soft, rgba(0, 188, 242, 0.15))" : undefined,
                borderColor: isSearchOpen ? "var(--pf-brand, #00bcf2)" : undefined,
                color: isSearchOpen ? "var(--accent-cyan, #00bcf2)" : undefined,
                flexShrink: 0,
              }}
              title="Search in this chat (Ctrl+F / Cmd+F)"
            >
              <SearchIcon size={13} />
              <span>Search Chat</span>
            </button>
          )}

          {/* Dev Mode Tabs - shown ONLY when Dev Option is turned ON from left sidebar */}
          {devMode && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                background: "var(--bg-surface-elevated)",
                padding: "2px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border-subtle)",
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                onClick={() => setActiveTab?.("chat")}
                className={`filter-btn ${activeTab === "chat" ? "active" : ""}`}
                style={{
                  padding: "4px 8px",
                  fontSize: "0.74rem",
                  borderRadius: "var(--radius-xs, 4px)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  flexShrink: 0,
                }}
              >
                <ChatBubbleIcon size={12} />
                <span>Chat</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab?.("mcp")}
                className={`filter-btn ${activeTab === "mcp" ? "active" : ""}`}
                style={{
                  padding: "4px 8px",
                  fontSize: "0.74rem",
                  borderRadius: "var(--radius-xs, 4px)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  flexShrink: 0,
                }}
              >
                <WrenchIcon size={12} />
                <span>MCP Logs ({details.mcpLogs?.length || 0})</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab?.("llm")}
                className={`filter-btn ${activeTab === "llm" ? "active" : ""}`}
                style={{
                  padding: "4px 8px",
                  fontSize: "0.74rem",
                  borderRadius: "var(--radius-xs, 4px)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  flexShrink: 0,
                }}
              >
                <SparkleIcon size={12} />
                <span>LLM Logs ({details.llmLogs?.length || 0})</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 1. STOREFRONT CHAT MESSAGES TAB */}
      {activeTab === "chat" && (
        <>
          {/* WhatsApp-Style In-Chat Search Bar */}
          {isSearchOpen && (
            <div className="chat-search-bar">
              <div className="chat-search-input-wrap">
                <SearchIcon size={15} style={{ color: "var(--accent-cyan)" }} />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setCurrentMatchIndex(0);
                  }}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search in chat messages..."
                  className="chat-search-input"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery("");
                      setCurrentMatchIndex(0);
                      searchInputRef.current?.focus();
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--text-dim)",
                      cursor: "pointer",
                      padding: "0 4px",
                      display: "inline-flex",
                      alignItems: "center",
                    }}
                    title="Clear search"
                  >
                    <CloseIcon size={12} />
                  </button>
                )}
              </div>

              {searchQuery.trim() && (
                <div className={`chat-search-counter ${totalMatches === 0 ? "is-empty" : ""}`}>
                  {totalMatches > 0 ? `${currentMatchIndex + 1} of ${totalMatches}` : "No matches"}
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button
                  type="button"
                  disabled={totalMatches <= 1}
                  onClick={handlePrevMatch}
                  className="chat-search-nav-btn"
                  title="Previous match (Shift+Enter or ↑)"
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                >
                  <ChevronUpIcon size={13} />
                </button>
                <button
                  type="button"
                  disabled={totalMatches <= 1}
                  onClick={handleNextMatch}
                  className="chat-search-nav-btn"
                  title="Next match (Enter or ↓)"
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                >
                  <ChevronDownIcon size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsSearchOpen(false);
                    setSearchQuery("");
                  }}
                  className="chat-search-nav-btn"
                  title="Close search (Esc)"
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                >
                  <CloseIcon size={13} />
                </button>
              </div>
            </div>
          )}

          {/* Widget Body - Customer & Assistant Bubbles */}
          <div className="storefront-chat-body">
            {visibleMessages.length === 0 ? (
              <div style={{ textAlign: "center", color: "var(--text-dim)", padding: "48px 20px" }}>
                <div style={{ marginBottom: 12, display: "flex", justifyContent: "center", color: "var(--text-dim)" }}>
                  <ChatMessageIcon size={36} />
                </div>
                <div style={{ fontWeight: 600 }}>No chat messages recorded</div>
                <p style={{ fontSize: "0.82rem", marginTop: 4 }}>This chat may only contain internal system events.</p>
              </div>
            ) : (
              visibleMessages.map((msg) => {
                const matchInfo = isSearchOpen
                  ? searchIndexData.messageIndexMap.get(msg.id)
                  : null;
                const startIndex = matchInfo ? matchInfo.startIndex : 0;
                const activeMatch = isSearchOpen && searchQuery.trim() ? currentMatchIndex : -1;

                if (msg.role === "user") {
                  return (
                    <div key={msg.id} className="storefront-message-row is-user">
                      <div className="storefront-user-bubble">
                        {activeMatch >= 0
                          ? renderHighlightedText(msg.cleanText, searchQuery, startIndex, activeMatch)
                          : msg.cleanText}
                      </div>
                      <div className="storefront-bubble-meta" style={{ justifyContent: "flex-end" }}>
                        <span>
                          <FormattedDate date={msg.createdAt} format="time" />
                        </span>
                      </div>
                    </div>
                  );
                }
                return (
                  <AssistantMessageCard
                    key={msg.id}
                    msg={msg}
                    searchQuery={isSearchOpen ? searchQuery : ""}
                    startIndex={startIndex}
                    activeMatchIndex={activeMatch}
                  />
                );
              })
            )}
          </div>
        </>
      )}

      {/* 2. MCP LOGS TAB CONTENT */}
      {/* 2. MCP CALL LOGS TAB CONTENT - Direct in root container */}
      {activeTab === "mcp" && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {(!details.mcpLogs || details.mcpLogs.length === 0) ? (
            <div style={{ textAlign: "center", color: "var(--text-dim)", padding: 40, flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
              No MCP tool calls recorded for this conversation.
            </div>
          ) : (
            <>
              {/* Call Switcher Bar when multiple calls exist */}
              {details.mcpLogs.length > 1 && (
                <div
                  className="mcp-log-switcher-bar"
                  style={{
                    padding: "8px 16px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    overflowX: "auto",
                    borderBottom: "1px solid var(--border-subtle)",
                    background: "var(--surface-primary)",
                    flexShrink: 0,
                  }}
                >
                  <span style={{ fontSize: "0.74rem", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em", marginRight: 4, whiteSpace: "nowrap" }}>
                    Calls ({details.mcpLogs.length}):
                  </span>
                  {details.mcpLogs.map((log, idx) => {
                    const isSelected = activeMcpLog?.id === log.id;
                    return (
                      <button
                        key={log.id}
                        type="button"
                        onClick={() => setSelectedMcpLogId(log.id)}
                        className={`filter-btn ${isSelected ? "active" : ""}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "4px 11px",
                          fontSize: "0.75rem",
                          fontWeight: isSelected ? 700 : 500,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <span style={{ opacity: 0.8 }}>#{details.mcpLogs.length - idx}</span>
                        <span style={{ fontWeight: 600 }}>{log.toolName || log.method}</span>
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: log.statusCode >= 200 && log.statusCode < 300 ? "var(--accent-emerald, #10b981)" : "#ef4444",
                          }}
                        />
                        <span style={{ fontSize: "0.72rem", opacity: 0.65 }}>{log.durationMs || 0}ms</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Selected MCP Call Viewer directly in root container */}
              <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "16px 20px" }}>
                {activeMcpLog && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, paddingBottom: 12, borderBottom: "1px solid var(--border-subtle)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span className={`mcp-server-pill ${(activeMcpLog.server || "").toLowerCase().includes("ucp") ? "ucp" : "storefront"}`}>
                          <ZapIcon size={11} />
                          <span>{activeMcpLog.server?.toUpperCase() || "MCP"}</span>
                        </span>
                        <span className="mcp-tool-pill">
                          <WrenchIcon size={12} style={{ color: "var(--accent-cyan)" }} />
                          <span>{activeMcpLog.toolName || activeMcpLog.method}</span>
                        </span>
                        <span className={`mcp-status-pill ${activeMcpLog.statusCode >= 200 && activeMcpLog.statusCode < 300 ? "status-success" : "status-error"}`}>
                          HTTP {activeMcpLog.statusCode}
                        </span>
                        <span className="mcp-duration-pill">
                          <ClockIcon size={11} />
                          <span>{activeMcpLog.durationMs || 0}ms</span>
                        </span>
                        <span style={{ fontSize: "0.75rem", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                          <FormattedDate date={activeMcpLog.createdAt} format="datetime" />
                        </span>
                      </div>
                    </div>

                    <div className="mcp-payload-stack" style={{ display: "flex", flexDirection: "column", gap: 16, width: "100%", minWidth: 0 }}>
                      <JsonViewer
                        raw={activeMcpLog.request}
                        title="Request Payload"
                        maxHeight="380px"
                        defaultUnpack={true}
                      />
                      <JsonViewer
                        raw={activeMcpLog.response}
                        title="Response Payload (Auto-Unpacked)"
                        maxHeight="580px"
                        defaultUnpack={true}
                      />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* 3. LLM LOGS TAB CONTENT - Direct in root container (No nested boxes) */}
      {activeTab === "llm" && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {(!details.llmLogs || details.llmLogs.length === 0) ? (
            <div style={{ textAlign: "center", color: "var(--text-dim)", padding: 40, flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
              No LLM requests logged for this conversation.
            </div>
          ) : (
            <>
              {/* Request Switcher Bar when multiple requests exist */}
              {details.llmLogs.length > 1 && (
                <div
                  className="llm-log-switcher-bar"
                  style={{
                    padding: "8px 16px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    overflowX: "auto",
                    borderBottom: "1px solid var(--border-subtle)",
                    background: "var(--surface-primary)",
                    flexShrink: 0,
                  }}
                >
                  <span style={{ fontSize: "0.74rem", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em", marginRight: 4, whiteSpace: "nowrap" }}>
                    Requests ({details.llmLogs.length}):
                  </span>
                  {details.llmLogs.map((log, idx) => {
                    const isSelected = activeLlmLog?.id === log.id;
                    let logModel = "";
                    let logTurns = 0;
                    try {
                      const p = typeof log.request === "string" ? JSON.parse(log.request) : log.request;
                      logModel = p?.model || "";
                      logTurns = Array.isArray(p?.messages) ? p.messages.length : 0;
                    } catch {}

                    return (
                      <button
                        key={log.id}
                        type="button"
                        onClick={() => setSelectedLlmLogId(log.id)}
                        className={`filter-btn ${isSelected ? "active" : ""}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "4px 11px",
                          fontSize: "0.75rem",
                          fontWeight: isSelected ? 700 : 500,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <span style={{ opacity: 0.8 }}>#{details.llmLogs.length - idx}</span>
                        <span style={{ fontWeight: 600 }}>{logModel || log.provider?.toUpperCase() || "LLM"}</span>
                        {logTurns > 0 && (
                          <span style={{ opacity: 0.75, fontSize: "0.72rem" }}>
                            ({logTurns} turns)
                          </span>
                        )}
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: log.statusCode >= 200 && log.statusCode < 300 ? "var(--accent-emerald, #10b981)" : "#ef4444",
                          }}
                        />
                        <span style={{ fontSize: "0.72rem", opacity: 0.65 }}>
                          <FormattedDate date={log.createdAt} format="time" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Inspector Content directly in root container (Zero nesting) */}
              <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
                {activeLlmLog && <LlmLogInspector log={activeLlmLog} />}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function isToolMessage(msg) {
  if (!msg) return false;
  if (msg.role === "tool" || msg.role === "tool_result") return true;
  if (typeof msg.content === "string") {
    const trimmed = msg.content.trim();
    return (
      trimmed.startsWith('[{"type":"tool_result"') ||
      trimmed.startsWith('{"type":"tool_result"') ||
      trimmed.includes('"type":"tool_result"')
    );
  }
  if (Array.isArray(msg.content)) {
    return msg.content.some((item) => item?.type === "tool_result");
  }
  return false;
}


function formatMessagePreview(msg) {
  if (!msg || (!msg.content && !msg.previewText)) return "";
  const isTool = isToolMessage(msg);
  let prefix = isTool ? "Tool: " : (msg.role === "user" ? "User: " : "Bot: ");
  let text = msg.previewText || msg.content;
  try {
    const parsed = typeof text === "string" ? JSON.parse(text) : text;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const textItem = parsed.find((item) => item?.type === "text" && item?.text);
      if (textItem) {
        text = textItem.text;
      } else if (parsed[0]?.type === "product_results") {
        const count = Array.isArray(parsed[0].products) ? parsed[0].products.length : 0;
        text = count > 0 ? `Shared ${count} recommended products` : "Shared product recommendations";
      } else if (parsed[0]?.type === "tool_result") {
        text = `Output for ${parsed[0].tool_use_id || "tool"}`;
      } else if (parsed[0]?.type === "tool_use") {
        text = `Call: ${parsed[0].name || "tool"}`;
      }
    }
  } catch {}

  // Safety fallback: Never leak raw JSON payloads like [{"type":"product_results"...
  if (typeof text === "string" && (text.includes('"type":"product_results"') || text.startsWith('[{"type":') || text.startsWith('{"type":'))) {
    try {
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const textItem = items.find((item) => item?.type === "text" && item?.text);
      if (textItem) {
        text = textItem.text;
      } else if (items.some((item) => item?.type === "product_results")) {
        const prodItem = items.find((item) => item?.type === "product_results");
        const count = Array.isArray(prodItem?.products) ? prodItem.products.length : 0;
        text = count > 0 ? `Shared ${count} recommended products` : "Shared product recommendations";
      } else {
        text = "Assistant response";
      }
    } catch {
      text = "Shared product recommendations";
    }
  }

  // Clean markdown tags, images, links, newlines for clean single-line preview
  if (typeof text === "string") {
    text = text
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
      .replace(/\[([^\]]+)\]\((?:https?:\/\/[^\s<\]]+|[^)\s]+)?\)?/g, (match, label) => {
        if (/cart|checkout/i.test(match)) {
          return "click here to proceed to checkout";
        }
        return label || "link";
      })
      .replace(/(?:^|\s|<)(https?:\/\/[^\s<>"')]+(?:\/cart|\/checkouts?|\/c\/)[^\s<>"')]*)/gi, " click here to proceed to checkout")
      .replace(/[*_#`~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  return `${prefix}${text}`;
}

export const loader = async ({ request }) => {
  await requireAdminUser(request);

  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const user = url.searchParams.get("user") || "";
  const startDate = url.searchParams.get("startDate") || "";
  const endDate = url.searchParams.get("endDate") || "";
  const selectedId = url.searchParams.get("id") || "";
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const rawLimit = parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = [10, 20, 50, 100].includes(rawLimit) ? rawLimit : 20;

  const [paginated, userFilterOptions] = await Promise.all([
    getConversationsPaginated({ search, user, page, limit, startDate, endDate }),
    getConversationUserFilters({ selectedUser: user }),
  ]);
  const { conversations, total, totalPages } = paginated;

  // If a conversation ID is selected or defaulted to the first one
  const targetId = selectedId || (conversations[0]?.id || null);
  const details = targetId ? await getConversationDetails(targetId) : null;
  const rawTab = url.searchParams.get("tab") || "chat";
  const tab = rawTab === "messages" ? "chat" : rawTab;
  const logId = url.searchParams.get("logId") || "";

  return {
    conversations,
    total,
    page,
    totalPages,
    limit,
    details,
    search,
    user,
    startDate,
    endDate,
    userFilterOptions,
    targetId,
    initialTab: tab,
    initialLogId: logId,
  };
};

function UserFilterSelect({ selectedUser, userFilterOptions, onSelectUser }) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [userList, setUserList] = useState(userFilterOptions?.users || []);
  const [hasMore, setHasMore] = useState(userFilterOptions?.hasMore || false);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const containerRef = useRef(null);
  const searchInputRef = useRef(null);
  const listRef = useRef(null);

  // Sync initial list when loader data changes
  useEffect(() => {
    if (!searchTerm) {
      setUserList(userFilterOptions?.users || []);
      setHasMore(userFilterOptions?.hasMore || false);
      setPage(1);
    }
  }, [userFilterOptions, searchTerm]);

  // Click outside listener
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Auto focus search input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    } else {
      setSearchTerm("");
    }
  }, [isOpen]);

  // Debounced search when searchTerm changes
  useEffect(() => {
    if (!isOpen) return;

    const timer = setTimeout(async () => {
      if (!searchTerm.trim()) {
        setUserList(userFilterOptions?.users || []);
        setHasMore(userFilterOptions?.hasMore || false);
        setPage(1);
        return;
      }

      setIsLoading(true);
      try {
        const res = await fetch(`/admin/conversations/users?search=${encodeURIComponent(searchTerm.trim())}`);
        if (res.ok) {
          const data = await res.json();
          setUserList(data.users || []);
          setHasMore(false);
          setPage(1);
        }
      } catch (err) {
        console.error("Error searching users:", err);
      } finally {
        setIsLoading(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [searchTerm, isOpen, userFilterOptions]);

  // Lazy load more users on scroll / click
  const handleLoadMore = async () => {
    if (isLoadingMore || !hasMore || searchTerm.trim()) return;
    setIsLoadingMore(true);
    const nextPage = page + 1;
    try {
      const res = await fetch(`/admin/conversations/users?page=${nextPage}&limit=25`);
      if (res.ok) {
        const data = await res.json();
        setUserList((prev) => {
          const existingKeys = new Set(prev.map((u) => u.key));
          const newItems = (data.users || []).filter((u) => !existingKeys.has(u.key));
          return [...prev, ...newItems];
        });
        setHasMore(data.hasMore || false);
        setPage(nextPage);
      }
    } catch (err) {
      console.error("Error lazy loading users:", err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Infinite scroll trigger on list container
  const handleScroll = (e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 40 && hasMore && !isLoadingMore && !isLoading && !searchTerm.trim()) {
      handleLoadMore();
    }
  };

  // Find label of currently selected user
  const selectedLabel = useMemo(() => {
    if (!selectedUser) return `All Users (${userFilterOptions?.totalCount || 0})`;
    if (selectedUser === "guest") return `Guest Shoppers (${userFilterOptions?.guestCount || 0})`;
    const found =
      userList.find(
        (u) =>
          u.key === selectedUser ||
          u.shopperId === selectedUser ||
          u.customerId === selectedUser ||
          (selectedUser.startsWith("shopper:") && u.shopperId === selectedUser.replace("shopper:", "")) ||
          (selectedUser.startsWith("customer:") && u.customerId === selectedUser.replace("customer:", ""))
      ) ||
      userFilterOptions?.users?.find(
        (u) =>
          u.key === selectedUser ||
          u.shopperId === selectedUser ||
          u.customerId === selectedUser ||
          (selectedUser.startsWith("shopper:") && u.shopperId === selectedUser.replace("shopper:", "")) ||
          (selectedUser.startsWith("customer:") && u.customerId === selectedUser.replace("customer:", ""))
      );
    if (found) return `${found.label} (${found.count})`;
    if (selectedUser.startsWith("name:")) return selectedUser.replace("name:", "");
    if (selectedUser.startsWith("customer:")) return `Customer #${selectedUser.replace("customer:", "").slice(-6)}`;
    if (selectedUser.startsWith("shopper:") || selectedUser.startsWith("guest:")) {
      const hash = selectedUser.replace(/^(?:shopper|guest):/, "").trim().slice(0, 8);
      return `Guest-${hash}`;
    }
    if (selectedUser.toLowerCase().startsWith("guest-")) {
      return selectedUser;
    }
    return selectedUser;
  }, [selectedUser, userList, userFilterOptions]);

  const handleSelect = (key) => {
    onSelectUser(key);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%", userSelect: "none" }}>
      {/* Trigger Button */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          className="filter-btn"
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "6px 10px",
            fontSize: "0.78rem",
            background: selectedUser ? "var(--pf-brand-soft)" : "var(--bg-surface-elevated)",
            borderColor: selectedUser ? "var(--pf-brand)" : "var(--border-subtle)",
            color: selectedUser ? "var(--accent-cyan)" : "var(--text-main)",
            fontWeight: selectedUser ? 600 : 500,
            cursor: "pointer",
            textAlign: "left",
          }}
          title="Filter conversations by user"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
            <UserIcon size={13} style={{ color: selectedUser ? "var(--accent-cyan)" : "var(--text-dim)", flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {selectedLabel}
            </span>
          </div>
          <ChevronDownIcon
            size={12}
            style={{
              color: "var(--text-dim)",
              flexShrink: 0,
              marginLeft: 4,
              transform: isOpen ? "rotate(180deg)" : "none",
              transition: "transform 0.15s ease",
            }}
          />
        </button>

        {selectedUser && (
          <button
            type="button"
            onClick={() => handleSelect("")}
            className="filter-btn"
            style={{ padding: "5px 8px", fontSize: "0.72rem", flexShrink: 0 }}
            title="Reset user filter"
          >
            Clear
          </button>
        )}
      </div>

      {/* Floating Searchable Popover */}
      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 5px)",
            left: 0,
            right: 0,
            zIndex: 1000,
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md, 10px)",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            maxHeight: "360px",
          }}
        >
          {/* Popover Header with Instant Search Input */}
          <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-surface-elevated)" }}>
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <SearchIcon size={13} style={{ position: "absolute", left: 9, color: "var(--text-dim)", pointerEvents: "none" }} />
              <input
                ref={searchInputRef}
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search 100k+ users (name, ID, email)..."
                style={{
                  width: "100%",
                  padding: "6px 26px 6px 28px",
                  fontSize: "0.76rem",
                  background: "var(--bg-input, #fff)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--radius-sm, 6px)",
                  color: "var(--text-main)",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm("")}
                  style={{
                    position: "absolute",
                    right: 6,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: 2,
                    color: "var(--text-dim)",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <CloseIcon size={12} />
                </button>
              )}
            </div>
          </div>

          {/* Quick Static Option: All Users */}
          {!searchTerm && (
            <div style={{ borderBottom: "1px solid var(--border-subtle)", padding: "4px" }}>
              <div
                onClick={() => handleSelect("")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 10px",
                  borderRadius: "var(--radius-xs, 4px)",
                  cursor: "pointer",
                  fontSize: "0.78rem",
                  background: !selectedUser ? "var(--pf-brand-soft)" : "transparent",
                  color: !selectedUser ? "var(--accent-cyan)" : "var(--text-main)",
                  fontWeight: !selectedUser ? 600 : 400,
                }}
              >
                <span>All Users</span>
                <span className="badge" style={{ fontSize: "0.7rem", padding: "1px 6px" }}>
                  {userFilterOptions?.totalCount || 0}
                </span>
              </div>
            </div>
          )}

          {/* Search Results Header (only shown when searching) */}
          {searchTerm && (
            <div style={{ padding: "6px 12px 2px 12px", fontSize: "0.68rem", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Search Results ({userList.length})
            </div>
          )}

          {/* Scrollable & Lazy-Loaded Users List */}
          <div
            ref={listRef}
            onScroll={handleScroll}
            style={{
              overflowY: "auto",
              flex: 1,
              padding: "4px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {isLoading ? (
              <div style={{ padding: "20px", textAlign: "center", fontSize: "0.76rem", color: "var(--text-dim)" }}>
                Searching users...
              </div>
            ) : userList.length === 0 ? (
              <div style={{ padding: "20px", textAlign: "center", fontSize: "0.76rem", color: "var(--text-dim)" }}>
                {searchTerm ? `No users matching "${searchTerm}"` : "No users found"}
              </div>
            ) : (
              <>
                {userList.map((u) => {
                  const isSelected = selectedUser === u.key;
                  const initials = u.name
                    ? u.name
                        .split(" ")
                        .filter(Boolean)
                        .map((n) => n[0])
                        .slice(0, 2)
                        .join("")
                        .toUpperCase()
                    : u.isGuest
                    ? "G"
                    : (u.label || "U")
                        .split(" ")
                        .filter(Boolean)
                        .map((n) => n[0])
                        .slice(0, 2)
                        .join("")
                        .toUpperCase();

                  const avatarBg = isSelected
                    ? "var(--accent-cyan)"
                    : u.isGuest
                    ? "rgba(245, 158, 11, 0.15)"
                    : "rgba(0, 188, 242, 0.15)";

                  const avatarColor = isSelected
                    ? "#fff"
                    : u.isGuest
                    ? "rgb(245, 158, 11)"
                    : "var(--accent-cyan)";

                  return (
                    <div
                      key={u.key}
                      onClick={() => handleSelect(u.key)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "6px 10px",
                        borderRadius: "var(--radius-xs, 4px)",
                        cursor: "pointer",
                        fontSize: "0.78rem",
                        background: isSelected ? "var(--pf-brand-soft)" : "transparent",
                        color: isSelected ? "var(--accent-cyan)" : "var(--text-main)",
                        fontWeight: isSelected ? 600 : 400,
                        transition: "background 0.12s",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "var(--bg-surface-elevated)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1, overflow: "hidden" }}>
                        <span
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: "50%",
                            background: avatarBg,
                            color: avatarColor,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "0.65rem",
                            fontWeight: 700,
                            flexShrink: 0,
                          }}
                        >
                          {initials}
                        </span>
                        <div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.78rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            <span>{u.label}</span>
                            {u.isGuest && (
                              <span className="badge badge-guest" style={{ fontSize: "0.62rem", padding: "0 4px" }}>
                                Guest
                              </span>
                            )}
                          </div>
                          {u.email && (
                            <div style={{ fontSize: "0.68rem", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {u.email}
                            </div>
                          )}
                        </div>
                      </div>

                      <span
                        className="badge"
                        style={{
                          fontSize: "0.7rem",
                          padding: "1px 6px",
                          flexShrink: 0,
                          marginLeft: 6,
                          background: isSelected ? "rgba(0, 188, 242, 0.2)" : undefined,
                        }}
                      >
                        {u.count}
                      </span>
                    </div>
                  );
                })}

                {/* Lazy Load More Trigger */}
                {hasMore && !searchTerm && (
                  <div style={{ padding: "6px", textAlign: "center" }}>
                    <button
                      type="button"
                      disabled={isLoadingMore}
                      onClick={handleLoadMore}
                      style={{
                        width: "100%",
                        padding: "5px 8px",
                        fontSize: "0.72rem",
                        color: "var(--accent-cyan)",
                        background: "none",
                        border: "1px dashed var(--border-subtle)",
                        borderRadius: "var(--radius-xs, 4px)",
                        cursor: isLoadingMore ? "default" : "pointer",
                      }}
                    >
                      {isLoadingMore ? "Loading more users..." : "Load more users..."}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminConversationsRoute() {
  const {
    conversations,
    total,
    page,
    totalPages,
    limit = 20,
    details,
    search,
    user,
    startDate = "",
    endDate = "",
    userFilterOptions,
    targetId,
    initialTab,
    initialLogId,
  } = useLoaderData();
  const { devMode } = useDevMode();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTabState, setActiveTabState] = useState(initialTab || "chat");
  const [expandedLogId, setExpandedLogId] = useState(initialLogId || null);

  const hasActiveFilters = Boolean(search || user || startDate || endDate);

  const rawTab = searchParams.get("tab") || activeTabState;
  const tabFromUrlOrState = rawTab === "messages" ? "chat" : rawTab;
  // If devMode is OFF, enforce activeTab is always "chat" so dev tabs (MCP, LLM) never stay open
  const activeTab = !devMode && (tabFromUrlOrState === "mcp" || tabFromUrlOrState === "llm")
    ? "chat"
    : tabFromUrlOrState;

  // When Dev Mode is turned OFF while on a developer tab (MCP or LLM), automatically reset tab in URL and state back to chat
  useEffect(() => {
    if (!devMode) {
      const currentUrlTab = searchParams.get("tab");
      if (currentUrlTab === "mcp" || currentUrlTab === "llm" || activeTabState !== "chat") {
        setActiveTabState("chat");
        if (currentUrlTab === "mcp" || currentUrlTab === "llm") {
          const params = new URLSearchParams(searchParams);
          params.delete("tab");
          setSearchParams(params, { preventScrollReset: true });
        }
      }
    }
  }, [devMode, searchParams, activeTabState, setSearchParams]);

  const setActiveTab = (newTab) => {
    setActiveTabState(newTab);
    const params = new URLSearchParams(searchParams);
    params.set("tab", newTab);
    setSearchParams(params, { preventScrollReset: true });
  };

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

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", gap: 12, height: "calc(100vh - 32px)", minHeight: "560px", alignItems: "stretch" }}>
        {/* Left Column: Conversation Directory */}
        <div className="glass-panel" style={{ height: "100%", display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}>
          <div className="panel-header" style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            <Form method="get" style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
              {/* Row 1: Search Input */}
              <div style={{ position: "relative", display: "flex", alignItems: "center", width: "100%" }}>
                <input
                  type="text"
                  name="search"
                  defaultValue={search}
                  placeholder="Search conversations, text..."
                  className="search-input"
                  style={{ width: "100%", minWidth: "unset", paddingLeft: "30px" }}
                />
                <span style={{ position: "absolute", left: "9px", display: "flex", alignItems: "center", pointerEvents: "none", color: "var(--text-dim)" }}>
                  <SearchIcon size={13} />
                </span>
              </div>

              {/* Row 2: Searchable User Filter */}
              <input type="hidden" name="user" value={user} id="conv-user-filter-val" />
              <UserFilterSelect
                selectedUser={user}
                userFilterOptions={userFilterOptions}
                onSelectUser={(val) => {
                  const input = document.getElementById("conv-user-filter-val");
                  if (input) input.value = val || "";
                  const params = new URLSearchParams(searchParams);
                  if (val) {
                    params.set("user", val);
                  } else {
                    params.delete("user");
                  }
                  params.delete("page");
                  params.delete("id");
                  setSearchParams(params);
                }}
              />

              {/* Row 3: From -> To Date Range Filter */}
              <DateRangeFilter startDate={startDate} endDate={endDate} compact={true} />

              {/* Row 4: Action Buttons */}
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button
                  type="submit"
                  className="admin-btn admin-btn-primary"
                  style={{ flex: 1, height: 32, fontSize: "0.78rem" }}
                >
                  Filter
                </button>
                <Link
                  to="/admin/conversations"
                  className={`filter-clear-btn ${hasActiveFilters ? "active" : ""}`}
                  style={{ height: 32, fontSize: "0.78rem", padding: "0 10px" }}
                  title="Reset all filters"
                >
                  <CloseIcon size={11} />
                  <span>Clear</span>
                </Link>
              </div>
            </Form>
          </div>

          <div style={{ overflowY: "auto", flex: 1 }}>
            {conversations.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: "0.85rem" }}>
                No conversations found
              </div>
            ) : (
              conversations.map((c) => {
                const isSelected = c.id === targetId;
                const displayText = c.firstMessage || "New Conversation";
                return (
                  <Link
                    key={c.id}
                    to={`/admin/conversations?id=${c.id}${search ? `&search=${encodeURIComponent(search)}` : ""}${user ? `&user=${encodeURIComponent(user)}` : ""}${startDate ? `&startDate=${encodeURIComponent(startDate)}` : ""}${endDate ? `&endDate=${encodeURIComponent(endDate)}` : ""}`}
                    style={{
                      display: "block",
                      padding: "12px 14px",
                      borderBottom: "1px solid var(--border-subtle)",
                      background: isSelected ? "rgba(6, 182, 212, 0.12)" : "transparent",
                      borderLeft: isSelected ? "3px solid var(--accent-cyan)" : "3px solid transparent",
                      textDecoration: "none",
                      transition: "background 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                      <div
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: "0.84rem",
                          fontWeight: isSelected ? 600 : 500,
                          color: isSelected ? "var(--accent-cyan)" : "var(--text-main)",
                          lineHeight: "1.35",
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                          wordBreak: "break-word",
                        }}
                        title={displayText}
                      >
                        {displayText}
                      </div>
                      <span style={{ fontSize: "0.74rem", color: "var(--text-dim)", flexShrink: 0, whiteSpace: "nowrap", paddingTop: 1 }}>
                        <FormattedDate date={c.updatedAt} format="whatsapp" />
                      </span>
                    </div>
                  </Link>
                );
              })
            )}
          </div>

          {/* Conversations Pagination Footer */}
          {total > 0 && (
            <AdminPagination
              page={page}
              totalPages={totalPages}
              total={total}
              limit={limit}
              compact={true}
              onPageChange={handlePageChange}
              onLimitChange={handleLimitChange}
              style={{ padding: "8px 12px", borderTop: "1px solid var(--border-subtle)" }}
            />
          )}
        </div>

        {/* Right Column: Selected Conversation Deep Dive */}
        <div className="glass-panel" style={{ height: "100%", display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}>
          {!details ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: "var(--text-dim)", padding: 24 }}>
              Select a conversation to view messages and logs
            </div>
          ) : (
            <StorefrontChatView
              details={details}
              devMode={devMode}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              expandedLogId={expandedLogId}
              setExpandedLogId={setExpandedLogId}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function BeautifiedJsonView({ raw, title }) {
  return (
    <JsonViewer
      raw={raw}
      title={title}
      maxHeight="420px"
      defaultUnpack={true}
    />
  );
}
