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

/**
 * Tool is only registered when the storefront customer is logged in.
 */
export function getCustomerAddressTools() {
  return [
    {
      name: CUSTOMER_ADDRESSES_TOOL_NAME,
      description:
        "Get the logged-in customer's saved Shopify shipping addresses from the store account. " +
        "Call this when the customer asks for their addresses, wants to ship to a saved/default address, " +
        "or needs an address for set_cart_shipping / checkout. " +
        "You MAY list these addresses to the customer. Prefer the default address when they say " +
        '"use my address" or "default". Pass fields into set_cart_shipping — do not invent addresses.',
      input_schema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Optional short reason (e.g. shipping, show_list)"
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
      instruction:
        addresses.length > 0
          ? "Use these saved addresses for shipping. Prefer is_default=true when the customer does not specify which one. " +
            "Map fields into set_cart_shipping (street_address, address_locality, address_region, postal_code, address_country, names, phone)."
          : "No saved addresses on file. Ask the customer to enter a shipping address, or add one in their Shopify account."
    });
  } catch (error) {
    console.error("[customer-addresses] tool failed", error.message);
    return toolError(error.message || "Failed to load addresses");
  }
}
