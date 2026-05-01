// ==UserScript==
// @name         Gaijin Market Price Watch
// @namespace    warthunder-tools
// @version      2.0.0
// @description  Watches the current Gaijin market sell/buy/auction view and notifies when an item drops far below its usual observed price.
// @homepage     https://github.com/Zitrone30/warthunder-market-scanner
// @homepageURL  https://github.com/Zitrone30/warthunder-market-scanner
// @supportURL   https://github.com/Zitrone30/warthunder-market-scanner/issues
// @downloadURL  https://raw.githubusercontent.com/Zitrone30/warthunder-market-scanner/refs/heads/main/warthunder-scanner.js
// @updateURL    https://raw.githubusercontent.com/Zitrone30/warthunder-market-scanner/refs/heads/main/warthunder-scanner.js
// @match        https://trade.gaijin.net/market/*
// @grant        none
// @license      AGPL-3.0-only
// @author       DNS/Marie
// ==/UserScript==


(function () {
  "use strict";

  const STORAGE_KEY = "gaijin-market-price-watch:v2";
  const TOKEN_STORAGE_KEY = "MarketApp,auth,tokenPair";
  const OLD_PRICE_COEFF = 10000;
  const NORMAL_PRICE_COEFF = 100000000;
  const SETTINGS_VERSION = 2;
  const OLD_DEFAULT_MIN_ALERT_PRICE = 5000;
  const DEFAULT_MIN_ALERT_PRICE_GJN = 2;
  const DEFAULT_MIN_ALERT_PRICE = DEFAULT_MIN_ALERT_PRICE_GJN * NORMAL_PRICE_COEFF;
  const HISTORY_LIMIT = 40;
  const HISTORY_COMPACT_LIMIT = 12;
  const DEFAULT_LANGUAGE = "en_US";
  const DEFAULT_CIRCUITS = {
    trade_server: "https://market-proxy.gaijin.net/web",
  };
  const DEFAULT_SETTINGS = {
    enabled: true,
    thresholdPercent: 25,
    minSamples: 6,
    minSamplesBypassPrice: 0,
    minAlertPrice: DEFAULT_MIN_ALERT_PRICE,
    minAlertPriceTouched: false,
    hideTrophies: false,
    settingsVersion: SETTINGS_VERSION,
    refreshIntervalMs: 30000,
    sampleCooldownMs: 10 * 60 * 1000,
    notifyCooldownMs: 30 * 60 * 1000,
    highlightDurationMs: 5 * 60 * 1000,
  };

  let state = loadState();
  let panelRefs = null;
  let refreshTimer = null;
  let circuitsPromise = null;
  let marketInfoPromise = null;
  let lastSearchRequest = null;
  let currentDeal = null;
  let pollInFlight = false;

  compactStoredState();
  ensurePanel();
  requestNotificationPermissionIfNeeded();
  installNetworkHooks();
  startWatching();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return emptyState();
      }

      const parsed = JSON.parse(raw);
      const settings = migrateSettings({ ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }, parsed.settings || {});
      return {
        settings,
        history: parsed.history || {},
        lastNotifications: parsed.lastNotifications || {},
        lastSeenPrices: parsed.lastSeenPrices || {},
        ui: {
          panelOpen: parsed.ui?.panelOpen ?? false,
          baseDevicePixelRatio: normalizeBaseDevicePixelRatio(parsed.ui?.baseDevicePixelRatio),
        },
      };
    } catch (error) {
      console.warn("Gaijin watcher: failed to load saved state, starting fresh.", error);
      return emptyState();
    }
  }

  function emptyState() {
      return {
        settings: { ...DEFAULT_SETTINGS },
        history: {},
        lastNotifications: {},
        lastSeenPrices: {},
        ui: {
          panelOpen: false,
          baseDevicePixelRatio: normalizeBaseDevicePixelRatio(),
        },
      };
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      compactStoredState();

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        updateStatus("Storage was full, compacted saved price history.");
      } catch (retryError) {
        console.warn("Gaijin watcher: failed to save state.", retryError);
        updateStatus("Storage full: current scan still works, but history could not be saved.");
      }
    }
  }

  function migrateSettings(settings, savedSettings) {
    if ((savedSettings.settingsVersion || 1) < SETTINGS_VERSION) {
      settings.minAlertPrice = migratePriceSetting(savedSettings.minAlertPrice, settings.minAlertPrice);
      settings.minSamplesBypassPrice = migratePriceSetting(
        savedSettings.minSamplesBypassPrice,
        settings.minSamplesBypassPrice
      );
    }

    if (
      !savedSettings.minAlertPriceTouched &&
      settings.minAlertPrice <= OLD_DEFAULT_MIN_ALERT_PRICE * (NORMAL_PRICE_COEFF / OLD_PRICE_COEFF)
    ) {
      settings.minAlertPrice = DEFAULT_MIN_ALERT_PRICE;
    }

    settings.settingsVersion = SETTINGS_VERSION;
    return settings;
  }

  function migratePriceSetting(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }

    return Math.round(parsed * (NORMAL_PRICE_COEFF / OLD_PRICE_COEFF));
  }

  function compactStoredState() {
    for (const [key, history] of Object.entries(state.history)) {
      const normalized = normalizeHistory(history);
      if (!normalized.length) {
        delete state.history[key];
        delete state.lastSeenPrices[key];
        delete state.lastNotifications[key];
        continue;
      }

      state.history[key] = normalized.slice(-HISTORY_COMPACT_LIMIT);
    }
  }

  function startWatching() {
    if (!isSupportedMarketPage()) {
      updateStatus("Open a Gaijin market page to start watching.");
      return;
    }

    installViewportHooks();
    runPoll("startup");
    scheduleRefreshTimer();
    window.addEventListener("popstate", () => runPoll("navigation"));
    window.addEventListener("hashchange", () => runPoll("navigation"));
  }

  function scheduleRefreshTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }

    refreshTimer = window.setInterval(() => runPoll("interval"), state.settings.refreshIntervalMs);
  }

  async function runPoll(reason) {
    if (!state.settings.enabled) {
      updateStatus("Watcher paused.");
      return;
    }

    if (!isSupportedMarketPage()) {
      updateStatus("This page is not a supported Gaijin market view.");
      renderStats([]);
      return;
    }

    if (pollInFlight) {
      updateStatus("Scan already running.");
      return;
    }

    try {
      pollInFlight = true;
      const request = lastSearchRequest || (await buildDefaultSearchRequest());
      if (!request) {
        updateStatus("Waiting for market search context.");
        return;
      }

      const result = await fetchAllSearchItems(request);
      const items = result.items;

      lastSearchRequest = { ...request };
      updateStatus(
        `Checked ${items.length} item${items.length === 1 ? "" : "s"} across ${result.pages} page${result.pages === 1 ? "" : "s"} (${reason})`
      );
      processItems(items);
    } catch (error) {
      console.warn("Gaijin watcher: poll failed.", error);
      updateStatus(`Request failed: ${error.message || "unknown error"}`);
    } finally {
      pollInFlight = false;
    }
  }

  function processItems(items) {
    updateTrophyVisibility(items);

    if (!items.length) {
      renderStats([]);
      saveState();
      return;
    }

    const interesting = [];

    for (const item of items) {
      if (state.settings.hideTrophies && isTrophyItem(item)) {
        continue;
      }

      const history = normalizeHistory(state.history[item.key] || []);
      const historyPrices = history.map((entry) => entry.price);
      const baseline = median(historyPrices);
      const averagePrice = average(historyPrices);
      const samples = history.length;
      const thresholdMultiplier = 1 - state.settings.thresholdPercent / 100;

      maybeStoreSample(item, history);

      if (
        hasEnoughSamples(item, samples) &&
        baseline > 0 &&
        item.price >= state.settings.minAlertPrice &&
        item.price <= baseline * thresholdMultiplier
      ) {
        const discountPercent = (1 - item.price / baseline) * 100;
        const candidate = { ...item, averagePrice, baseline, samples, discountPercent };
        interesting.push(candidate);
        highlightItemCard(item);
        if (maybeNotify(candidate)) {
          renderDeal(candidate);
        }
      }
    }

    renderStats(interesting);
    saveState();
  }

  function maybeStoreSample(item, history) {
    const now = Date.now();
    const lastSeen = state.lastSeenPrices[item.key];

    if (
      lastSeen &&
      lastSeen.price === item.price &&
      now - lastSeen.ts < state.settings.sampleCooldownMs
    ) {
      return;
    }

    history.push({ price: item.price, ts: now });
    state.history[item.key] = history.slice(-HISTORY_LIMIT);
    state.lastSeenPrices[item.key] = { price: item.price, ts: now };
  }

  function hasEnoughSamples(item, samples) {
    if (samples >= state.settings.minSamples) {
      return true;
    }

    return (
      state.settings.minSamplesBypassPrice > 0 &&
      item.price >= state.settings.minSamplesBypassPrice &&
      samples > 0
    );
  }

  function maybeNotify(item) {
    const now = Date.now();
    const last = state.lastNotifications[item.key] || 0;

    if (now - last < state.settings.notifyCooldownMs) {
      return false;
    }

    const title = "Gaijin Market deal spotted";
    const body =
      `${item.name}\n` +
      `Deal: ${formatMoney(item.price)}\n` +
      `Average: ${formatMoney(item.averagePrice)}\n` +
      `Normal: ${formatMoney(item.baseline)}\n` +
      `Drop: ${item.discountPercent.toFixed(1)}%`;

    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }

    playChime();
    state.lastNotifications[item.key] = now;
    updateStatus(`Alert: ${item.name} is ${item.discountPercent.toFixed(1)}% below baseline.`);
    return true;
  }

  function installNetworkHooks() {
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = async function wrappedFetch(input, init) {
        const response = await originalFetch.call(this, input, init);

        try {
          const url = typeof input === "string" ? input : input?.url || "";
          const body = init?.body;

          if (isTradeServerRequest(url, body)) {
            const parsedBody = decodeQueryBody(body);
            if (parsedBody.action === "cln_market_search") {
              lastSearchRequest = normalizeSearchRequest(parsedBody);
              const cloned = response.clone();
              cloned
                .json()
                .then((payload) => {
                  const data = unwrapPayload(payload);
                  processItems(parseSearchItems(data?.assets || []));
                })
                .catch(() => {});
            }
          }
        } catch (error) {
          console.debug("Gaijin watcher: fetch hook failed.", error);
        }

        return response;
      };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__gpwMethod = method;
      this.__gpwUrl = url;
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function patchedSend(body) {
      this.__gpwBody = body;
      this.addEventListener("load", () => {
        try {
          if (this.__gpwInternal) {
            return;
          }

          if (!isTradeServerRequest(this.__gpwUrl, this.__gpwBody)) {
            return;
          }

          const parsedBody = decodeQueryBody(this.__gpwBody);
          if (parsedBody.action !== "cln_market_search") {
            return;
          }

          lastSearchRequest = normalizeSearchRequest(parsedBody);
          const payload = JSON.parse(this.responseText || "{}");
          const data = unwrapPayload(payload);
          processItems(parseSearchItems(data?.assets || []));
        } catch (error) {
          console.debug("Gaijin watcher: xhr hook failed.", error);
        }
      });

      return originalSend.apply(this, arguments);
    };
  }

  function isTradeServerRequest(url, body) {
    if (!url || !body) {
      return false;
    }

    return String(url).includes("/web") && String(body).includes("action=cln_market_search");
  }

  function decodeQueryBody(body) {
    const params = new URLSearchParams(String(body || ""));
    const result = {};

    for (const [key, value] of params.entries()) {
      result[key] = value;
    }

    return result;
  }

  async function buildDefaultSearchRequest() {
    const token = readToken();
    if (!token) {
      updateStatus("No Gaijin market token found. Log in first.");
      return null;
    }

    const marketInfo = await loadMarketInfo();
    const appIds = Object.values(marketInfo?.games || {})
      .map((game) => String(game.appid || ""))
      .filter(Boolean);

    return {
      action: "cln_market_search",
      token,
      skip: "0",
      count: "20",
      text: "",
      language: DEFAULT_LANGUAGE,
      options: getOptionsForCurrentPath(),
      appid_filter: appIds.join("\n"),
    };
  }

  async function loadCircuits() {
    if (!circuitsPromise) {
      circuitsPromise = fetch("/config/circuits.json")
        .then((response) => response.json())
        .then((json) => json.default || DEFAULT_CIRCUITS)
        .catch(() => DEFAULT_CIRCUITS);
    }

    return circuitsPromise;
  }

  async function loadMarketInfo() {
    if (!marketInfoPromise) {
      const token = readToken();
      marketInfoPromise = postMarketAction({
        action: "cln_market_info",
        token,
        language: DEFAULT_LANGUAGE,
      }).catch((error) => {
        marketInfoPromise = null;
        throw error;
      });
    }

    return marketInfoPromise;
  }

  async function postMarketAction(params) {
    const circuits = await loadCircuits();
    const body = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        body.append(key, value);
      }
    }

    const payload = await postWithXhr(circuits.trade_server, body.toString());
    const data = unwrapPayload(payload);

    if (payload?.error) {
      throw new Error(payload.error);
    }

    return data;
  }

  async function fetchAllSearchItems(request) {
    const pageSize = getSearchPageSize(request.count);
    const seenKeys = new Set();
    const allItems = [];
    let pages = 0;
    let skip = 0;

    for (;;) {
      const payload = await postMarketAction({
        ...request,
        skip: String(skip),
        count: String(pageSize),
      });

      const pageItems = parseSearchItems(payload?.assets || []);
      pages += 1;

      for (const item of pageItems) {
        if (seenKeys.has(item.key)) {
          continue;
        }

        seenKeys.add(item.key);
        allItems.push(item);
      }

      if (pageItems.length < pageSize) {
        break;
      }

      skip += pageSize;
    }

    return {
      items: allItems,
      pages,
    };
  }

  function postWithXhr(url, body) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.__gpwInternal = true;
      xhr.open("POST", url, true);
      xhr.timeout = 15000;
      xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");

      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(`HTTP ${xhr.status}`));
          return;
        }

        try {
          resolve(JSON.parse(xhr.responseText || "{}"));
        } catch (error) {
          reject(new Error("Invalid JSON response"));
        }
      };

      xhr.onerror = () => {
        reject(new Error("NetworkError when attempting to fetch resource."));
      };

      xhr.ontimeout = () => {
        reject(new Error("Request timed out"));
      };

      xhr.send(body);
    });
  }

  function unwrapPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return payload;
    }

    return payload.result || payload.response || payload;
  }

  function normalizeSearchRequest(params) {
    return {
      action: "cln_market_search",
      token: readToken(),
      skip: params.skip || "0",
      count: params.count || "20",
      text: params.text || "",
      language: params.language || DEFAULT_LANGUAGE,
      options: params.options || getOptionsForCurrentPath(),
      appid_filter: params.appid_filter || "",
      sort: params.sort || "",
      tags: params.tags || "",
    };
  }

  function parseSearchItems(assets) {
    return assets
      .map((asset) => {
        const appid = String(asset.appid || asset.appId || "");
        const hashName = asset.hash_name || asset.market_hash_name || asset.classInfo?.market_hash_name;
        const name =
          asset.name ||
          asset.market_name ||
          asset.classInfo?.market_name ||
          asset.classInfo?.name ||
          hashName;
        const price = Number(asset.price || 0);

        if (!appid || !hashName || !Number.isFinite(price) || price <= 0) {
          return null;
        }

        return {
          key: `${appid}::${hashName}`,
          appid,
          hashName,
          name,
          price,
          depth: Number(asset.depth || 0),
        };
      })
      .filter(Boolean);
  }

  function readToken() {
    try {
      const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      return parsed?.token || null;
    } catch {
      return null;
    }
  }

  function getOptionsForCurrentPath() {
    if (location.pathname.includes("/market/buy")) {
      return "any_buy_orders\ninclude_marketpairs";
    }

    if (location.pathname.includes("/market/auction")) {
      return "include_auctions";
    }

    return "any_sell_orders\ninclude_marketpairs";
  }

  function isSupportedMarketPage() {
    return /\/market\/(sell|buy|auction)/.test(location.pathname);
  }

  function normalizeHistory(history) {
    return history.filter((entry) => Number.isFinite(entry.price) && entry.price > 0);
  }

  function median(values) {
    if (!values.length) {
      return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  }

  function average(values) {
    if (!values.length) {
      return 0;
    }

    return values.reduce((total, value) => total + value, 0) / values.length;
  }

  function formatMoney(value) {
    if (!Number.isFinite(value)) {
      return "";
    }

    return `${(value / NORMAL_PRICE_COEFF).toFixed(2)} GJN`;
  }

  function playChime() {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();

      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.value = 0.04;

      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.18);
    } catch (error) {
      console.debug("Gaijin watcher: audio notification failed.", error);
    }
  }

  function highlightItemCard(item) {
    const selectors = Array.from(document.querySelectorAll(`a[href*="/market/${item.appid}/"]`));

    for (const anchor of selectors) {
      const href = anchor.getAttribute("href") || "";
      if (!href.includes(encodeURIComponent(item.hashName))) {
        continue;
      }

      const card = anchor.closest(".lot") || anchor;
      if (!(card instanceof HTMLElement)) {
        continue;
      }

      card.style.outline = "3px solid #ff7b00";
      card.style.outlineOffset = "2px";
      card.style.boxShadow = "0 0 0 4px rgba(255, 123, 0, 0.18)";

      window.setTimeout(() => {
        card.style.outline = "";
        card.style.outlineOffset = "";
        card.style.boxShadow = "";
      }, state.settings.highlightDurationMs);

      break;
    }
  }

  function updateTrophyVisibility(items) {
    restoreHiddenTrophyCards();

    if (!state.settings.hideTrophies) {
      return;
    }

    for (const item of items) {
      if (!isTrophyItem(item)) {
        continue;
      }

      const card = findItemCard(item);
      if (!card) {
        continue;
      }

      card.dataset.gpwHiddenTrophy = "true";
      card.style.display = "none";
    }
  }

  function restoreHiddenTrophyCards() {
    for (const card of document.querySelectorAll("[data-gpw-hidden-trophy='true']")) {
      if (!(card instanceof HTMLElement)) {
        continue;
      }

      card.style.display = "";
      delete card.dataset.gpwHiddenTrophy;
    }
  }

  function isTrophyItem(item) {
    return `${item.name || ""} ${item.hashName || ""}`.toLowerCase().includes("trophy");
  }

  function findItemCard(item) {
    const selectors = Array.from(document.querySelectorAll(`a[href*="/market/${item.appid}/"]`));

    for (const anchor of selectors) {
      const href = anchor.getAttribute("href") || "";
      if (!href.includes(encodeURIComponent(item.hashName))) {
        continue;
      }

      const card = anchor.closest(".lot") || anchor;
      if (card instanceof HTMLElement) {
        return card;
      }
    }

    return null;
  }

  function requestNotificationPermissionIfNeeded() {
    if (!("Notification" in window)) {
      updateStatus("Browser notifications are not available here.");
      return;
    }

    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {
        updateStatus("Notification permission was not granted.");
      });
    }
  }

  function ensurePanel() {
    if (document.getElementById("gaijin-price-watch-panel")) {
      return;
    }

    const panel = document.createElement("div");
    panel.id = "gaijin-price-watch-panel";
    panel.innerHTML = `
      <button id="gpw-toggle" type="button" aria-label="Toggle price watch">PW</button>
      <div id="gpw-panel-shell">
        <div id="gpw-header">
          <div id="gaijin-price-watch-title">Price Watch</div>
          <button id="gpw-close" type="button" aria-label="Hide price watch">x</button>
        </div>
        <label>
          Enabled
          <input id="gpw-enabled" type="checkbox" />
        </label>
        <label>
          Alert if below %
          <input id="gpw-threshold" type="number" min="1" max="95" step="1" />
        </label>
        <label>
          Min samples
          <input id="gpw-samples" type="number" min="1" max="100" step="1" />
        </label>
        <label>
          Bypass samples GJN
          <input id="gpw-sample-bypass-price" type="number" min="0" max="100000" step="0.01" />
        </label>
        <label>
          Min price GJN
          <input id="gpw-min-price" type="number" min="0" max="10000" step="0.01" />
        </label>
        <label>
          Hide trophies
          <input id="gpw-hide-trophies" type="checkbox" />
        </label>
        <label>
          Refresh sec
          <input id="gpw-refresh" type="number" min="5" max="600" step="5" />
        </label>
        <div id="gpw-actions">
          <button id="gpw-scan" type="button">Scan now</button>
          <button id="gpw-open-deal" type="button" disabled>Open deal</button>
          <button id="gpw-reset" type="button">Reset history</button>
        </div>
        <div id="gpw-stats"></div>
        <div id="gpw-status"></div>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #gaijin-price-watch-panel {
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 999999;
        font: 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #f6f7f9;
        transform-origin: bottom right;
        will-change: transform;
      }

      #gpw-toggle,
      #gpw-panel-shell {
        background: rgba(22, 24, 28, 0.94);
        color: #f6f7f9;
        box-shadow: 0 14px 40px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(10px);
      }

      #gpw-toggle {
        position: absolute;
        right: 0;
        bottom: 0;
        width: 52px;
        height: 52px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 999px;
        font-weight: 700;
        letter-spacing: 0.04em;
        cursor: pointer;
      }

      #gpw-panel-shell {
        width: 260px;
        padding: 14px;
        border-radius: 12px;
        margin-bottom: 60px;
      }

      #gaijin-price-watch-panel.gpw-collapsed #gpw-panel-shell {
        display: none;
      }

      @media (max-width: 900px) {
        #gaijin-price-watch-panel {
          bottom: 12px;
          right: 12px;
        }

        #gpw-panel-shell {
          width: min(260px, calc(100vw - 24px));
        }
      }

      #gpw-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
      }

      #gaijin-price-watch-title {
        font-size: 15px;
        font-weight: 700;
      }

      #gpw-close {
        width: 28px;
        height: 28px;
        padding: 0;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
        color: inherit;
        cursor: pointer;
        line-height: 1;
      }

      #gaijin-price-watch-panel label {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        align-items: center;
        margin-bottom: 8px;
      }

      #gaijin-price-watch-panel input[type="number"] {
        width: 72px;
        appearance: textfield;
        -moz-appearance: textfield;
      }

      #gaijin-price-watch-panel input[type="number"]::-webkit-outer-spin-button,
      #gaijin-price-watch-panel input[type="number"]::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }

      #gaijin-price-watch-panel input,
      #gaijin-price-watch-panel button {
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.08);
        color: inherit;
        padding: 6px 8px;
      }

      #gpw-actions {
        display: flex;
        gap: 8px;
        margin: 10px 0;
      }

      #gpw-actions button {
        cursor: pointer;
        flex: 1;
      }

      #gpw-stats,
      #gpw-status {
        color: rgba(246, 247, 249, 0.84);
        font-size: 12px;
      }

      #gpw-status {
        margin-top: 8px;
      }
    `;

    document.documentElement.appendChild(style);
    document.body.appendChild(panel);

    panelRefs = {
      toggle: panel.querySelector("#gpw-toggle"),
      shell: panel.querySelector("#gpw-panel-shell"),
      close: panel.querySelector("#gpw-close"),
      enabled: panel.querySelector("#gpw-enabled"),
      threshold: panel.querySelector("#gpw-threshold"),
      samples: panel.querySelector("#gpw-samples"),
      sampleBypassPrice: panel.querySelector("#gpw-sample-bypass-price"),
      minPrice: panel.querySelector("#gpw-min-price"),
      hideTrophies: panel.querySelector("#gpw-hide-trophies"),
      refresh: panel.querySelector("#gpw-refresh"),
      scan: panel.querySelector("#gpw-scan"),
      openDeal: panel.querySelector("#gpw-open-deal"),
      reset: panel.querySelector("#gpw-reset"),
      stats: panel.querySelector("#gpw-stats"),
      status: panel.querySelector("#gpw-status"),
    };

    panelRefs.enabled.checked = state.settings.enabled;
    panelRefs.threshold.value = String(state.settings.thresholdPercent);
    panelRefs.samples.value = String(state.settings.minSamples);
    panelRefs.sampleBypassPrice.value = formatGjnInput(state.settings.minSamplesBypassPrice);
    panelRefs.minPrice.value = formatGjnInput(state.settings.minAlertPrice);
    panelRefs.hideTrophies.checked = state.settings.hideTrophies;
    panelRefs.refresh.value = String(Math.round(state.settings.refreshIntervalMs / 1000));
    syncPanelVisibility();
    updatePanelScale();

    panelRefs.toggle.addEventListener("click", () => {
      state.ui.panelOpen = !state.ui.panelOpen;
      saveState();
      syncPanelVisibility();
    });

    panelRefs.close.addEventListener("click", () => {
      state.ui.panelOpen = false;
      saveState();
      syncPanelVisibility();
    });

    panelRefs.enabled.addEventListener("change", () => {
      state.settings.enabled = panelRefs.enabled.checked;
      saveState();
      updateStatus(state.settings.enabled ? "Watcher enabled." : "Watcher paused.");
    });

    panelRefs.threshold.addEventListener("change", () => {
      state.settings.thresholdPercent = clampNumber(panelRefs.threshold.value, 1, 95, 25);
      panelRefs.threshold.value = String(state.settings.thresholdPercent);
      saveState();
      runPoll("settings");
    });

    panelRefs.samples.addEventListener("change", () => {
      state.settings.minSamples = clampNumber(panelRefs.samples.value, 1, 100, 6);
      panelRefs.samples.value = String(state.settings.minSamples);
      saveState();
      runPoll("settings");
    });

    panelRefs.sampleBypassPrice.addEventListener("change", () => {
      state.settings.minSamplesBypassPrice = parseGjnInput(panelRefs.sampleBypassPrice.value, 0, 100000, 0);
      panelRefs.sampleBypassPrice.value = formatGjnInput(state.settings.minSamplesBypassPrice);
      saveState();
      runPoll("settings");
    });

    panelRefs.minPrice.addEventListener("change", () => {
      state.settings.minAlertPrice = parseGjnInput(panelRefs.minPrice.value, 0, 10000, DEFAULT_MIN_ALERT_PRICE_GJN);
      state.settings.minAlertPriceTouched = true;
      panelRefs.minPrice.value = formatGjnInput(state.settings.minAlertPrice);
      saveState();
      runPoll("settings");
    });

    panelRefs.hideTrophies.addEventListener("change", () => {
      state.settings.hideTrophies = panelRefs.hideTrophies.checked;
      saveState();
      if (!state.settings.hideTrophies) {
        restoreHiddenTrophyCards();
      }
      runPoll("settings");
    });

    panelRefs.refresh.addEventListener("change", () => {
      const seconds = clampNumber(panelRefs.refresh.value, 5, 600, 30);
      state.settings.refreshIntervalMs = seconds * 1000;
      panelRefs.refresh.value = String(seconds);
      saveState();
      scheduleRefreshTimer();
      runPoll("settings");
    });

    panelRefs.scan.addEventListener("click", () => runPoll("manual"));
    panelRefs.openDeal.addEventListener("click", () => {
      if (!currentDeal) {
        return;
      }

      window.open(getItemUrl(currentDeal), "_blank", "noopener");
    });

    panelRefs.reset.addEventListener("click", () => {
      state.history = {};
      state.lastNotifications = {};
      state.lastSeenPrices = {};
      currentDeal = null;
      saveState();
      renderStats([]);
      updateStatus("Saved history cleared.");
    });
  }

  function clampNumber(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.max(min, Math.min(max, parsed));
  }

  function parseGjnInput(value, min, max, fallback) {
    const parsed = Number.parseFloat(value);
    const normalized = Number.isFinite(parsed) ? parsed : fallback;
    const clamped = Math.max(min, Math.min(max, normalized));
    return Math.round(clamped * NORMAL_PRICE_COEFF);
  }

  function formatGjnInput(value) {
    const amount = Number(value || 0) / NORMAL_PRICE_COEFF;
    return amount.toFixed(2);
  }

  function parseInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function getSearchPageSize(value) {
    return Math.max(1, parseInteger(value, 25));
  }

  function renderStats(interesting) {
    if (!panelRefs) {
      return;
    }

    const tracked = Object.keys(state.history).length;
    if (!interesting.length) {
      if (currentDeal) {
        renderDeal(currentDeal);
        return;
      }

      renderNoDeal(tracked);
      return;
    }

    if (!currentDeal) {
      renderNoDeal(tracked);
    }
  }

  function renderDeal(deal) {
    if (!panelRefs) {
      return;
    }

    const tracked = Object.keys(state.history).length;
    currentDeal = deal;
    panelRefs.openDeal.disabled = false;
    panelRefs.stats.textContent =
      `Tracking ${tracked} items. Last deal: ${deal.name}. ` +
      `Deal: ${formatMoney(deal.price)}. Average: ${formatMoney(deal.averagePrice)}. ` +
      `Drop: ${deal.discountPercent.toFixed(1)}% below baseline.`;
  }

  function renderNoDeal(tracked) {
    currentDeal = null;
    panelRefs.openDeal.disabled = true;
    panelRefs.stats.textContent = `Tracking ${tracked} item${tracked === 1 ? "" : "s"}. No deal right now.`;
  }

  function getItemUrl(item) {
    const card = findItemCard(item);
    const anchor = card?.closest?.("a") || card?.querySelector?.("a");
    const href = anchor?.getAttribute?.("href");

    if (href) {
      return new URL(href, location.origin).href;
    }

    return `${location.origin}/market/${item.appid}/${encodeURIComponent(item.hashName)}`;
  }

  function updateStatus(message) {
    if (panelRefs) {
      panelRefs.status.textContent = message;
    }
  }

  function syncPanelVisibility() {
    const root = document.getElementById("gaijin-price-watch-panel");
    if (!root || !panelRefs) {
      return;
    }

    root.classList.toggle("gpw-collapsed", !state.ui.panelOpen);
    panelRefs.toggle.textContent = state.ui.panelOpen ? "Hide" : "PW";
  }

  function installViewportHooks() {
    window.addEventListener("resize", updatePanelScale);

    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", updatePanelScale);
      window.visualViewport.addEventListener("scroll", updatePanelScale);
    }
  }

  function updatePanelScale() {
    const root = document.getElementById("gaijin-price-watch-panel");
    if (!root) {
      return;
    }

    const zoomFactor = getCurrentZoomFactor();
    const inverseScale = 1 / zoomFactor;
    root.style.transform = `scale(${clampScale(inverseScale)})`;
  }

  function getCurrentZoomFactor() {
    const baseDevicePixelRatio = normalizeBaseDevicePixelRatio(state.ui?.baseDevicePixelRatio);
    const currentDevicePixelRatio = normalizeBaseDevicePixelRatio();
    const deviceScale = currentDevicePixelRatio / baseDevicePixelRatio;
    const viewportScale = Number(window.visualViewport?.scale || 1);
    const normalizedViewportScale = Number.isFinite(viewportScale) && viewportScale > 0
      ? viewportScale
      : 1;

    return deviceScale * normalizedViewportScale;
  }

  function clampScale(value) {
    if (!Number.isFinite(value)) {
      return 1;
    }

    return Math.max(0.7, Math.min(1.6, value));
  }

  function normalizeBaseDevicePixelRatio(value) {
    const ratio = Number(value || window.devicePixelRatio || 1);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  }
})();
