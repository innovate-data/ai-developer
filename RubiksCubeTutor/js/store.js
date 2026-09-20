/*
 * Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved.
 * Proprietary software. See LICENSE, or the Licence page inside the app.
 */
/*
 * store.js - who may use "Help me solve it".
 *
 * The 2x2 walkthrough is free. On a 3x3 and bigger it is a one-off purchase, the same
 * unlock for every size, restorable on the buyer's other devices.
 *
 * This file only holds the answer and asks the host to change it; it never handles
 * money. Inside the iOS app the host is StoreKit (see ios/CubeClubhouse/StoreManager.swift),
 * which owns the truth: it checks the receipt on every launch and calls applyNative()
 * with what Apple says. The copy kept in localStorage is a convenience so the app looks
 * right before that check finishes, and on a plain web page, where there is no shop at
 * all, the guide stays locked and the page says where to buy it. Nothing here pretends
 * to be a licence check: a browser cannot enforce one without a server.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RC = root.RC || {};
    root.RC.Store = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PRODUCT_ID = 'com.iralearning.cubeclubhouse.solver';
  const KEY = 'cubeclubhouse.unlock';
  const FREE_SIZE = 2;              // the 2x2 guide costs nothing
  const DEFAULT_PRICE = '$0.99';

  let unlocked = false;
  let price = DEFAULT_PRICE;
  let shopReady = false;            // a host that can actually take the money is present
  const listeners = [];

  const storage = () => {
    try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
  };
  (function load() {
    const s = storage();
    try { unlocked = !!s && s.getItem(KEY) === 'yes'; } catch { unlocked = false; }
  })();
  function remember() {
    const s = storage();
    try { if (s) { if (unlocked) s.setItem(KEY, 'yes'); else s.removeItem(KEY); } } catch { /* private mode */ }
  }
  const emit = () => { for (const fn of listeners.slice()) fn({ unlocked, price, shopReady }); };

  // The native side of the app, when there is one.
  function host() {
    if (typeof window === 'undefined') return null;
    const wk = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.store;
    if (wk) return { post: (msg) => wk.postMessage(msg) };
    if (window.CubeClubhouseHost && typeof window.CubeClubhouseHost.postMessage === 'function') {
      return { post: (msg) => window.CubeClubhouseHost.postMessage(msg) };
    }
    return null;
  }

  // Waiting on the shop: one promise at a time, settled by the host calling back.
  let pending = null;
  function ask(action) {
    const h = host();
    if (!h) return Promise.resolve({ ok: false, reason: 'no-shop' });
    if (pending) return pending.promise;
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    pending = { settle, promise };
    // If the host never answers (an old build, a crash), do not hang the button.
    const timer = setTimeout(() => finish({ ok: false, reason: 'no-answer' }), 90000);
    pending.timer = timer;
    try {
      h.post({ action, product: PRODUCT_ID });
    } catch {
      finish({ ok: false, reason: 'no-shop' });
    }
    return promise;
  }
  function finish(result) {
    if (!pending) return;
    clearTimeout(pending.timer);
    const settle = pending.settle;
    pending = null;
    settle(result);
  }

  return {
    PRODUCT_ID,
    FREE_SIZE,
    /** Is the paid walkthrough available? */
    isUnlocked: () => unlocked,
    /** Does a cube of this size need the purchase? */
    needsUnlock: (n) => !unlocked && n > FREE_SIZE,
    /** What the shop says it costs, in the reader's own currency where known. */
    price: () => price,
    /** True inside the app, where a purchase can actually be made. */
    canBuy: () => !!host(),
    /** True once the shop has told us its price and our entitlement. */
    ready: () => shopReady,
    onChange(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },

    buy: () => ask('buy'),
    restore: () => ask('restore'),
    /** Ask the host to send the current state; harmless with no host. */
    sync() { const h = host(); if (h) { try { h.post({ action: 'sync', product: PRODUCT_ID }); } catch { /* ignore */ } } },

    /**
     * Called by the native app: StoreKit's answer, which always wins over what we
     * remembered. `result` settles a buy() or restore() the page is waiting on.
     */
    applyNative(state) {
      const s = state || {};
      if (typeof s.unlocked === 'boolean' && s.unlocked !== unlocked) { unlocked = s.unlocked; remember(); }
      if (typeof s.price === 'string' && s.price) price = s.price;
      if (typeof s.shopReady === 'boolean') shopReady = s.shopReady;
      if (s.result) finish(s.result);
      emit();
      return unlocked;
    },

    /** Tests only: forget everything and start over. */
    __reset() { unlocked = false; price = DEFAULT_PRICE; shopReady = false; remember(); emit(); },
  };
});
