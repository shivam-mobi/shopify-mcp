/**
 * Logged-in-only tool: read Liquid-synced customer addresses from DB.
 */
import { listStoreCustomerAddresses } from "../db.server.js";

export const CUSTOMER_ADDRESSES_TOOL_NAME = "get_customer_addresses";

function toolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data)
      }
    ],
    structuredContent: typeof data === "object" ? data : undefined
  };
}

function toolError(message) {
  return toolResult({
    success: false,
    error: true,
    message: String(message || "Could not load customer addresses."),
    addresses: []
  });
}

function compactAddressLabel(address, index) {
  const street = String(address.street_address || "").trim();
  const city = String(address.address_locality || "").trim();
  const region = String(address.address_region || "").trim();
  const postal = String(address.postal_code || "").trim();
  const place = [city, region, postal].filter(Boolean).join(" ");
  const line = [street, place].filter(Boolean).join(", ");
  const prefix = address.is_default ? "Default" : `Address ${index + 1}`;
  return line ? `${prefix} · ${line}` : prefix;
}

/**
 * Tool is only registered when the storefront customer is logged in.
 */
export function getCustomerAddressTools() {
  return [
    {
      name: CUSTOMER_ADDRESSES_TOOL_NAME,
      description:
        "Load saved Shopify shipping addresses for a logged-in customer. " +
        "Call ONLY when they clearly mention addresses — e.g. saved address, my addresses, shipping address, use my address, default address, pick an address for checkout. " +
        "NEVER call for product requests: \"show the products\", \"list filters\", \"show fresheners\", catalog results, or any \"show/list/see\" that is about products (not addresses). " +
        "If unclear whether they want products or addresses, ask a short clarifying question — do NOT call this tool. " +
        "A compact address select UI appears after this tool — do NOT paste full address lists in your reply. " +
        "Prefer the default address when they say \"use my address\" or \"default\". " +
        "After they pick one, pass fields into set_cart_shipping — do not invent addresses.",
      input_schema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Optional short reason (e.g. shipping, show_list). Only when the user clearly asked about addresses."
          }
        },
        required: []
      }
    }
  ];
}

export function isCustomerAddressesTool(toolName) {
  return toolName === CUSTOMER_ADDRESSES_TOOL_NAME;
}

/**
 * Build SSE payload for the storefront address select UI.
 */
export function extractCustomerAddressesUi(toolUseResponse) {
  try {
    const data =
      toolUseResponse?.structuredContent ||
      (() => {
        const text = toolUseResponse?.content?.find((b) => b.type === "text")?.text;
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })();

    if (!data?.success || !Array.isArray(data.addresses) || data.addresses.length === 0) {
      return null;
    }

    return {
      title: "Select a saved address",
      addresses: data.addresses.map((address, index) => ({
        ...address,
        label: compactAddressLabel(address, index)
      }))
    };
  } catch (error) {
    console.error("[customer-addresses] extract UI failed", error.message);
    return null;
  }
}

export async function callCustomerAddressesTool(
  _toolName,
  _toolArgs = {},
  { shopifyCustomerId = null, shopDomain = null } = {}
) {
  const customerId = String(shopifyCustomerId || "").trim();
  if (!customerId) {
    return toolError("Customer is not logged in. Ask them to sign in to use saved addresses.");
  }

  try {
    const addresses = await listStoreCustomerAddresses(customerId, {
      shopDomain: shopDomain || null
    });

    return toolResult({
      success: true,
      found: addresses.length > 0,
      address_count: addresses.length,
      addresses,
      ui_instruction:
        addresses.length > 0
          ? "CRITICAL: A select dropdown of saved addresses is already shown in the chat UI. " +
            "FORBIDDEN in your reply: listing street/city/state/ZIP/phone/name fields, numbered address lists, or long address blocks. " +
            "Reply in ONE short sentence only (e.g. \"Pick a saved address below, or tell me a new one.\")."
          : undefined,
      instruction:
        addresses.length > 0
          ? "Saved addresses are shown in the UI select. Prefer is_default=true when the customer does not specify which one. " +
            "When they choose one (or describe one), map fields into set_cart_shipping " +
            "(street_address, address_locality, address_region, postal_code, address_country, names, phone). " +
            "Do not invent addresses. Do not paste the address book into chat text."
          : "No saved addresses on file. Ask the customer to enter a shipping address, or add one in their Shopify account."
    });
  } catch (error) {
    console.error("[customer-addresses] tool failed", error.message);
    return toolError(error.message || "Failed to load addresses");
  }
}
