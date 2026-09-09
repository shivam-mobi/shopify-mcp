# AIRA AI Chatbot — System Documentation

Complete reference for the **PUREFLOW AIRA** shop chat agent (`shop-chat-agent` / Shopify handle `pureflowair-chatbot`). This document covers architecture, database, Shopify Admin API, MCP, tools, chat flow, admin UI, and environment configuration as implemented in this codebase.

---

## 1. Overview

AIRA is an AI shopping assistant embedded on the Shopify storefront via a **theme app extension** (`chat-bubble`). Shoppers can:

- Find **vehicle cabin filters** by VIN or year/make/model (fitment MySQL)
- Search **home furnace filters** and **fresheners**
- Ask **store policies / FAQs**
- Manage **cart, shipping, discounts**, and get a **checkout link**
- Use **saved addresses** when logged in
- Optionally use **Customer Account MCP** for order/status tools (when authenticated)

Based on Shopify’s storefront MCP / shop-chat-agent template, customized for PUREFLOW (fitment DB, catalog wrappers, cart wrappers, policy digest, AIRA UTM attribution).

### Tech stack

| Layer | Choice | Key paths |
|--------|--------|-----------|
| App framework | React Router 7 | `package.json`, `app/routes.js` |
| Shopify app | `@shopify/shopify-app-react-router`, App Bridge | `app/shopify.server.js`, `app/routes/app.jsx` |
| App DB | Prisma + SQLite (`file:dev.sqlite`) | `prisma/schema.prisma`, `app/db.server.js` |
| Fitment data | MySQL (3 pools) when `FITMENT_ENABLED=true` | `app/fitment/` |
| LLM | Gemini (default), Claude, or OpenAI | `app/services/llm.server.js` |
| Storefront protocol | Shopify MCP (JSON-RPC) + UCP cart/checkout | `app/mcp-client.js` |
| Chat UI | Theme app extension | `extensions/chat-bubble/` |
| Streaming | Server-Sent Events (SSE) | `app/services/streaming.server.js`, `app/routes/chat.jsx` |

Assistant brand name in UI/prompts: **AIRA**.

---

## 2. High-level architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Storefront (Liquid theme)                                       │
│  extensions/chat-bubble/  →  chat.js / chat.css / chat-interface │
└───────────────────────────────┬─────────────────────────────────┘
                                │ SSE POST /chat
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  App server (React Router)                                       │
│  chat.jsx → LLM loop → local tools + MCPClient                   │
│  Prisma (conversations, logs) · Fitment MySQL · Admin GraphQL    │
└───────┬─────────────────┬──────────────────┬────────────────────┘
        │                 │                  │
        ▼                 ▼                  ▼
 Storefront MCP      UCP MCP            Customer MCP
 /api/mcp            /api/ucp/mcp       …/customer/api/mcp
 (catalog/policies)  (cart/checkout)    (orders; auth required)
        │
        ▼
 Admin GraphQL (home filters, variant enrichment)
```

---

## 3. Database (Prisma / SQLite)

Source: `prisma/schema.prisma`

| Model | Purpose | Key fields |
|--------|---------|------------|
| **Session** | Shopify OAuth sessions (Prisma session storage) | `shop`, `accessToken`, `scope`, online user fields |
| **CustomerToken** | Customer Account API tokens per chat | `conversationId`, `accessToken`, `refreshToken?`, `expiresAt` |
| **CodeVerifier** | PKCE for customer OAuth | `state`, `verifier`, `expiresAt` |
| **Conversation** | Chat session + cart/checkout state | `activeCartId`, `activeCheckoutId`, `checkoutUrl`, `shippingAddress` (JSON), customer name/login/`shopifyCustomerId`, `shopDomain` → many `Message` |
| **Message** | Chat turns | `role` (`user` / `assistant`), `content` (text or JSON for tool/product payloads) |
| **CustomerAccountUrls** | Discovered Customer Account MCP/auth URLs | `mcpApiUrl`, `authorizationUrl`, `tokenUrl` |
| **LlmRequestLog** | Full LLM request/response audit | `conversationId?`, `request`, `response`, `statusCode`, `provider` |
| **McpCallLog** | MCP / Admin GraphQL audit | `server` (`storefront` \| `ucp` \| `customer` \| `admin`), `method`, `toolName?`, `endpoint`, payloads, `durationMs` |
| **StorePolicyDigest** | Local policy cheat sheet | singleton `id="default"`, `digest`, `contentDate` |
| **ToolEmptyResultLog** | Empty/error tool observability | `toolName`, `userQuery`, `reason` (`empty` \| `error` \| `no_results`) |
| **StoreCustomer** | Liquid-synced logged-in customer | unique `(shopifyCustomerId, shopDomain)` |
| **StoreCustomerAddress** | Saved shipping addresses | street/city/region/postal/phone, `isDefault` |

Helpers live in `app/db.server.js` (`storeLlmRequestLog`, `storeMcpCallLog`, conversation/message CRUD, customer tokens, etc.).

### Fitment MySQL (separate from Prisma)

When `FITMENT_ENABLED=true`, fitment tools use three MySQL connection pools (`DB_HOST_1|2|3`, etc.):

- VCDB / vehicle catalog
- Shopify product sync
- Master / fitment mapping data

See `app/fitment/` (tools, VIN lookup, DB pools).

---

## 4. Chat API & routes

### Primary: `GET` / `POST` `/chat` — `app/routes/chat.jsx`

| Request | Behavior |
|---------|----------|
| `POST /chat` with message | Chat turn → **SSE** stream |
| `GET /chat?config=true` | Public config: `conversationStorage`, `showToolCallsInChat` |
| `GET /chat?history=true&conversation_id=` | JSON message history (optional `customer_id` ownership check) |
| `OPTIONS` | CORS preflight |

**Typical body:** `message`, `conversation_id?`, `prompt_type?`, `init?` (welcome), customer fields (`customer_id`, `customer_logged_in`, names), shop context.

**Turn flow:**

1. Parse body → create SSE (`createSseStream`).
2. Welcome (`init: true`): sync customer context → LLM with **no tools** → save welcome message.
3. Normal turn: warm MCP → connect UCP + storefront + customer MCP → assemble tool list → save user message → load history → inject hint/context messages → **LLM loop** until `end_turn` (or stop after tool error).
4. On each `tool_use`: route to local wrappers or `mcpClient.callTool` → push `tool_result` → optional UI SSE events.
5. After cart mutations: `appendFinalCartSnapshot`.
6. End turn: emit `fitment_options` / `customer_addresses` / `install_resources` / `product_results` as needed.

**SSE event types:**  
`id`, `chunk`, `message_complete`, `end_turn`, `welcome_skipped`, `tool_use`, `tool_error`, `auth_required`, `new_message`, `content_block_complete`, `fitment_options`, `customer_addresses`, `install_resources`, `product_results`.

### Related routes

| Path | File | Role |
|------|------|------|
| `/chat/sessions` | `app/routes/chat.sessions.jsx` | List/claim conversations for logged-in customer |
| `/chat/customer-addresses` | `app/routes/chat.customer-addresses.jsx` | Sync/list Liquid → DB addresses |
| `/auth/callback` | `app/routes/auth.callback.jsx` | Customer Account OAuth code → token |
| `/auth/*`, `/auth/login` | `app/routes/auth.$.jsx`, `auth.login.jsx` | Shopify app auth / login |
| `/auth/token-status` | `app/routes/auth.token-status.jsx` | Token status helper |
| `/api/webhooks` | `app/routes/api.webhooks.jsx` | `APP_UNINSTALLED` → delete sessions |
| `/events/products` | `app/routes/events.products.jsx` | Events ack (no-op) |
| `/app`, `/app` index | `app/routes/app.jsx`, `app._index.jsx` | Embedded admin shell + home |

Streaming utility: `app/services/streaming.server.js`.

---

## 5. LLM layer

| Piece | Path |
|--------|------|
| Factory | `app/services/llm.server.js` — `createLlmService()` via `LLM_PROVIDER` |
| Config | `app/services/config.server.js` |
| Gemini | `app/services/gemini.server.js` (`@google/genai`) — tool calls use non-streaming `generateContent`; text-only can stream |
| Claude | `app/services/claude.server.js` |
| OpenAI | `app/services/openai.server.js` |
| Prompts | `app/services/prompts.server.js` → `app/prompts/prompts.json` |
| Prompt types | `standardAssistant` (default), `enthusiasticAssistant` |

Every provider logs via `storeLlmRequestLog` → `LlmRequestLog`.

**Tool-calling loop:** LLM returns `stop_reason: "tool_use"` with `{ type: "tool_use", id, name, input }` blocks; `chat.jsx` executes tools and continues until `end_turn`.

Default models (overridable by env):

- Gemini: `gemini-3.6-flash`
- Claude: `claude-sonnet-4-20250514`
- OpenAI: `gpt-4o`

---

## 6. Tools & function calling

Tools come from two sources:

1. **Shopify MCP** — discovered at runtime via `tools/list`
2. **Local wrappers** — registered in app code and merged into the LLM tool list

Routing is in `app/routes/chat.jsx` (`onToolUse`). Result formatting / product cards: `app/services/tool.server.js`. Empty-result logging: `app/services/tool-empty-log.server.js`.

### 6.1 App-defined tools (exposed to the LLM)

#### Cart wrappers — `app/services/cart-tools.server.js`

Low-level merge logic: `app/services/cart.server.js`.  
Checkout UTMs: `app/services/aira-attribution.server.js` (`utm_source=aira`, `utm_medium=chat`, `utm_campaign=chatbot_checkout`).

| Tool | Purpose | Underlying APIs |
|------|---------|-----------------|
| `add_to_cart` | Add variant; merge into conversation cart | UCP MCP `create_cart` / `update_cart` |
| `remove_from_cart` | Reduce qty or remove a line | UCP `get_cart` + `update_cart` |
| `get_my_cart` | Cart summary + checkout link | UCP cart + `create_checkout` / `update_checkout` / `get_checkout` |
| `set_cart_shipping` | Set/update shipping on checkout | UCP checkout; persists address on `Conversation` |
| `remove_cart_shipping` | Clear shipping; keep cart | UCP `update_checkout` |
| `clear_my_cart` | Empty cart | UCP cancel/update + DB clear |
| `apply_discount_code` | Apply/clear promo on checkout | UCP `create_checkout` / `update_checkout` |

**Raw UCP tools hidden from the LLM** (still used server-side by wrappers) via `filterCartToolsForLlm`:

`create_cart`, `get_cart`, `update_cart`, `cancel_cart`, `create_checkout`, `get_checkout`, `update_checkout`, `complete_checkout`, `cancel_checkout`

#### Catalog — `app/services/catalog-search.server.js`

| Tool | Purpose | APIs |
|------|---------|------|
| `search_store_products` | Home filters or fresheners | `home_filter` → **Admin GraphQL** (`shopify-products.server.js`); `freshener` → MCP `search_catalog` |

Raw MCP catalog tools **hidden from LLM**: `search_catalog`, `search_shop_catalog`.

#### Fitment — `app/fitment/fitment-tools.server.js`

**Exposed to LLM:** only `get_fitment_next_step`.

**Internal (callable by code, not listed to LLM):**  
`lookup_fitment_years`, `lookup_fitment_makes`, `lookup_fitment_models`, `lookup_fitment_engines`, `get_fitment_qualifier`, `find_fitment_products`.

| Tool | Purpose | Data / APIs |
|------|---------|-------------|
| `get_fitment_next_step` | VIN or year/make/model → engines/qualifiers → products with `variantId` | MySQL VCDB/master/Shopify sync; optional VIN API (`app/fitment/vin.server.js`); product enrichment via Admin GraphQL |

#### Policies — `app/services/store-policies.server.js`

| Tool | Purpose | Source |
|------|---------|--------|
| `search_store_policies` | Local digest fallback | `StorePolicyDigest` / defaults in `db.server.js` |
| `search_shop_policies_and_faqs` | Shopify policy/FAQ (MCP; still available to LLM) | Storefront MCP; empty → auto-fallback to local |

#### Addresses — `app/services/customer-addresses.server.js`

| Tool | Purpose | Source |
|------|---------|--------|
| `get_customer_addresses` | Saved addresses (logged-in only) | Prisma `StoreCustomerAddress` (synced from Liquid) |

### 6.2 Quick reference — all app-defined LLM tool names

```
add_to_cart
remove_from_cart
get_my_cart
set_cart_shipping
remove_cart_shipping
clear_my_cart
apply_discount_code
search_store_products
get_fitment_next_step
search_store_policies
get_customer_addresses
```

### 6.3 Shopify MCP tools (runtime discovery)

Discovered by `MCPClient` (`app/mcp-client.js`). Exact set is **shop-dependent**. Referenced / known names:

| Area | Tool names |
|------|------------|
| Catalog (filtered from LLM) | `search_catalog`, `search_shop_catalog` |
| Policies | `search_shop_policies_and_faqs` |
| Cart/checkout (filtered; used by wrappers) | `create_cart`, `get_cart`, `update_cart`, `cancel_cart`, `create_checkout`, `get_checkout`, `update_checkout`, `complete_checkout`, `cancel_checkout` |
| Product detail (prompt-referenced) | `lookup_catalog`, `get_product`, `get_product_details` |
| Customer Account (auth) | `get_most_recent_order_status`, `get_order_status`, `get_order`, `get_store_credit_balances`, `request_return` |

### 6.4 Intent hints & helpers

Injected as system/context messages before the LLM call:

| Service | Role |
|---------|------|
| `store-help-hints.server.js` | Steer FAQ/shipping questions toward policy tools |
| `catalog-search-hints.server.js` | Steer home/freshener queries to `search_store_products` |
| `install-media.server.js` | Prefer product PDF / YouTube for install questions |
| `customer-context.server.js` | Welcome, greeting, customer-name sync |
| `product-compare.server.js` | Compare attrs, scoring, best-pick metadata for product cards |

Product-search tool name allowlist (config): `search_catalog`, `search_shop_catalog`, `search_store_products`, `find_fitment_products`, `get_fitment_next_step`.

---

## 7. MCP (Model Context Protocol)

The app is an MCP **client** of Shopify’s endpoints. There is **no** in-repo MCP server for the chatbot runtime.

### Runtime client — `app/mcp-client.js`

| Server | Endpoint pattern | Auth |
|--------|------------------|------|
| **Storefront** | `{storefront}/api/mcp` | Optional Catalog Bearer + `Shopify-Buyer-IP` |
| **UCP** | `{storefront}/api/ucp/mcp` | Same + UCP agent profile meta |
| **Customer** | `{shop}.account…/customer/api/mcp` or discovered `mcp_api` | Customer access token; 401 → SSE `auth_required` |

Protocol: JSON-RPC `tools/list` and `tools/call`.

**Features:**

- In-memory `tools/list` cache (until process restart); toggle with `MCP_TOOLS_LIST_CACHE`
- Call logging → `McpCallLog` (`MCP_LOG_ENABLED`)
- Startup warmup from `STOREFRONT_URL` (`MCP_WARMUP_ON_START`, `MCP_WARMUP_FAIL_HARD`, `MCP_WARMUP_REQUIRE_CUSTOMER`)
- Catalog Token tier: `CATALOG_CLIENT_ID` / `CATALOG_CLIENT_SECRET` → `https://api.shopify.com/auth/access_token` (`catalog-auth.server.js`)
- UCP agent profile URL: `UCP_AGENT_PROFILE` (default Shopify example profile in config)

### Dev-only Cursor MCP (not storefront chat)

`.mcp.json` configures `@shopify/dev-mcp` for Polaris/Liquid docs during development. This is **not** used by the live chatbot.

---

## 8. Shopify integration

### Admin API (GraphQL)

- File: `app/services/shopify-products.server.js`
- Operations: product search (home filters), variants by IDs (enrichment)
- Auth: `SHOPIFY_ADMIN_ACCESS_TOKEN` / `SHOPIFY_ACCESS_TOKEN`, else Partner offline session (`unauthenticated.admin`)
- Logged as `McpCallLog` with `server: "admin"`, `method: "graphql"`

**App scopes** (`shopify.app.toml`):

```
read_products, read_discounts, unauthenticated_read_product_listings
```

### Storefront / UCP MCP

See §7. Used for catalog search (fresheners), policies, and all cart/checkout.

### Customer Account API

- Well-known discovery: `/.well-known/customer-account-api`
- OAuth PKCE: `app/auth.server.js` → `/auth/callback`
- Scope: `customer-account-mcp-api:full`
- Tokens stored in `CustomerToken`; URLs in `CustomerAccountUrls`

### App OAuth / sessions

- `app/shopify.server.js` — PrismaSessionStorage, October 2025 API version, `authPathPrefix: /auth`
- Embedded admin app: `pureflowair-chatbot`

### Webhooks

- `APP_UNINSTALLED` → delete `Session` rows (`api.webhooks.jsx`)

### Theme extension — `extensions/chat-bubble/`

| File | Role |
|------|------|
| `shopify.extension.toml` | Theme extension type |
| `blocks/chat-interface.liquid` | Bubble UI, brand color, assistant name (AIRA) |
| `assets/chat.js` | SSE to `/chat`, history, sessions, address sync |
| `assets/chat.css` | Styles |
| `locales/en.default.json` | Strings |

---

## 9. Admin / merchant UI

Minimal embedded admin:

- Shell: `app/routes/app.jsx` — nav “Home”
- Home: `app/routes/app._index.jsx` — reference copy; merchants enable the theme extension
- Public landing: `app/routes/_index/route.jsx`

There is **no** in-app merchant conversation browser, prompt editor, or LLM dashboard. Observability is via SQLite tables: `LlmRequestLog`, `McpCallLog`, `ToolEmptyResultLog`.

---

## 10. Services reference (`app/services/`)

| File | Purpose |
|------|---------|
| `aira-attribution.server.js` | Append AIRA UTM params to checkout URLs |
| `app-url.server.js` | Resolve `APP_URL` / OAuth redirect URL |
| `cart-tools.server.js` | LLM-facing cart/checkout wrapper tools |
| `cart.server.js` | Per-conversation cart merge, UCP helpers, checkout URL extraction |
| `catalog-auth.server.js` | Catalog API client credentials → Bearer token cache |
| `catalog-search-hints.server.js` | Hint LLM toward `search_store_products` |
| `catalog-search.server.js` | `search_store_products` (Admin vs MCP) |
| `claude.server.js` | Anthropic provider |
| `config.server.js` | Central `AppConfig` |
| `customer-addresses.server.js` | `get_customer_addresses` + SSE UI payload |
| `customer-context.server.js` | Welcome / greeting / profile sync |
| `gemini.server.js` | Google Gemini provider |
| `install-media.server.js` | Prefer PDF/YouTube for install questions |
| `llm.server.js` | Provider factory |
| `openai.server.js` | OpenAI provider |
| `product-compare.server.js` | Compare / best-pick for product cards |
| `prompts.server.js` | Load system prompt by `promptType` |
| `shopify-products.server.js` | Admin GraphQL products/variants |
| `store-help-hints.server.js` | Force policy-tool use for help questions |
| `store-policies.server.js` | Local policy tool + Shopify empty fallback |
| `streaming.server.js` | SSE stream manager |
| `tool-empty-log.server.js` | Persist empty/failed tool results |
| `tool.server.js` | Tool success/error handling, product card extraction |

**Also important outside `services/`:**  
`app/mcp-client.js`, `app/db.server.js`, `app/auth.server.js`, `app/fitment/*`, `app/shopify.server.js`.

Related deep-dive: [`fitment-and-catalog-flow.md`](./fitment-and-catalog-flow.md).

---

## 11. Conversation → cart → checkout (end-to-end)

```mermaid
sequenceDiagram
  participant UI as chat-bubble
  participant Chat as /chat SSE
  participant LLM as Gemini/Claude/OpenAI
  participant Local as Local tools
  participant MCP as Shopify UCP MCP
  participant DB as Prisma Conversation

  UI->>Chat: POST message + conversation_id + customer context
  Chat->>DB: save user message; load history; activeCartId
  Chat->>MCP: tools/list (cached)
  Chat->>LLM: system prompt + tools + history + hints
  LLM->>Chat: tool_use (fitment / search_store_products / …)
  Chat->>Local: execute; enrich products
  Chat->>UI: product_results / fitment_options SSE
  LLM->>Chat: add_to_cart(variant_id)
  Chat->>MCP: create_cart or update_cart
  Chat->>DB: set activeCartId
  Chat->>LLM: tool_result + FINAL CART SNAPSHOT
  LLM->>Chat: set_cart_shipping(...)
  Chat->>MCP: create_checkout / update_checkout
  Chat->>DB: shippingAddress, activeCheckoutId, checkoutUrl (+ AIRA UTMs)
  LLM->>Chat: get_my_cart
  Chat->>UI: assistant text with markdown checkout link
  UI->>Customer: open checkout_url on Shopify
```

**Persistence:** One Shopify cart (`activeCartId`) and checkout (`activeCheckoutId` / `checkoutUrl`) per `Conversation`. Shipping JSON stored for reuse. Logged-in customers can claim sessions via `/chat/sessions` and sync addresses via Liquid → `/chat/customer-addresses`.

### Product discovery paths

1. **Vehicle cabin filters** → `get_fitment_next_step` (MySQL) → Admin enrich variants  
2. **Home furnace filters** → `search_store_products` `home_filter` → Admin GraphQL  
3. **Fresheners** → `search_store_products` `freshener` → MCP `search_catalog`  
4. **Policies** → `search_shop_policies_and_faqs` → fallback `search_store_policies`

---

## 12. Environment variables (names only)

### AI / LLM

`LLM_PROVIDER`, `LLM_MAX_TOKENS`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `CLAUDE_API_KEY`, `CLAUDE_MODEL`, `OPENAI_API_KEY`, `OPENAI_MODEL`

### Shopify app

`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `APP_URL`, `REDIRECT_URL`, `SCOPES`, `SHOP_CUSTOM_DOMAIN`

### Shopify store / Admin

`SHOPIFY_STORE_DOMAIN`, `SHOPIFY_SHOP`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_API_VERSION`, `STOREFRONT_URL`, `SHOPIFY_STOREFRONT_URL`

### MCP / Catalog

`CATALOG_CLIENT_ID`, `CATALOG_CLIENT_SECRET`, `CATALOG_BUYER_IP_FALLBACK`, `UCP_AGENT_PROFILE`, `MCP_LOG_ENABLED`, `MCP_TOOLS_LIST_CACHE`, `MCP_WARMUP_ON_START`, `MCP_WARMUP_FAIL_HARD`, `MCP_WARMUP_REQUIRE_CUSTOMER`

### Chat UX

`CHAT_CONVERSATION_STORAGE` (`localStorage` \| `sessionStorage`), `CHAT_SHOW_TOOL_CALLS`

### Fitment / VIN

`FITMENT_ENABLED`, `DB_HOST_1|2|3`, `DB_PORT_*`, `DB_DATABASE_*`, `DB_USERNAME_*`, `DB_PASSWORD_*`, `VIN_API_URL`, `VIN_API_USERNAME`, `VIN_API_PASSWORD`

---

## 13. Key file map

```
app/
  routes/
    chat.jsx                    # Main SSE chat + tool loop
    chat.sessions.jsx           # Cross-device session claim
    chat.customer-addresses.jsx # Address sync API
    auth.*.jsx / auth.callback  # App + Customer Account auth
    api.webhooks.jsx            # APP_UNINSTALLED
    app.jsx / app._index.jsx    # Embedded admin
  services/                     # LLM, cart, catalog, policies, streaming…
  fitment/                      # Fitment tools + MySQL + VIN
  mcp-client.js                 # Storefront / UCP / Customer MCP
  db.server.js                  # Prisma helpers + logs
  auth.server.js                # Customer OAuth PKCE
  shopify.server.js             # Shopify app bootstrap
  prompts/prompts.json          # System prompts (AIRA)
extensions/chat-bubble/         # Storefront chat UI
prisma/schema.prisma            # App DB models
docs/
  ai-chatbot-system.md          # This document
  fitment-and-catalog-flow.md   # Fitment/catalog detail
.mcp.json                       # Cursor Shopify dev MCP (docs only)
shopify.app.toml                # App handle, scopes, auth URLs
```

---

## 14. Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Sync app URL + `shopify app dev` |
| `npm run setup` | `prisma generate` + `migrate deploy` |
| `npm run build` / `start` | Production build / serve |
| `npm run deploy` | Deploy app + extensions to Shopify |

---

*Generated from the current codebase. When tools, schema, or MCP wiring change, update this doc alongside the code.*
