/**
 * Shop AI Chat - Client-side implementation
 *
 * This module handles the chat interface for the Shopify AI Chat application.
 * It manages the UI interactions, API communication, and message rendering.
 */
(function() {
  'use strict';

  /**
   * Application namespace to prevent global scope pollution
   */
  /**
   * Resolve the backend API base URL from theme config.
   */
  function getApiBaseUrl() {
    const apiUrl = window.shopChatConfig?.apiUrl;
    if (!apiUrl) {
      throw new Error('Chat API URL is not configured');
    }
    return apiUrl.replace(/\/+$/, '');
  }

  /**
   * Build request headers for backend API calls.
   */
  function getApiHeaders(extraHeaders = {}) {
    return {
      'ngrok-skip-browser-warning': 'true',
      ...extraHeaders
    };
  }

  const CHAT_EXPANDED_KEY = 'shopAiChatExpanded';
  const BUBBLE_CALLOUT_KEY = 'shopAiBubbleCalloutSeen';
  const SHOPPER_ID_KEY = 'shopAiShopperId';
  // Per-shopper cache so home/recent chats paint before shopper-session returns.
  const SESSIONS_CACHE_PREFIX = 'shopAiSessions:';
  const ACTIVE_CONVERSATION_PREFIX = 'shopAiActiveConversation:';
  // Legacy unscoped keys — cleared once; replaced by shopper-scoped cache above.
  const LEGACY_CONVERSATION_ID_KEY = 'shopAiConversationId';
  const LEGACY_SESSIONS_INDEX_KEY = 'shopAiSessionsIndex';
  let conversationStorageMode = 'localStorage';
  let activeConversationId = null;
  let sessionsMemory = [];
  let shopperSessionFetched = false;

  function getBrowserStore() {
    try {
      return conversationStorageMode === 'sessionStorage' ? sessionStorage : localStorage;
    } catch (e) {
      return null;
    }
  }

  function getOrCreateShopperId() {
    try {
      let id = localStorage.getItem(SHOPPER_ID_KEY);
      if (!id || !String(id).trim()) {
        id =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `anon_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(SHOPPER_ID_KEY, id);
      }
      return String(id).trim();
    } catch (e) {
      return `anon_${Date.now()}`;
    }
  }

  function sessionsCacheKey(shopperId = getOrCreateShopperId()) {
    return SESSIONS_CACHE_PREFIX + String(shopperId || '').trim();
  }

  function activeConversationCacheKey(shopperId = getOrCreateShopperId()) {
    return ACTIVE_CONVERSATION_PREFIX + String(shopperId || '').trim();
  }

  function clearLegacyConversationStorage() {
    try {
      localStorage.removeItem(LEGACY_CONVERSATION_ID_KEY);
      sessionStorage.removeItem(LEGACY_CONVERSATION_ID_KEY);
      localStorage.removeItem(LEGACY_SESSIONS_INDEX_KEY);
      sessionStorage.removeItem(LEGACY_SESSIONS_INDEX_KEY);
    } catch (e) {
      // ignore
    }
  }

  function resolveConversationStorageMode(mode) {
    return String(mode || '').toLowerCase() === 'sessionstorage'
      ? 'sessionStorage'
      : 'localStorage';
  }

  function coerceTimestamp(value, fallback = Date.now()) {
    if (value == null || value === '') return fallback;

    if (typeof value === 'number' && Number.isFinite(value)) {
      // Unix seconds vs milliseconds
      return value > 0 && value < 1e12 ? value * 1000 : value;
    }

    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && String(value).trim() !== '') {
      return asNumber > 0 && asNumber < 1e12 ? asNumber * 1000 : asNumber;
    }

    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  function normalizeSessionEntry(s) {
    if (!s || !s.id) return null;
    return {
      id: String(s.id),
      title: s.title || 'Chat',
      preview: s.preview || '',
      updatedAt: coerceTimestamp(s.updatedAt, Date.now())
    };
  }

  function persistSessionsToStorage(sessions) {
    const store = getBrowserStore();
    if (!store) return;
    try {
      const list = (Array.isArray(sessions) ? sessions : [])
        .map(normalizeSessionEntry)
        .filter(Boolean);
      store.setItem(sessionsCacheKey(), JSON.stringify(list));
    } catch (e) {
      // ignore quota / private mode
    }
  }

  function loadSessionsFromStorage() {
    const store = getBrowserStore();
    if (!store) return [];
    try {
      const raw = store.getItem(sessionsCacheKey());
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeSessionEntry).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  function persistActiveConversationToStorage(id) {
    const store = getBrowserStore();
    if (!store) return;
    try {
      const key = activeConversationCacheKey();
      if (id) store.setItem(key, String(id));
      else store.removeItem(key);
    } catch (e) {
      // ignore
    }
  }

  function loadActiveConversationFromStorage() {
    const store = getBrowserStore();
    if (!store) return null;
    try {
      const id = store.getItem(activeConversationCacheKey());
      return id && String(id).trim() ? String(id).trim() : null;
    } catch (e) {
      return null;
    }
  }

  function hydrateShopperCacheFromStorage() {
    sessionsMemory = loadSessionsFromStorage();
    const cachedId = loadActiveConversationFromStorage();
    if (cachedId) {
      activeConversationId = cachedId;
    }
  }

  function getConversationId() {
    return activeConversationId || null;
  }

  function setConversationId(id) {
    activeConversationId = id ? String(id) : null;
    persistActiveConversationToStorage(activeConversationId);
  }

  function clearConversationId() {
    activeConversationId = null;
    persistActiveConversationToStorage(null);
  }

  async function resolveShopperSessionFromServer(options = {}) {
    const apiBaseUrl = getApiBaseUrl();
    const payload = {
      ...getCustomerContextPayload(),
      action: options.action || 'get',
      ...(options.conversation_id
        ? { conversation_id: options.conversation_id }
        : {})
    };

    const response = await fetch(`${apiBaseUrl}/chat/shopper-session`, {
      method: 'POST',
      headers: getApiHeaders({
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`shopper-session ${response.status} ${text}`.trim());
    }

    const data = await response.json();
    if (Object.prototype.hasOwnProperty.call(data, 'conversation_id')) {
      setConversationId(data.conversation_id || null);
    }
    if (Array.isArray(data.sessions)) {
      sessionsMemory = data.sessions.map(normalizeSessionEntry).filter(Boolean);
      persistSessionsToStorage(sessionsMemory);
    }
    return data;
  }

  /**
   * Fetch shopper-session at most once per page load.
   * Conversation switches / new chats use localStorage + chat API bind.
   */
  async function resolveShopperSessionOnceOnLoad() {
    if (shopperSessionFetched) return null;
    shopperSessionFetched = true;
    try {
      return await resolveShopperSessionFromServer({ action: 'get' });
    } catch (error) {
      shopperSessionFetched = false;
      throw error;
    }
  }

  function createLocalConversationId() {
    return String(Date.now());
  }

  function getCustomerContextPayload() {
    const config = window.shopChatConfig || {};
    const firstName = String(config.customerFirstName || '').trim();
    const lastName = String(config.customerLastName || '').trim();
    const customerId = String(config.customerId || '').trim();
    const shopDomain = String(window.shopDomain || config.shopDomain || '').trim();
    const payload = {};

    if (config.customerLoggedIn === true || customerId) {
      payload.customer_logged_in = true;
    }
    if (customerId) {
      payload.customer_id = customerId;
    }
    if (firstName) {
      payload.customer_first_name = firstName;
    }
    if (lastName) {
      payload.customer_last_name = lastName;
    }
    if (shopDomain) {
      payload.shop = shopDomain;
    }
    const shopperId = getOrCreateShopperId();
    if (shopperId) {
      payload.shopper_id = shopperId;
    }

    return payload;
  }

  /**
   * Push Liquid customer.addresses into app DB (logged-in page load only).
   * Does not put addresses into the LLM prompt — tool reads DB later.
   */
  async function syncCustomerAddressesToServer() {
    const config = window.shopChatConfig || {};
    const customerId = getLoggedInCustomerId();
    if (!customerId || !isCustomerLoggedIn()) return null;

    const shopDomain = String(window.shopDomain || config.shopDomain || '').trim();
    if (!shopDomain) {
      console.warn('Skipping address sync: missing shop domain');
      return null;
    }

    const addresses = Array.isArray(config.customerAddresses)
      ? config.customerAddresses
      : [];
    const email = String(config.customerEmail || '').trim();

    try {
      const apiBaseUrl = getApiBaseUrl();
      const response = await fetch(`${apiBaseUrl}/chat/customer-addresses`, {
        method: 'POST',
        headers: getApiHeaders({
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify({
          ...getCustomerContextPayload(),
          customer_email: email || undefined,
          addresses
        })
      });

      if (!response.ok) {
        console.warn('Failed to sync customer addresses', response.status);
        return null;
      }

      return await response.json();
    } catch (error) {
      console.warn('Customer address sync error', error);
      return null;
    }
  }

  function isCustomerLoggedIn() {
    const config = window.shopChatConfig || {};
    return config.customerLoggedIn === true || Boolean(String(config.customerId || '').trim());
  }

  function getLoggedInCustomerId() {
    return String(window.shopChatConfig?.customerId || '').trim();
  }

  /**
   * Include variant_id so similar titles (e.g. freshener scents) add the correct product.
   * Full text is sent to the API; the chat bubble hides the variant_id.
   */
  function buildAddToCartMessage(product) {
    const title = String(product?.title || 'this product').trim() || 'this product';
    const variantId = String(
      product?.variantId || product?.variant_id || product?.id || ''
    ).trim();
    if (variantId && /ProductVariant\//i.test(variantId)) {
      return `Add "${title}" to my cart using variant_id: ${variantId}`;
    }
    return `Add ${title} to my cart`;
  }

  /** Hide Shopify variant GIDs from what the customer sees in chat. */
  function stripVariantIdForDisplay(text) {
    return String(text || '')
      .replace(/\s*using\s+variant_id:\s*gid:\/\/shopify\/ProductVariant\/\d+/gi, '')
      .replace(/\s*variant_id:\s*gid:\/\/shopify\/ProductVariant\/\d+/gi, '')
      .replace(/\s*gid:\/\/shopify\/ProductVariant\/\d+/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /** Only hit /cart.js + theme sync for cart/checkout/shipping-related messages. */
  function shouldSyncThemeCartForMessage(text) {
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return false;
    return /\b(cart|checkout|check[\s-]?out|add(?:ing)?(?:\s+\w+){0,4}\s+to\s+(?:my\s+)?cart|remove(?:\s+\w+){0,4}\s+from\s+(?:my\s+)?cart|empty\s+cart|clear\s+cart|shipping|address|discount|promo|coupon|proceed\s+to\s+pay|quantity|qty)\b/i.test(
      t
    );
  }

  function getStaticWelcomeFallback() {
    return window.shopChatConfig?.welcomeMessage || "I can help with cabin air filters and vehicle fitment, cabin filter air fresheners, and home filters.";
  }

  function getAssistantName() {
    return String(window.shopChatConfig?.assistantName || 'AIRA').trim() || 'AIRA';
  }

  /** Display name: "AIRA" / "aira" → "Aira" */
  function getAssistantDisplayName() {
    const raw = getAssistantName();
    if (!raw) return 'Aira';
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function decodeHtmlEntities(text) {
    const el = document.createElement('textarea');
    el.innerHTML = String(text || '');
    return el.value;
  }

  function getCustomerFirstName() {
    const config = window.shopChatConfig || {};
    const raw = String(config.customerFirstName || '').trim();
    if (!raw) return '';
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  /**
   * Home greeting: "Hi Ayush, I'm Aira!" when named, else "Hi, I'm Aira!"
   * Returns safe HTML with assistant name bolded.
   */
  function getHomeGreetingHtml() {
    const config = window.shopChatConfig || {};
    const assistant = getAssistantDisplayName();
    const customer = getCustomerFirstName();
    const boldName = `<strong class="shop-ai-greeting-name">${escapeHtml(assistant)}</strong>`;

    if (customer) {
      const template = decodeHtmlEntities(
        config.greetingWithName || "Hi {customer}, I'm {name}!<br>How can I help?"
      );
      return template
        .replace(/\{customer\}/g, escapeHtml(customer))
        .replace(/\{name\}/g, boldName);
    }

    const template = decodeHtmlEntities(
      config.greetingAnonymous || "Hi, I'm {name}!<br>How can I help?"
    );
    return template.replace(/\{name\}/g, boldName);
  }

  function readSessionsIndex() {
    return Array.isArray(sessionsMemory) ? sessionsMemory.slice() : [];
  }

  function writeSessionsIndex(sessions) {
    sessionsMemory = Array.isArray(sessions) ? sessions.slice() : [];
    persistSessionsToStorage(sessionsMemory);
  }

  function formatSessionDate(timestamp) {
    const date = new Date(coerceTimestamp(timestamp, Date.now()));
    if (Number.isNaN(date.getTime())) return '';

    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = date.toDateString() === yesterday.toDateString();

    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (isToday) return `Today · ${time}`;
    if (isYesterday) return `Yesterday · ${time}`;
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  const Sessions = {
    upsert: function(conversationId, patch = {}) {
      if (!conversationId) return;
      const sessions = readSessionsIndex();
      const index = sessions.findIndex((s) => s.id === conversationId);
      const existing = index >= 0 ? sessions[index] : { id: conversationId, title: 'New chat', preview: '', updatedAt: Date.now() };
      const next = {
        ...existing,
        ...patch,
        id: conversationId,
        updatedAt: coerceTimestamp(patch.updatedAt, Date.now())
      };

      if (index >= 0) {
        sessions.splice(index, 1);
      }
      sessions.unshift(next);
      writeSessionsIndex(sessions);
      return next;
    },

    touchFromMessage: function(conversationId, userMessage) {
      const text = stripVariantIdForDisplay(userMessage);
      if (!conversationId || !text) return;
      const sessions = readSessionsIndex();
      const existing = sessions.find((s) => s.id === conversationId);
      const title = existing?.title && existing.title !== 'New chat'
        ? existing.title
        : text.slice(0, 48) + (text.length > 48 ? '…' : '');

      this.upsert(conversationId, {
        title,
        preview: text.slice(0, 80),
        updatedAt: Date.now()
      });
    },

    list: function() {
      return readSessionsIndex().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },

    remove: function(conversationId) {
      writeSessionsIndex(readSessionsIndex().filter((s) => s.id !== conversationId));
    },

    replaceAll: function(sessions) {
      const list = Array.isArray(sessions) ? sessions : [];
      writeSessionsIndex(list.map(normalizeSessionEntry).filter(Boolean));
    },

    /**
     * When logged in: claim local sessions, then load server list for this customer.
     */
    syncFromServer: async function() {
      const customerId = getLoggedInCustomerId();
      if (!customerId || !isCustomerLoggedIn()) {
        return this.list();
      }

      try {
        const apiBaseUrl = getApiBaseUrl();
        const localIds = this.list().map((s) => s.id);
        const currentId = getConversationId();
        if (currentId && !localIds.includes(currentId)) {
          localIds.push(currentId);
        }

        const response = await fetch(`${apiBaseUrl}/chat/sessions`, {
          method: 'POST',
          headers: getApiHeaders({
            Accept: 'application/json',
            'Content-Type': 'application/json'
          }),
          body: JSON.stringify({
            customer_id: customerId,
            conversation_ids: localIds,
            ...getCustomerContextPayload()
          })
        });

        if (!response.ok) {
          console.warn('Failed to sync chat sessions', response.status);
          return this.list();
        }

        const data = await response.json();
        if (Array.isArray(data.sessions)) {
          this.replaceAll(data.sessions);
        }
        return this.list();
      } catch (error) {
        console.warn('Chat session sync failed', error);
        return this.list();
      }
    }
  };

  const ShopAIChat = {
    Config: {
      load: async function() {
        const fromTheme = window.shopChatConfig?.conversationStorage;
        if (fromTheme) {
          conversationStorageMode = resolveConversationStorageMode(fromTheme);
        }

        try {
          const apiBaseUrl = getApiBaseUrl();
          const response = await fetch(`${apiBaseUrl}/chat?config=true`, {
            headers: getApiHeaders({ Accept: 'application/json' })
          });

          if (response.ok) {
            const data = await response.json();
            if (!fromTheme && data.conversationStorage) {
              conversationStorageMode = resolveConversationStorageMode(data.conversationStorage);
            }
            window.shopChatConfig = window.shopChatConfig || {};
            if (data.speak && typeof data.speak === 'object') {
              const mode = String(data.speak.mode || '').toLowerCase();
              window.shopChatConfig.speak = {
                mode: mode || (data.speak.enabled === false ? 'off' : 'auto'),
                enabled: data.speak.enabled !== false,
                edgeEnabled: data.speak.edgeEnabled !== false,
                browserEnabled: data.speak.browserEnabled !== false
              };
            }
            if (typeof data.showToolCallsInChat === 'boolean') {
              window.shopChatConfig.showToolCallsInChat = data.showToolCallsInChat;
            }
          }
        } catch (error) {
          console.warn('Could not load chat config; using defaults', error);
        }
      }
    },

    /**
     * UI-related elements and functionality
     */
    UI: {
      elements: {},
      isMobile: false,

      /**
       * Initialize UI elements and event listeners
       * @param {HTMLElement} container - The main container element
       */
      init: function(container) {
        if (!container) return;

        // Cache DOM elements
        this.elements = {
          container: container,
          chatBubble: container.querySelector('.shop-ai-chat-bubble'),
          chatWindow: container.querySelector('.shop-ai-chat-window'),
          homeButton: container.querySelector('.shop-ai-home-btn'),
          homeView: container.querySelector('.shop-ai-home-view'),
          chatView: container.querySelector('.shop-ai-chat-view'),
          greetingEl: container.querySelector('[data-greeting-target]'),
          greetingSubEl: container.querySelector('[data-greeting-sub-target]'),
          sessionsList: container.querySelector('.shop-ai-sessions-list'),
          suggestionChips: container.querySelectorAll('.shop-ai-suggestion-chip'),
          expandButton: container.querySelector('.shop-ai-chat-expand'),
          closeButton: container.querySelector('.shop-ai-chat-close'),
          chatInput: container.querySelector('.shop-ai-chat-input-field'),
          inputWrap: container.querySelector('.shop-ai-input-wrap'),
          voiceButton: container.querySelector('.shop-ai-voice-btn'),
          voiceStatus: container.querySelector('.shop-ai-voice-status'),
          sendButton: container.querySelector('.shop-ai-chat-send'),
          messagesContainer: container.querySelector('.shop-ai-chat-messages'),
          bubbleCallout: container.querySelector('.shop-ai-bubble-callout'),
          bubbleCalloutText: container.querySelector('[data-callout-text]'),
          bubbleCalloutBody: container.querySelector('.shop-ai-bubble-callout-body'),
          bubbleCalloutDismiss: container.querySelector('.shop-ai-bubble-callout-dismiss')
        };

        this.currentView = 'home';
        this.pendingNewChat = true;
        this.isResponding = false;
        this.updateGreeting();
        this.renderSessionsList();

        this.syncChatOpenState();
        this.restoreExpandedState();

        // Detect mobile device
        this.isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

        // Set up event listeners
        this.setupEventListeners();
        this.setupHeaderTooltips();
        this.setupBubbleCallout();
        ShopAIChat.Voice.init(this.elements, this);
        requestAnimationFrame(() => {
          this.autoResizeChatInput(this.elements.chatInput);
        });

        // Fix for iOS Safari viewport height issues
        if (this.isMobile) {
          this.setupMobileViewport();
        }
      },

      /**
       * Set up all event listeners for UI interactions
       */
      setupEventListeners: function() {
        const {
          chatBubble,
          homeButton,
          suggestionChips,
          expandButton,
          closeButton,
          chatInput,
          sendButton,
          messagesContainer
        } = this.elements;

        // Toggle chat window visibility
        chatBubble.addEventListener('click', () => this.toggleChatWindow());

        if (homeButton) {
          homeButton.addEventListener('click', () => this.showHomeView());
        }

        suggestionChips.forEach((chip) => {
          chip.addEventListener('click', () => {
            if (this.isResponding) return;
            const suggestion = chip.dataset.suggestion || chip.textContent.trim();
            if (!suggestion) return;
            this.showChatView();
            ShopAIChat.Message.sendText(suggestion, messagesContainer);
          });
        });

        // Expand / collapse chat window (desktop)
        if (expandButton) {
          expandButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this.toggleExpanded();
          });
        }

        // Close chat window
        closeButton.addEventListener('click', () => this.closeChatWindow());

        // Send on Enter; Shift+Enter adds a new line
        chatInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey && chatInput.value.trim() !== '') {
            e.preventDefault();
            if (this.isResponding) return;
            this.showChatView();
            ShopAIChat.Message.send(chatInput, messagesContainer);

            if (this.isMobile) {
              chatInput.blur();
              setTimeout(() => chatInput.focus(), 300);
            }
          }
        });

        chatInput.addEventListener('input', () => {
          this.autoResizeChatInput(chatInput);
        });

        // Send message when clicking send button
        sendButton.addEventListener('click', () => {
          if (this.isResponding) return;
          if (chatInput.value.trim() !== '') {
            this.showChatView();
            ShopAIChat.Message.send(chatInput, messagesContainer);

            // On mobile, focus input after sending
            if (this.isMobile) {
              setTimeout(() => chatInput.focus(), 300);
            }
          }
        });

        // After keyboard closes, restore full viewport height (iOS)
        if (this.isMobile && chatInput) {
          chatInput.addEventListener('blur', () => {
            this.scheduleViewportHeightRefresh();
          });
        }

        // Handle window resize to adjust scrolling
        window.addEventListener('resize', () => this.scrollToBottom());

        // Add global click handler for auth links
        document.addEventListener('click', function(event) {
          if (event.target && event.target.classList.contains('shop-auth-trigger')) {
            event.preventDefault();
            if (window.shopAuthUrl) {
              ShopAIChat.Auth.openAuthPopup(window.shopAuthUrl);
            }
          }
        });
      },

      /**
       * Real-world chat pattern: collapse to 0, measure scrollHeight, clamp to line range.
       */
      autoResizeChatInput: function(chatInput) {
        if (!chatInput) return;

        const lineHeight = 20;
        const singleLineHeight = lineHeight;
        const maxHeight = lineHeight * 6;
        const prevHeight = parseInt(chatInput.style.height, 10) || singleLineHeight;

        if (!chatInput.value.trim()) {
          chatInput.style.height = `${singleLineHeight}px`;
          chatInput.style.overflowY = 'hidden';
          if (prevHeight !== singleLineHeight) {
            this.scrollContentForInput();
          }
          return;
        }

        chatInput.style.height = `${singleLineHeight}px`;
        const contentHeight = chatInput.scrollHeight;
        const nextHeight = Math.max(singleLineHeight, Math.min(contentHeight, maxHeight));

        chatInput.style.height = `${nextHeight}px`;
        if (contentHeight > maxHeight) {
          chatInput.style.overflowY = 'auto';
        } else {
          chatInput.style.overflowY = 'hidden';
        }

        const voiceActive = Boolean(
          ShopAIChat.Voice?.isListening || ShopAIChat.Voice?.keepListening
        );

        if (voiceActive || contentHeight > maxHeight) {
          chatInput.scrollTop = chatInput.scrollHeight;
        }

        if (nextHeight !== prevHeight) {
          this.scrollContentForInput();
        }
      },

      /**
       * Keep caret at the end of dictated text and scroll the input to show it.
       */
      syncInputCaretToEnd: function(chatInput, options = {}) {
        if (!chatInput) return;

        const end = chatInput.value.length;
        const shouldFocus = options.focus !== false;

        if (shouldFocus && document.activeElement !== chatInput) {
          chatInput.focus({ preventScroll: false });
        }

        try {
          chatInput.setSelectionRange(end, end);
        } catch (error) {
          // Ignore if the field is not focusable yet.
        }

        this.autoResizeChatInput(chatInput);

        requestAnimationFrame(() => {
          chatInput.scrollTop = chatInput.scrollHeight;
          this.scrollContentForInput();
        });
      },

      /**
       * Keep chat/home content visible when the input bar grows (e.g. voice dictation).
       */
      scrollContentForInput: function() {
        if (this._scrollInputRaf) return;

        this._scrollInputRaf = requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this._scrollInputRaf = null;

            const { messagesContainer, homeView, chatView } = this.elements;
            const voiceActive = Boolean(
              ShopAIChat.Voice?.isListening || ShopAIChat.Voice?.keepListening
            );

            let scrollEl = null;
            if (chatView && !chatView.hidden && messagesContainer) {
              scrollEl = messagesContainer;
            } else if (homeView && !homeView.hidden) {
              scrollEl = homeView;
            }

            if (!scrollEl) return;

            const nearBottom =
              scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= 96;

            if (voiceActive || nearBottom) {
              scrollEl.scrollTop = scrollEl.scrollHeight;
            }
          });
        });
      },

      /**
       * Setup mobile-specific viewport adjustments
       */
      setupMobileViewport: function() {
        this.updateViewportHeight = function() {
          const height = window.visualViewport
            ? window.visualViewport.height
            : window.innerHeight;
          document.documentElement.style.setProperty('--viewport-height', `${height}px`);
        };

        this.updateViewportHeight();
        window.addEventListener('resize', this.updateViewportHeight);
        if (window.visualViewport) {
          window.visualViewport.addEventListener('resize', this.updateViewportHeight);
        }
      },

      /**
       * Keep launcher bubble from covering the input bar on mobile.
       */
      syncChatOpenState: function() {
        const { container, chatWindow } = this.elements;
        if (!container || !chatWindow) return;

        const isOpen = chatWindow.classList.contains('active');
        container.classList.toggle('shop-ai-chat-window-open', isOpen);
      },

      scheduleViewportHeightRefresh: function() {
        if (!this.isMobile || typeof this.updateViewportHeight !== 'function') return;

        const refresh = this.updateViewportHeight;
        refresh();
        setTimeout(refresh, 120);
        setTimeout(refresh, 350);
      },

      /**
       * Toggle chat window visibility
       */
      toggleChatWindow: function() {
        const { chatWindow, chatInput } = this.elements;

        chatWindow.classList.toggle('active');

        if (chatWindow.classList.contains('active')) {
          this.dismissBubbleCallout();
          // On mobile, prevent body scrolling and delay focus
          if (this.isMobile) {
            document.body.classList.add('shop-ai-chat-open');
            setTimeout(() => chatInput.focus(), 500);
          } else {
            chatInput.focus();
          }
          this.updateGreeting();
          this.renderSessionsList();
          // Always scroll messages to bottom when opening
          this.scrollToBottom();
          ShopAIChat.ThemeCart.importThemeCartIntoChat({ reason: 'chat-open' }).catch(() => {});
        } else {
          // Remove body class when closing
          document.body.classList.remove('shop-ai-chat-open');
          this.scheduleViewportHeightRefresh();
          ShopAIChat.Voice.stop();
          ShopAIChat.Speak.stop();
        }

        this.syncChatOpenState();
      },

      /**
       * Close chat window
       */
      closeChatWindow: function() {
        const { chatWindow, chatInput } = this.elements;

        chatWindow.classList.remove('active');

        ShopAIChat.Voice.stop();
        ShopAIChat.Speak.stop();

        // On mobile, blur input to hide keyboard and enable body scrolling
        if (this.isMobile) {
          chatInput.blur();
          document.body.classList.remove('shop-ai-chat-open');
          this.scheduleViewportHeightRefresh();
        }

        this.syncChatOpenState();
      },

      /**
       * Toggle expanded popup size (desktop only).
       */
      toggleExpanded: function(forceExpanded) {
        const { chatWindow, expandButton } = this.elements;
        if (!chatWindow || this.isMobile) return;

        const shouldExpand =
          typeof forceExpanded === 'boolean'
            ? forceExpanded
            : !chatWindow.classList.contains('expanded');

        chatWindow.classList.toggle('expanded', shouldExpand);
        sessionStorage.setItem(CHAT_EXPANDED_KEY, shouldExpand ? '1' : '0');
        this.updateExpandButtonLabels(shouldExpand);

        this.scrollToBottom();
      },

      restoreExpandedState: function() {
        const { chatWindow } = this.elements;
        if (!chatWindow || this.isMobile) return;

        const saved = sessionStorage.getItem(CHAT_EXPANDED_KEY);
        if (saved === '1') {
          chatWindow.classList.add('expanded');
          this.updateExpandButtonLabels(true);
        }
      },

      updateExpandButtonLabels: function(isExpanded) {
        const { expandButton } = this.elements;
        if (!expandButton) return;

        const expandLabel =
          window.shopChatConfig?.expandButtonLabel || 'Expand';
        const collapseLabel =
          window.shopChatConfig?.collapseButtonLabel || 'Minimize';
        const label = isExpanded ? collapseLabel : expandLabel;
        expandButton.setAttribute('aria-label', label);
        const tipEl = expandButton.querySelector('.shop-ai-tip');
        if (tipEl) {
          tipEl.textContent = label;
        }
      },

      setupHeaderTooltips: function() {
        const tipButtons = this.elements.container?.querySelectorAll('.shop-ai-has-tip');
        if (!tipButtons) return;

        tipButtons.forEach((button) => {
          button.addEventListener('mouseenter', () => {
            button.classList.add('is-tip-visible');
          });
          button.addEventListener('mouseleave', () => {
            button.classList.remove('is-tip-visible');
          });
          button.addEventListener('focus', () => {
            button.classList.add('is-tip-visible');
          });
          button.addEventListener('blur', () => {
            button.classList.remove('is-tip-visible');
          });
        });
      },

      /**
       * Launcher tip on each page load: "Hi Shivam, I'm Aira!" with wave.
       * Hides after dismiss or opening chat (this page visit only).
       */
      setupBubbleCallout: function() {
        const {
          bubbleCallout,
          bubbleCalloutText,
          bubbleCalloutBody,
          bubbleCalloutDismiss,
          chatWindow
        } = this.elements;

        if (!bubbleCallout || !bubbleCalloutText) return;

        bubbleCalloutText.innerHTML = getHomeGreetingHtml();

        if (bubbleCalloutBody) {
          bubbleCalloutBody.addEventListener('click', () => {
            this.dismissBubbleCallout();
            if (chatWindow && !chatWindow.classList.contains('active')) {
              this.toggleChatWindow();
            }
          });
        }

        if (bubbleCalloutDismiss) {
          bubbleCalloutDismiss.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.dismissBubbleCallout();
          });
        }

        // Clear old forever-flag so refresh can show the tip again
        try {
          localStorage.removeItem(BUBBLE_CALLOUT_KEY);
        } catch {
          // ignore
        }

        if (chatWindow?.classList.contains('active')) return;

        bubbleCallout.hidden = false;
        // Double rAF so the enter transition runs after paint
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            bubbleCallout.classList.add('is-visible');
          });
        });
      },

      dismissBubbleCallout: function() {
        const { bubbleCallout } = this.elements;
        if (this._calloutTimer) {
          clearTimeout(this._calloutTimer);
          this._calloutTimer = null;
        }
        if (!bubbleCallout) return;

        bubbleCallout.classList.remove('is-visible');
        setTimeout(() => {
          bubbleCallout.hidden = true;
        }, 280);
      },

      updateGreeting: function() {
        const { greetingEl, greetingSubEl } = this.elements;
        if (greetingEl) {
          greetingEl.innerHTML = getHomeGreetingHtml();
        }
        if (greetingSubEl) {
          const sub =
            window.shopChatConfig?.greetingSubtitle ||
            'Here to help you find the right cabin air filters, vehicle fitment, cabin filter air fresheners, and home filters.';
          greetingSubEl.textContent = decodeHtmlEntities(sub);
        }

        const { bubbleCalloutText } = this.elements;
        if (bubbleCalloutText) {
          bubbleCalloutText.innerHTML = getHomeGreetingHtml();
        }
      },

      showHomeView: function() {
        const { homeView, chatView, chatWindow } = this.elements;
        if (!homeView || !chatView) return;

        this.currentView = 'home';
        homeView.hidden = false;
        chatView.hidden = true;
        if (chatWindow) {
          chatWindow.classList.add('is-home-view');
        }
        this.pendingNewChat = true;
        this.updateGreeting();
        this.renderSessionsList();
      },

      showChatView: function() {
        const { homeView, chatView, chatWindow } = this.elements;
        if (!homeView || !chatView) return;

        this.currentView = 'chat';
        homeView.hidden = true;
        chatView.hidden = false;
        if (chatWindow) {
          chatWindow.classList.remove('is-home-view');
        }
      },

      clearMessages: function() {
        const { messagesContainer } = this.elements;
        if (messagesContainer) {
          messagesContainer.innerHTML = '';
        }
      },

      renderSessionsList: function() {
        const { sessionsList } = this.elements;
        if (!sessionsList) return;

        const sessions = Sessions.list();
        const currentId = getConversationId();
        sessionsList.innerHTML = '';

        if (!sessions.length) {
          const empty = document.createElement('p');
          empty.classList.add('shop-ai-sessions-empty');
          empty.textContent = window.shopChatConfig?.noSessionsLabel || 'No previous chats yet.';
          sessionsList.appendChild(empty);
          return;
        }

        sessions.forEach((session) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.classList.add('shop-ai-session-item');
          if (session.id === currentId) {
            button.classList.add('is-active');
          }

          button.innerHTML =
            '<svg class="shop-ai-session-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>' +
            '<span class="shop-ai-session-body">' +
            `<span class="shop-ai-session-title">${this.escapeHtml(session.title || 'Chat')}</span>` +
            `<span class="shop-ai-session-meta">${formatSessionDate(session.updatedAt || Date.now())}</span>` +
            '</span>';

          button.addEventListener('click', () => {
            this.loadSession(session.id);
          });

          sessionsList.appendChild(button);
        });
      },

      escapeHtml: function(text) {
        const div = document.createElement('div');
        div.textContent = String(text || '');
        return div.innerHTML;
      },

      loadSession: async function(conversationId) {
        if (!conversationId) return;

        this.pendingNewChat = false;
        // Use cached conversation id — history only; no shopper-session call.
        setConversationId(conversationId);
        this.clearMessages();
        this.showChatView();
        this.renderSessionsList();

        await ShopAIChat.API.fetchChatHistory(
          conversationId,
          this.elements.messagesContainer
        );
        ShopAIChat.ThemeCart.importThemeCartIntoChat({ reason: 'load-session' }).catch(() => {});
      },

      /**
       * Lock/unlock sending while the assistant is responding.
       */
      setSendingState: function(isResponding) {
        this.isResponding = Boolean(isResponding);

        const { sendButton, chatInput, voiceButton, suggestionChips, chatWindow } = this.elements;

        if (sendButton) {
          sendButton.disabled = this.isResponding;
          sendButton.classList.toggle('is-disabled', this.isResponding);
          sendButton.setAttribute('aria-disabled', this.isResponding ? 'true' : 'false');
        }

        if (chatInput) {
          chatInput.readOnly = this.isResponding;
          chatInput.classList.toggle('is-responding', this.isResponding);
        }

        if (voiceButton) {
          voiceButton.disabled = this.isResponding;
        }

        if (suggestionChips) {
          suggestionChips.forEach((chip) => {
            chip.disabled = this.isResponding;
          });
        }

        if (chatWindow) {
          chatWindow.classList.toggle('is-responding', this.isResponding);
        }

        if (this.isResponding) {
          ShopAIChat.Voice.stop();
          ShopAIChat.Speak.stop();
        }
      },

      /**
       * Scroll messages container to bottom
       */
      scrollToBottom: function() {
        const { messagesContainer } = this.elements;
        setTimeout(() => {
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }, 100);
      },

      /**
       * Show typing indicator in the chat (at most one at a time).
       */
      showTypingIndicator: function() {
        const { messagesContainer } = this.elements;

        this.removeTypingIndicator();

        const typingIndicator = document.createElement('div');
        typingIndicator.classList.add('shop-ai-typing-indicator');
        typingIndicator.innerHTML = '<span></span><span></span><span></span>';
        messagesContainer.appendChild(typingIndicator);
        this.scrollToBottom();
      },

      /**
       * Remove all typing indicators from the chat
       */
      removeTypingIndicator: function() {
        const { messagesContainer } = this.elements;

        messagesContainer
          .querySelectorAll('.shop-ai-typing-indicator')
          .forEach((el) => el.remove());
      },

      /**
       * Display clickable engine / qualifier suggestion buttons
       */
      displayFitmentOptions: function(payload) {
        const { messagesContainer, chatInput } = this.elements;
        const options = Array.isArray(payload?.options) ? payload.options : [];
        if (!options.length) return;

        // Remove any previous unused suggestion chips
        messagesContainer
          .querySelectorAll('.shop-ai-fitment-options')
          .forEach((el) => el.remove());

        const wrap = document.createElement('div');
        wrap.classList.add('shop-ai-fitment-options');

        if (payload.title) {
          const title = document.createElement('div');
          title.classList.add('shop-ai-fitment-options-title');
          title.textContent = payload.title;
          wrap.appendChild(title);
        }

        const list = document.createElement('div');
        list.classList.add('shop-ai-fitment-options-list');

        options.forEach((option) => {
          const label = option.label || option.value;
          const value = option.value || option.label;
          if (!label || !value) return;

          const button = document.createElement('button');
          button.type = 'button';
          button.classList.add('shop-ai-fitment-option');
          button.textContent = label;
          button.addEventListener('click', () => {
            if (wrap.classList.contains('is-used')) return;
            wrap.classList.add('is-used');
            wrap.querySelectorAll('.shop-ai-fitment-option').forEach((btn) => {
              btn.disabled = true;
              if (btn === button) btn.classList.add('is-selected');
            });

            if (chatInput) chatInput.value = '';
            ShopAIChat.UI.showChatView();
            ShopAIChat.Message.sendText(value, messagesContainer);
          });
          list.appendChild(button);
        });

        wrap.appendChild(list);
        messagesContainer.appendChild(wrap);

        // Buttons already show the choices — drop the duplicate list from assistant text
        const assistants = messagesContainer.querySelectorAll('.shop-ai-message.assistant');
        for (let i = assistants.length - 1; i >= 0; i -= 1) {
          const el = assistants[i];
          if (!el.dataset.rawText || !el.dataset.rawText.trim()) continue;
          el.dataset.rawText = ShopAIChat.Formatting.stripListedFitmentOptions(
            el.dataset.rawText,
            options
          );
          ShopAIChat.Formatting.formatMessageContent(el);
          break;
        }

        this.scrollToBottom();
      },

      /**
       * Compact <select> for saved Shopify addresses (logged-in customers).
       */
      displayCustomerAddresses: function(payload) {
        const { messagesContainer, chatInput } = this.elements;
        const addresses = Array.isArray(payload?.addresses) ? payload.addresses : [];
        if (!addresses.length) return;

        messagesContainer
          .querySelectorAll('.shop-ai-address-select')
          .forEach((el) => el.remove());

        const wrap = document.createElement('div');
        wrap.classList.add('shop-ai-address-select');

        const title = document.createElement('div');
        title.classList.add('shop-ai-address-select-title');
        title.textContent = payload.title || 'Select a saved address';
        wrap.appendChild(title);

        const row = document.createElement('div');
        row.classList.add('shop-ai-address-select-row');

        const select = document.createElement('select');
        select.classList.add('shop-ai-address-select-input');
        select.setAttribute('aria-label', 'Saved shipping addresses');

        addresses.forEach((address, index) => {
          const option = document.createElement('option');
          option.value = String(index);
          option.textContent = address.label || `Address ${index + 1}`;
          if (address.is_default) option.selected = true;
          select.appendChild(option);
        });

        const button = document.createElement('button');
        button.type = 'button';
        button.classList.add('shop-ai-address-select-use');
        button.textContent = 'Use address';

        const buildShipMessage = (address) => {
          const parts = [
            address.street_address,
            address.extended_address,
            [address.address_locality, address.address_region, address.postal_code]
              .filter(Boolean)
              .join(', '),
            address.address_country
          ].filter(Boolean);
          const name = [address.first_name, address.last_name].filter(Boolean).join(' ');
          const bits = [`Please use this saved shipping address: ${parts.join(', ')}.`];
          if (name) bits.push(`Name: ${name}.`);
          if (address.phone_number) bits.push(`Phone: ${address.phone_number}.`);
          if (address.email) bits.push(`Email: ${address.email}.`);
          return bits.join(' ');
        };

        button.addEventListener('click', () => {
          if (wrap.classList.contains('is-used')) return;
          const chosen = addresses[Number(select.value)];
          if (!chosen) return;

          wrap.classList.add('is-used');
          select.disabled = true;
          button.disabled = true;

          if (chatInput) chatInput.value = '';
          ShopAIChat.UI.showChatView();
          ShopAIChat.Message.sendText(buildShipMessage(chosen), messagesContainer);
        });

        row.appendChild(select);
        row.appendChild(button);
        wrap.appendChild(row);
        messagesContainer.appendChild(wrap);
        this.scrollToBottom();
      },

      /**
       * Compact install PDF / video links for "how do I install this".
       */
      displayInstallResources: function(payload) {
        const { messagesContainer } = this.elements;
        const products = Array.isArray(payload?.products) ? payload.products : [];
        if (!products.length) return;

        messagesContainer
          .querySelectorAll('.shop-ai-install-resources')
          .forEach((el) => el.remove());

        const wrap = document.createElement('div');
        wrap.classList.add('shop-ai-install-resources');

        const title = document.createElement('div');
        title.classList.add('shop-ai-install-resources-title');
        title.textContent = payload.title || 'Installation resources';
        wrap.appendChild(title);

        products.forEach((product) => {
          const row = document.createElement('div');
          row.classList.add('shop-ai-install-resource');

          const name = document.createElement('div');
          name.classList.add('shop-ai-install-resource-name');
          name.textContent = product.title || 'Product';
          row.appendChild(name);

          const links = document.createElement('div');
          links.classList.add('shop-ai-install-resource-links');

          if (product.pdfUrl) {
            const pdf = document.createElement('a');
            pdf.classList.add('shop-ai-product-pdf');
            pdf.href = product.pdfUrl;
            pdf.target = '_blank';
            pdf.rel = 'noopener noreferrer';
            pdf.textContent = product.pdfTitle || 'Installation Guide (PDF)';
            links.appendChild(pdf);
          }

          if (product.youtubeUrl) {
            const yt = document.createElement('a');
            yt.classList.add('shop-ai-product-youtube');
            yt.href = product.youtubeUrl;
            yt.target = '_blank';
            yt.rel = 'noopener noreferrer';
            yt.textContent = 'Installation Video';
            links.appendChild(yt);
          }

          row.appendChild(links);
          wrap.appendChild(row);
        });

        messagesContainer.appendChild(wrap);
        this.scrollToBottom();
      },

      /**
       * If this turn's assistant text landed after product cards, move it just above them.
       * Never jump over a user message (that would scramble later turns after refresh).
       */
      placeAssistantTextBeforeProducts: function(messageEl) {
        const { messagesContainer } = this.elements;
        if (!messagesContainer) return;

        const productSections = messagesContainer.querySelectorAll('.shop-ai-product-section');
        if (!productSections.length) return;

        const lastProducts = productSections[productSections.length - 1];
        const textEl = (messageEl && this.isNonEmptyAssistant(messageEl))
          ? messageEl
          : this.findSameTurnAssistantAfter(lastProducts);

        if (!textEl) return;
        if (!(textEl.compareDocumentPosition(lastProducts) & Node.DOCUMENT_POSITION_PRECEDING)) {
          return;
        }

        let node = lastProducts.nextSibling;
        while (node && node !== textEl) {
          if (node.classList && node.classList.contains('shop-ai-message') && node.classList.contains('user')) {
            return;
          }
          node = node.nextSibling;
        }

        const actionsEl =
          textEl.nextElementSibling &&
          textEl.nextElementSibling.classList.contains('shop-ai-message-actions')
            ? textEl.nextElementSibling
            : null;

        lastProducts.parentNode.insertBefore(textEl, lastProducts);
        if (actionsEl) {
          lastProducts.parentNode.insertBefore(actionsEl, lastProducts);
        } else if (ShopAIChat.Speak?.attachButton) {
          ShopAIChat.Speak.attachButton(textEl);
        }
      },

      isNonEmptyAssistant: function(el) {
        return !!(
          el &&
          el.classList &&
          el.classList.contains('shop-ai-message') &&
          el.classList.contains('assistant') &&
          String(el.dataset.rawText || el.textContent || '').trim()
        );
      },

      findSameTurnAssistantAfter: function(productSection) {
        let node = productSection.nextSibling;
        while (node) {
          if (node.classList && node.classList.contains('shop-ai-message')) {
            if (node.classList.contains('user')) return null;
            if (this.isNonEmptyAssistant(node)) return node;
          }
          node = node.nextSibling;
        }
        return null;
      },

      removeEmptyAssistant: function(el) {
        if (!el || !el.parentNode) return;
        if (!el.classList.contains('assistant')) return;
        if (String(el.dataset.rawText || el.textContent || '').trim()) return;
        const actionsEl =
          el.nextElementSibling &&
          el.nextElementSibling.classList.contains('shop-ai-message-actions')
            ? el.nextElementSibling
            : null;
        if (actionsEl) actionsEl.remove();
        el.remove();
      },

      ensureAssistantMessage: function(currentMessageElement, messagesContainer, updateCurrentElement) {
        if (currentMessageElement && currentMessageElement.parentNode) {
          return currentMessageElement;
        }
        const el = document.createElement('div');
        el.classList.add('shop-ai-message', 'assistant');
        el.textContent = '';
        el.dataset.rawText = '';
        messagesContainer.appendChild(el);
        if (typeof updateCurrentElement === 'function') {
          updateCurrentElement(el);
        }
        return el;
      },

      appendHistoryMessage: function(message, messagesContainer) {
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        const createdAt = message.createdAt || message.created_at || null;
        let blocks = null;

        try {
          const parsed = JSON.parse(message.content);
          if (Array.isArray(parsed)) blocks = parsed;
        } catch (e) {
          blocks = null;
        }

        if (!blocks) {
          const text = String(message.content || '').trim();
          if (text) {
            ShopAIChat.Message.add(text, role, messagesContainer, { createdAt });
          }
          return;
        }

        blocks.forEach((contentBlock) => {
          if (contentBlock.type === 'text' && String(contentBlock.text || '').trim()) {
            ShopAIChat.Message.add(contentBlock.text, role, messagesContainer, { createdAt });
          } else if (contentBlock.type === 'product_results' && Array.isArray(contentBlock.products)) {
            this.displayProductResults(contentBlock.products);
          } else if (contentBlock.type === 'tool_use' && contentBlock.name) {
            ShopAIChat.Message.addToolUse(
              `Calling tool: ${contentBlock.name} with arguments: ${JSON.stringify(contentBlock.input || {})}`,
              messagesContainer
            );
          }
        });
      },

      /**
       * Ensure copy/speak/time rows exist under every assistant bubble (history reload safe).
       */
      reattachAssistantActions: function(messagesContainer) {
        const root = messagesContainer || this.elements?.messagesContainer;
        if (!root || !ShopAIChat.Speak?.attachButton) return;

        root.querySelectorAll('.shop-ai-message.assistant').forEach((el) => {
          const raw = String(el.dataset.rawText || '').trim();
          const visible = String(el.textContent || '').trim();
          if (!raw && !visible) return;
          if (visible === 'Loading conversation history...') return;
          if (!el.dataset.rawText && visible) {
            el.dataset.rawText = visible;
          }
          ShopAIChat.Speak.attachButton(el);
        });
      },

      /**
       * Display product results in the chat
       * @param {Array} products - Array of product data objects
       */
      displayProductResults: function(products) {
        const { messagesContainer } = this.elements;
        console.log('[ShopAIChat] displayProductResults compare-best-12', {
          count: Array.isArray(products) ? products.length : 0,
          best: Array.isArray(products) ? products.find((p) => p && p.isBest)?.title : null
        });

        // Create a wrapper for the product section
        const productSection = document.createElement('div');
        productSection.classList.add('shop-ai-product-section');
        messagesContainer.appendChild(productSection);
        this.placeAssistantTextBeforeProducts();

        // Add a header for the product results
        const header = document.createElement('div');
        header.classList.add('shop-ai-product-header');
        header.innerHTML = '<h4>Top Matching Products</h4>';
        productSection.appendChild(header);

        const list = Array.isArray(products) ? products.slice() : [];
        const best = list.find((p) => p && p.isBest) || list[0] || null;

        // Horizontal carousel with scroll arrows (so users see more products exist)
        const carousel = document.createElement('div');
        carousel.classList.add('shop-ai-product-carousel');

        const productsContainer = document.createElement('div');
        productsContainer.classList.add('shop-ai-product-grid');

        const { prevBtn, nextBtn, refresh } = ShopAIChat.Product.createScrollControls(
          carousel,
          productsContainer,
          {
            prevLabel: 'Scroll products left',
            nextLabel: 'Scroll products right',
            stepSelector: '.shop-ai-product-card'
          }
        );

        carousel.appendChild(prevBtn);
        carousel.appendChild(productsContainer);
        carousel.appendChild(nextBtn);
        productSection.appendChild(carousel);

        if (!list.length) {
          const noProductsMessage = document.createElement('p');
          noProductsMessage.textContent = "No products found";
          noProductsMessage.style.padding = "10px";
          productsContainer.appendChild(noProductsMessage);
          prevBtn.hidden = true;
          nextBtn.hidden = true;
        } else {
          list.forEach(product => {
            const productCard = ShopAIChat.Product.createCard(product);
            productsContainer.appendChild(productCard);
          });

          refresh();
          setTimeout(refresh, 120);

          if (list.length > 1) {
            productSection.appendChild(ShopAIChat.Product.createComparisonTable(list));
          }

          if (best) {
            productSection.appendChild(ShopAIChat.Product.createBestProductSection(best));
          }
        }

        this.scrollToBottom();
      }
    },

    /**
     * Message handling and display functionality
     */
    Message: {
      /**
       * Send a message to the API
       * @param {HTMLInputElement} chatInput - The input element
       * @param {HTMLElement} messagesContainer - The messages container
       */
      send: async function(chatInput, messagesContainer) {
        const userMessage = chatInput.value.trim();
        if (!userMessage || ShopAIChat.UI?.isResponding) return;

        // Clear input
        chatInput.value = '';

        if (ShopAIChat.UI?.elements?.chatInput) {
          ShopAIChat.UI.autoResizeChatInput(ShopAIChat.UI.elements.chatInput);
        }

        await this.sendText(userMessage, messagesContainer);
      },

      /**
       * Send a prepared message (typed or from a suggestion chip)
       */
      sendText: async function(userMessage, messagesContainer) {
        const text = String(userMessage || '').trim();
        if (!text || ShopAIChat.UI?.isResponding) return;

        ShopAIChat.UI.setSendingState(true);

        try {
          let conversationId = getConversationId();
          const startingFromHome =
            ShopAIChat.UI.currentView === 'home' || ShopAIChat.UI.pendingNewChat;

          if (startingFromHome) {
            // New thread locally — chat API binds shopper_id / activeConversationId.
            conversationId = createLocalConversationId();
            setConversationId(conversationId);
            Sessions.upsert(conversationId, { title: 'New chat', updatedAt: Date.now() });
            ShopAIChat.UI.clearMessages();
            ShopAIChat.UI.pendingNewChat = false;
          } else if (!conversationId) {
            conversationId = createLocalConversationId();
            setConversationId(conversationId);
            Sessions.upsert(conversationId, { title: 'New chat', updatedAt: Date.now() });
          }

          ShopAIChat.UI.showChatView();
          Sessions.touchFromMessage(conversationId, text);
          ShopAIChat.UI.renderSessionsList();

          // Add user message to chat
          this.add(text, 'user', messagesContainer);

          // Show typing indicator
          ShopAIChat.UI.showTypingIndicator();

          await ShopAIChat.API.streamResponse(text, conversationId, messagesContainer);
        } catch (error) {
          console.error('Error communicating with the LLM API:', error);
          ShopAIChat.UI.removeTypingIndicator();
          this.add(
            "Sorry, I couldn't complete that right now. Please try again in a moment.",
            'assistant',
            messagesContainer
          );
        } finally {
          ShopAIChat.UI.setSendingState(false);
        }
      },

      /**
       * Add a message to the chat
       * @param {string} text - Message content
       * @param {string} sender - Message sender ('user' or 'assistant')
       * @param {HTMLElement} messagesContainer - The messages container
       * @returns {HTMLElement} The created message element
       */
      add: function(text, sender, messagesContainer, options = {}) {
        if (!String(text || '').trim()) return null;

        const messageElement = document.createElement('div');
        messageElement.classList.add('shop-ai-message', sender);

        if (options.createdAt) {
          const ts = coerceTimestamp(options.createdAt, NaN);
          if (!Number.isNaN(ts)) {
            messageElement.dataset.messageAt = String(ts);
          }
        } else {
          messageElement.dataset.messageAt = String(Date.now());
        }

        if (sender === 'assistant') {
          messageElement.dataset.rawText = text;
          // Append first so Speak actions can attach as a sibling under the bubble.
          messagesContainer.appendChild(messageElement);
          ShopAIChat.Formatting.formatMessageContent(messageElement);
        } else {
          // Still send full text (with variant_id) to the API; hide GIDs in the bubble.
          messageElement.textContent = stripVariantIdForDisplay(text);
          messagesContainer.appendChild(messageElement);
        }

        ShopAIChat.UI.scrollToBottom();

        return messageElement;
      },

      /**
       * Add a tool use message to the chat with expandable arguments
       * @param {string} toolMessage - Tool use message content
       * @param {HTMLElement} messagesContainer - The messages container
       */
      addToolUse: function(toolMessage, messagesContainer) {
        // Parse the tool message to extract tool name and arguments
        const match = toolMessage.match(/Calling tool: (.+?) with arguments: ([\s\S]+)/);
        if (!match) {
          // Fallback for unexpected format
          const toolUseElement = document.createElement('div');
          toolUseElement.classList.add('shop-ai-message', 'tool-use');
          toolUseElement.textContent = toolMessage;
          messagesContainer.appendChild(toolUseElement);
          ShopAIChat.UI.scrollToBottom();
          return;
        }

        const toolName = match[1];
        const argsString = match[2];

        // Create the main tool use element
        const toolUseElement = document.createElement('div');
        toolUseElement.classList.add('shop-ai-message', 'tool-use');

        // Create the header (always visible)
        const headerElement = document.createElement('div');
        headerElement.classList.add('shop-ai-tool-header');

        const toolText = document.createElement('span');
        toolText.classList.add('shop-ai-tool-text');
        toolText.textContent = `Calling tool: ${toolName}`;

        const toggleElement = document.createElement('span');
        toggleElement.classList.add('shop-ai-tool-toggle');
        toggleElement.textContent = '[+]';

        headerElement.appendChild(toolText);
        headerElement.appendChild(toggleElement);

        // Create the arguments section (initially hidden)
        const argsElement = document.createElement('div');
        argsElement.classList.add('shop-ai-tool-args');

        try {
          // Try to format JSON arguments nicely
          const parsedArgs = JSON.parse(argsString);
          argsElement.textContent = JSON.stringify(parsedArgs, null, 2);
        } catch (e) {
          // If not valid JSON, just show as-is
          argsElement.textContent = argsString;
        }

        // Add click handler to toggle arguments visibility
        headerElement.addEventListener('click', function() {
          const isExpanded = argsElement.classList.contains('expanded');
          if (isExpanded) {
            argsElement.classList.remove('expanded');
            toggleElement.textContent = '[+]';
          } else {
            argsElement.classList.add('expanded');
            toggleElement.textContent = '[-]';
          }
        });

        // Assemble the complete element
        toolUseElement.appendChild(headerElement);
        toolUseElement.appendChild(argsElement);

        messagesContainer.appendChild(toolUseElement);
        ShopAIChat.UI.scrollToBottom();
      }
    },

    /**
     * Text formatting and markdown handling
     */
    Formatting: {
      /**
       * Format message content with markdown and links
       * @param {HTMLElement} element - The element to format
       */
      formatMessageContent: function(element) {
        if (!element || !element.dataset.rawText) return;

        const rawText = element.dataset.rawText;

        // Process the text with various Markdown features
        let processedText = this.stripBestPickFromReply(rawText);

        // Remove markdown images entirely (LLM often emits ![alt](image_url)).
        // The link regex below would otherwise turn them into clickable "!alt" image links.
        processedText = processedText.replace(/!\[[^\]]*\]\([^)]+\)/g, '');
        // Remove stock quantity lines from assistant text (cards show stock status)
        processedText = processedText.replace(/^\s*Stock:\s*.*$/gim, '');
        processedText = processedText.replace(/^\s*Variant ID:\s*.*$/gim, '');
        processedText = processedText.replace(/gid:\/\/shopify\/ProductVariant\/\d+/gi, '');
        processedText = processedText.replace(/\n{3,}/g, '\n\n').trim();

        // Fix placeholder storefront hosts the model sometimes invents
        const storefrontOrigin = (window.shopChatConfig && window.shopChatConfig.storefrontUrl)
          ? String(window.shopChatConfig.storefrontUrl).replace(/\/+$/, '')
          : window.location.origin;
        processedText = processedText.replace(
          /https?:\/\/(?:www\.)?yourstore\.com/gi,
          storefrontOrigin
        );

        // Process Markdown links (including LLM typos that omit the closing ")").
        processedText = this.replaceMarkdownLinks(processedText);

        // Convert text to HTML with proper list handling
        processedText = this.convertMarkdownToHtml(processedText);

        // Apply the formatted HTML
        element.innerHTML = processedText;
        ShopAIChat.Speak.attachButton(element);
      },

      /**
       * Engine/qualifier choices live in buttons — drop them from assistant text.
       */
      stripListedFitmentOptions: function(text, options) {
        let source = String(text || '');
        const labels = (Array.isArray(options) ? options : [])
          .map((option) => String(option.label || option.value || '').trim())
          .filter(Boolean);
        if (!labels.length) return source;

        labels.forEach((label) => {
          const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          source = source.replace(
            new RegExp(`^\\s*(?:[-*]\\s+|\\d+\\.\\s+)?(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*$`, 'gim'),
            ''
          );
          source = source.replace(new RegExp(`\\*\\*${escaped}\\*\\*`, 'gi'), '');
        });

        source = source
          .replace(/please choose one of the following(?: engines?)?:?\s*/gi, '')
          .replace(/choose one of the following(?: engines?)?:?\s*/gi, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        return source;
      },

      /**
       * Best pick lives in the UI card — strip it from assistant chat text.
       */
      stripBestPickFromReply: function(text) {
        let source = String(text || '');
        if (!/\bbest pick\b|\bbest product is\b|\brecommended pick\b/i.test(source)) {
          return source;
        }

        source = source
          .replace(/[^.!?\n]*\bbest pick\b[^.!?\n]*[.!?]*/gi, ' ')
          .replace(/[^.!?\n]*\bbest product is\b[^.!?\n]*[.!?]*/gi, ' ')
          .replace(/[^.!?\n]*\brecommended pick\b[^.!?\n]*[.!?]*/gi, ' ')
          .replace(/[ \t]{2,}/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        return source;
      },

      /**
       * Turn relative storefront paths into absolute URLs so target=_blank works.
       */
      toAbsoluteUrl: function(url) {
        if (!url || url === '#' || url === '#auth') return url;
        if (/^https?:\/\//i.test(url)) return url;
        if (url.startsWith('//')) return window.location.protocol + url;
        if (url.startsWith('/')) return window.location.origin + url;
        if (url.startsWith('mailto:') || url.startsWith('tel:')) return url;
        return url;
      },

      /**
       * Strip trailing sentence punctuation the model often glues onto URLs.
       */
      cleanMarkdownHref: function(url) {
        return String(url || '')
          .trim()
          .replace(/^<|>$/g, '')
          .replace(/[.,;:!?'"”)\]\s]+$/g, '');
      },

      escapeHtmlAttr: function(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      },

      renderMarkdownAnchor: function(label, url) {
        const href = this.toAbsoluteUrl(this.cleanMarkdownHref(url));
        if (!href) return label;

        if (
          href.includes('shopify.com/authentication') &&
          (href.includes('oauth/authorize') || href.includes('authentication'))
        ) {
          window.shopAuthUrl = href;
          return '<a href="#auth" class="shop-auth-trigger">' + label + '</a>';
        }

        const safeHref = this.escapeHtmlAttr(href);
        if (href.includes('/cart') || href.includes('checkout')) {
          return (
            '<a href="' +
            safeHref +
            '" target="_blank" rel="noopener noreferrer">click here to proceed to checkout</a>'
          );
        }

        return (
          '<a href="' +
          safeHref +
          '" target="_blank" rel="noopener noreferrer">' +
          label +
          '</a>'
        );
      },

      /**
       * Convert [text](url) to anchors. Also handles missing closing ")" on long URLs.
       */
      replaceMarkdownLinks: function(text) {
        let processedText = String(text || '');

        // Well-formed: [label](url)
        processedText = processedText.replace(
          /\[([^\]]+)\]\(([^)\s]+)\)/g,
          (match, label, url) => this.renderMarkdownAnchor(label, url)
        );

        // Malformed / truncated: [label](https://... without ")"
        processedText = processedText.replace(
          /\[([^\]]+)\]\((https?:\/\/[^\s<\]]+)/g,
          (match, label, url) => this.renderMarkdownAnchor(label, url)
        );

        return processedText;
      },

      /**
       * Convert Markdown text to HTML with list support
       * @param {string} text - Markdown text to convert
       * @returns {string} HTML content
       */
      convertMarkdownToHtml: function(text) {
        text = text.replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>');
        const lines = text.split('\n');
        let currentList = null;
        let listItems = [];
        let htmlContent = '';
        let startNumber = 1;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const unorderedMatch = line.match(/^\s*([-*])\s+(.*)/);
          const orderedMatch = line.match(/^\s*(\d+)[\.)]\s+(.*)/);

          if (unorderedMatch) {
            if (currentList !== 'ul') {
              if (currentList === 'ol') {
                htmlContent += `<ol start="${startNumber}">` + listItems.join('') + '</ol>';
                listItems = [];
              }
              currentList = 'ul';
            }
            listItems.push('<li>' + unorderedMatch[2] + '</li>');
          } else if (orderedMatch) {
            if (currentList !== 'ol') {
              if (currentList === 'ul') {
                htmlContent += '<ul>' + listItems.join('') + '</ul>';
                listItems = [];
              }
              currentList = 'ol';
              startNumber = parseInt(orderedMatch[1], 10);
            }
            listItems.push('<li>' + orderedMatch[2] + '</li>');
          } else {
            if (currentList) {
              htmlContent += currentList === 'ul'
                ? '<ul>' + listItems.join('') + '</ul>'
                : `<ol start="${startNumber}">` + listItems.join('') + '</ol>';
              listItems = [];
              currentList = null;
            }

            if (line.trim() === '') {
              htmlContent += '<br>';
            } else {
              htmlContent += '<p>' + line + '</p>';
            }
          }
        }

        if (currentList) {
          htmlContent += currentList === 'ul'
            ? '<ul>' + listItems.join('') + '</ul>'
            : `<ol start="${startNumber}">` + listItems.join('') + '</ol>';
        }

        htmlContent = htmlContent.replace(/<\/p><p>/g, '</p>\n<p>');
        return htmlContent;
      }
    },

    /**
     * API communication and data handling
     */
    API: {
      /**
       * Stream a response from the API
       * @param {string} userMessage - User's message text
       * @param {string} conversationId - Conversation ID for context
       * @param {HTMLElement} messagesContainer - The messages container
       */
      streamResponse: async function(userMessage, conversationId, messagesContainer, options) {
        const opts = options || {};
        const isInit = opts.init === true;
        let currentMessageElement = null;
        const ownsSendingState = !ShopAIChat.UI.isResponding;

        if (ownsSendingState) {
          ShopAIChat.UI.setSendingState(true);
        }

        try {
          const promptType = window.shopChatConfig?.promptType || "standardAssistant";
          // Snapshot theme cart only when the message is cart-related (avoids /cart.js on every ask).
          // Theme removals still sync via cart:updated listeners + chat open.
          let themeCartItems = null;
          if (!isInit && shouldSyncThemeCartForMessage(userMessage)) {
            try {
              themeCartItems = await ShopAIChat.ThemeCart.getThemeCartItems();
            } catch (themeError) {
              console.warn('[ShopAIChat] theme cart snapshot skipped', themeError?.message || themeError);
              themeCartItems = [];
            }
          }

          const requestBody = JSON.stringify({
            ...(isInit ? { init: true } : { message: userMessage }),
            conversation_id: conversationId,
            prompt_type: promptType,
            ...(isInit && window.shopChatConfig?.welcomeMessage
              ? { welcome_template: window.shopChatConfig.welcomeMessage }
              : {}),
            ...(Array.isArray(themeCartItems) ? { theme_cart_items: themeCartItems } : {}),
            ...getCustomerContextPayload()
          });

          const apiBaseUrl = getApiBaseUrl();
          const streamUrl = `${apiBaseUrl}/chat`;
          const shopId = window.shopId;
          const shopDomain = window.shopDomain;

          const response = await fetch(streamUrl, {
            method: 'POST',
            headers: getApiHeaders({
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'X-Shopify-Shop-Id': shopId,
              ...(shopDomain ? { 'X-Shopify-Shop-Domain': shopDomain } : {})
            }),
            body: requestBody
          });

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          const updateCurrent = (newElement) => {
            currentMessageElement = newElement;
          };

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  this.handleStreamEvent(
                    data,
                    currentMessageElement,
                    messagesContainer,
                    userMessage,
                    updateCurrent
                  );
                } catch (e) {
                  console.error('Error parsing event data:', e, line);
                }
              }
            }
          }

          ShopAIChat.UI.removeEmptyAssistant(currentMessageElement);
        } catch (error) {
          console.error('Error in streaming:', error);
          ShopAIChat.UI.removeTypingIndicator();
          ShopAIChat.Message.add(
            "Sorry, I couldn't complete that right now. Please try again in a moment.",
            'assistant',
            messagesContainer
          );
        } finally {
          if (ownsSendingState) {
            ShopAIChat.UI.setSendingState(false);
          }
        }
      },

      /**
       * Request LLM-generated welcome for a new session (saved to chat history).
       */
      requestWelcome: async function(messagesContainer, conversationId) {
        if (ShopAIChat.UI.isResponding) return;

        const id = conversationId || Date.now().toString();
        setConversationId(id);
        Sessions.upsert(id, { title: 'New chat', updatedAt: Date.now() });
        ShopAIChat.UI.showChatView();
        ShopAIChat.UI.showTypingIndicator();

        try {
          await ShopAIChat.API.streamResponse(null, id, messagesContainer, { init: true });
        } catch (error) {
          console.error('Error requesting welcome message:', error);
          ShopAIChat.UI.removeTypingIndicator();
          ShopAIChat.Message.add(getStaticWelcomeFallback(), 'assistant', messagesContainer);
        }
      },

      /**
       * Handle stream events from the API
       * @param {Object} data - Event data
       * @param {HTMLElement} currentMessageElement - Current message element being updated
       * @param {HTMLElement} messagesContainer - The messages container
       * @param {string} userMessage - The original user message
       * @param {Function} updateCurrentElement - Callback to update the current element reference
       */
      handleStreamEvent: function(data, currentMessageElement, messagesContainer, userMessage, updateCurrentElement) {
        switch (data.type) {
          case 'id':
            if (data.conversation_id) {
              setConversationId(data.conversation_id);
              Sessions.upsert(data.conversation_id, { updatedAt: Date.now() });
              ShopAIChat.UI.renderSessionsList();
            }
            break;

          case 'chunk':
            ShopAIChat.UI.removeTypingIndicator();
            currentMessageElement = ShopAIChat.UI.ensureAssistantMessage(
              currentMessageElement,
              messagesContainer,
              updateCurrentElement
            );
            currentMessageElement.dataset.rawText += data.chunk;
            currentMessageElement.textContent = currentMessageElement.dataset.rawText;
            ShopAIChat.UI.scrollToBottom();
            break;

          case 'message_complete':
            ShopAIChat.UI.removeTypingIndicator();
            if (currentMessageElement && String(currentMessageElement.dataset.rawText || '').trim()) {
              ShopAIChat.Formatting.formatMessageContent(currentMessageElement);
              ShopAIChat.UI.placeAssistantTextBeforeProducts(currentMessageElement);
            } else {
              ShopAIChat.UI.removeEmptyAssistant(currentMessageElement);
              if (typeof updateCurrentElement === 'function') updateCurrentElement(null);
            }
            ShopAIChat.UI.scrollToBottom();
            break;

          case 'end_turn':
            ShopAIChat.UI.removeTypingIndicator();
            ShopAIChat.UI.removeEmptyAssistant(currentMessageElement);
            if (currentMessageElement && currentMessageElement.parentNode) {
              ShopAIChat.UI.placeAssistantTextBeforeProducts(currentMessageElement);
            }
            break;

          case 'error':
            console.error('Stream error:', data.error);
            ShopAIChat.UI.removeTypingIndicator();
            currentMessageElement = ShopAIChat.UI.ensureAssistantMessage(
              currentMessageElement,
              messagesContainer,
              updateCurrentElement
            );
            currentMessageElement.dataset.rawText =
              "Sorry, I couldn't complete that right now. Please try again in a moment.";
            currentMessageElement.textContent = currentMessageElement.dataset.rawText;
            ShopAIChat.Speak.attachButton(currentMessageElement);
            break;

          case 'tool_error':
          case 'rate_limit_exceeded':
            console.error('Tool error:', data.message || data.error);
            ShopAIChat.UI.removeTypingIndicator();
            ShopAIChat.UI.removeEmptyAssistant(currentMessageElement);
            ShopAIChat.Message.add(
              data.message ||
                "Sorry, I couldn't complete that right now. Please try again in a moment.",
              'assistant',
              messagesContainer
            );
            if (typeof updateCurrentElement === 'function') {
              updateCurrentElement(null);
            }
            break;

          case 'auth_required':
            // Save the last user message for resuming after authentication
            sessionStorage.setItem('shopAiLastMessage', userMessage || '');
            break;

          case 'product_results':
            ShopAIChat.UI.displayProductResults(data.products);
            break;

          case 'fitment_options':
            ShopAIChat.UI.displayFitmentOptions(data);
            break;

          case 'customer_addresses':
            ShopAIChat.UI.displayCustomerAddresses(data);
            break;

          case 'install_resources':
            ShopAIChat.UI.displayInstallResources(data);
            break;

          case 'theme_cart_sync':
            ShopAIChat.ThemeCart.syncFromChatCart(data).catch((error) => {
              console.warn('[ShopAIChat] theme cart sync failed', error?.message || error);
            });
            break;

          case 'tool_use':
            if (data.tool_use_message) {
              ShopAIChat.Message.addToolUse(data.tool_use_message, messagesContainer);
            }
            break;

          case 'new_message':
            ShopAIChat.UI.removeEmptyAssistant(currentMessageElement);
            if (currentMessageElement && currentMessageElement.parentNode) {
              ShopAIChat.Formatting.formatMessageContent(currentMessageElement);
            }
            ShopAIChat.UI.showTypingIndicator();
            if (typeof updateCurrentElement === 'function') {
              updateCurrentElement(null);
            }
            break;

          case 'content_block_complete':
            ShopAIChat.UI.showTypingIndicator();
            break;
        }
      },

      /**
       * Check if a conversation has saved messages (without rendering).
       */
      sessionHasHistory: async function(conversationId) {
        if (!conversationId) return false;

        try {
          const apiBaseUrl = getApiBaseUrl();
          const params = new URLSearchParams({
            history: 'true',
            conversation_id: conversationId
          });
          const customerId = getLoggedInCustomerId();
          if (customerId) params.set('customer_id', customerId);

          const historyUrl = `${apiBaseUrl}/chat?${params.toString()}`;
          const response = await fetch(historyUrl, {
            method: 'GET',
            headers: getApiHeaders({
              Accept: 'application/json',
              'Content-Type': 'application/json'
            }),
            mode: 'cors'
          });

          if (!response.ok) return false;
          const data = await response.json();
          return Array.isArray(data.messages) && data.messages.length > 0;
        } catch {
          return false;
        }
      },

      /**
       * Fetch chat history from the server
       * @param {string} conversationId - Conversation ID
       * @param {HTMLElement} messagesContainer - The messages container
       */
      fetchChatHistory: async function(conversationId, messagesContainer) {
        try {
          // Show a loading message
          const loadingMessage = document.createElement('div');
          loadingMessage.classList.add('shop-ai-message', 'assistant');
          loadingMessage.textContent = "Loading conversation history...";
          messagesContainer.appendChild(loadingMessage);

          // Fetch history from the server
          const apiBaseUrl = getApiBaseUrl();
          const params = new URLSearchParams({
            history: 'true',
            conversation_id: conversationId
          });
          const customerId = getLoggedInCustomerId();
          if (customerId) params.set('customer_id', customerId);
          const historyUrl = `${apiBaseUrl}/chat?${params.toString()}`;
          console.log('Fetching history from:', historyUrl);

          const response = await fetch(historyUrl, {
            method: 'GET',
            headers: getApiHeaders({
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            }),
            mode: 'cors'
          });

          if (!response.ok) {
            console.error('History fetch failed:', response.status, response.statusText);
            throw new Error('Failed to fetch chat history: ' + response.status);
          }

          const data = await response.json();

          // Remove loading message
          messagesContainer.removeChild(loadingMessage);

          // No messages — generate welcome via LLM and persist to history
          if (!data.messages || data.messages.length === 0) {
            await ShopAIChat.API.requestWelcome(messagesContainer, conversationId);
            return;
          }

          // Add messages to the UI - skip empty/tool_result; restore text, tools, products
          data.messages.forEach(message => {
            ShopAIChat.UI.appendHistoryMessage(message, messagesContainer);
          });

          // History / session switches can miss action rows — re-attach after full render.
          ShopAIChat.UI.reattachAssistantActions(messagesContainer);

          // Scroll to bottom
          ShopAIChat.UI.scrollToBottom();

        } catch (error) {
          console.error('Error fetching chat history:', error);

          // Remove loading message if it exists
          const loadingMessage = messagesContainer.querySelector('.shop-ai-message.assistant');
          if (loadingMessage && loadingMessage.textContent === "Loading conversation history...") {
            messagesContainer.removeChild(loadingMessage);
          }

          // Show error and welcome message
          ShopAIChat.Message.add(getStaticWelcomeFallback(), 'assistant', messagesContainer);

          // Clear the conversation ID since we couldn't fetch this conversation
          clearConversationId();
        }
      }
    },

    /**
     * Authentication-related functionality
     */
    Auth: {
      /**
       * Opens an authentication popup window
       * @param {string|HTMLElement} authUrlOrElement - The auth URL or link element that was clicked
       */
      openAuthPopup: function(authUrlOrElement) {
        let authUrl;
        if (typeof authUrlOrElement === 'string') {
          // If a string URL was passed directly
          authUrl = authUrlOrElement;
        } else {
          // If an element was passed
          authUrl = authUrlOrElement.getAttribute('data-auth-url');
          if (!authUrl) {
            console.error('No auth URL found in element');
            return;
          }
        }

        // Open the popup window centered in the screen
        const width = 600;
        const height = 700;
        const left = (window.innerWidth - width) / 2 + window.screenX;
        const top = (window.innerHeight - height) / 2 + window.screenY;

        const popup = window.open(
          authUrl,
          'ShopifyAuth',
          `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
        );

        // Focus the popup window
        if (popup) {
          popup.focus();
        } else {
          // If popup was blocked, show a message
          alert('Please allow popups for this site to authenticate with Shopify.');
        }

        // Start polling for token availability
        const conversationId = getConversationId();
        if (conversationId) {
          const messagesContainer = document.querySelector('.shop-ai-chat-messages');

          // Add a message to indicate authentication is in progress
          ShopAIChat.Message.add("Authentication in progress. Please complete the process in the popup window.",
            'assistant', messagesContainer);

          this.startTokenPolling(conversationId, messagesContainer);
        }
      },

      /**
       * Start polling for token availability
       * @param {string} conversationId - Conversation ID
       * @param {HTMLElement} messagesContainer - The messages container
       */
      startTokenPolling: function(conversationId, messagesContainer) {
        if (!conversationId) return;

        console.log('Starting token polling for conversation:', conversationId);
        const pollingId = 'polling_' + Date.now();
        sessionStorage.setItem('shopAiTokenPollingId', pollingId);

        let attemptCount = 0;
        const maxAttempts = 30;

        const poll = async () => {
          if (sessionStorage.getItem('shopAiTokenPollingId') !== pollingId) {
            console.log('Another polling session has started, stopping this one');
            return;
          }

          if (attemptCount >= maxAttempts) {
            console.log('Max polling attempts reached, stopping');
            return;
          }

          attemptCount++;

          try {
            const apiBaseUrl = getApiBaseUrl();
            const tokenUrl = `${apiBaseUrl}/auth/token-status?conversation_id=${encodeURIComponent(conversationId)}`;
            const response = await fetch(tokenUrl, {
              headers: getApiHeaders()
            });

            if (!response.ok) {
              throw new Error('Token status check failed: ' + response.status);
            }

            const data = await response.json();

            if (data.status === 'authorized') {
              console.log('Token available, resuming conversation');
              const message = sessionStorage.getItem('shopAiLastMessage');

              if (message) {
                sessionStorage.removeItem('shopAiLastMessage');
                setTimeout(() => {
                  ShopAIChat.Message.add("Authorization successful! I'm now continuing with your request.",
                    'assistant', messagesContainer);
                  ShopAIChat.API.streamResponse(message, conversationId, messagesContainer);
                  ShopAIChat.UI.showTypingIndicator();
                }, 500);
              }

              sessionStorage.removeItem('shopAiTokenPollingId');
              return;
            }

            console.log('Token not available yet, polling again in 10s');
            setTimeout(poll, 10000);
          } catch (error) {
            console.error('Error polling for token status:', error);
            setTimeout(poll, 10000);
          }
        };

        setTimeout(poll, 2000);
      }
    },

    /**
     * Web Speech API voice input
     */
    Voice: {
      recognition: null,
      isListening: false,
      keepListening: false,
      manualStop: false,
      ui: null,
      elements: null,
      messagesContainer: null,
      statusTimer: null,
      restartTimer: null,
      inputEditTimer: null,
      autoSubmitTimer: null,
      isRestarting: false,
      isAutoSubmitting: false,
      /** Ignore late Safari onresult events that rewrite the input after send */
      suppressResults: false,
      sessionPrefix: '',
      /** Pause after last speech before auto-send (ms) */
      silenceSubmitMs: 1400,

      getLabel: function(key, fallback) {
        return window.shopChatConfig?.[key] || fallback;
      },

      isSupported: function() {
        return Boolean(
          typeof window !== 'undefined' &&
          (window.SpeechRecognition || window.webkitSpeechRecognition)
        );
      },

      createRecognition: function() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return null;

        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.lang = document.documentElement.lang || navigator.language || 'en-US';
        return recognition;
      },

      init: function(elements, ui) {
        this.ui = ui;
        this.elements = elements;
        this.messagesContainer = elements.messagesContainer;

        const { voiceButton, chatInput } = elements;
        if (!voiceButton || !chatInput) return;

        if (!this.isSupported()) {
          voiceButton.hidden = true;
          return;
        }

        voiceButton.hidden = false;
        this.recognition = this.createRecognition();
        if (!this.recognition) {
          voiceButton.hidden = true;
          return;
        }

        voiceButton.addEventListener('click', () => {
          if (this.isListening) {
            this.stop();
          } else {
            this.start(elements);
          }
        });

        chatInput.addEventListener('input', () => {
          if (this.isListening || (this.keepListening && !this.manualStop)) {
            this.handleInputDuringListening(elements, chatInput);
          } else {
            this.hideStatus(elements);
          }
          if (this.ui) {
            this.ui.autoResizeChatInput(chatInput);
          }
        });

        this.recognition.onstart = () => {
          this.isListening = true;
          this.isRestarting = false;
          this.syncSessionPrefix(chatInput);
          this.setListeningState(elements, true);
          this.showStatus(
            elements,
            this.getLabel('voiceListeningLabel', 'Listening… Speak, then pause to send.')
          );
          if (this.ui) {
            this.ui.scrollContentForInput();
          }
        };

        this.recognition.onend = () => {
          this.isListening = false;

          if (this.isRestarting) {
            this.scheduleRestart(80);
            return;
          }

          if (this.keepListening && !this.manualStop) {
            this.syncSessionPrefix(chatInput);
            this.scheduleRestart();
            return;
          }

          this.setListeningState(elements, false);

          // Safari often fires final onresult after stop — keep suppressing briefly
          if (this.isAutoSubmitting || this.suppressResults) {
            this.clearInputSafely(elements.chatInput);
            setTimeout(() => {
              this.suppressResults = false;
              this.isAutoSubmitting = false;
              this.manualStop = false;
              this.sessionPrefix = '';
            }, 400);
            return;
          }

          this.finalizeInput(elements);
          this.sessionPrefix = '';
          this.manualStop = false;
        };

        this.recognition.onerror = (event) => {
          const error = event?.error || 'unknown';

          if (error === 'aborted' && (this.isRestarting || this.isAutoSubmitting)) {
            return;
          }

          // Silence while listening: if we already have text, send it; otherwise keep listening
          if (error === 'no-speech' && this.keepListening && !this.manualStop) {
            const text = String(elements.chatInput?.value || '').trim();
            if (text) {
              this.submitVoiceMessage(elements);
              return;
            }
            this.syncSessionPrefix(chatInput);
            this.scheduleRestart();
            return;
          }

          if (error === 'aborted') {
            this.hideStatus(elements);
            return;
          }

          this.keepListening = false;
          this.manualStop = false;
          this.isRestarting = false;
          this.clearAutoSubmitTimer();

          let message = this.getLabel('voiceErrorLabel', 'Voice input failed. Please try again.');

          if (error === 'not-allowed' || error === 'service-not-allowed') {
            message = this.getLabel('voiceDeniedLabel', 'Microphone access denied.');
          } else if (error === 'no-speech') {
            message = this.getLabel('voiceNoSpeechLabel', 'No speech detected. Try again.');
          }

          this.setListeningState(elements, false);
          this.showStatus(elements, message, true);
        };

        this.recognition.onresult = (event) => {
          const { chatInput: input } = elements;
          if (!input || this.isRestarting || this.isAutoSubmitting || this.suppressResults) {
            return;
          }

          let finalTranscript = '';
          let interimTranscript = '';

          for (let i = 0; i < event.results.length; i += 1) {
            const transcript = event.results[i][0]?.transcript || '';
            if (event.results[i].isFinal) {
              finalTranscript += transcript;
            } else {
              interimTranscript += transcript;
            }
          }

          const spoken = `${finalTranscript}${interimTranscript}`.trim();
          const prefix = this.sessionPrefix || '';
          input.value = spoken ? `${prefix}${spoken}`.trim() : prefix.trim();

          if (this.ui) {
            this.ui.syncInputCaretToEnd(input);
          }

          // After you pause speaking, auto-send the message
          if (input.value.trim()) {
            this.scheduleAutoSubmit(elements);
          }
        };
      },

      clearInputSafely: function(chatInput) {
        if (!chatInput) return;
        chatInput.value = '';
        if (this.ui) {
          this.ui.autoResizeChatInput(chatInput);
        }
      },

      syncSessionPrefix: function(chatInput) {
        if (!chatInput) return;
        const trimmed = chatInput.value.trim();
        this.sessionPrefix = trimmed ? `${trimmed} ` : '';
      },

      handleInputDuringListening: function(elements, chatInput) {
        this.syncSessionPrefix(chatInput);

        clearTimeout(this.inputEditTimer);
        this.inputEditTimer = setTimeout(() => {
          if (this.keepListening && !this.manualStop) {
            this.restartRecognitionSession(elements);
          }
        }, 200);
      },

      restartRecognitionSession: function(elements) {
        if (!this.recognition || !this.keepListening || this.manualStop) return;

        const { chatInput } = elements;
        this.syncSessionPrefix(chatInput);
        this.clearRestartTimer();
        this.isRestarting = true;

        try {
          if (this.isListening) {
            this.recognition.stop();
          } else {
            this.isRestarting = false;
            this.scheduleRestart(80);
          }
        } catch (error) {
          this.isRestarting = false;
          this.scheduleRestart(80);
        }
      },

      finalizeInput: function(elements) {
        // Mic stopped with text → send automatically (no review step)
        this.submitVoiceMessage(elements);
      },

      scheduleAutoSubmit: function(elements) {
        this.clearAutoSubmitTimer();
        this.autoSubmitTimer = setTimeout(() => {
          this.autoSubmitTimer = null;
          this.submitVoiceMessage(elements);
        }, this.silenceSubmitMs);
      },

      clearAutoSubmitTimer: function() {
        if (this.autoSubmitTimer) {
          clearTimeout(this.autoSubmitTimer);
          this.autoSubmitTimer = null;
        }
      },

      /**
       * Stop mic and send the dictated message.
       */
      submitVoiceMessage: function(elements) {
        const els = elements || this.elements || this.ui?.elements;
        if (!els || this.isAutoSubmitting) return;

        const input = els.chatInput;
        const messagesContainer = els.messagesContainer;
        const text = String(input?.value || '').trim();

        this.clearAutoSubmitTimer();
        clearTimeout(this.inputEditTimer);
        this.inputEditTimer = null;
        this.clearRestartTimer();

        if (!text) {
          this.hideStatus(els);
          this.setListeningState(els, false);
          this.keepListening = false;
          this.manualStop = false;
          this.isAutoSubmitting = false;
          this.suppressResults = false;
          this.sessionPrefix = '';
          return;
        }

        if (ShopAIChat.UI?.isResponding) {
          this.setListeningState(els, false);
          this.keepListening = false;
          this.suppressResults = true;
          this.clearInputSafely(input);
          return;
        }

        // Lock before stop() — Safari may emit late onresult and refill the textarea
        this.isAutoSubmitting = true;
        this.suppressResults = true;
        this.manualStop = true;
        this.keepListening = false;
        this.isRestarting = false;
        this.sessionPrefix = '';

        try {
          if (this.isListening && this.recognition) {
            this.recognition.stop();
          }
        } catch (error) {
          // ignore
        }

        this.setListeningState(els, false);
        this.hideStatus(els);

        // Clear immediately, then send the captured text (not live input)
        this.clearInputSafely(input);

        if (this.ui) {
          this.ui.showChatView();
        }

        ShopAIChat.Message.sendText(text, messagesContainer);

        // Keep suppressResults until onend / short fallback for Safari
        setTimeout(() => {
          this.clearInputSafely(input);
          if (!this.isListening) {
            this.suppressResults = false;
            this.isAutoSubmitting = false;
            this.manualStop = false;
          }
        }, 500);
      },

      start: function(elements) {
        if (!this.recognition || this.isListening) return;

        ShopAIChat.Speak.stop();

        this.elements = elements;
        this.manualStop = false;
        this.keepListening = true;
        this.isAutoSubmitting = false;
        this.suppressResults = false;
        this.clearRestartTimer();
        this.clearAutoSubmitTimer();

        const { chatInput } = elements;
        if (chatInput) {
          chatInput.focus();
        }

        try {
          this.recognition.start();
        } catch (error) {
          if (String(error?.message || '').includes('already started')) {
            this.stop({ skipSubmit: true });
            setTimeout(() => {
              try {
                this.recognition.start();
              } catch (retryError) {
                this.showStatus(
                  elements,
                  this.getLabel('voiceErrorLabel', 'Voice input failed. Please try again.'),
                  true
                );
              }
            }, 120);
            return;
          }

          this.showStatus(
            elements,
            this.getLabel('voiceErrorLabel', 'Voice input failed. Please try again.'),
            true
          );
        }
      },

      stop: function(options = {}) {
        if (!this.recognition) return;

        const skipSubmit = options.skipSubmit === true;
        this.manualStop = true;
        this.keepListening = false;
        this.isRestarting = false;
        this.clearRestartTimer();
        this.clearAutoSubmitTimer();
        clearTimeout(this.inputEditTimer);
        this.inputEditTimer = null;

        const hadText = Boolean(String(this.ui?.elements?.chatInput?.value || '').trim());

        try {
          if (this.isListening) {
            this.recognition.stop();
          }
        } catch (error) {
          // ignore stop errors when recognition is idle
        }

        if (!this.isListening && this.ui?.elements) {
          this.setListeningState(this.ui.elements, false);
          if (!skipSubmit && hadText) {
            this.submitVoiceMessage(this.ui.elements);
          } else {
            this.hideStatus(this.ui.elements);
            this.sessionPrefix = '';
            this.manualStop = false;
          }
        }
      },

      scheduleRestart: function(delay) {
        this.clearRestartTimer();
        const waitMs = typeof delay === 'number' ? delay : 200;

        this.restartTimer = setTimeout(() => {
          if (!this.keepListening || this.manualStop || !this.recognition) return;

          try {
            this.recognition.start();
          } catch (error) {
            if (String(error?.message || '').includes('already started')) {
              return;
            }
            this.keepListening = false;
            this.isRestarting = false;
            if (this.elements) {
              this.setListeningState(this.elements, false);
              this.showStatus(
                this.elements,
                this.getLabel('voiceErrorLabel', 'Voice input failed. Please try again.'),
                true
              );
            }
          }
        }, waitMs);
      },

      clearRestartTimer: function() {
        if (this.restartTimer) {
          clearTimeout(this.restartTimer);
          this.restartTimer = null;
        }
      },

      setListeningState: function(elements, listening) {
        const { voiceButton, inputWrap, chatInput } = elements;
        if (voiceButton) {
          voiceButton.classList.toggle('is-listening', listening);
          const startLabel = this.getLabel('voiceStartLabel', 'Start voice input');
          const stopLabel = this.getLabel('voiceStopLabel', 'Stop voice input');
          voiceButton.setAttribute('aria-label', listening ? stopLabel : startLabel);
          voiceButton.setAttribute('title', listening ? stopLabel : startLabel);
        }
        if (inputWrap) {
          inputWrap.classList.toggle('is-listening', listening);
        }
        if (chatInput && listening) {
          chatInput.placeholder = this.getLabel('voiceListeningLabel', 'Listening…');
        } else if (chatInput) {
          chatInput.placeholder =
            window.shopChatConfig?.inputPlaceholder || 'Ask anything you need';
        }
      },

      showStatus: function(elements, message, isError, autoHideMs) {
        const { voiceStatus } = elements;
        if (!voiceStatus) return;

        voiceStatus.textContent = decodeHtmlEntities(message);
        voiceStatus.hidden = false;
        voiceStatus.classList.toggle('is-error', Boolean(isError));

        if (this.ui) {
          this.ui.scrollContentForInput();
        }

        this.clearStatusTimer();
        if (!this.isListening) {
          const delay = typeof autoHideMs === 'number' ? autoHideMs : (isError ? 4000 : 2500);
          this.statusTimer = setTimeout(() => {
            this.hideStatus(elements);
          }, delay);
        }
      },

      hideStatus: function(elements) {
        const { voiceStatus } = elements;
        if (!voiceStatus) return;

        voiceStatus.hidden = true;
        voiceStatus.textContent = '';
        voiceStatus.classList.remove('is-error');
      },

      clearStatusTimer: function() {
        if (this.statusTimer) {
          clearTimeout(this.statusTimer);
          this.statusTimer = null;
        }
      }
    },

    /**
     * Assistant read-aloud: Edge TTS and/or browser TTS (env via /chat?config=true).
     */
    Speak: {
      utterance: null,
      activeButton: null,
      speakTimer: null,
      audio: null,
      audioUrl: null,
      speakRequestId: 0,

      getLabel: function(key, fallback) {
        return window.shopChatConfig?.[key] || fallback;
      },

      getSpeakConfig: function() {
        const speak = window.shopChatConfig?.speak;
        if (!speak || typeof speak !== 'object') {
          return { mode: 'auto', enabled: true, edgeEnabled: true, browserEnabled: true };
        }

        const mode = String(speak.mode || '').toLowerCase();
        if (mode === 'off') {
          return { mode: 'off', enabled: false, edgeEnabled: false, browserEnabled: false };
        }
        if (mode === 'edge') {
          return { mode: 'edge', enabled: true, edgeEnabled: true, browserEnabled: false };
        }
        if (mode === 'browser') {
          return { mode: 'browser', enabled: true, edgeEnabled: false, browserEnabled: true };
        }
        if (mode === 'auto') {
          return { mode: 'auto', enabled: true, edgeEnabled: true, browserEnabled: true };
        }

        // Legacy boolean payload from older servers
        return {
          mode: speak.enabled === false ? 'off' : 'auto',
          enabled: speak.enabled !== false,
          edgeEnabled: speak.edgeEnabled !== false,
          browserEnabled: speak.browserEnabled !== false
        };
      },

      isBrowserTtsSupported: function() {
        return Boolean(
          typeof window !== 'undefined' &&
          window.speechSynthesis &&
          typeof window.SpeechSynthesisUtterance === 'function'
        );
      },

      isEdgeAllowed: function() {
        const cfg = this.getSpeakConfig();
        return cfg.enabled && cfg.edgeEnabled;
      },

      isBrowserAllowed: function() {
        const cfg = this.getSpeakConfig();
        return cfg.enabled && cfg.browserEnabled && this.isBrowserTtsSupported();
      },

      /** Show speaker when any configured TTS path can run. */
      isSupported: function() {
        return this.isEdgeAllowed() || this.isBrowserAllowed();
      },

      isPlaying: function() {
        if (this.audio && !this.audio.paused && !this.audio.ended) return true;
        if (
          typeof window !== 'undefined' &&
          window.speechSynthesis &&
          (window.speechSynthesis.speaking || window.speechSynthesis.pending)
        ) {
          return true;
        }
        return false;
      },

      stripForSpeech: function(text) {
        let source = String(text || '');
        if (ShopAIChat.Formatting?.stripBestPickFromReply) {
          source = ShopAIChat.Formatting.stripBestPickFromReply(source);
        }

        source = source
          .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
          .replace(/^\s*Stock:\s*.*$/gim, '')
          .replace(/^\s*Variant ID:\s*.*$/gim, '')
          .replace(/gid:\/\/shopify\/ProductVariant\/\d+/gi, '')
          .replace(/[*_`#>~]/g, '')
          .replace(/^\s*[-*]\s+/gm, '')
          .replace(/^\s*\d+\.\s+/gm, '')
          .replace(/\n{2,}/g, '. ')
          .replace(/\n/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();

        return source;
      },

      plainTextFromMessage: function(element) {
        if (!element) return '';

        if (element.dataset?.rawText) {
          return this.stripForSpeech(element.dataset.rawText);
        }

        const clone = element.cloneNode(true);
        clone.querySelectorAll('.shop-ai-message-actions, .shop-ai-speak-btn, .shop-ai-message-action-btn').forEach((btn) => btn.remove());
        return this.stripForSpeech(clone.textContent || '');
      },

      copyIconHtml: function() {
        return (
          '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
          '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>' +
          '</svg>'
        );
      },

      speakIconHtml: function() {
        return (
          '<svg class="shop-ai-speak-icon shop-ai-speak-icon--play" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>' +
          '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>' +
          '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>' +
          '</svg>' +
          '<svg class="shop-ai-speak-icon shop-ai-speak-icon--stop" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" hidden>' +
          '<rect x="6" y="6" width="12" height="12" rx="1"></rect>' +
          '</svg>'
        );
      },

      formatMessageTime: function(timestamp) {
        // Use a stable clock time (not relative "Just now") so it doesn't
        // stay wrong until the conversation is reopened from history.
        return formatSessionDate(timestamp);
      },

      getActionsRow: function(element) {
        if (!element || !element.parentNode) return null;
        const next = element.nextElementSibling;
        if (next && next.classList.contains('shop-ai-message-actions')) {
          return next;
        }
        return null;
      },

      removeActionsRow: function(element) {
        const row = this.getActionsRow(element);
        if (row) row.remove();
        if (element) element.classList.remove('has-speak');
      },

      /**
       * Claude-style row under the bubble: copy, speak, time (outside the message).
       */
      attachButton: function(element) {
        if (!element || !element.classList.contains('assistant') || !element.parentNode) return;

        if (this.activeButton && !this.activeButton.isConnected) {
          this.stop();
        }

        const text = this.plainTextFromMessage(element);
        if (!text) {
          this.removeActionsRow(element);
          return;
        }

        if (!element.dataset.messageAt) {
          element.dataset.messageAt = String(Date.now());
        }

        let actions = this.getActionsRow(element);
        if (!actions) {
          actions = document.createElement('div');
          actions.className = 'shop-ai-message-actions';
          element.parentNode.insertBefore(actions, element.nextSibling);
        }

        // Copy
        let copyBtn = actions.querySelector('.shop-ai-copy-btn');
        if (!copyBtn) {
          copyBtn = document.createElement('button');
          copyBtn.type = 'button';
          copyBtn.className = 'shop-ai-message-action-btn shop-ai-copy-btn';
          copyBtn.innerHTML = this.copyIconHtml();
          const copyLabel = this.getLabel('copyMessageLabel', 'Copy');
          copyBtn.setAttribute('aria-label', copyLabel);
          copyBtn.setAttribute('title', copyLabel);
          copyBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.copyMessage(element, copyBtn);
          });
          actions.appendChild(copyBtn);
        }

        // Speak (only when TTS is available)
        let speakBtn = actions.querySelector('.shop-ai-speak-btn');
        if (this.isSupported()) {
          if (!speakBtn) {
            speakBtn = document.createElement('button');
            speakBtn.type = 'button';
            speakBtn.className = 'shop-ai-message-action-btn shop-ai-speak-btn';
            speakBtn.innerHTML = this.speakIconHtml();
            const startLabel = this.getLabel('speakStartLabel', 'Listen to response');
            speakBtn.setAttribute('aria-label', startLabel);
            speakBtn.setAttribute('title', startLabel);
            speakBtn.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              this.toggle(element, speakBtn);
            });
            actions.appendChild(speakBtn);
          }
          element.classList.add('has-speak');
        } else if (speakBtn) {
          speakBtn.remove();
          element.classList.remove('has-speak');
        }

        // Time
        let timeEl = actions.querySelector('.shop-ai-message-time');
        if (!timeEl) {
          timeEl = document.createElement('span');
          timeEl.className = 'shop-ai-message-time';
          actions.appendChild(timeEl);
        }
        timeEl.textContent = this.formatMessageTime(element.dataset.messageAt);
      },

      copyMessage: function(element, button) {
        const text = this.plainTextFromMessage(element);
        if (!text) return;

        const doneLabel = this.getLabel('copyMessageDoneLabel', 'Copied');
        const copyLabel = this.getLabel('copyMessageLabel', 'Copy');

        const markCopied = () => {
          if (!button) return;
          button.classList.add('is-copied');
          button.setAttribute('aria-label', doneLabel);
          button.setAttribute('title', doneLabel);
          clearTimeout(button._copyResetTimer);
          button._copyResetTimer = setTimeout(() => {
            button.classList.remove('is-copied');
            button.setAttribute('aria-label', copyLabel);
            button.setAttribute('title', copyLabel);
          }, 1600);
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(markCopied).catch(() => {
            this.copyMessageFallback(text, markCopied);
          });
          return;
        }

        this.copyMessageFallback(text, markCopied);
      },

      copyMessageFallback: function(text, onDone) {
        try {
          const area = document.createElement('textarea');
          area.value = text;
          area.setAttribute('readonly', '');
          area.style.position = 'fixed';
          area.style.left = '-9999px';
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          area.remove();
          if (typeof onDone === 'function') onDone();
        } catch (error) {
          // ignore copy failures
        }
      },

      toggle: function(element, button) {
        if (!button) return;

        const isActive = this.activeButton === button && this.isPlaying();

        if (isActive) {
          this.stop();
          return;
        }

        this.speak(element, button);
      },

      speak: function(element, button) {
        if (!element || !button) return;
        if (!this.isSupported()) return;

        const text = this.plainTextFromMessage(element);
        if (!text) return;

        if (ShopAIChat.Voice?.isListening || ShopAIChat.Voice?.keepListening) {
          ShopAIChat.Voice.stop({ skipSubmit: true });
        }

        this.stop();

        this.activeButton = button;
        this.setSpeakingState(button, true);
        const requestId = ++this.speakRequestId;

        const tryBrowser = () => {
          if (requestId !== this.speakRequestId) return;
          if (this.isBrowserAllowed()) {
            this.speakWithBrowser(text, button, requestId);
          } else {
            this.clearSpeakingState();
          }
        };

        if (this.isEdgeAllowed()) {
          this.speakWithEdge(text, button, requestId).then((ok) => {
            if (requestId !== this.speakRequestId) return;
            if (ok) return;
            tryBrowser();
          });
          return;
        }

        tryBrowser();
      },

      speakWithEdge: async function(text, button, requestId) {
        if (!this.isEdgeAllowed()) return false;

        try {
          const apiBaseUrl = getApiBaseUrl();
          const response = await fetch(`${apiBaseUrl}/chat/speak`, {
            method: 'POST',
            headers: getApiHeaders({
              'Content-Type': 'application/json',
              Accept: 'audio/mpeg'
            }),
            body: JSON.stringify({ text })
          });

          if (requestId !== this.speakRequestId) return false;

          if (!response.ok) {
            console.warn('[Speak] Edge TTS HTTP', response.status);
            return false;
          }

          const blob = await response.blob();
          if (requestId !== this.speakRequestId) return false;
          if (!blob || !blob.size) return false;

          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          this.audio = audio;
          this.audioUrl = url;

          audio.onended = () => {
            if (this.audio === audio) {
              this.clearAudio();
              this.clearSpeakingState();
            }
          };
          audio.onerror = () => {
            if (this.audio === audio) {
              this.clearAudio();
              this.clearSpeakingState();
            }
          };

          await audio.play();
          return true;
        } catch (error) {
          console.warn('[Speak] Edge TTS failed', error?.message || error);
          return false;
        }
      },

      speakWithBrowser: function(text, button, requestId) {
        if (!this.isBrowserAllowed()) {
          this.clearSpeakingState();
          return;
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = document.documentElement.lang || navigator.language || 'en-US';

        utterance.onend = () => {
          if (this.utterance === utterance) {
            this.clearSpeakingState();
          }
        };
        utterance.onerror = () => {
          if (this.utterance === utterance) {
            this.clearSpeakingState();
          }
        };

        this.utterance = utterance;
        this.activeButton = button;
        this.setSpeakingState(button, true);

        clearTimeout(this.speakTimer);
        this.speakTimer = setTimeout(() => {
          if (requestId !== this.speakRequestId) return;
          try {
            window.speechSynthesis.speak(utterance);
          } catch (error) {
            this.clearSpeakingState();
          }
        }, 40);
      },

      clearAudio: function() {
        if (this.audio) {
          try {
            this.audio.pause();
            this.audio.removeAttribute('src');
            this.audio.load();
          } catch (error) {
            // ignore
          }
          this.audio = null;
        }
        if (this.audioUrl) {
          try {
            URL.revokeObjectURL(this.audioUrl);
          } catch (error) {
            // ignore
          }
          this.audioUrl = null;
        }
      },

      stop: function() {
        this.speakRequestId += 1;
        clearTimeout(this.speakTimer);
        this.speakTimer = null;
        this.clearAudio();

        if (typeof window !== 'undefined' && window.speechSynthesis) {
          try {
            window.speechSynthesis.cancel();
          } catch (error) {
            // ignore cancel errors
          }
        }

        this.utterance = null;
        this.clearSpeakingState();
      },

      setSpeakingState: function(button, speaking) {
        if (!button) return;

        button.classList.toggle('is-speaking', speaking);
        const playIcon = button.querySelector('.shop-ai-speak-icon--play');
        const stopIcon = button.querySelector('.shop-ai-speak-icon--stop');
        if (playIcon) playIcon.hidden = speaking;
        if (stopIcon) stopIcon.hidden = !speaking;

        const label = speaking
          ? this.getLabel('speakStopLabel', 'Stop listening')
          : this.getLabel('speakStartLabel', 'Listen to response');
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
      },

      clearSpeakingState: function() {
        if (this.activeButton) {
          this.setSpeakingState(this.activeButton, false);
        }
        this.activeButton = null;
        this.utterance = null;
      }
    },

    /**
     * Mirror chat/UCP cart onto the Shopify theme Ajax cart (/cart.js).
     * Already-removed theme lines are treated as no-ops (qty 0 / missing).
     * Also imports theme → chat (merge) so manual theme items are not wiped.
     */
    ThemeCart: {
      syncing: false,
      importing: false,
      suppressImportUntil: 0,
      _listenersBound: false,
      _importTimer: null,

      cartRoot: function() {
        const root = window.Shopify?.routes?.root;
        if (typeof root === 'string' && root.length) {
          return root.endsWith('/') ? root : `${root}/`;
        }
        return '/';
      },

      cartUrl: function(path) {
        return `${this.cartRoot()}${String(path || '').replace(/^\//, '')}`;
      },

      toNumericVariantId: function(value) {
        const raw = String(value || '').trim();
        if (!raw) return null;
        if (/^\d+$/.test(raw)) return raw;
        const match = raw.match(/ProductVariant\/(\d+)/i);
        return match ? match[1] : null;
      },

      ensureListeners: function() {
        if (this._listenersBound) return;
        this._listenersBound = true;

        const onThemeCartEvent = (event) => {
          const detail = event?.detail;
          if (detail && typeof detail === 'object' && detail.source === 'shop-ai-chat') {
            return;
          }
          this.scheduleImportFromTheme('theme-event');
        };

        document.addEventListener('cart:updated', onThemeCartEvent);
        document.documentElement.addEventListener('cart:updated', onThemeCartEvent);
        document.addEventListener('cart:refresh', onThemeCartEvent);
      },

      scheduleImportFromTheme: function(reason) {
        if (this.syncing || this.importing) return;
        if (Date.now() < (this.suppressImportUntil || 0)) return;

        clearTimeout(this._importTimer);
        this._importTimer = setTimeout(() => {
          this.importThemeCartIntoChat({ reason: reason || 'scheduled' }).catch((error) => {
            console.warn('[ShopAIChat] theme→chat import failed', error?.message || error);
          });
        }, 450);
      },

      getThemeCartItems: async function() {
        const cart = await this.fetchThemeCart();
        const byVariant = new Map();
        (cart.items || []).forEach((line) => {
          const id = this.toNumericVariantId(line.variant_id);
          const qty = Math.max(0, Number(line.quantity) || 0);
          if (!id || qty <= 0) return;
          byVariant.set(id, (byVariant.get(id) || 0) + qty);
        });
        return Array.from(byVariant.entries()).map(([variant_id, quantity]) => ({
          variant_id,
          quantity
        }));
      },

      /**
       * Sync theme Ajax cart → conversation UCP cart.
       * Empty theme cart clears chat cart (theme is source of truth when emptied).
       */
      importThemeCartIntoChat: async function(options = {}) {
        if (this.importing || this.syncing) return null;
        if (Date.now() < (this.suppressImportUntil || 0) && !options.force) return null;

        const conversationId = getConversationId();
        if (!conversationId) return null;

        this.importing = true;
        try {
          let items = [];
          try {
            items = await this.getThemeCartItems();
          } catch (error) {
            console.warn('[ShopAIChat] theme cart read failed', error?.message || error);
            return null;
          }

          const apiBaseUrl = getApiBaseUrl();
          const shopId = window.shopId;
          const shopDomain = window.shopDomain;
          const response = await fetch(`${apiBaseUrl}/chat/theme-cart-import`, {
            method: 'POST',
            headers: getApiHeaders({
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'X-Shopify-Shop-Id': shopId,
              ...(shopDomain ? { 'X-Shopify-Shop-Domain': shopDomain } : {})
            }),
            body: JSON.stringify({
              conversation_id: conversationId,
              items,
              shop: shopDomain || undefined,
              ...getCustomerContextPayload()
            })
          });

          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`theme-cart-import ${response.status} ${text}`.trim());
          }

          const result = await response.json();
          console.log('[ShopAIChat] theme→chat import', {
            reason: options.reason || null,
            merged: result?.merged,
            cleared: result?.cleared || false,
            itemCount: result?.items?.length || 0
          });

          // Theme is source of truth — do not bump theme from chat after import.
          return result;
        } finally {
          this.importing = false;
        }
      },

      /**
       * Raise theme line qtys to match chat/UCP (never remove theme lines).
       */
      bumpThemeQuantitiesFromChat: async function(items) {
        const desired = new Map();
        (Array.isArray(items) ? items : []).forEach((item) => {
          const id = this.toNumericVariantId(item?.variant_id);
          const qty = Math.max(0, Number(item?.quantity) || 0);
          if (!id || qty <= 0) return;
          desired.set(id, (desired.get(id) || 0) + qty);
        });
        if (!desired.size) return;

        this.suppressImportUntil = Date.now() + 2000;
        const prevSyncing = this.syncing;
        this.syncing = true;
        try {
          let cart = await this.fetchThemeCart();
          const updates = {};
          const present = new Set();

          (cart.items || []).forEach((line) => {
            const vid = String(line.variant_id);
            present.add(vid);
            if (desired.has(vid) && desired.get(vid) > Number(line.quantity || 0)) {
              updates[vid] = desired.get(vid);
            }
          });

          if (Object.keys(updates).length) {
            cart = await this.postJson(this.cartUrl('cart/update.js'), { updates });
          }

          const toAdd = [];
          desired.forEach((qty, vid) => {
            if (!present.has(String(vid)) && qty > 0) {
              toAdd.push({ id: Number(vid), quantity: qty });
            }
          });

          if (toAdd.length) {
            try {
              await this.postJson(this.cartUrl('cart/add.js'), { items: toAdd });
            } catch (addError) {
              for (const item of toAdd) {
                try {
                  await this.postJson(this.cartUrl('cart/add.js'), { items: [item] });
                } catch (oneError) {
                  console.warn('[ShopAIChat] theme bump add skipped', item.id, oneError?.message || oneError);
                }
              }
            }
            cart = await this.fetchThemeCart();
          }

          await this.notifyThemeCartChanged(cart);
        } finally {
          this.syncing = prevSyncing;
        }
      },

      /**
       * @param {{ empty?: boolean, items?: Array<{ variant_id?: string, quantity?: number }> }} payload
       */
      syncFromChatCart: async function(payload) {
        if (this.syncing) return;
        this.syncing = true;
        this.suppressImportUntil = Date.now() + 2000;

        try {
          const desired = new Map();
          const sourceItems = Array.isArray(payload?.items) ? payload.items : [];

          if (!payload?.empty) {
            sourceItems.forEach((item) => {
              const id = this.toNumericVariantId(item?.variant_id);
              const qty = Math.max(0, Number(item?.quantity) || 0);
              if (!id || qty <= 0) return;
              desired.set(id, (desired.get(id) || 0) + qty);
            });
          }

          // Empty chat cart → clear theme cart (no-op if already empty).
          if (!desired.size) {
            await this.clearThemeCart();
            await this.notifyThemeCartChanged();
            console.log('[ShopAIChat] theme cart synced (cleared)');
            return;
          }

          let cart = await this.fetchThemeCart();
          const updates = {};

          (cart.items || []).forEach((line) => {
            const vid = String(line.variant_id);
            updates[vid] = desired.has(vid) ? desired.get(vid) : 0;
          });

          if (Object.keys(updates).length) {
            cart = await this.postJson(this.cartUrl('cart/update.js'), { updates });
          }

          // Add variants that chat has but theme does not (or were already removed manually).
          const toAdd = [];
          desired.forEach((qty, vid) => {
            const line = (cart.items || []).find((item) => String(item.variant_id) === String(vid));
            if (!line && qty > 0) {
              toAdd.push({ id: Number(vid), quantity: qty });
            }
          });

          if (toAdd.length) {
            try {
              await this.postJson(this.cartUrl('cart/add.js'), { items: toAdd });
            } catch (addError) {
              console.warn('[ShopAIChat] theme cart bulk add failed, trying one-by-one', addError?.message || addError);
              for (const item of toAdd) {
                try {
                  await this.postJson(this.cartUrl('cart/add.js'), { items: [item] });
                } catch (oneError) {
                  // Unavailable / already handled — ignore
                  console.warn('[ShopAIChat] theme add skipped', item.id, oneError?.message || oneError);
                }
              }
            }
            cart = await this.fetchThemeCart();
          }

          await this.notifyThemeCartChanged(cart);
          console.log('[ShopAIChat] theme cart synced', {
            desired: Array.from(desired.entries()).map(([id, quantity]) => ({ id, quantity })),
            themeCount: (cart.items || []).length
          });
        } finally {
          this.syncing = false;
        }
      },

      fetchThemeCart: async function() {
        const response = await fetch(this.cartUrl('cart.js'), {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'same-origin'
        });
        if (!response.ok) {
          throw new Error(`cart.js failed: ${response.status}`);
        }
        return response.json();
      },

      clearThemeCart: async function() {
        try {
          await this.postJson(this.cartUrl('cart/clear.js'), {});
        } catch (error) {
          // Already empty / theme without clear — try zeroing lines
          const cart = await this.fetchThemeCart();
          if (!(cart.items || []).length) return cart;
          const updates = {};
          (cart.items || []).forEach((line) => {
            updates[String(line.variant_id)] = 0;
          });
          return this.postJson(this.cartUrl('cart/update.js'), { updates });
        }
        return this.fetchThemeCart();
      },

      postJson: async function(url, body) {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          credentials: 'same-origin',
          body: JSON.stringify(body || {})
        });
        if (!response.ok) {
          let detail = '';
          try {
            detail = await response.text();
          } catch (e) {
            // ignore
          }
          throw new Error(`${url} failed: ${response.status} ${detail}`.trim());
        }
        try {
          return await response.json();
        } catch (e) {
          return {};
        }
      },

      notifyThemeCartChanged: async function(cart) {
        this.suppressImportUntil = Date.now() + 2000;

        let latest = cart;
        try {
          if (!latest || !Array.isArray(latest.items)) {
            latest = await this.fetchThemeCart();
          }
        } catch (e) {
          latest = cart || null;
        }

        // Mark as our event so theme→chat import listeners ignore the echo.
        if (latest && typeof latest === 'object') {
          try {
            latest.source = 'shop-ai-chat';
          } catch (e) {
            // ignore
          }
        }

        try {
          document.documentElement.dispatchEvent(
            new CustomEvent('cart:updated', { bubbles: true, detail: latest })
          );
          document.dispatchEvent(
            new CustomEvent('cart:updated', { bubbles: true, detail: latest })
          );
          document.dispatchEvent(
            new CustomEvent('cart:refresh', { bubbles: true, detail: latest })
          );
        } catch (e) {
          // ignore
        }

        // Common theme hooks
        try {
          if (typeof window.publish === 'function' && window.PUB_SUB_EVENTS?.cartUpdate) {
            window.publish(window.PUB_SUB_EVENTS.cartUpdate, { cart: latest, source: 'shop-ai-chat' });
          }
        } catch (e) {
          // ignore
        }

        try {
          if (window.Shopify?.theme?.cart?.update) {
            window.Shopify.theme.cart.update(latest);
          }
        } catch (e) {
          // ignore
        }

        // Refresh cart count bubbles if present
        try {
          const count = latest?.item_count;
          if (typeof count === 'number') {
            document.querySelectorAll('[data-cart-count], .cart-count, .cart-count-bubble span').forEach((el) => {
              if (el.childElementCount === 0 || el.matches('span')) {
                el.textContent = String(count);
              }
            });
          }
        } catch (e) {
          // ignore
        }
      }
    },

    /**
     * Product-related functionality
     */
    Product: {
      /**
       * Left/right controls for a horizontal scroller.
       */
      createScrollControls: function(carousel, scroller, options = {}) {
        const prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.classList.add('shop-ai-product-scroll', 'shop-ai-product-scroll--prev');
        prevBtn.setAttribute('aria-label', options.prevLabel || 'Scroll left');
        prevBtn.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>';

        const nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.classList.add('shop-ai-product-scroll', 'shop-ai-product-scroll--next');
        nextBtn.setAttribute('aria-label', options.nextLabel || 'Scroll right');
        nextBtn.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>';

        const refresh = function() {
          const maxScroll = scroller.scrollWidth - scroller.clientWidth;
          const canScroll = maxScroll > 4;
          carousel.classList.toggle('has-overflow', canScroll);
          if (!canScroll) {
            prevBtn.hidden = true;
            nextBtn.hidden = true;
            return;
          }
          // Keep both visible on small screens so users notice scrolling is possible;
          // only dim/disable at the edges.
          prevBtn.hidden = false;
          nextBtn.hidden = false;
          const atStart = scroller.scrollLeft <= 4;
          const atEnd = scroller.scrollLeft >= maxScroll - 4;
          prevBtn.disabled = atStart;
          nextBtn.disabled = atEnd;
          prevBtn.classList.toggle('is-disabled', atStart);
          nextBtn.classList.toggle('is-disabled', atEnd);
        };

        const scrollByStep = function(direction) {
          let amount = Math.max(140, scroller.clientWidth * 0.75);
          if (options.stepSelector) {
            const stepEl = scroller.querySelector(options.stepSelector);
            if (stepEl) amount = stepEl.offsetWidth + 12;
          } else if (typeof options.step === 'number') {
            amount = options.step;
          }
          scroller.scrollBy({ left: direction * amount, behavior: 'smooth' });
        };

        prevBtn.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (!prevBtn.disabled) scrollByStep(-1);
        });
        nextBtn.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (!nextBtn.disabled) scrollByStep(1);
        });
        scroller.addEventListener('scroll', refresh, { passive: true });
        if (typeof ResizeObserver !== 'undefined') {
          const observer = new ResizeObserver(refresh);
          observer.observe(scroller);
          observer.observe(carousel);
        }

        return { prevBtn, nextBtn, refresh };
      },

      /**
       * Create a product card element
       * @param {Object} product - Product data
       * @returns {HTMLElement} Product card element
       */
      createCard: function(product) {
        const card = document.createElement('div');
        card.classList.add('shop-ai-product-card');
        if (product.isBest) {
          card.classList.add('shop-ai-product-card--best');
        }

        // Create image container
        const imageContainer = document.createElement('div');
        imageContainer.classList.add('shop-ai-product-image');

        // Add product image or placeholder
        const image = document.createElement('img');
        image.src = product.image_url || 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
        image.alt = product.title;
        image.onerror = function() {
          // If image fails to load, use a fallback placeholder
          this.src = 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
        };
        imageContainer.appendChild(image);

        if (product.isBest) {
          const badge = document.createElement('span');
          badge.classList.add('shop-ai-best-badge');
          badge.textContent = 'Best pick';
          imageContainer.appendChild(badge);
        }

        card.appendChild(imageContainer);

        // Add product info
        const info = document.createElement('div');
        info.classList.add('shop-ai-product-info');

        // Add product title (full text always visible)
        const title = document.createElement('h3');
        title.classList.add('shop-ai-product-title');
        title.setAttribute('aria-label', product.title || 'Product title');
        title.textContent = product.title || '';

        let productHref = '';
        if (product.url) {
          productHref = product.url;
          if (productHref.includes('yourstore.com')) {
            const storefrontOrigin = (window.shopChatConfig && window.shopChatConfig.storefrontUrl)
              ? String(window.shopChatConfig.storefrontUrl).replace(/\/+$/, '')
              : window.location.origin;
            productHref = productHref.replace(/https?:\/\/(?:www\.)?yourstore\.com/gi, storefrontOrigin);
          } else if (productHref.startsWith('/')) {
            const storefrontOrigin = (window.shopChatConfig && window.shopChatConfig.storefrontUrl)
              ? String(window.shopChatConfig.storefrontUrl).replace(/\/+$/, '')
              : window.location.origin;
            productHref = storefrontOrigin + productHref;
          }
        }

        if (productHref) {
          title.classList.add('shop-ai-product-title--link');
          title.addEventListener('click', function(event) {
            event.preventDefault();
            event.stopPropagation();
            window.open(productHref, '_blank', 'noopener,noreferrer');
          });
        }

        info.appendChild(title);

        // Add product price
        const price = document.createElement('p');
        price.classList.add('shop-ai-product-price');
        price.textContent = product.price;
        if (product.compareAtPrice) {
          const compare = document.createElement('span');
          compare.classList.add('shop-ai-product-compare-price');
          compare.textContent = ` ${product.compareAtPrice}`;
          price.appendChild(compare);
        }
        info.appendChild(price);

        const qty = typeof product.inventoryQuantity === 'number' ? product.inventoryQuantity : null;
        const inStock =
          product.inStock === true &&
          product.availableForSale !== false &&
          qty !== 0;

        const stock = document.createElement('p');
        stock.classList.add('shop-ai-product-stock');
        if (inStock) {
          stock.classList.add('in-stock');
          stock.textContent = 'In stock';
        } else {
          stock.classList.add('out-of-stock');
          stock.textContent = 'Out of stock';
          card.classList.add('shop-ai-product-card--out-of-stock');
        }
        info.appendChild(stock);

        const resources = document.createElement('div');
        resources.classList.add('shop-ai-product-resources');

        const pdfUrl = String(product.pdfUrl || product.pdf_url || '').trim();
        const pdfTitle = String(product.pdfTitle || product.pdf_title || '').trim();
        if (pdfUrl) {
          const pdfLink = document.createElement('a');
          pdfLink.classList.add('shop-ai-product-pdf');
          pdfLink.href = pdfUrl;
          pdfLink.target = '_blank';
          pdfLink.rel = 'noopener noreferrer';
          pdfLink.textContent = pdfTitle || 'View PDF';
          resources.appendChild(pdfLink);
        }

        const youtubeUrl = String(product.youtubeUrl || product.youtube_url || '').trim();
        if (youtubeUrl) {
          const ytLink = document.createElement('a');
          ytLink.classList.add('shop-ai-product-youtube');
          ytLink.href = youtubeUrl;
          ytLink.target = '_blank';
          ytLink.rel = 'noopener noreferrer';
          ytLink.textContent = 'Installation Video';
          resources.appendChild(ytLink);
        }

        info.appendChild(resources);

        // Only show Add to Cart when in stock
        if (inStock) {
          const button = document.createElement('button');
          button.classList.add('shop-ai-add-to-cart');
          button.textContent = 'Add to Cart';
          button.dataset.productId = product.id;
          button.addEventListener('click', function() {
            const input = document.querySelector('.shop-ai-chat-input-field');
            const messagesContainer = document.querySelector('.shop-ai-chat-messages');
            ShopAIChat.UI.showChatView();
            if (input) {
              input.value = buildAddToCartMessage(product);
              const sendButton = document.querySelector('.shop-ai-chat-send');
              if (sendButton) {
                sendButton.click();
              }
            }
          });
          info.appendChild(button);
        }

        card.appendChild(info);

        return card;
      },

      createComparisonTable: function(products) {
        const wrap = document.createElement('div');
        wrap.classList.add('shop-ai-compare');

        const heading = document.createElement('h5');
        heading.classList.add('shop-ai-compare-title');
        heading.textContent = 'Quick comparison';
        wrap.appendChild(heading);

        const scroller = document.createElement('div');
        scroller.classList.add('shop-ai-compare-scroll');

        const table = document.createElement('table');
        table.classList.add('shop-ai-compare-table');

        const productName = (product) => {
          const full = String(product.title || product.sku || product.partNumber || 'Product').trim();
          if (full.length <= 42) return full;
          return `${full.slice(0, 39).trim()}…`;
        };

        const productNameFull = (product) =>
          String(product.title || product.sku || product.partNumber || 'Product').trim();

        const yesNo = (value) => (value ? 'Yes' : 'No');

        const headerRow = document.createElement('tr');
        const featureHeader = document.createElement('th');
        featureHeader.textContent = 'Feature';
        headerRow.appendChild(featureHeader);
        products.forEach((product) => {
          const th = document.createElement('th');
          const label = document.createElement('span');
          label.classList.add('shop-ai-compare-product-head');
          label.textContent = productName(product);
          th.appendChild(label);
          th.title = productNameFull(product);
          if (product.isBest) th.classList.add('is-best');
          headerRow.appendChild(th);
        });
        table.appendChild(headerRow);

        const isFreshenerCompare = products.some(
          (p) =>
            p.productCategory === 'freshener' ||
            p.filterType === 'freshener' ||
            /\bfreshener/i.test(String(p.title || '')) ||
            /\bfreshener|freshers/i.test(String(p.productType || p.product_type || ''))
        );

        const rows = isFreshenerCompare
          ? [
              {
                label: 'Fragrance',
                value: (p) => p.fragrance || '—'
              },
              {
                label: 'Duration',
                value: (p) =>
                  typeof p.durationDays === 'number' ? `Up to ${p.durationDays} days` : '—'
              },
              {
                label: 'Odor eliminator',
                value: (p) => yesNo(p.hasOdorEliminator)
              },
              { label: 'Price', value: (p) => p.price || '—' },
              {
                label: 'Stock',
                value: (p) =>
                  p.inStock && p.availableForSale !== false ? 'In stock' : 'Out of stock'
              }
            ]
          : [
              { label: 'HEPA', value: (p) => yesNo(p.isHepa) },
              { label: 'Antibacterial', value: (p) => yesNo(p.hasAntibacterial) },
              { label: 'Charcoal / odor', value: (p) => yesNo(p.hasCharcoal) },
              { label: 'Price', value: (p) => p.price || '—' },
              {
                label: 'Stock',
                value: (p) =>
                  p.inStock && p.availableForSale !== false ? 'In stock' : 'Out of stock'
              }
            ];

        rows.forEach((row) => {
          const tr = document.createElement('tr');
          const label = document.createElement('td');
          label.textContent = row.label;
          tr.appendChild(label);
          products.forEach((product) => {
            const td = document.createElement('td');
            td.textContent = row.value(product);
            if (product.isBest) td.classList.add('is-best');
            tr.appendChild(td);
          });
          table.appendChild(tr);
        });

        scroller.appendChild(table);
        wrap.appendChild(scroller);
        return wrap;
      },

      createBestProductSection: function(bestProduct) {
        const section = document.createElement('div');
        section.classList.add('shop-ai-best-section');

        const heading = document.createElement('h5');
        heading.classList.add('shop-ai-best-section-title');
        heading.textContent = 'Best product';
        section.appendChild(heading);

        section.appendChild(ShopAIChat.Product.createBestHighlightCard(bestProduct));
        return section;
      },

      createBestHighlightCard: function(product) {
        const card = document.createElement('div');
        card.classList.add('shop-ai-best-highlight');

        const imageWrap = document.createElement('div');
        imageWrap.classList.add('shop-ai-best-highlight-image');
        const image = document.createElement('img');
        image.src = product.image_url || 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
        image.alt = product.title || 'Best product';
        image.onerror = function() {
          this.src = 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
        };
        imageWrap.appendChild(image);

        const badge = document.createElement('span');
        badge.classList.add('shop-ai-best-badge');
        badge.textContent = 'Best pick';
        imageWrap.appendChild(badge);
        card.appendChild(imageWrap);

        const info = document.createElement('div');
        info.classList.add('shop-ai-best-highlight-info');

        let productHref = '';
        if (product.url) {
          productHref = product.url;
          if (productHref.includes('yourstore.com')) {
            const storefrontOrigin = (window.shopChatConfig && window.shopChatConfig.storefrontUrl)
              ? String(window.shopChatConfig.storefrontUrl).replace(/\/+$/, '')
              : window.location.origin;
            productHref = productHref.replace(/https?:\/\/(?:www\.)?yourstore\.com/gi, storefrontOrigin);
          } else if (productHref.startsWith('/')) {
            const storefrontOrigin = (window.shopChatConfig && window.shopChatConfig.storefrontUrl)
              ? String(window.shopChatConfig.storefrontUrl).replace(/\/+$/, '')
              : window.location.origin;
            productHref = storefrontOrigin + productHref;
          }
        }

        const title = document.createElement('h3');
        title.classList.add('shop-ai-best-highlight-title');
        const fullTitle = product.title || '';
        title.textContent = fullTitle.length <= 72 ? fullTitle : `${fullTitle.slice(0, 69).trim()}…`;
        title.title = fullTitle;
        if (productHref) {
          title.classList.add('shop-ai-best-highlight-title--link');
          title.addEventListener('click', function(event) {
            event.preventDefault();
            event.stopPropagation();
            window.open(productHref, '_blank', 'noopener,noreferrer');
          });
        }
        info.appendChild(title);

        const qty = typeof product.inventoryQuantity === 'number' ? product.inventoryQuantity : null;
        const inStock =
          product.inStock === true &&
          product.availableForSale !== false &&
          qty !== 0;

        const price = document.createElement('span');
        price.classList.add('shop-ai-product-price');
        price.textContent = product.price || '';

        const stock = document.createElement('span');
        stock.classList.add('shop-ai-product-stock');
        if (inStock) {
          stock.classList.add('in-stock');
          stock.textContent = 'In stock';
        } else {
          stock.classList.add('out-of-stock');
          stock.textContent = 'Out of stock';
        }

        const meta = document.createElement('div');
        meta.classList.add('shop-ai-best-highlight-meta');
        meta.appendChild(price);
        meta.appendChild(stock);
        info.appendChild(meta);

        const pdfUrl = String(product.pdfUrl || product.pdf_url || '').trim();
        const pdfTitle = String(product.pdfTitle || product.pdf_title || '').trim();
        if (pdfUrl) {
          const pdfLink = document.createElement('a');
          pdfLink.classList.add('shop-ai-product-pdf');
          pdfLink.href = pdfUrl;
          pdfLink.target = '_blank';
          pdfLink.rel = 'noopener noreferrer';
          pdfLink.textContent = pdfTitle || 'View PDF';
          info.appendChild(pdfLink);
        }

        const youtubeUrl = String(product.youtubeUrl || product.youtube_url || '').trim();
        if (youtubeUrl) {
          const ytLink = document.createElement('a');
          ytLink.classList.add('shop-ai-product-youtube');
          ytLink.href = youtubeUrl;
          ytLink.target = '_blank';
          ytLink.rel = 'noopener noreferrer';
          ytLink.textContent = 'Installation Video';
          info.appendChild(ytLink);
        }

        if (inStock) {
          const actions = document.createElement('div');
          actions.classList.add('shop-ai-best-highlight-actions');
          const button = document.createElement('button');
          button.classList.add('shop-ai-add-to-cart');
          button.textContent = 'Add to Cart';
          button.addEventListener('click', function() {
            const input = document.querySelector('.shop-ai-chat-input-field');
            ShopAIChat.UI.showChatView();
            if (input) {
              input.value = buildAddToCartMessage(product);
              const sendButton = document.querySelector('.shop-ai-chat-send');
              if (sendButton) sendButton.click();
            }
          });
          actions.appendChild(button);
          info.appendChild(actions);
        }

        card.appendChild(info);
        return card;
      }
    },

    /**
     * Initialize the chat application
     */
    init: async function() {
      // Initialize UI
      const container = document.querySelector('.shop-ai-chat-container');
      if (!container) return;

      this.UI.init(container);
      await this.Config.load();
      this.ThemeCart.ensureListeners();
      clearLegacyConversationStorage();

      // Paint home/recent chats from local cache immediately (keyed by shopAiShopperId).
      hydrateShopperCacheFromStorage();
      this.UI.showHomeView();

      // One shopper-session call per page load — then rely on localStorage + chat bind.
      resolveShopperSessionOnceOnLoad()
        .then(() => {
          if (this.UI.currentView === 'home') {
            this.UI.renderSessionsList();
          }
        })
        .catch((error) => {
          console.warn('[ShopAIChat] shopper session resolve failed', error?.message || error);
        });

      if (isCustomerLoggedIn() && getLoggedInCustomerId()) {
        syncCustomerAddressesToServer().catch(() => {});
      }
    }
  };

  // Initialize the application when DOM is ready
  document.addEventListener('DOMContentLoaded', function() {
    ShopAIChat.init().catch(function(error) {
      console.error('Failed to initialize chat:', error);
    });
  });
})();
