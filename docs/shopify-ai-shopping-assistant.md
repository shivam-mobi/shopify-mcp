# AI Shopping Assistant for Shopify

**Client presentation brief**  
Product: **AIRA** — conversational shopping assistant on the Shopify storefront  
Foundation: Shopify MCP / shop-chat-agent boilerplate, extended with a database layer and custom tools

---

## 1. Product overview

**What it is**  
A storefront chat assistant. Shoppers ask questions in natural language; the assistant finds products, answers store questions, manages the cart, and hands them a checkout link on Shopify.

**Problem it solves**  
Finding the right product (especially vehicle fitment), navigating policies, and moving from discovery to checkout often means jumping across search, filters, and help pages. Many shoppers abandon when that path feels slow or unclear.

**How it improves the experience**
- Guided discovery instead of manual catalog browsing
- One conversation for products, policies, cart, and checkout handoff
- Memory of the chat (and cart) so shoppers do not start over after each message
- Storefront-native chat bubble — no separate app for the customer

---

## 2. Solution architecture

```
Shopper (chat bubble)
  → AI assistant
    → Database layer (conversation, cart state, customer context)
      → Shopify MCP APIs (+ Admin API where needed)
        → Shopify store (catalog, cart, checkout)
```

| Layer | Role (business language) |
|--------|---------------------------|
| Chat bubble | What the customer sees and types into |
| AI assistant | Understands intent and chooses the next action |
| Database layer | Remembers the conversation, cart, shipping, and (when logged in) customer context |
| Shopify MCP / store APIs | Live store catalog, policies, cart, and checkout |
| Shopify checkout | Where payment is completed (via link from chat) |

**Why the database layer matters**  
Without it, each message is isolated and low-level store calls are harder to keep consistent. With it, the assistant keeps one cart per chat, restores history, syncs saved addresses for logged-in shoppers, and supports a safer cart/checkout flow than raw MCP calls alone.

**Beyond the Shopify MCP boilerplate**  
Custom product discovery (vehicle fitment, home filters, fresheners), cart/checkout wrappers, local policy fallback, address tools, product comparison UI, install-resource guidance, checkout attribution, and a branded theme extension with richer chat UX.

---

## 3. Key capabilities

### 3.1 Tools provided via Shopify MCP

*Discovered live from the shop. Exact availability can vary by store configuration and shopper authentication.*

#### Catalog & policies (Storefront MCP)

| Tool | What it does | Customer / business value |
|------|----------------|---------------------------|
| `search_catalog` / `search_shop_catalog` | Search the live store catalog | Access to real product data from Shopify |
| `search_shop_policies_and_faqs` | Retrieve store policies and FAQs | Answers shipping, returns, and help questions from official store content |

> **Note:** Raw catalog search tools are **hidden from the AI** in our build. Product discovery for shoppers goes through our custom wrappers (below). Policy search remains available to the AI; if it returns nothing useful, our local policy tool is used as fallback.

#### Cart & checkout (UCP MCP)

*Used behind the scenes by our cart wrappers — not exposed directly to the AI.*

| Tool | What it does |
|------|----------------|
| `create_cart` | Create a Shopify cart |
| `get_cart` | Read cart contents |
| `update_cart` | Update line items |
| `cancel_cart` | Cancel / clear a cart |
| `create_checkout` | Create a checkout session |
| `get_checkout` | Read checkout state |
| `update_checkout` | Update shipping, discounts, etc. |
| `complete_checkout` | Complete checkout *(not used as the primary shopper path)* |
| `cancel_checkout` | Cancel a checkout session |

**Value of these MCP cart tools:** They provide real Shopify cart and checkout sessions. Our wrappers make them safe and continuous for a chat conversation.

#### Customer Account MCP *(when the shopper authenticates)*

| Tool | What it does | Status |
|------|----------------|--------|
| `get_most_recent_order_status` | Recent order status | Needs confirmation per shop |
| `get_order_status` | Order status by id | Needs confirmation per shop |
| `get_order` | Order details | Needs confirmation per shop |
| `get_store_credit_balances` | Store credit balances | Needs confirmation per shop |
| `request_return` | Start a return | Needs confirmation per shop |

**Value:** Order and account help inside chat when the shop enables Customer Account MCP and the shopper is logged in.

Payment is completed on Shopify’s checkout page, not inside the chat.

---

### 3.2 Tools created by our developers

*These are the AI-facing tools shoppers experience. They wrap or extend Shopify MCP (and Admin API / fitment data where needed).*

#### Cart & checkout wrappers

| Tool | What it does | Customer / business value |
|------|----------------|---------------------------|
| `add_to_cart` | Add a product variant to the conversation cart | Shop without leaving the chat |
| `remove_from_cart` | Remove an item or reduce quantity | Easy basket edits mid-conversation |
| `get_my_cart` | Show cart summary and checkout link | Clear view of what’s ready to buy |
| `set_cart_shipping` | Set or update shipping address | Collect shipping before checkout |
| `remove_cart_shipping` | Clear shipping; keep the cart | Correct address mistakes without restarting |
| `clear_my_cart` | Empty the cart | Quick reset if the shopper changes mind |
| `apply_discount_code` | Apply or clear a promo code | Use discounts without leaving chat |

#### Product discovery

| Tool | What it does | Customer / business value |
|------|----------------|---------------------------|
| `get_fitment_next_step` | Vehicle cabin-filter fitment by VIN or year / make / model | Find the right filter without guessing SKUs |
| `search_store_products` | Search home furnace filters or fresheners | Category-focused discovery in the same chat |

#### Help & account

| Tool | What it does | Customer / business value |
|------|----------------|---------------------------|
| `search_store_policies` | Local store-policy digest when Shopify returns nothing useful | More reliable answers to help questions |
| `get_customer_addresses` | Saved addresses for logged-in shoppers | Faster checkout using known addresses |

---

### 3.3 Experience features (beyond tools)

| Capability | Source | Customer / business value |
|------------|--------|---------------------------|
| Conversation memory + one cart per chat | Custom (database layer) | Continuity across turns; consistent basket |
| Cross-device chat for logged-in customers | Custom | Resume conversations linked to the account |
| Product cards, comparison, “best pick” | Custom (UI + ranking) | Easier side-by-side choice |
| Install guidance (PDF / video when available) | Custom | Clearer “how do I install this?” help |
| Checkout link with AIRA tracking | Custom | Handoff to Shopify; chat-origin checkouts can be attributed |
| Voice input and speak-aloud replies | Custom (browser support) | Hands-free / accessible interaction where supported |
| Live catalog, policies, cart, checkout | Shopify MCP | Official store systems behind the experience |

---

## 4. Customer journey

```
Discover → Choose → Cart → Ship / promo → Checkout link → Pay on Shopify
```

| Stage | Example assistant interaction |
|-------|-------------------------------|
| Open chat | Welcome; greet by name when the storefront customer is known |
| Discover | Fitment wizard (vehicle), home-filter search, or freshener search |
| Choose | Product cards; compare options; optional “best pick” cue |
| Cart | Add / remove / clear items; review cart summary |
| Prepare checkout | Set shipping; use a saved address; apply a discount code |
| Policies / help | Shipping, returns, FAQs; install links when relevant |
| Purchase handoff | Checkout link opens Shopify checkout |
| After purchase *(conditional)* | Order / account questions if Customer Account MCP is available and the shopper is authenticated |
| Return later | History restore; logged-in session sync across devices |

---

## 5. Business value

| Value | How the product supports it |
|-------|-----------------------------|
| Personalised assistance | Conversation context, customer name, saved addresses, logged-in session continuity |
| Faster product discovery | Fitment and catalog tools replace multi-step manual search |
| Better customer experience | Streaming replies, product cards, chips for fitment/addresses, voice options |
| Less buying friction | Cart, shipping, discounts, and checkout link in one thread |
| Operational visibility | Request and tool logging for support and improvement *(merchant analytics UI not included today)* |
| Attribution of assisted checkouts | Checkout links tagged for chat-origin traffic |

*No revenue, conversion, or cost-saving claims are asserted here; impact depends on store, catalog, and traffic.*

---

## 6. Competitive differentiation

| Standard Shopify MCP chatbot | This solution |
|------------------------------|---------------|
| Relies mainly on raw MCP tools | Custom tool layer designed for shopping flows |
| Limited session/cart continuity | Database layer: history, one cart/checkout per conversation, shipping memory |
| Generic catalog search | Domain discovery: vehicle fitment, home filters, fresheners |
| Policies only if MCP returns them | Shopify policies plus local digest fallback |
| Basic cart via low-level MCP | Safer wrappers: merge cart, shipping, discounts, checkout handoff |
| Minimal storefront chrome | Branded bubble with cards, comparison, sessions, addresses, voice |
| Little post-interaction insight | Logging of LLM and store API calls for debugging and iteration |

**In short:** Shopify MCP supplies the store connection; the database layer and custom tools supply reliability, category-specific discovery, and a complete path from question to checkout link.

---

## 7. Future opportunities

*Labeled as enhancements — not current product features.*

| Opportunity | Why it fits the current architecture |
|-------------|--------------------------------------|
| Richer order help in chat | Customer Account MCP path already exists when shops enable it |
| Merchant analytics / conversation insights UI | Logs already capture LLM and tool activity |
| Broader catalog categories with the same tool pattern | Catalog and Admin search paths are already modular |
| Deeper in-chat checkout experiences | Checkout APIs exist under the hood; today handoff is via checkout link |
| Stronger long-term preference / recommendation models | Today ranking is heuristic within search results only |
| Additional LLM providers or prompt variants per brand | Multi-provider and prompt-type hooks are already in place |

---

## 8. Presentation outline

### Slide 1 — Title
- AI shopping assistant for Shopify (AIRA)
- Conversational discovery → cart → checkout handoff
- Built on Shopify MCP, extended for real retail journeys

### Slide 2 — The shopping problem
- Hard to find the right product (especially fitment)
- Policies and cart live in different places
- Friction between “interested” and “ready to pay”

### Slide 3 — Product snapshot
- Storefront chat bubble
- Natural-language shopping associate
- One thread for find, decide, cart, and checkout link

### Slide 4 — How it works (architecture)
- Shopper → AI → database layer → Shopify
- Database = memory and consistent cart/checkout state
- MCP = live store systems; custom tools = shopping experience

### Slide 5 — Tool map: Shopify MCP vs custom
- MCP: catalog, policies, cart/checkout engines, optional account tools
- Custom: fitment, category search, cart wrappers, policies fallback, addresses
- We hide raw cart/catalog MCP from the AI and expose safer shopping tools

### Slide 6 — Discovery capabilities
- Vehicle fitment (VIN or year / make / model)
- Home filters and fresheners
- Product cards, comparison, install help

### Slide 7 — From cart to checkout
- Add / edit cart in chat
- Shipping, saved addresses, discount codes
- Tracked checkout link → pay on Shopify

### Slide 8 — Why this vs a basic MCP chatbot
- Database layer for memory and cart integrity
- Custom tools for fitment, cart, policies, addresses
- Richer UI and attribution beyond the boilerplate

### Slide 9 — Business value
- Personalised, faster discovery
- Lower friction to checkout handoff
- Visibility into assistant behaviour for ongoing improvement

### Slide 10 — Roadmap (future only)
- Analytics UI, deeper account/order journeys, broader catalog
- Possible richer checkout experiences
- Clear line: roadmap vs shipped today

---

## Appendix — Tool quick reference

### Custom tools (developer-built, exposed to the AI)

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

### Shopify MCP tools (platform)

| Area | Tools | Exposed to AI? |
|------|-------|----------------|
| Catalog | `search_catalog`, `search_shop_catalog` | No (used via wrappers) |
| Policies | `search_shop_policies_and_faqs` | Yes (+ local fallback) |
| Cart / checkout | `create_cart`, `get_cart`, `update_cart`, `cancel_cart`, `create_checkout`, `get_checkout`, `update_checkout`, `complete_checkout`, `cancel_checkout` | No (used by cart wrappers) |
| Customer Account | Order / credit / return tools *(shop-dependent)* | Yes, when authenticated |

### Source-of-truth notes

- Capabilities reflect the current codebase and project documentation.
- Live MCP tool lists can vary by shop; Customer Account features require shopper authentication and shop configuration.
- Vehicle fitment requires fitment data to be enabled in the environment.
- Do not present payment-inside-chat, guaranteed conversion lift, or unverified Customer Account tools as current features.
