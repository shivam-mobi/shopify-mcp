# How AIRA Works — A Plain-Language Guide

This is a friendly, detailed walkthrough of our PUREFLOW shopping chatbot (**AIRA**).  
If you want the short technical reference (tables, file paths, env names), see [`ai-chatbot-system.md`](./ai-chatbot-system.md). This document is meant to answer: *what is this thing, how does a chat actually happen, and what is each piece for?*

---

## What is AIRA?

AIRA is the chat bubble on the Shopify storefront. A shopper can talk to it like a store associate:

- “I need a cabin filter for my 2019 Honda Civic”
- “Do you ship to Canada?”
- “Add that to my cart and check out”

Behind that bubble is our Shopify app (`pureflowair-chatbot`). The UI lives in a **theme extension** (`chat-bubble`). The brain lives on our server. Shopify provides catalog, cart, checkout, and (when logged in) customer account features through something called **MCP**.

Think of it like this:

| Layer | Everyday meaning |
|--------|------------------|
| Chat bubble | The face the customer sees |
| Our server (`/chat`) | The brain that talks to the AI and runs tools |
| AI model (Gemini / Claude / OpenAI) | The language skills — decides what to say and which tools to call |
| Tools | Hands — search products, update cart, look up policies |
| Shopify MCP / Admin API | The store’s inventory and checkout systems |
| Our database | Memory — past messages, cart IDs, tokens, logs |

---

## The big picture (one shopping chat)

1. Shopper opens the bubble → we may send a welcome message.
2. Shopper types a question → browser sends it to our app with **one HTTP POST**.
3. That same connection stays open while we **stream** the reply back (text appears live).
4. If the AI needs data (products, cart, policies), it asks our server to run a **tool**.
5. The tool talks to Shopify (or our fitment MySQL), gets an answer, and the AI continues.
6. When done, we close that connection. The next message starts a **new** POST.

We do **not** use WebSockets. We use normal HTTP plus **SSE** (Server-Sent Events) for streaming.

---

## How streaming works (simple)

When someone asks “how do messages move?” the answer is:

**One message = one HTTP request/response.**  
The shopper’s text goes up in the POST body. The assistant’s reply comes back on **that same response**, piece by piece (`chunk`, then maybe `product_results`, then `end_turn`). When the turn is finished, the connection closes.

Next message → new POST → new stream. Nothing stays permanently open between turns.

Why stream at all? So the UI can show words as they arrive instead of waiting for the full answer (and for tool calls) in silence.

Related endpoints that are normal JSON (not streams): chat history, session list, config, address sync.

---

## What happens on a normal chat turn (step by step)

File that orchestrates this: `app/routes/chat.jsx`.

1. **Receive the message** — conversation id, customer info (logged in or not), the text.
2. **Save the user message** in the database so history survives refresh.
3. **Load conversation history** so the AI knows what was already said.
4. **Connect to Shopify MCP** (storefront + UCP cart + customer if possible) and build the tool list the AI is allowed to see.
5. **Add hints** — small system notes that nudge the AI (“this sounds like a policy question → use the policy tool”).
6. **Call the LLM** with the system prompt (AIRA’s personality + rules), history, and tools.
7. **Tool loop** — if the AI says “call `add_to_cart`…”, we run it, feed the result back, and call the LLM again until it decides to stop (`end_turn`).
8. **Push UI events** — product cards, fitment year/make/model options, address pickers, etc.
9. **Save the assistant message** and close the stream.

Welcome (`init: true`) is a lighter version: greet the customer, usually **without** tools.

---

## The AI brain

We support three providers (pick one with `LLM_PROVIDER`):

- **Gemini** (default)
- **Claude**
- **OpenAI**

The system prompt lives in `app/prompts/prompts.json` and tells AIRA how to behave, which tools to prefer, and how to talk about products and checkout.

Every request/response can be saved in **`LlmRequestLog`** so we can debug “what did the model see?” later.

Important idea: the AI does **not** talk to Shopify directly. It only asks for **tools**. Our server decides how each tool actually runs.

---

## Tools — the AI’s hands

Tools come from two places:

1. **Our wrappers** — friendly names we designed (`add_to_cart`, `get_fitment_next_step`, …)
2. **Shopify MCP tools** — discovered live from the shop (`tools/list`)

We intentionally **hide** some raw Shopify tools from the AI (especially low-level cart tools) and replace them with safer wrappers that:

- keep one cart per conversation
- merge line items correctly
- attach AIRA tracking to checkout links (`utm_source=aira`, etc.)

### Tools we expose to the AI (main ones)

**Cart & checkout**

| Tool | In plain words |
|------|----------------|
| `add_to_cart` | Put this variant in the cart |
| `remove_from_cart` | Take something out or reduce qty |
| `get_my_cart` | Show what’s in the cart + checkout link |
| `set_cart_shipping` | Save shipping address for checkout |
| `remove_cart_shipping` | Clear shipping, keep the cart |
| `clear_my_cart` | Empty everything |
| `apply_discount_code` | Apply or clear a promo code |

Under the hood these call Shopify **UCP MCP** cart/checkout tools.

**Finding products**

| Tool | In plain words |
|------|----------------|
| `get_fitment_next_step` | Vehicle cabin filters — VIN or year/make/model wizard |
| `search_store_products` | Home filters (Admin API) or fresheners (catalog MCP) |

**Help & account**

| Tool | In plain words |
|------|----------------|
| `search_shop_policies_and_faqs` | Ask Shopify for policies/FAQs |
| `search_store_policies` | Our local policy cheat sheet if Shopify returns nothing useful |
| `get_customer_addresses` | Saved addresses for a logged-in shopper |

If Customer Account login succeeded, Shopify may also offer order-status style tools through **Customer MCP**.

### How product search is split (important)

- **Car cabin filters** → fitment MySQL + `get_fitment_next_step` → enrich with Admin GraphQL  
- **Home / furnace filters** → `search_store_products` with `home_filter` → **Admin GraphQL**  
- **Fresheners** → `search_store_products` with `freshener` → Storefront MCP catalog search  

Same chat experience for the customer; different backends underneath.

---

## MCP — what is that?

**MCP** means Model Context Protocol. In practice for us: Shopify hosts special endpoints where our app can list tools and call them with JSON-RPC.

We talk to **three** Shopify MCP “servers”:

| Server | Rough job |
|--------|-----------|
| **Storefront MCP** (`/api/mcp`) | Catalog search, policies/FAQs |
| **UCP MCP** (`/api/ucp/mcp`) | Cart and checkout |
| **Customer MCP** | Orders / account stuff — needs the shopper to log in |

Our code that does this is `app/mcp-client.js`. We cache the tool list in memory, log calls to **`McpCallLog`**, and can warm tools up when the app starts.

**Catalog client id / secret** (in `.env`) are **not** the merchant Session token. They are used to get a short-lived Catalog/UCP access token so cart and catalog MCP work at the Token tier. That token lives in memory (cached), not in the `Session` table.

There is also a `.mcp.json` Shopify **dev** MCP for Cursor docs — that is only for developers writing code, not for shoppers.

---

## Tokens & auth — don’t mix these up

People often ask “which token is which?” Here is the human version.

### 1. `Session` table — merchant / app token

When the **store owner installs** our Shopify app, Shopify gives us an **offline (or online) access token**. We store it in **`Session`**.

- Used for **Admin GraphQL** and for the merchant opening our embedded admin (`/app`).
- **Not** Catalog credentials.
- **Not** the shopper’s login.

In code, Admin product calls prefer `SHOPIFY_ADMIN_ACCESS_TOKEN` from `.env` if set; otherwise they fall back to this Session token. So if the app is installed, you often don’t *need* the Admin token in `.env` — but having it can help for scripts or when no Partner session exists.

### 2. Catalog client id + secret — cart/catalog MCP

Separate credentials. They mint a **Catalog Bearer token** used when calling Storefront/UCP MCP. Different purpose from Session.

### 3. Shopper Customer Account login — three tables working together

When the AI (or UI) needs **customer-account** powers (orders, etc.):

1. **`CustomerAccountUrls`** — we look up Shopify’s well-known endpoints once and save:
   - where to log in (`authorizationUrl`)
   - where to trade the code for a token (`tokenUrl`)
   - where Customer MCP lives (`mcpApiUrl`)  
   These are **addresses**, not tokens.

2. **`CodeVerifier`** — short-lived secret for **PKCE** during login. We save it when login starts; on callback we prove it’s really our login flow.

3. **`CustomerToken`** — after login succeeds, we store the shopper’s **access token** keyed by `conversationId`. That is what Customer MCP uses in the `Authorization` header.

Flow in one sentence:  
*Find URLs → start login with CodeVerifier → callback verifies → save CustomerToken → call Customer MCP.*

### 4. Storefront customer from Liquid (separate path)

Even without Customer Account OAuth, if the shopper is logged into the storefront, Liquid can pass customer id/name and we can sync **addresses** into `StoreCustomer` / `StoreCustomerAddress`. The `get_customer_addresses` tool reads those. That is different from Customer Account MCP login.

---

## The database — what we remember

Main app DB is **SQLite via Prisma** (`prisma/schema.prisma`).

### Chat memory

- **`Conversation`** — one chat thread. Also holds `activeCartId`, `activeCheckoutId`, `checkoutUrl`, last shipping JSON, and optional customer identity for cross-device claim.
- **`Message`** — each user/assistant turn.

### Auth & Shopify glue

- **`Session`** — merchant app install token (Admin).
- **`CustomerToken`**, **`CodeVerifier`**, **`CustomerAccountUrls`** — shopper Customer Account login (see above).

### Help content & observability

- **`StorePolicyDigest`** — local policy cheat sheet when Shopify policy search is empty.
- **`LlmRequestLog`** — what we sent the AI and what came back.
- **`McpCallLog`** — MCP and Admin GraphQL calls (timing, payloads).
- **`ToolEmptyResultLog`** — “tool ran but found nothing useful” for debugging.

### Fitment MySQL (not Prisma)

Vehicle fitment data lives in separate MySQL databases (when `FITMENT_ENABLED=true`). Prisma does not replace that. Fitment tools query MySQL, then we often enrich product/variant details with Admin GraphQL.

---

## Cart → shipping → checkout (how a sale happens)

1. AI finds a product and gets a **variant id**.
2. `add_to_cart` creates or updates the Shopify cart; we store `activeCartId` on the conversation.
3. Shopper may set shipping with `set_cart_shipping` → we create/update checkout and save address + `checkoutUrl`.
4. Discounts go through `apply_discount_code`.
5. `get_my_cart` returns a summary and a **checkout link** (with AIRA UTM params).
6. Shopper clicks the link and finishes on Shopify’s checkout page.

We keep **one active cart (and checkout) per conversation**, so “add another filter” doesn’t accidentally create a random second cart every time.

---

## What the storefront UI does

Theme extension: `extensions/chat-bubble/`

- Liquid block draws the bubble and passes shop/customer context.
- `chat.js` talks to our APIs: stream chat, load history, list/claim sessions, sync addresses.
- Styles and English strings live next to it.

Merchant setup is mostly: install the app, enable the theme block. The embedded admin home page is minimal — it doesn’t browse all conversations; those live in our DB / logs.

---

## Admin GraphQL — when we use it

Even though MCP handles a lot, we still call **Shopify Admin GraphQL** for:

- searching **home filters**
- enriching fitment products with variant/price/image details

Auth options:

1. `SHOPIFY_ADMIN_ACCESS_TOKEN` in `.env`, or  
2. Offline **`Session`** token from app install  

Scopes today include things like `read_products`, `read_discounts`, `unauthenticated_read_product_listings`.

---

## Other small but useful pieces

- **Webhooks** — when the app is uninstalled, we clean up `Session` rows.
- **Hints** — services that gently steer the model (policy questions → policy tools; home/freshener wording → catalog search).
- **Product compare** — ranks/highlights a “best pick” on product cards.
- **Install media** — prefers PDF / YouTube when someone asks how to install.
- **Empty tool logging** — when a search returns nothing, we record it so we can improve prompts or data.

---

## Environment variables (in human terms)

You don’t need every variable memorized. Group them by job:

| Job | Examples |
|-----|----------|
| Which AI to use | `LLM_PROVIDER`, `GEMINI_API_KEY`, models, max tokens |
| Shopify app identity | API key/secret, app URL, scopes |
| Admin product calls | `SHOPIFY_ADMIN_ACCESS_TOKEN` (optional if Session exists) |
| Storefront / MCP | `STOREFRONT_URL`, Catalog client id/secret |
| Chat UX | localStorage vs sessionStorage, show tool calls in UI |
| Fitment | `FITMENT_ENABLED`, MySQL hosts, VIN API |

Never commit real secrets. Rotate anything that was pasted into chat or shared.

---

## Mental model cheat sheet

| Question | Short answer |
|----------|--------------|
| REST or WebSocket? | HTTP (REST-style endpoints). Chat replies use **SSE streaming**, not WebSockets. |
| Same connection for stream? | Yes — one POST streams the reply; next message opens a new POST. |
| Session token? | Merchant app install → Admin API. |
| Catalog id/secret? | Separate → Catalog/UCP MCP auth. |
| CodeVerifier → CustomerToken? | Yes — PKCE login then store shopper token. |
| CustomerAccountUrls? | Cached login/MCP **URLs**, not tokens. |
| Who talks to Shopify? | Our server tools, not the raw LLM. |

---

## Where to look in the code (if you’re diving in)

| You want to understand… | Start here |
|--------------------------|------------|
| Full chat turn + tools | `app/routes/chat.jsx` |
| SSE streaming | `app/services/streaming.server.js` |
| MCP client | `app/mcp-client.js` |
| Cart wrappers | `app/services/cart-tools.server.js`, `cart.server.js` |
| Fitment | `app/fitment/` |
| Admin products | `app/services/shopify-products.server.js` |
| DB helpers | `app/db.server.js` |
| Bubble UI | `extensions/chat-bubble/` |
| Schema | `prisma/schema.prisma` |

---

## Related docs

- [`ai-chatbot-system.md`](./ai-chatbot-system.md) — compact technical reference  
- [`fitment-and-catalog-flow.md`](./fitment-and-catalog-flow.md) — deeper fitment/catalog path  

If this guide and the code drift apart, trust the code and update this file so the next person gets the same clear story.
