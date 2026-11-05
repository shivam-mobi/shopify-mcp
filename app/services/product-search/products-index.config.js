/**
 * Meilisearch configuration for the products index — edit this file, then:
 *   npm run meili:config   apply PRODUCTS_INDEX_SETTINGS (no product resync needed)
 *   npm run meili:sync     needed only when POPULARITY or the document fields change
 * SEARCH_TUNING is read at request time: rebuild/restart the app after editing it.
 */

export const PRODUCTS_INDEX_UID = process.env.MEILI_PRODUCTS_INDEX || "products";
export const PRODUCTS_PRIMARY_KEY = "id";

/** Must match the model used by the embed:products scripts (OPENAI_EMBEDDING_MODEL). */
export const PRODUCT_EMBEDDER = "openai";
export const PRODUCT_EMBEDDING_DIMENSIONS = 1536;

export const PRODUCTS_INDEX_SETTINGS = {
  /** Order matters: a match in an earlier field ranks higher. */
  searchableAttributes: [
    "title",
    "brand",
    "notes",
    "fragrance_family",
    "scent_type",
    "product_type",
    "tags",
    "collections",
    "description"
  ],
  filterableAttributes: [
    "gender",
    "kids",
    "brand",
    "product_type",
    "fragrance_family",
    "scent_type",
    "notes",
    "collection_handles",
    "applicable_offer",
    "price",
    "max_price",
    "variant_prices",
    "offer_variant_prices",
    "on_sale",
    "in_stock",
    "online_only",
    "best_seller"
  ],
  sortableAttributes: [
    "price",
    "max_price",
    "popularity",
    "rating",
    "review_count",
    "created_at",
    "discount_percent"
  ],
  /** "sort" first so an explicit sort (price, popularity) wins; popularity breaks relevance ties. */
  rankingRules: ["sort", "words", "typo", "proximity", "attribute", "exactness", "popularity:desc"],
  /** Ignored in queries and documents. Gender, price and ranking words belong in filters/sort. */
  stopWords: [
    "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "with", "my", "me", "some",
    "i", "im", "i'm", "ive", "i've", "you", "your", "we", "us",
    "please", "perfume", "perfumes", "cologne", "colognes", "fragrance", "fragrances",
    "scent", "scents", "smell", "smells", "smelling", "men", "mens", "women", "womens", "him", "her",
    "popular", "best", "top", "bestseller", "bestsellers", "trending", "cheap", "cheapest", "affordable",
    "something", "like", "similar", "want", "need", "looking", "show", "find",
    "recommend", "recommendation", "suggest", "suggestion", "give", "tell", "buy", "good"
  ],
  synonyms: {
    edp: ["eau de parfum"],
    "eau de parfum": ["edp"],
    edt: ["eau de toilette"],
    "eau de toilette": ["edt"],
    edc: ["eau de cologne"],
    "eau de cologne": ["edc"],
    oud: ["agarwood"],
    agarwood: ["oud"],
    "body mist": ["body spray"],
    "body spray": ["body mist"],
    aftershave: ["after shave"],
    "after shave": ["aftershave"],
    citrusy: ["citrus"],
    woodsy: ["woody"],
    flowery: ["floral"],
    gourmand: ["vanilla", "sweet"],
    kids: ["children", "kid", "baby"],
    children: ["kids"],
    mini: ["miniature", "travel"],
    travel: ["mini", "miniature"],
    aquatic: ["fresh", "marine", "oceanic", "water"],
    marine: ["aquatic", "fresh"],
    clean: ["fresh", "soapy"],
    oriental: ["amber", "spicy"],
    sweet: ["gourmand", "sugary", "vanilla"],
    fruity: ["fruit", "berry"],
    musky: ["musk"],
    smoky: ["smoke", "tobacco"]
  },
  typoTolerance: {
    enabled: true,
    minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 },
    disableOnNumbers: true
  },
  /** Must exceed the number of brands so brand-name matching sees every brand. */
  faceting: { maxValuesPerFacet: 2000 },
  pagination: { maxTotalHits: 1000 },
  embedders: {
    [PRODUCT_EMBEDDER]: { source: "userProvided", dimensions: PRODUCT_EMBEDDING_DIMENSIONS }
  }
};

/** Popularity score stored on each document (0–1). Weights should add up to 1. */
export const POPULARITY = {
  reviewVolumeWeight: 0.45,
  ratingWeight: 0.35,
  bestSellerWeight: 0.2,
  /** Bayesian prior: products with few reviews are pulled toward the store average. */
  ratingPriorCount: 10,
  bestSellerCollectionPrefix: "best-selling"
};

/**
 * Category types the LLM can pick (filters.categories). The search turns a type into
 * Shopify collection handles using the gender filter: men → men + shared, women → women + shared,
 * no gender (couple, family, anyone) → all of them. A product matches if it is in any handle.
 *
 * To add or change a category: edit this list and restart the app (no re-sync needed).
 * Handles must be collection handles that products are in (see collection_handles in Meilisearch).
 */
export const CATEGORY_GROUPS = {
  bundles: {
    description: "bundles, combos, value sets, multi-product deals",
    men: ["bundle-deals-for-men"],
    women: ["bundle-deals-for-women"],
    // "product-bundles" holds the single perfumes bundles are made from, not bundles.
    shared: ["bundle-deals-perfumes", "his-and-her-bundles", "bundle-deals"]
  },
  best_sellers: {
    description: "best sellers (also set sort popular)",
    men: ["best-selling-colognes-for-men"],
    women: ["best-selling-perfumes-for-women"],
    shared: ["top-100-best-sellers", "best-selling-perfumes-and-colognes"]
  },
  new_arrivals: {
    description: "new arrivals, just in",
    men: ["mens-cologne-new-arrivals"],
    women: ["womens-perfume-new-arrivals"],
    shared: ["new-arrivals"]
  },
  clearance: {
    description: "clearance, final sale, last chance",
    men: ["clearance-for-mens-cologne"],
    women: ["clearance-for-women-perfume"],
    shared: ["fragrance-clearance"]
  },
  deals: {
    description: "current deals and flash sales",
    men: [],
    women: [],
    shared: ["top-deals", "weekend-flash-sale", "flash-sale-deal", "mystery-sale"]
  },
  gift_sets: {
    description: "gift sets",
    men: ["cologne-gift-sets-for-men"],
    women: ["perfume-gift-sets-for-women"],
    shared: ["gift-set", "gift-sets", "fragrance-gift-sets"]
  },
  minis: {
    description: "mini / travel size perfumes",
    men: [],
    women: [],
    shared: ["mini-perfume", "miniatures-perfumes-and-colognes"]
  },
  body_sprays: { description: "body sprays and mists", men: [], women: [], shared: ["body-sprays"] },
  beauty: { description: "beauty and skin care", men: [], women: [], shared: ["beauty"] },
  exclusives: { description: "only at Perfumania exclusives", men: [], women: [], shared: ["only-at-perfumania"] },
  edp: {
    description: "eau de parfum",
    men: [],
    women: [],
    shared: ["eau-de-parfum-edp-s", "eau-de-parfum", "eau-de-parfum-spray"]
  },
  edt: { description: "eau de toilette", men: [], women: [], shared: ["eau-de-toilette-edt-s"] }
};

export const SEARCH_TUNING = {
  /** 0 = keyword only, 1 = vector only. */
  semanticRatio: 0.5,
  /** "frequency" drops the most common query words first when nothing matches all of them. */
  matchingStrategy: "frequency",
  /**
   * Relevance cutoff, relative to the best keyword hit and the best vector hit of each query.
   * Keyword scores spread out (0.6–1.0); vector scores sit in a narrow band (0.55–0.85),
   * so vector hits get a tighter window. Results scoring above either cutoff are kept.
   */
  relevance: {
    /** Best keyword hit below this is a partial/accidental match: ignored, result is "related". */
    keywordConfidentScore: 0.7,
    keywordWindow: 0.15,
    semanticWindow: 0.04,
    minScore: 0.5,
    /**
     * Products containing every query word are always kept, whatever their score, and listed
     * before meaning-only matches. A match here counts as "strong"; anything else (tags,
     * collections, description) is "weak".
     */
    strongFields: ["title", "brand", "notes", "key_notes", "fragrance_family", "scent_type", "product_type"],
    /** Weak-field-only matches are added only when there are fewer strong matches than this. */
    weakMatchesWhenStrongBelow: 20,
    /** Multi-word queries: words must be this close (1 = adjacent, 0.25 = far apart / other fields). */
    minProximity: 0.5
  },
  /** Most relevant hits considered per query; the shopper's sort and paging apply within them. */
  maxCandidates: 500,
  defaultLimit: 10,
  maxLimit: 50,
  /** Order in which filters are dropped when a search returns nothing. */
  relaxOrder: ["scent_type", "fragrance_family", "notes", "product_type", "category", "on_sale", "exclude"],
  /** Never relaxed: the shopper said these explicitly. */
  hardFilters: ["gender", "kids", "brand", "price", "applicable_offer"],
  /** Facet counts returned to the LLM so it can suggest refinements. */
  facets: ["brand", "fragrance_family", "product_type"],
  facetValuesPerField: 6,
  /** Shorthand the LLM may send for product_type / fragrance_family values. */
  facetAliases: {
    edp: "Eau de Parfum",
    edt: "Eau de Toilette",
    edc: "Eau de Cologne",
    "body mist": "Body Spray"
  },
  /** Query words that switch on the kids filter. */
  kidsWords: ["kid", "kids", "child", "children", "baby", "babies", "toddler"],
  /** Query words for more than one person: no gender is inferred, categories cover men and women. */
  sharedWords: ["couple", "couples", "both", "together", "family", "partners"],
  /** Query words that set the gender filter when the LLM did not set it. */
  genderWords: {
    men: ["men", "mens", "man", "male", "him", "his", "he", "boyfriend", "husband", "dad", "father", "guy", "guys", "gentleman", "gents"],
    women: ["women", "womens", "woman", "female", "her", "she", "ladies", "lady", "girlfriend", "wife", "mom", "mother", "gal", "gals"],
    boys: ["boy", "boys", "son", "grandson", "little boy"],
    girls: ["girl", "girls", "daughter", "granddaughter", "little girl"],
    kids: ["kid", "kids", "child", "children", "baby", "toddler"]
  },
  /** Safety net when the LLM leaves ranking words in the query instead of setting sort. */
  sortHints: {
    popular: ["popular", "best", "bestseller", "bestsellers", "bestselling", "top", "trending", "favorite", "famous", "hyped"],
    top_rated: ["rated", "reviewed", "highest rated", "best rated", "reviews"],
    discount_desc: ["biggest discount", "deepest discount", "highest discount", "best discount", "biggest deal", "best deal", "biggest discounts"],
    price_asc: ["cheap", "cheapest", "affordable", "budget", "inexpensive", "deal", "deals", "discount", "discounted", "sale"],
    price_desc: ["expensive", "luxury", "premium", "high end"],
    newest: ["newest", "latest"]
  },
  /** Sort words that are also product words (titles, collections, descriptions): never dropped from the query. */
  keepSortWords: ["luxury", "premium", "expensive"],
  /** Fields checked when the shopper excludes something ("not sweet", "no oud"). */
  excludeFields: ["notes", "scent_type", "fragrance_family"],
  /**
   * What an excluded word means. A product is excluded when one of these is a whole word of its
   * note / scent type / family ("vanilla" → "Vanilla", "Madagascar Vanilla", but not "Vanillin").
   * Plurals match too ("gourmand" → "Gourmands"). Words not listed here exclude only themselves.
   */
  excludeTerms: {
    sweet: [
      "sweet", "vanilla", "vanille", "vanila", "caramel", "caramelized", "tonka", "praline", "honey",
      "sugar", "sugared", "candy", "candied", "chocolate", "cocoa", "gourmand", "marshmallow",
      "toffee", "butterscotch", "meringue", "cake", "cotton candy"
    ],
    gourmand: ["gourmand", "vanilla", "caramel", "praline", "chocolate", "candy", "sugar", "toffee"],
    vanilla: ["vanilla", "vanille", "vanila"],
    musky: ["musk", "musky"],
    musk: ["musk", "musky"],
    smoky: ["smoke", "smoky", "incense", "birch", "tar"],
    powdery: ["powder", "powdery", "iris", "orris", "aldehyde", "aldehydes"],
    spicy: ["spice", "spicy", "pepper", "cinnamon", "clove", "cardamom", "nutmeg", "saffron"],
    woody: ["wood", "woody", "woods", "cedar", "sandalwood", "vetiver", "oud", "patchouli"],
    oud: ["oud", "agarwood"],
    fruity: ["fruit", "fruity", "fruits", "berry", "berries", "peach", "pear", "cherry", "plum", "raspberry", "strawberry", "pineapple", "mango"],
    floral: ["floral", "florals", "flower", "flowers", "rose", "jasmine", "tuberose", "lily", "peony", "gardenia", "ylang-ylang"],
    citrus: ["citrus", "citruses", "lemon", "bergamot", "grapefruit", "lime", "mandarin"],
    aquatic: ["aquatic", "aquatics", "marine", "sea", "ozonic"],
    leather: ["leather"]
  },
  /** Removed from the query when filters.exclude is set, with the excluded words ("fresh not sweet" → "fresh"). */
  negationWords: ["not", "no", "non", "without", "less", "avoid", "except", "nothing", "too"]
};
