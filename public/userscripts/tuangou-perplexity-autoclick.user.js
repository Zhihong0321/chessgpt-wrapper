// ==UserScript==
// @name         Tuangou — auto open Perplexity
// @description  When the URL contains chessgpt_autoppx=1 (from Team AI Portal), clicks the red 打开 Perplexity control once.
// @namespace    https://github.com/chessgpt
// @version      1.1.0
// @match        https://v.tuangouai.com/*
// @match        http://v.tuangouai.com/*
// @match        *://*.tuangouai.com/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    function shouldAuto() {
        try {
            return /chessgpt_autoppx=1(?:&|#|$)/.test(location.href) || location.href.includes("chessgpt_autoppx=1");
        } catch (_) {
            return false;
        }
    }
    if (!shouldAuto()) return;

    function walk(node, visit) {
        if (!node) return;
        if (node.nodeType === 1) {
            visit(node);
            if (node.shadowRoot) walk(node.shadowRoot, visit);
            const ch = node.children;
            for (let i = 0; i < ch.length; i++) walk(ch[i], visit);
        } else if (node.nodeType === 11) {
            const ch = node.children;
            for (let i = 0; i < ch.length; i++) walk(ch[i], visit);
        }
    }

    function normalizedText(el) {
        return ((el.innerText != null ? el.innerText : el.textContent) || "").replace(/\s+/g, " ").trim();
    }

    function looksLikePerplexityOpenButton(el) {
        const t = normalizedText(el);
        if (!t.includes("Perplexity")) return false;
        if (!(t.includes("打开") || /\bopen\b/i.test(t))) return false;
        const tag = el.tagName;
        if (tag === "A" || tag === "BUTTON") return true;
        if (el.getAttribute("role") === "button") return true;
        if (typeof el.onclick === "function") return true;
        try {
            const cs = window.getComputedStyle(el);
            const zi = parseFloat(cs.zIndex);
            if (cs.cursor === "pointer" || (!Number.isNaN(zi) && zi > 0)) return t.length < 120;
        } catch (_) {}
        return false;
    }

    function findControl() {
        let best = null;
        let bestLen = Infinity;
        walk(document.documentElement, (el) => {
            if (!looksLikePerplexityOpenButton(el)) return;
            const t = normalizedText(el);
            if (t.length < bestLen) {
                bestLen = t.length;
                best = el;
            }
        });
        if (best) return best;
        walk(document.documentElement, (el) => {
            if (el.nodeType !== 1) return;
            const t = normalizedText(el);
            if (t.includes("打开") && t.includes("Perplexity") && t.length < 80) {
                const a = el.closest("a, button");
                if (a && (!best || normalizedText(a).length < normalizedText(best).length)) best = a;
            }
        });
        return best;
    }

    function fireClick(el) {
        if (!el) return false;
        try {
            el.click();
        } catch (_) {}
        try {
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        } catch (_) {}
        return true;
    }

    let done = false;
    function tryOnce() {
        if (done) return true;
        if (!document.documentElement) return false;
        const el = findControl();
        if (!el) return false;
        done = true;
        fireClick(el);
        return true;
    }

    if (tryOnce()) return;

    const obs = new MutationObserver(() => {
        if (tryOnce()) obs.disconnect();
    });
    if (document.documentElement) {
        obs.observe(document.documentElement, { childList: true, subtree: true });
    }

    let ticks = 0;
    const poll = setInterval(() => {
        ticks++;
        if (tryOnce() || ticks > 120) {
            clearInterval(poll);
            obs.disconnect();
        }
    }, 250);
})();
