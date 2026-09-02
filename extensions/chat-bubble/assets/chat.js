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

  const CONVERSATION_ID_KEY = 'shopAiConversationId';
  const CHAT_EXPANDED_KEY = 'shopAiChatExpanded';
  const SESSIONS_INDEX_KEY = 'shopAiSessionsIndex';
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

  function getCustomerContextPayload() {
    const config = window.shopChatConfig || {};
    const firstName = String(config.customerFirstName || '').trim();
    const lastName = String(config.customerLastName || '').trim();
    const payload = {};

    if (config.customerLoggedIn === true) {
      payload.customer_logged_in = true;
    }
    if (firstName) {
      payload.customer_first_name = firstName;
    }
    if (lastName) {
      payload.customer_last_name = lastName;
    }

    return payload;
  }

  function getStaticWelcomeFallback() {
    return window.shopChatConfig?.welcomeMessage || "I'm your AI-powered shopping assistant. I can help you with cabin air filters for your vehicle.";
  }

  function getAssistantName() {
    return String(window.shopChatConfig?.assistantName || 'AIRA').trim() || 'AIRA';
  }

  function decodeHtmlEntities(text) {
    const el = document.createElement('textarea');
    el.innerHTML = String(text || '');
    return el.value;
  }

  function formatGreetingTemplate(template) {
    return decodeHtmlEntities(String(template || '')).replace(/\{name\}/g, getAssistantName());
  }

  function getTimeBasedGreeting() {
    const hour = new Date().getHours();
    const config = window.shopChatConfig || {};
    if (hour < 12) {
      return formatGreetingTemplate(config.greetingMorning || "Good morning, I'm {name}!");
    }
    if (hour < 17) {
      return formatGreetingTemplate(config.greetingAfternoon || "Good afternoon, I'm {name}!");
    }
    return formatGreetingTemplate(config.greetingEvening || "Good evening, I'm {name}!");
  }

  function readSessionsIndex() {
    try {
      const raw = localStorage.getItem(SESSIONS_INDEX_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeSessionsIndex(sessions) {
    localStorage.setItem(SESSIONS_INDEX_KEY, JSON.stringify(sessions.slice(0, 20)));
  }

  function formatSessionDate(timestamp) {
    const date = new Date(timestamp);
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
        updatedAt: patch.updatedAt || Date.now()
      };

      if (index >= 0) {
        sessions.splice(index, 1);
      }
      sessions.unshift(next);
      writeSessionsIndex(sessions);
      return next;
    },

    touchFromMessage: function(conversationId, userMessage) {
      const text = String(userMessage || '').trim();
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
    }
  };

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
          homeButton: container.querySelector('.shop-ai-home-btn'),
          homeView: container.querySelector('.shop-ai-home-view'),
          chatView: container.querySelector('.shop-ai-chat-view'),
          greetingEl: container.querySelector('[data-greeting-target]'),
          sessionsList: container.querySelector('.shop-ai-sessions-list'),
          suggestionChips: container.querySelectorAll('.shop-ai-suggestion-chip'),
          expandButton: container.querySelector('.shop-ai-chat-expand'),
          closeButton: container.querySelector('.shop-ai-chat-close'),
          chatInput: container.querySelector('.shop-ai-chat-input-field'),
          inputWrap: container.querySelector('.shop-ai-input-wrap'),
          voiceButton: container.querySelector('.shop-ai-voice-btn'),
          voiceStatus: container.querySelector('.shop-ai-voice-status'),
          sendButton: container.querySelector('.shop-ai-chat-send'),
          messagesContainer: container.querySelector('.shop-ai-chat-messages')
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
        } else {
          // Remove body class when closing
          document.body.classList.remove('shop-ai-chat-open');
          this.scheduleViewportHeightRefresh();
          ShopAIChat.Voice.stop();
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

      updateGreeting: function() {
        const { greetingEl } = this.elements;
        if (greetingEl) {
          greetingEl.textContent = getTimeBasedGreeting();
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
        setConversationId(conversationId);
        this.clearMessages();
        this.showChatView();
        await ShopAIChat.API.fetchChatHistory(conversationId, this.elements.messagesContainer);
        this.renderSessionsList();
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
            conversationId = Date.now().toString();
            setConversationId(conversationId);
            ShopAIChat.UI.clearMessages();
            ShopAIChat.UI.pendingNewChat = false;
          } else if (!conversationId) {
            conversationId = Date.now().toString();
            setConversationId(conversationId);
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
        const pricedAtCount = (source.match(/\bPriced at\s*\$/gi) || []).length;
        const inlinePriceCount = (source.match(/\$\d+\.\d{2}/g) || []).length;
        const looksLikeCatalogDump =
          variantIdCount >= 1 ||
          priceLineCount >= 2 ||
          pricedAtCount >= 1 ||
          (inlinePriceCount >= 2 && /filter|product|cabin|hepa|febreez/i.test(source)) ||
          (/Description:\s*/i.test(source) && priceLineCount >= 1) ||
          (/here are the options|following (?:filters|products)|options below/i.test(source) &&
            (pricedAtCount >= 1 || inlinePriceCount >= 2));

        if (!looksLikeCatalogDump) {
          return source;
        }

        const fallback =
          "I found matching filters for your vehicle. Browse the product cards and comparison below, then tell me which one to add to your cart.";

        // Keep only a short intro before the first product dump block
        const cut = source.search(
          /\n\s*(?:Price:|Variant ID:|Description:)|(?:\n|^)[^*\n]{10,}:\s*(?:Priced at\s*\$|\$\d+\.\d{2})/i
        );
        let intro = cut > 0 ? source.slice(0, cut).trim() : '';

        // Drop intro lines that are themselves product titles in a list
        intro = intro
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((line) => !/^(Price|Description|Variant ID|Stock):/i.test(line))
          .filter((line) => !/gid:\/\/shopify\/ProductVariant\//i.test(line))
          .filter((line) => !/\bPriced at\s*\$/i.test(line))
          .filter((line) => !/\$\d+\.\d{2}/.test(line))
          .join(' ')
          .trim();

        if (!intro || intro.length > 220 || /Price:|Variant ID:|\$\d+\.\d{2}/i.test(intro)) {
          return fallback;
        }

        // If intro is only "Here are the products..." keep a cleaner line
        if (/here are the (?:products|options)|following products|products that fit|you will need a cabin air filter\. here are/i.test(intro)) {
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
          const requestBody = JSON.stringify({
            ...(isInit ? { init: true } : { message: userMessage }),
            conversation_id: conversationId,
            prompt_type: promptType,
            ...(isInit && window.shopChatConfig?.welcomeMessage
              ? { welcome_template: window.shopChatConfig.welcomeMessage }
              : {}),
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
       * Check if a conversation has saved messages (without rendering).
       */
      sessionHasHistory: async function(conversationId) {
        if (!conversationId) return false;

        try {
          const apiBaseUrl = getApiBaseUrl();
          const historyUrl = `${apiBaseUrl}/chat?history=true&conversation_id=${encodeURIComponent(conversationId)}`;
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

          // No messages — generate welcome via LLM and persist to history
          if (!data.messages || data.messages.length === 0) {
            await ShopAIChat.API.requestWelcome(messagesContainer, conversationId);
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
      isRestarting: false,
      sessionPrefix: '',

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
            this.getLabel('voiceListeningLabel', 'Listening…')
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
          this.finalizeInput(elements);
          this.sessionPrefix = '';
          this.manualStop = false;
        };

        this.recognition.onerror = (event) => {
          const error = event?.error || 'unknown';

          if (error === 'aborted' && this.isRestarting) {
            return;
          }

          if (error === 'no-speech' && this.keepListening && !this.manualStop) {
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
          if (!input || this.isRestarting) return;

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
        };
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
        const { chatInput: input } = elements;
        if (!input) return;

        const text = input.value.trim();
        if (!text) {
          this.hideStatus(elements);
          return;
        }

        input.focus();
        if (this.ui) {
          this.ui.syncInputCaretToEnd(input, { focus: false });
        } else {
          const length = input.value.length;
          input.setSelectionRange(length, length);
        }

        this.showStatus(
          elements,
          this.getLabel(
            'voiceReviewLabel',
            'Review your message, edit if needed, then tap send.'
          ),
          false,
          6000
        );
      },

      start: function(elements) {
        if (!this.recognition || this.isListening) return;

        this.elements = elements;
        this.manualStop = false;
        this.keepListening = true;
        this.clearRestartTimer();

        const { chatInput } = elements;
        if (chatInput) {
          chatInput.focus();
        }

        try {
          this.recognition.start();
        } catch (error) {
          if (String(error?.message || '').includes('already started')) {
            this.stop();
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

      stop: function() {
        if (!this.recognition) return;

        this.manualStop = true;
        this.keepListening = false;
        this.isRestarting = false;
        this.clearRestartTimer();
        clearTimeout(this.inputEditTimer);
        this.inputEditTimer = null;

        try {
          if (this.isListening) {
            this.recognition.stop();
          }
        } catch (error) {
          // ignore stop errors when recognition is idle
        }

        if (!this.isListening && this.ui?.elements) {
          this.setListeningState(this.ui.elements, false);
          this.finalizeInput(this.ui.elements);
          this.sessionPrefix = '';
          this.manualStop = false;
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
            const input = document.querySelector('.shop-ai-chat-input-field');
            const messagesContainer = document.querySelector('.shop-ai-chat-messages');
            ShopAIChat.UI.showChatView();
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

      const conversationId = getConversationId();
      const sessions = Sessions.list();

      // Register current session in index if missing
      if (conversationId && !sessions.some((s) => s.id === conversationId)) {
        Sessions.upsert(conversationId, { title: 'Chat', updatedAt: Date.now() });
      }

      if (conversationId) {
        // Load history in background; show home until user picks a session or sends a message
        const hasMessages = await this.API.sessionHasHistory(conversationId);
        if (hasMessages) {
          this.UI.pendingNewChat = false;
          this.UI.showChatView();
          await this.API.fetchChatHistory(conversationId, this.UI.elements.messagesContainer);
        } else {
          this.UI.showHomeView();
        }
      } else {
        this.UI.showHomeView();
      }

      this.UI.renderSessionsList();
    }
  };

  // Initialize the application when DOM is ready
  document.addEventListener('DOMContentLoaded', function() {
    ShopAIChat.init().catch(function(error) {
      console.error('Failed to initialize chat:', error);
    });
  });
})();
