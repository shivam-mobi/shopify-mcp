# AI Shopping Assistant for Shopify

**Client presentation brief**  
Product: AIRA — conversational shopping assistant on the Shopify storefront  
Basis: Shopify MCP / shop-chat-agent foundation, extended with a database layer and custom tools

---

## 1. Product overview

**What it is**  
A chat assistant embedded on the storefront. Shoppers ask questions in natural language; the assistant finds products, answers store questions, manages the cart, and hands them a checkout link on Shopify.

**Problem it solves**  
Finding the right product (especially vehicle fitment), navigating policies, and moving from discovery to checkout often means hunting across search, filters, and help pages. Many shoppers abandon when that path feels slow or unclear.

**How it improves the experience**  
- Guided discovery instead of manual catalog browsing  
- One conversation for products, policies, cart, and checkout handoff  
- Memory of the chat (and cart) so shoppers do not start over after each message  
- Storefront-native UI (chat bubble) — no separate app for the customer

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
| Shopify checkout | Where payment is completed (link from chat) |

**Why the database layer matters**  
Without it, each message is isolated and low-level store calls are harder to keep consistent. With it, the assistant keeps one cart per chat, restores history, syncs saved addresses for logged-in shoppers, and supports a safer cart/checkout flow than raw MCP calls alone.

**Beyond the Shopify MCP boilerplate**  
Custom product discovery (vehicle fitment, home filters, fresheners), cart/checkout wrappers, local policy fallback, address tools, product comparison UI, install-resource guidance, checkout attribution, and a branded theme extension with richer chat UX.

---

## 3. Key capabilities

### Custom-built (our extensions)

| Capability | Customer / business value |
|------------|---------------------------|
| Vehicle cabin-filter fitment (VIN or year / make / model) | Shoppers find filters that fit their vehicle without guessing SKUs |
| Home furnace filter search | Size / performance-oriented discovery for home products |
| Freshener / scent search | Quick browse of lifestyle add-ons in the same chat |
| Cart management (add, remove, clear, view) | Edit the basket inside the conversation |
| Shipping address in chat | Collect or update shipping before checkout |
| Discount codes in chat | Apply or clear promos without leaving the assistant |
| Checkout link with tracking | Hand off to Shopify checkout; chat-originated checkouts can be attributed |
| Saved addresses (logged-in shoppers) | Faster checkout using addresses already on the account |
| Local store policy fallback | Reliable answers when Shopify policy search returns nothing useful |
| Conversation memory + cart persistence | Continuity across turns; one active cart per chat |
| Cross-device chat for logged-in customers | Resume conversations linked to the customer account |
| Product cards, comparison, and “best pick” highlighting | Easier side-by-side choice among returned products |
| Install guidance (product PDF / video when available) | Clearer “how do I install this?” help |
| Voice input and speak-aloud replies | Hands-free / accessible interaction in supported browsers |

### From Shopify MCP (store platform)

| Capability | Customer / business value |
|------------|---------------------------|
| Catalog / policy MCP endpoints | Official store catalog and policy data |
| Cart and checkout (UCP) | Real Shopify cart and checkout sessions behind the wrappers |
| Customer Account tools (when shopper authenticates) | Order / account help when the shop exposes these tools |

**Needs confirmation (shop-dependent):** exact Customer Account tools available live (e.g. order status). Payment is completed on Shopify’s checkout page, not inside the chat.

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
| Operational visibility | Request and tool logging for support and improvement *(merchant-facing analytics UI not included today)* |
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
| Richer order  help | Customer Account MCP path already exists when shops enable it |
| Merchant analytics / conversation insights UI | Logs already capture LLM and tool activity |
| Broader catalog categories with the same tool pattern | Catalog and Admin search paths are already modular |
| Deeper in-chat checkout experiences | Checkout APIs exist under the hood; today handoff is via checkout link |
| Stronger long-term preference / recommendation models | Today ranking is heuristic within search results only |
| Additional LLM providers or prompt variants per brand | Multi-provider and prompt-type hooks are already in place |

---

## 8. Presentation outline

### Slide 1 — Title  
- AI shopping assistant for Shopify  
- Conversational discovery → cart → checkout handoff  
- Built on Shopify MCP, extended for real retail journeys  

### Slide 2 — The shopping problem  
- Hard to find the right product (especially fitment)  
- Policies and cart live in different places  
- Friction between “interested” and “ready to pay”  

### Slide 3 — Product snapshot  
- Storefront chat bubble (AIRA)  
- Natural-language shopping associate  
- One thread for find, decide, cart, and checkout link  

### Slide 4 — How it works (architecture)  
- Shopper → AI → database layer → Shopify  
- Database = memory and consistent cart/checkout state  
- MCP = live store systems; custom tools = shopping experience  

### Slide 5 — Discovery capabilities  
- Vehicle fitment (VIN or year / make / model)  
- Home filters and fresheners  
- Product cards, comparison, install help  

### Slide 6 — From cart to checkout  
- Add / edit cart in chat  
- Shipping, saved addresses, discount codes  
- Tracked checkout link → pay on Shopify  

### Slide 7 — Trust and support  
- Policies and FAQs (Shopify + local fallback)  
- Conversation history and logged-in continuity  
- Optional account/order tools when authenticated *(shop-dependent)*  

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

## Appendix — Source of truth notes

- Capabilities above reflect the current codebase and project documentation (`ai-chatbot-system.md`, implementation under `app/`, `prisma/`, `extensions/chat-bubble/`).  
- Live MCP tool lists can vary by shop; Customer Account features require shopper authentication and shop configuration.  
- Vehicle fitment requires fitment data configuration to be enabled in the environment.  
- Do not present payment-inside-chat, guaranteed conversion lift, or unverified Customer Account tools as current features.
