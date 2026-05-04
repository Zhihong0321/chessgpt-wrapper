// ==UserScript==
// @name         Tuangou — auto open Perplexity
// @description  When opened from Team AI Portal (?chessgpt_autoppx=1), clicks the red "打开 Perplexity …" button once.
// @namespace    https://github.com/chessgpt
// @version      1.0.0
// @match        https://v.tuangouai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    "use strict";
    try {
        if (!new URL(location.href).searchParams.has("chessgpt_autoppx")) return;
    } catch (_) {
        return;
    }

    let done = false;
    function findControl() {
        const selectors = ["a", "button", '[role="button"]'];
        for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
                const text = (el.textContent || "").replace(/\s+/g, " ");
                if (text.includes("打开 Perplexity")) return el;
            }
        }
        return null;
    }

    function tryOnce() {
        if (done) return true;
        const el = findControl();
        if (!el) return false;
        done = true;
        el.click();
        return true;
    }

    if (tryOnce()) return;

    const obs = new MutationObserver(() => {
        if (tryOnce()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 25000);
})();
