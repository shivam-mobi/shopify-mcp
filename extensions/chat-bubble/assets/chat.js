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

  function getApiHeaders(extraHeaders = {}) {
    return {
      'ngrok-skip-browser-warning': 'true',
      ...extraHeaders
    };
  }

  const CONVERSATION_ID_KEY = 'shopAiConversationId';
  let conversationStorageMode = 'localStorage';

  function resolveConversationStorageMode(mode) {
    return String(mode || '').toLowerCase() === 'sessionstorage'
      ? 'sessionStorage'
      : 'localStorage';
  }

  function getConversationStorage() {
    return resolveConversationStorageMode(conversationStorageMode) === 'sessionStorage'
      ? sessionStorage
      : localStorage;
  }

  function getConversationId() {
    const storage = getConversationStorage();
    let id = storage.getItem(CONVERSATION_ID_KEY);

    // Migrate an existing per-tab session id into localStorage when upgrading
    if (!id && storage === localStorage) {
      id = sessionStorage.getItem(CONVERSATION_ID_KEY);
      if (id) {
        localStorage.setItem(CONVERSATION_ID_KEY, id);
        sessionStorage.removeItem(CONVERSATION_ID_KEY);
      }
    }

    return id;
  }

  function setConversationId(id) {
    getConversationStorage().setItem(CONVERSATION_ID_KEY, id);
  }

  function clearConversationId() {
    getConversationStorage().removeItem(CONVERSATION_ID_KEY);
    sessionStorage.removeItem(CONVERSATION_ID_KEY);
  }

  const ShopAIChat = {
    Config: {
      load: async function() {
        const fromTheme = window.shopChatConfig?.conversationStorage;
        if (fromTheme) {
          conversationStorageMode = resolveConversationStorageMode(fromTheme);
          return;
        }

        try {
          const apiBaseUrl = getApiBaseUrl();
          const response = await fetch(`${apiBaseUrl}/chat?config=true`, {
            headers: getApiHeaders({ Accept: 'application/json' })
          });

          if (response.ok) {
            const data = await response.json();
            conversationStorageMode = resolveConversationStorageMode(data.conversationStorage);
          }
        } catch (error) {
          console.warn('Could not load chat config; using localStorage for conversation id', error);
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
          closeButton: container.querySelector('.shop-ai-chat-close'),
          chatInput: container.querySelector('.shop-ai-chat-input input'),
          sendButton: container.querySelector('.shop-ai-chat-send'),
          messagesContainer: container.querySelector('.shop-ai-chat-messages')
        };

        // Detect mobile device
        this.isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

        // Set up event listeners
        this.setupEventListeners();

        // Fix for iOS Safari viewport height issues
        if (this.isMobile) {
          this.setupMobileViewport();
        }
      },

      /**
       * Set up all event listeners for UI interactions
       */
      setupEventListeners: function() {
        const { chatBubble, closeButton, chatInput, sendButton, messagesContainer } = this.elements;

        // Toggle chat window visibility
        chatBubble.addEventListener('click', () => this.toggleChatWindow());

        // Close chat window
        closeButton.addEventListener('click', () => this.closeChatWindow());

        // Send message when pressing Enter in input
        chatInput.addEventListener('keypress', (e) => {
          if (e.key === 'Enter' && chatInput.value.trim() !== '') {
            ShopAIChat.Message.send(chatInput, messagesContainer);

            // On mobile, handle keyboard
            if (this.isMobile) {
              chatInput.blur();
              setTimeout(() => chatInput.focus(), 300);
            }
          }
        });

        // Send message when clicking send button
        sendButton.addEventListener('click', () => {
          if (chatInput.value.trim() !== '') {
            ShopAIChat.Message.send(chatInput, messagesContainer);

            // On mobile, focus input after sending
            if (this.isMobile) {
              setTimeout(() => chatInput.focus(), 300);
            }
          }
        });

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
       * Setup mobile-specific viewport adjustments
       */
      setupMobileViewport: function() {
        const setViewportHeight = () => {
          document.documentElement.style.setProperty('--viewport-height', `${window.innerHeight}px`);
        };
        window.addEventListener('resize', setViewportHeight);
        setViewportHeight();
      },

      /**
       * Toggle chat window visibility
       */
      toggleChatWindow: function() {
        const { chatWindow, chatInput } = this.elements;

        chatWindow.classList.toggle('active');

        if (chatWindow.classList.contains('active')) {
          // On mobile, prevent body scrolling and delay focus
          if (this.isMobile) {
            document.body.classList.add('shop-ai-chat-open');
            setTimeout(() => chatInput.focus(), 500);
          } else {
            chatInput.focus();
          }
          // Always scroll messages to bottom when opening
          this.scrollToBottom();
        } else {
          // Remove body class when closing
          document.body.classList.remove('shop-ai-chat-open');
        }
      },

      /**
       * Close chat window
       */
      closeChatWindow: function() {
        const { chatWindow, chatInput } = this.elements;

        chatWindow.classList.remove('active');

        // On mobile, blur input to hide keyboard and enable body scrolling
        if (this.isMobile) {
          chatInput.blur();
          document.body.classList.remove('shop-ai-chat-open');
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
       * Show typing indicator in the chat
       */
      showTypingIndicator: function() {
        const { messagesContainer } = this.elements;

        const typingIndicator = document.createElement('div');
        typingIndicator.classList.add('shop-ai-typing-indicator');
        typingIndicator.innerHTML = '<span></span><span></span><span></span>';
        messagesContainer.appendChild(typingIndicator);
        this.scrollToBottom();
      },

      /**
       * Remove typing indicator from the chat
       */
      removeTypingIndicator: function() {
        const { messagesContainer } = this.elements;

        const typingIndicator = messagesContainer.querySelector('.shop-ai-typing-indicator');
        if (typingIndicator) {
          typingIndicator.remove();
        }
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

        lastProducts.parentNode.insertBefore(textEl, lastProducts);
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
        let blocks = null;

        try {
          const parsed = JSON.parse(message.content);
          if (Array.isArray(parsed)) blocks = parsed;
        } catch (e) {
          blocks = null;
        }

        if (!blocks) {
          const text = String(message.content || '').trim();
          if (text) ShopAIChat.Message.add(text, role, messagesContainer);
          return;
        }

        blocks.forEach((contentBlock) => {
          if (contentBlock.type === 'text' && String(contentBlock.text || '').trim()) {
            ShopAIChat.Message.add(contentBlock.text, role, messagesContainer);
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

        // Create the product grid container
        const productsContainer = document.createElement('div');
        productsContainer.classList.add('shop-ai-product-grid');
        productSection.appendChild(productsContainer);

        if (!list.length) {
          const noProductsMessage = document.createElement('p');
          noProductsMessage.textContent = "No products found";
          noProductsMessage.style.padding = "10px";
          productsContainer.appendChild(noProductsMessage);
        } else {
          list.forEach(product => {
            const productCard = ShopAIChat.Product.createCard(product);
            productsContainer.appendChild(productCard);
          });

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
        if (!userMessage) return;

        // Clear input
        chatInput.value = '';

        await this.sendText(userMessage, messagesContainer);
      },

      /**
       * Send a prepared message (typed or from a suggestion chip)
       */
      sendText: async function(userMessage, messagesContainer) {
        const text = String(userMessage || '').trim();
        if (!text) return;

        const conversationId = getConversationId();

        // Add user message to chat
        this.add(text, 'user', messagesContainer);

        // Show typing indicator
        ShopAIChat.UI.showTypingIndicator();

        try {
          ShopAIChat.API.streamResponse(text, conversationId, messagesContainer);
        } catch (error) {
          console.error('Error communicating with the LLM API:', error);
          ShopAIChat.UI.removeTypingIndicator();
          this.add(
            "Sorry, I couldn't complete that right now. Please try again in a moment.",
            'assistant',
            messagesContainer
          );
        }
      },

      /**
       * Add a message to the chat
       * @param {string} text - Message content
       * @param {string} sender - Message sender ('user' or 'assistant')
       * @param {HTMLElement} messagesContainer - The messages container
       * @returns {HTMLElement} The created message element
       */
      add: function(text, sender, messagesContainer) {
        if (!String(text || '').trim()) return null;

        const messageElement = document.createElement('div');
        messageElement.classList.add('shop-ai-message', sender);

        if (sender === 'assistant') {
          messageElement.dataset.rawText = text;
          ShopAIChat.Formatting.formatMessageContent(messageElement);
        } else {
          messageElement.textContent = text;
        }

        messagesContainer.appendChild(messageElement);
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
        const match = toolMessage.match(/Calling tool: (\w+) with arguments: (.+)/);
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
        let processedText = this.stripBestPickFromReply(
          this.stripDuplicateProductListing(rawText)
        );

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

        // Process Markdown links
        const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
        processedText = processedText.replace(markdownLinkRegex, (match, text, url) => {
          const href = this.toAbsoluteUrl(String(url || '').trim());
          if (!href) {
            return text;
          }

          // Check if it's an auth URL
          if (href.includes('shopify.com/authentication') &&
             (href.includes('oauth/authorize') || href.includes('authentication'))) {
            // Store the auth URL in a global variable for later use - this avoids issues with onclick handlers
            window.shopAuthUrl = href;
            // Just return normal link that will be handled by the document click handler
            return '<a href="#auth" class="shop-auth-trigger">' + text + '</a>';
          }
          // If it's a checkout link, replace the text
          else if (href.includes('/cart') || href.includes('checkout')) {
            return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">click here to proceed to checkout</a>';
          } else {
            // For normal links, preserve the original text
            return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
          }
        });

        // Convert text to HTML with proper list handling
        processedText = this.convertMarkdownToHtml(processedText);

        // Apply the formatted HTML
        element.innerHTML = processedText;
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
       * Hide long LLM product dumps — cards + comparison UI already show them.
       */
      stripDuplicateProductListing: function(text) {
        const source = String(text || '');
        const variantIdCount = (source.match(/Variant ID:\s*gid:\/\/shopify\/ProductVariant\//gi) || []).length;
        const priceLineCount = (source.match(/^\s*Price:\s*/gim) || []).length;
        const looksLikeCatalogDump =
          variantIdCount >= 1 ||
          priceLineCount >= 2 ||
          (/Description:\s*/i.test(source) && priceLineCount >= 1);

        if (!looksLikeCatalogDump) {
          return source;
        }

        const fallback =
          "I found matching filters for your vehicle. Browse the product cards and comparison below, then tell me which one to add to your cart.";

        // Keep only a short intro before the first Price:/Variant ID:/product dump block
        const cut = source.search(/\n\s*(?:Price:|Variant ID:|Description:)/i);
        let intro = cut > 0 ? source.slice(0, cut).trim() : '';

        // Drop intro lines that are themselves product titles in a list
        intro = intro
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((line) => !/^(Price|Description|Variant ID|Stock):/i.test(line))
          .filter((line) => !/gid:\/\/shopify\/ProductVariant\//i.test(line))
          .join(' ')
          .trim();

        if (!intro || intro.length > 220 || /Price:|Variant ID:/i.test(intro)) {
          return fallback;
        }

        // If intro is only "Here are the products..." keep a cleaner line
        if (/here are the products|following products|products that fit/i.test(intro)) {
          return fallback;
        }

        return intro;
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
      streamResponse: async function(userMessage, conversationId, messagesContainer) {
        let currentMessageElement = null;

        try {
          const promptType = window.shopChatConfig?.promptType || "standardAssistant";
          const requestBody = JSON.stringify({
            message: userMessage,
            conversation_id: conversationId,
            prompt_type: promptType
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
            currentMessageElement.textContent =
              "Sorry, I couldn't complete that right now. Please try again in a moment.";
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
          const historyUrl = `${apiBaseUrl}/chat?history=true&conversation_id=${encodeURIComponent(conversationId)}`;
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

          // No messages, show welcome message
          if (!data.messages || data.messages.length === 0) {
            const welcomeMessage = window.shopChatConfig?.welcomeMessage || "👋 Hi there! How can I help you today?";
            ShopAIChat.Message.add(welcomeMessage, 'assistant', messagesContainer);
            return;
          }

          // Add messages to the UI - skip empty/tool_result; restore text, tools, products
          data.messages.forEach(message => {
            ShopAIChat.UI.appendHistoryMessage(message, messagesContainer);
          });

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
          const welcomeMessage = window.shopChatConfig?.welcomeMessage || "👋 Hi there! How can I help you today?";
          ShopAIChat.Message.add(welcomeMessage, 'assistant', messagesContainer);

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
     * Product-related functionality
     */
    Product: {
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

        // Only show Add to Cart when in stock
        if (inStock) {
          const button = document.createElement('button');
          button.classList.add('shop-ai-add-to-cart');
          button.textContent = 'Add to Cart';
          button.dataset.productId = product.id;
          button.addEventListener('click', function() {
            const input = document.querySelector('.shop-ai-chat-input input');
            if (input) {
              input.value = `Add ${product.title} to my cart`;
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

        const table = document.createElement('table');
        table.classList.add('shop-ai-compare-table');

        const productName = (product) => String(product.title || product.sku || product.partNumber || 'Product');

        const yesNo = (value) => (value ? 'Yes' : 'No');

        const headerRow = document.createElement('tr');
        const featureHeader = document.createElement('th');
        featureHeader.textContent = 'Feature';
        headerRow.appendChild(featureHeader);
        products.forEach((product) => {
          const th = document.createElement('th');
          th.textContent = productName(product);
          th.title = product.title || '';
          if (product.isBest) th.classList.add('is-best');
          headerRow.appendChild(th);
        });
        table.appendChild(headerRow);

        const rows = [
          { label: 'HEPA', value: (p) => yesNo(p.isHepa) },
          { label: 'Antibacterial', value: (p) => yesNo(p.hasAntibacterial) },
          { label: 'Charcoal / odor', value: (p) => yesNo(p.hasCharcoal) },
          { label: 'Price', value: (p) => p.price || '—' },
          {
            label: 'Stock',
            value: (p) => (p.inStock && p.availableForSale !== false ? 'In stock' : 'Out of stock')
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

        wrap.appendChild(table);
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
        title.textContent = product.title || '';
        if (productHref) {
          title.classList.add('shop-ai-best-highlight-title--link');
          title.addEventListener('click', function(event) {
            event.preventDefault();
            event.stopPropagation();
            window.open(productHref, '_blank', 'noopener,noreferrer');
          });
        }
        info.appendChild(title);

        const price = document.createElement('p');
        price.classList.add('shop-ai-product-price');
        price.textContent = product.price || '';
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
        }
        info.appendChild(stock);

        if (inStock) {
          const actions = document.createElement('div');
          actions.classList.add('shop-ai-best-highlight-actions');
          const button = document.createElement('button');
          button.classList.add('shop-ai-add-to-cart');
          button.textContent = 'Add to Cart';
          button.addEventListener('click', function() {
            const input = document.querySelector('.shop-ai-chat-input input');
            if (input) {
              input.value = `Add ${product.title} to my cart`;
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

      // Check for existing conversation
      const conversationId = getConversationId();

      if (conversationId) {
        // Fetch conversation history
        this.API.fetchChatHistory(conversationId, this.UI.elements.messagesContainer);
      } else {
        // No previous conversation, show welcome message
        const welcomeMessage = window.shopChatConfig?.welcomeMessage || "👋 Hi there! How can I help you today?";
        this.Message.add(welcomeMessage, 'assistant', this.UI.elements.messagesContainer);
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
