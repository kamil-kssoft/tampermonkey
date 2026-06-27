// ==UserScript==
// @name         Medium Summarizer PRO (Stylowy panel + PL translation)
// @namespace    https://openai.com/
// @version      4.3.0
// @description  Summarize articles on any site; compact icon panel expands on hover. Polish translation, token/cost tracking, Dropbox upload.
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      api.kssoft.com.pl
// @require      https://cdn.jsdelivr.net/npm/@mozilla/readability@0.5.0/Readability.js
// ==/UserScript==

(function () {
    "use strict";

    const LOG_PREFIX = "[Medium Summarizer PRO]";
    const scriptVersion =
      typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version
        ? GM_info.script.version
        : "4.3.0";
    console.info(`${LOG_PREFIX} userscript starting`, {
      version: scriptVersion,
      href: location.href,
      readyState: document.readyState,
    });

    /** Tampermonkey script storage only — never commit real keys into the script file. */
    const OPENAI_API_KEY_STORAGE_KEY = "summarizerPro_openai_api_key_v1";

    function getStoredOpenAiApiKey() {
      try {
        return String(GM_getValue(OPENAI_API_KEY_STORAGE_KEY, "") || "").trim();
      } catch {
        return "";
      }
    }

    /** @returns {string|null} Bearer token or null if user cancelled / left empty */
    function ensureOpenAiApiKey() {
      const existing = getStoredOpenAiApiKey();
      if (existing) return existing;
      const raw = window.prompt(
        [
          "Wklej klucz API OpenAI (Bearer).",
          "Zostanie zapisany tylko w pamięci Tampermonkey (Dashboard → ten skrypt → Values), nie w pliku .js.",
        ].join("\n\n"),
        ""
      );
      if (raw === null) return null;
      const key = raw.trim();
      if (!key) {
        alert("Brak klucza — przerwano.");
        return null;
      }
      GM_setValue(OPENAI_API_KEY_STORAGE_KEY, key);
      return key;
    }

    function openApiKeySettingsDialog() {
      const stored = getStoredOpenAiApiKey();
      const raw = window.prompt(
        stored
          ? "Wklej nowy klucz aby nadpisać.\nAby usunąć zapisany klucz, wpisz dokładnie: USUN\n\nAnuluj = bez zmian."
          : "Wklej klucz API OpenAI.\n\nAnuluj = bez zmian.",
        ""
      );
      if (raw === null) return;
      const t = raw.trim();
      if (t.toUpperCase() === "USUN") {
        GM_deleteValue(OPENAI_API_KEY_STORAGE_KEY);
        alert("Klucz usunięty z pamięci Tampermonkey.");
        return;
      }
      if (!t) {
        alert("Pusty wpis — bez zmian.");
        return;
      }
      GM_setValue(OPENAI_API_KEY_STORAGE_KEY, t);
      alert("Klucz zapisany.");
    }

    const PA_API_BASE_URL_KEY = "pa_api_base_url";
    const PA_API_TOKEN_KEY = "pa_api_token";
    const PA_API_DEFAULT_BASE_URL = "https://api.kssoft.com.pl";
    const PA_UPLOAD_TIMEOUT_MS = 30_000;
    const PA_UPLOAD_MAX_ATTEMPTS = 3;
    const PA_UPLOAD_BACKOFF_MS = [1000, 2000, 4000];

    function getPaApiBaseUrl() {
      const stored = String(GM_getValue(PA_API_BASE_URL_KEY, "") || "").trim();
      return stored || PA_API_DEFAULT_BASE_URL;
    }

    function getStoredPaApiToken() {
      return String(GM_getValue(PA_API_TOKEN_KEY, "") || "").trim();
    }

    /** @returns {string|null} Bearer token or null if user cancelled / left empty */
    function ensurePaApiToken() {
      const existing = getStoredPaApiToken();
      if (existing) return existing;
      const raw = window.prompt(
        [
          "Wklej token API Personal Automation (Bearer z CLI: python -m app.cli.manage_token regenerate).",
          "Zostanie zapisany tylko w pamięci Tampermonkey (Dashboard → ten skrypt → Values).",
        ].join("\n\n"),
        ""
      );
      if (raw === null) return null;
      const token = raw.trim();
      if (!token) {
        alert("Brak tokenu — przerwano.");
        return null;
      }
      GM_setValue(PA_API_TOKEN_KEY, token);
      return token;
    }

    function openPaApiSettingsDialog() {
      const storedToken = getStoredPaApiToken();
      const storedBase = getPaApiBaseUrl();
      const baseRaw = window.prompt(
        "URL API (bez końcowego /).\nAnuluj = bez zmian.",
        storedBase
      );
      if (baseRaw === null) return;
      const base = baseRaw.trim().replace(/\/+$/, "");
      if (base) GM_setValue(PA_API_BASE_URL_KEY, base);

      const tokenRaw = window.prompt(
        storedToken
          ? "Wklej nowy token API aby nadpisać.\nAby usunąć zapisany token, wpisz dokładnie: USUN\n\nAnuluj = bez zmian."
          : "Wklej token API Personal Automation.\n\nAnuluj = bez zmian.",
        ""
      );
      if (tokenRaw === null) return;
      const t = tokenRaw.trim();
      if (t.toUpperCase() === "USUN") {
        GM_deleteValue(PA_API_TOKEN_KEY);
        alert("Token API usunięty z pamięci Tampermonkey.");
        return;
      }
      if (!t) {
        alert("Pusty wpis tokenu — bez zmian.");
        return;
      }
      GM_setValue(PA_API_TOKEN_KEY, t);
      alert("Ustawienia API zapisane.");
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function gmRequest(options) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: options.method || "GET",
          url: options.url,
          headers: options.headers || {},
          data: options.data,
          timeout: options.timeout ?? PA_UPLOAD_TIMEOUT_MS,
          onload(response) {
            resolve(response);
          },
          onerror(err) {
            reject(new Error(err?.error || "Błąd sieci"));
          },
          ontimeout() {
            reject(new Error(`Timeout po ${PA_UPLOAD_TIMEOUT_MS / 1000}s`));
          },
        });
      });
    }

    function formatUploadError(response) {
      let detail = "";
      try {
        const body = JSON.parse(response.responseText || "{}");
        detail = body.detail ?? body.message ?? "";
        if (typeof detail === "object") detail = JSON.stringify(detail);
      } catch {
        detail = (response.responseText || "").slice(0, 200);
      }
      const suffix = detail ? `: ${detail}` : "";
      return `HTTP ${response.status}${suffix}`;
    }

    async function uploadSummaryToDropbox(payload) {
      const token = ensurePaApiToken();
      if (!token) throw new Error("Brak tokenu API");

      const baseUrl = getPaApiBaseUrl();
      const url = `${baseUrl}/api/summaries`;
      let lastError = new Error("Upload nie powiódł się");

      for (let attempt = 0; attempt < PA_UPLOAD_MAX_ATTEMPTS; attempt++) {
        try {
          const response = await gmRequest({
            method: "POST",
            url,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            data: JSON.stringify(payload),
            timeout: PA_UPLOAD_TIMEOUT_MS,
          });

          if (response.status >= 200 && response.status < 300) {
            try {
              return JSON.parse(response.responseText || "{}");
            } catch {
              return { success: true };
            }
          }

          const errMsg = formatUploadError(response);
          lastError = new Error(errMsg);
          if (response.status >= 400 && response.status < 500) {
            throw lastError;
          }
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
        }

        if (attempt < PA_UPLOAD_MAX_ATTEMPTS - 1) {
          await sleep(PA_UPLOAD_BACKOFF_MS[attempt]);
        }
      }

      throw lastError;
    }

    function buildSummaryUploadPayload(state) {
      return {
        title: state.articleTitleOriginal || state.articleTitle || "medium-article",
        url: state.articleUrl || window.location.href,
        source: location.hostname,
        createdAt: new Date().toISOString(),
        markdown: state.summaryPl || "",
      };
    }

    function setUploadStatus(el, message, kind) {
      if (!el) return;
      el.textContent = message;
      el.className = `upload-status upload-status--${kind || "info"}`;
    }

    const MIN_ARTICLE_CHARS = 500;
    const MAX_ARTICLE_CHARS = 240_000;

    // 💰 Ceny (USD / 1K tokenów)
    const MODEL_PRICING = {
      "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
      "gpt-4o": { input: 0.0025, output: 0.01 },
      "gpt-3.5-turbo": { input: 0.0005, output: 0.0015 },
    };

    // 🎨 Styl panelu — domyślnie ikona, po najechaniu pełny panel
    GM_addStyle(`
        #summaryPanel {
            position: fixed;
            bottom: 16px;
            right: 16px;
            background: #ffffffee;
            backdrop-filter: blur(6px);
            border: 1px solid #e2e8f0;
            box-shadow: 0 3px 14px rgba(0, 0, 0, 0.08);
            z-index: 99999;
            font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
            font-size: 11px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            width: 48px;
            height: 48px;
            padding: 0;
            border-radius: 50%;
            gap: 0;
            transition: width 0.28s ease, height 0.28s ease, border-radius 0.28s ease,
                padding 0.28s ease, box-shadow 0.25s ease, align-items 0.2s ease;
        }
        #summaryPanel:hover,
        #summaryPanel:focus-within,
        #summaryPanel.summaryPanel--expanded {
            width: min(240px, calc(100vw - 24px));
            height: auto;
            min-height: 0;
            border-radius: 10px;
            padding: 8px 10px;
            gap: 6px;
            align-items: stretch;
            box-shadow: 0 4px 18px rgba(0, 0, 0, 0.12);
        }
        #summaryPanelFab {
            flex-shrink: 0;
            width: 44px;
            height: 44px;
            margin: 0;
            padding: 0;
            border: none;
            background: transparent;
            border-radius: 50%;
            font-size: 22px;
            line-height: 1;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #summaryPanelFab:focus-visible {
            outline: 2px solid #3182ce;
            outline-offset: 2px;
        }
        #summaryPanelBody {
            display: none;
            flex-direction: column;
            gap: 6px;
            width: 100%;
            min-width: 0;
        }
        #summaryPanel:hover #summaryPanelFab,
        #summaryPanel:focus-within #summaryPanelFab,
        #summaryPanel.summaryPanel--expanded #summaryPanelFab {
            display: none;
        }
        #summaryPanel:hover #summaryPanelBody,
        #summaryPanel:focus-within #summaryPanelBody,
        #summaryPanel.summaryPanel--expanded #summaryPanelBody {
            display: flex;
        }
        #summaryTitle {
            font-size: 11px;
            font-weight: 600;
            color: #1a202c;
            text-align: center;
            margin-bottom: 2px;
            line-height: 1.2;
        }
        #modelSelect {
            border: 1px solid #cbd5e0;
            border-radius: 6px;
            padding: 4px 5px;
            font-size: 10px;
            color: #2d3748;
            background: white;
            cursor: pointer;
        }
        .summaryPanelBtn {
            color: white;
            border: none;
            border-radius: 6px;
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.3s ease, transform 0.1s ease;
            line-height: 1.2;
        }
        #summaryButton {
            background: linear-gradient(135deg, #3182ce, #63b3ed);
        }
        #summaryButton:hover {
            background: linear-gradient(135deg, #2b6cb0, #4299e1);
        }
        #summaryButton:active {
            transform: scale(0.97);
        }
        #summaryButtonV2 {
            background: linear-gradient(135deg, #553c9a, #805ad5);
        }
        #summaryButtonV2:hover {
            background: linear-gradient(135deg, #44337a, #6b46c1);
        }
        #summaryButtonV2:active {
            transform: scale(0.97);
        }
        #summaryPanelCustomBlock {
            margin-top: 4px;
            padding-top: 8px;
            border-top: 1px solid #e2e8f0;
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        label#summaryPanelCustomLabel {
            font-size: 10px;
            font-weight: 600;
            color: #4a5568;
            line-height: 1.2;
            cursor: pointer;
        }
        #summaryPanelCustomPrompt {
            width: 100%;
            min-height: 40px;
            max-height: 100px;
            resize: vertical;
            box-sizing: border-box;
            border: 1px solid #cbd5e0;
            border-radius: 6px;
            padding: 5px 6px;
            font-size: 10px;
            line-height: 1.35;
            color: #2d3748;
            background: #fff;
            font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        }
        #summaryPanelCustomPrompt:focus {
            outline: none;
            border-color: #319795;
            box-shadow: 0 0 0 1px #31979533;
        }
        #summaryButtonCustom {
            background: linear-gradient(135deg, #285e61, #319795);
        }
        #summaryButtonCustom:hover {
            background: linear-gradient(135deg, #234e52, #2c7a7b);
        }
        #summaryButtonCustom:active {
            transform: scale(0.97);
        }
        #summaryBox {
            position: fixed;
            bottom: 168px;
            right: 16px;
            width: min(700px, calc(100vw - 32px));
            max-height: 65vh;
            display: flex;
            flex-direction: column;
            gap: 0;
            background: #ffffff;
            border-radius: 16px;
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
            border: 1px solid #e2e8f0;
            padding: 0;
            font-family: ui-monospace, "Cascadia Code", monospace;
            font-size: 12px;
            color: #2d3748;
            line-height: 1.5;
            z-index: 99999;
            animation: fadeIn 0.3s ease;
            transition: width 0.35s ease, max-height 0.35s ease, border-radius 0.35s ease;
            overflow: hidden;
        }
        #summaryBox.summaryBox--collapsed {
            width: 40px;
            min-width: 40px;
            max-height: min(65vh, 220px);
            border-radius: 10px 0 0 10px;
            cursor: pointer;
        }
        #summaryBoxToolbar {
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 6px;
            padding: 8px 10px;
            border-bottom: 1px solid #e2e8f0;
            background: #f8fafc;
            border-radius: 16px 16px 0 0;
        }
        #summaryBox.summaryBox--collapsed #summaryBoxToolbar {
            flex-direction: column;
            justify-content: flex-start;
            align-items: center;
            padding: 8px 4px;
            border-bottom: none;
            border-radius: 10px 0 0 10px;
            gap: 4px;
        }
        #summaryBoxToggle {
            flex-shrink: 0;
            border: 1px solid #cbd5e0;
            background: #fff;
            color: #2d3748;
            border-radius: 8px;
            width: 32px;
            height: 28px;
            font-size: 12px;
            line-height: 1;
            cursor: pointer;
            transition: background 0.2s ease, border-color 0.2s ease;
        }
        #summaryBoxToggle:hover {
            background: #edf2f7;
            border-color: #a0aec0;
        }
        #summaryBox.summaryBox--collapsed #summaryBoxToggle {
            width: 28px;
            height: 28px;
        }
        #summaryBoxMain {
            flex: 1;
            min-height: 0;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        #summaryBoxInner {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding: 14px;
            white-space: pre-wrap;
        }
        #summaryBox.summaryBox--collapsed #summaryBoxMain {
            display: none;
        }
        #summaryBoxFooter {
            flex-shrink: 0;
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 10px 14px 14px;
            border-top: 1px solid #e2e8f0;
            background: #f8fafc;
            font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        }
        #summaryRefinePrompt {
            width: 100%;
            min-height: 44px;
            max-height: 120px;
            resize: vertical;
            box-sizing: border-box;
            border: 1px solid #cbd5e0;
            border-radius: 8px;
            padding: 8px 10px;
            font-size: 12px;
            line-height: 1.4;
            color: #2d3748;
            background: #fff;
        }
        #summaryRefinePrompt:focus {
            outline: none;
            border-color: #3182ce;
            box-shadow: 0 0 0 1px #3182ce33;
        }
        #summaryRefineBtn {
            align-self: flex-end;
            background: linear-gradient(135deg, #2c5282, #3182ce);
            color: white;
            border: none;
            border-radius: 8px;
            padding: 6px 14px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s ease, transform 0.1s ease;
        }
        #summaryRefineBtn:hover:not(:disabled) {
            background: linear-gradient(135deg, #2a4365, #2b6cb0);
        }
        #summaryRefineBtn:active:not(:disabled) {
            transform: scale(0.98);
        }
        #summaryRefineBtn:disabled {
            opacity: 0.65;
            cursor: not-allowed;
        }
        .summaryBoxCollapsedHint {
            display: none;
            writing-mode: vertical-rl;
            text-orientation: mixed;
            font-size: 10px;
            font-weight: 600;
            color: #4a5568;
            letter-spacing: 0.04em;
            user-select: none;
            padding: 4px 0;
        }
        #summaryBox.summaryBox--collapsed .summaryBoxCollapsedHint {
            display: block;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        #downloadBtn {
            display: inline-block;
            margin-top: 10px;
            background: linear-gradient(135deg, #38a169, #68d391);
            color: white;
            border: none;
            border-radius: 8px;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 13px;
            transition: background 0.3s ease, transform 0.1s ease;
        }
        #downloadBtn:hover {
            background: linear-gradient(135deg, #2f855a, #48bb78);
        }
        #downloadBtn:active {
            transform: scale(0.96);
        }
        #uploadBtn {
            display: inline-block;
            margin-top: 10px;
            margin-left: 8px;
            background: linear-gradient(135deg, #3182ce, #63b3ed);
            color: white;
            border: none;
            border-radius: 8px;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 13px;
            transition: background 0.3s ease, transform 0.1s ease;
        }
        #uploadBtn:hover:not(:disabled) {
            background: linear-gradient(135deg, #2b6cb0, #4299e1);
        }
        #uploadBtn:active:not(:disabled) {
            transform: scale(0.96);
        }
        #uploadBtn:disabled {
            opacity: 0.65;
            cursor: wait;
        }
        .upload-status {
            margin-top: 8px;
            font-size: 12px;
            line-height: 1.4;
            max-width: 100%;
            word-break: break-word;
        }
        .upload-status--info {
            color: #4a5568;
        }
        .upload-status--success {
            color: #276749;
        }
        .upload-status--error {
            color: #c53030;
        }
        #summarizerPickBanner {
            position: fixed;
            left: 50%;
            top: 12px;
            transform: translateX(-50%);
            z-index: 2147483646;
            max-width: min(520px, calc(100vw - 24px));
            padding: 10px 14px;
            border-radius: 10px;
            background: #1a202cf2;
            color: #f7fafc;
            font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
            font-size: 13px;
            font-weight: 600;
            line-height: 1.35;
            box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
            pointer-events: none;
            text-align: center;
        }
    `);

    console.info(`${LOG_PREFIX} GM_addStyle applied; Readability:`, {
      available: typeof Readability !== "undefined",
      body: Boolean(document.body),
    });

    // 🤖 Utwórz panel (zwinięty: tylko ikona)
    const panel = document.createElement("div");
    panel.id = "summaryPanel";
    panel.innerHTML = `
        <button type="button" id="summaryPanelFab" title="Summarizer — naciśnij lub najedź myszką" aria-label="Otwórz panel Summarizer">🤖</button>
        <div id="summaryPanelBody">
            <div id="summaryTitle">🤖 Summarizer</div>
            <select id="modelSelect">
                ${Object.keys(MODEL_PRICING)
                  .map((m) => `<option value="${m}">${m}</option>`)
                  .join("")}
            </select>
            <button type="button" id="summaryPanelApiKeyBtn" class="summaryPanelBtn" style="background:linear-gradient(135deg,#4a5568,#718096);font-size:9px;padding:3px 6px;">Klucz API…</button>
            <button type="button" id="summaryPanelPaApiBtn" class="summaryPanelBtn" style="background:linear-gradient(135deg,#2c5282,#4299e1);font-size:9px;padding:3px 6px;">Token Dropbox API…</button>
            <button type="button" id="summaryButton" class="summaryPanelBtn">summary with template</button>
            <button type="button" id="summaryButtonV2" class="summaryPanelBtn">summary (compact)</button>
            <div id="summaryPanelCustomBlock">
                <label id="summaryPanelCustomLabel" for="summaryPanelCustomPrompt">Custom prompt</label>
                <textarea id="summaryPanelCustomPrompt" rows="2" placeholder="Describe how to summarize (Ctrl+Enter / ⌘+Enter)…" aria-label="Custom summarization prompt"></textarea>
                <button type="button" id="summaryButtonCustom" class="summaryPanelBtn">Run custom</button>
            </div>
        </div>
    `;
    document.body.appendChild(panel);
    console.info(`${LOG_PREFIX} panel mounted (#summaryPanel bottom-right).`);

    const fab = panel.querySelector("#summaryPanelFab");
    fab.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.toggle("summaryPanel--expanded");
    });
    document.addEventListener(
      "click",
      (e) => {
        if (!panel.classList.contains("summaryPanel--expanded")) return;
        if (panel.contains(e.target)) return;
        panel.classList.remove("summaryPanel--expanded");
      },
      true
    );

    const btnApiKey = panel.querySelector("#summaryPanelApiKeyBtn");
    btnApiKey.addEventListener("click", (e) => {
      e.stopPropagation();
      openApiKeySettingsDialog();
    });

    const btnPaApi = panel.querySelector("#summaryPanelPaApiBtn");
    btnPaApi.addEventListener("click", (e) => {
      e.stopPropagation();
      openPaApiSettingsDialog();
    });

    const btn = panel.querySelector("#summaryButton");
    const btnV2 = panel.querySelector("#summaryButtonV2");
    const btnCustom = panel.querySelector("#summaryButtonCustom");
    const panelCustomPrompt = panel.querySelector("#summaryPanelCustomPrompt");
    const select = panel.querySelector("#modelSelect");
    const actionButtons = [btn, btnV2, btnCustom];

    panelCustomPrompt.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      btnCustom.click();
    });

    function syncSummaryBoxToggle(box) {
      const t = box.querySelector("#summaryBoxToggle");
      if (!t) return;
      const collapsed = box.classList.contains("summaryBox--collapsed");
      t.textContent = collapsed ? "▶" : "◀";
      t.title = collapsed ? "Rozwiń panel" : "Zwiń panel";
    }

    function ensureSummaryBox() {
      let box = document.getElementById("summaryBox");
      if (box) return box;
      box = document.createElement("div");
      box.id = "summaryBox";
      box.innerHTML = `
        <div id="summaryBoxToolbar">
          <button type="button" id="summaryBoxToggle" title="Zwiń panel">◀</button>
          <span class="summaryBoxCollapsedHint" aria-hidden="true">PL</span>
        </div>
        <div id="summaryBoxMain">
          <div id="summaryBoxInner"></div>
          <div id="summaryBoxFooter">
            <label for="summaryRefinePrompt" style="font-size:10px;font-weight:600;color:#4a5568;">Doprecyzuj streszczenie</label>
            <textarea id="summaryRefinePrompt" rows="2" placeholder="Np. dodaj więcej przykładów kodu, skróć TL;DR… (Ctrl+Enter / ⌘+Enter: wyślij)"></textarea>
            <button type="button" id="summaryRefineBtn">Zaktualizuj streszczenie</button>
          </div>
        </div>
      `;
      document.body.appendChild(box);
      const toggle = box.querySelector("#summaryBoxToggle");
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        box.classList.toggle("summaryBox--collapsed");
        syncSummaryBoxToggle(box);
      });
      box.addEventListener("click", () => {
        if (!box.classList.contains("summaryBox--collapsed")) return;
        box.classList.remove("summaryBox--collapsed");
        syncSummaryBoxToggle(box);
      });
      const refineTa = box.querySelector("#summaryRefinePrompt");
      refineTa.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        runRefineSummary(box);
      });
      box.querySelector("#summaryRefineBtn").addEventListener("click", () => runRefineSummary(box));
      return box;
    }

    const SUMMARY_BODY_MARKER = "[data-summarizer-pl-summary]";

    function getSummaryBoxInner(box) {
      return box?.querySelector?.("#summaryBoxInner") ?? null;
    }

    /** Polish markdown only; footer with link is appended here. */
    function updateSummaryBodyDisplay(box, polishMarkdown) {
      const inner = getSummaryBoxInner(box);
      if (!inner) return;
      const state = box._summarizerState;
      const url = state?.articleUrl ?? "";
      const footer = url ? `\n\n---\n🔗 Oryginalny artykuł: ${url}` : "";
      let el = inner.querySelector(SUMMARY_BODY_MARKER);
      if (!el) {
        el = document.createElement("div");
        el.id = "summaryBoxSummaryBody";
        el.dataset.summarizerPlSummary = "";
        inner.insertBefore(el, inner.firstChild);
      }
      el.textContent = `${polishMarkdown}${footer}`;
      try {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } catch (_) {
        /* ignore */
      }
    }

    function attachSummaryExportButtons(inner, box) {
      inner.querySelector("#summaryActions")?.remove();

      const actions = document.createElement("div");
      actions.id = "summaryActions";

      const downloadBtn = document.createElement("button");
      downloadBtn.id = "downloadBtn";
      downloadBtn.type = "button";
      downloadBtn.textContent = "⬇️ Download Markdown (PL)";
      downloadBtn.onclick = () => {
        const state = box._summarizerState;
        const pl = state?.summaryPl;
        if (!pl) {
          alert("Brak streszczenia do pobrania.");
          return;
        }
        const blob = new Blob([pl], { type: "text/markdown;charset=utf-8" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        const date = new Date().toISOString().replaceAll(/[:.]/g, "-");
        const slug = state?.articleTitle || "medium-article";
        const model = select.value;
        link.download = `${slug}_summary_pl_${model}_${date}.md`;
        link.click();
      };

      const uploadBtn = document.createElement("button");
      uploadBtn.id = "uploadBtn";
      uploadBtn.type = "button";
      uploadBtn.textContent = "☁️ Wyślij do Dropbox";
      const uploadStatus = document.createElement("div");
      uploadStatus.id = "uploadStatus";
      uploadStatus.className = "upload-status upload-status--info";
      uploadStatus.setAttribute("aria-live", "polite");

      uploadBtn.onclick = async () => {
        const state = box._summarizerState;
        if (!state?.summaryPl) {
          alert("Brak streszczenia do wysłania.");
          return;
        }
        const payload = buildSummaryUploadPayload(state);
        if (!payload.markdown.trim()) {
          alert("Streszczenie jest puste.");
          return;
        }

        uploadBtn.disabled = true;
        setUploadStatus(uploadStatus, "Wysyłanie do Dropbox…", "info");

        try {
          const result = await uploadSummaryToDropbox(payload);
          const filename = result.filename || result.dropbox_path || "plik";
          setUploadStatus(uploadStatus, `✅ Zapisano: ${filename}`, "success");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setUploadStatus(uploadStatus, `❌ ${msg}`, "error");
          console.error(`${LOG_PREFIX} Dropbox upload failed`, err);
        } finally {
          uploadBtn.disabled = false;
        }
      };

      actions.appendChild(document.createElement("br"));
      actions.appendChild(downloadBtn);
      actions.appendChild(uploadBtn);
      actions.appendChild(uploadStatus);
      inner.appendChild(actions);
    }

    function buildRefineUserContent(instruction, articleText, existingSummaryPl) {
      return [
        "You are revising a Polish Markdown summary of an article.",
        "Apply the user's instructions precisely. Stay strictly faithful to the original article — do not invent facts.",
        "Output must be Polish Markdown only (same general tone and formatting as the current summary unless the user asks otherwise).",
        "",
        "USER INSTRUCTIONS:",
        instruction,
        "",
        "---",
        "",
        "ORIGINAL ARTICLE (plain text extracted from the page):",
        "",
        articleText,
        "",
        "---",
        "",
        "CURRENT SUMMARY (Polish Markdown):",
        "",
        existingSummaryPl,
        "",
        "---",
        "",
        "Return ONLY the updated Polish Markdown summary. No preamble or closing remarks.",
      ].join("\n");
    }

    async function runRefineSummary(box) {
      const state = box._summarizerState;
      if (!state?.articleText) {
        alert("Brak zapisanej treści artykułu. Wygeneruj najpierw streszczenie.");
        return;
      }
      const refineTa = box.querySelector("#summaryRefinePrompt");
      const refineBtn = box.querySelector("#summaryRefineBtn");
      const instruction = refineTa?.value?.trim();
      if (!instruction) {
        alert("Wpisz instrukcję doprecyzowania.");
        return;
      }

      const model = select.value;
      const prices = MODEL_PRICING[model];
      if (!prices) {
        alert("Nieobsługiwany model.");
        return;
      }

      const apiKey = ensureOpenAiApiKey();
      if (!apiKey) return;

      refineBtn.disabled = true;
      const prevLabel = refineBtn.textContent;
      refineBtn.textContent = `Przetwarzanie (${model})…`;

      const userContent = buildRefineUserContent(instruction, state.articleText, state.summaryPl);

      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
              { role: "system", content: "You are a careful editor. Follow instructions exactly." },
              { role: "user", content: userContent },
            ],
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          const msg = data?.error?.message || res.statusText || "Request failed";
          throw new Error(msg);
        }
        const updated = (data?.choices?.[0]?.message?.content || "").trim();
        if (!updated) {
          throw new Error("Pusta odpowiedź modelu.");
        }
        state.summaryPl = updated;
        const usage = data?.usage || { prompt_tokens: 0, completion_tokens: 0 };
        const cost =
          (usage.prompt_tokens / 1000) * prices.input + (usage.completion_tokens / 1000) * prices.output;
        console.log(
          `✏️ Refine: input=${usage.prompt_tokens}, output=${usage.completion_tokens}, cost=$${cost.toFixed(6)}`
        );

        updateSummaryBodyDisplay(box, state.summaryPl);
      } catch (err) {
        alert("❌ Błąd doprecyzowania: " + err.message);
        console.error(err);
      } finally {
        refineBtn.disabled = false;
        refineBtn.textContent = prevLabel;
      }
    }

    const summaryPrompt = (articleText) => `
  You are an expert technical summarizer, specialized in creating actionable notes for developers, architects, and product managers.

  You will process a blog post, article or research paper and output a structured summary designed for quick understanding and reference.

  ✅ FORMAT REQUIRED (STRICT):

  # Title of the article

  ## 🧠 Key Concepts
  - Bullet points with concise explanations

  ## ⚙️ Technologies Involved
  - List of key technologies mentioned in the article (if any)

  ## 🔄 Practical Workflow
  - Bullet points or steps if any practical process or architecture is described
  - Include example code or pseudocode if available

  ## ✅ Strengths and Limitations
  | Strengths | Limitations |
  |-----------|-------------|
  | ...       | ...         |

  ## 📝 Final Summary
  A one-paragraph high-level summary of the article.

  ## 🚀 Suggested Next Steps
  - Optional suggestions for further exploration or implementation.

  ✅ RULES:
  - Always use clear headings (Markdown format)
  - Always include the Strengths and Limitations table, even if you must write N/A if no content is available.
  - Prefer short, precise sentences.
  - Do not hallucinate facts — stay strictly based on the provided article.
  - If example code is present, extract and format cleanly.

  Now process this article chunk:

  ${articleText}
  `;

    const summaryPromptV2 = (articleText) => `
  You are a sharp editor. Produce a compact Markdown brief from the article below — no rigid section template.

  Use this structure only if it fits the content; otherwise adapt:
  - **TL;DR** — 2–4 sentences.
  - **Takeaways** — bullet list (max 10), each one clause.
  - **Notable detail** — metrics, dates, names, or quotes worth keeping (or "—" if none).
  - **Caveats** — what the article glosses over or where claims are weak/speculative (or "—").

  Rules: stay strictly factual; short sentences; no filler; preserve Markdown where useful.

  Article:

  ${articleText}
  `;

    const summaryPromptCustom = (userInstruction, articleText) =>
      [
        "You are a helpful assistant. Follow the user's instructions exactly when summarizing or extracting from the article.",
        "Output Markdown. Write in clear English unless the user explicitly asks for another language (the result will be translated to Polish in a later step).",
        "Stay strictly faithful to the article — do not invent facts.",
        "",
        "USER INSTRUCTIONS:",
        userInstruction,
        "",
        "---",
        "",
        "ARTICLE:",
        "",
        articleText,
      ].join("\n");

    const defaultCaptions = {
      summaryButton: "summary with template",
      summaryButtonV2: "summary (compact)",
      summaryButtonCustom: "Run custom",
    };

    function getArticleParagraphElements() {
      const selectors = [
        "article p",
        "main p",
        '[role="main"] p',
        ".post-content p",
        ".entry-content p",
        ".article-content p",
        ".markdown-body p",
      ];
      for (const sel of selectors) {
        const nodes = document.querySelectorAll(sel);
        if (nodes.length >= 2) return Array.from(nodes);
      }
      return Array.from(document.querySelectorAll("body p")).slice(0, 250);
    }

    function normalizeArticleText(raw) {
      if (!raw) return "";
      return raw
        .replace(/\u00a0/g, " ")
        .replace(/\r\n?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    function clipArticleText(text) {
      if (text.length <= MAX_ARTICLE_CHARS) return text;
      return text.slice(0, MAX_ARTICLE_CHARS) + "\n\n[… treść obcięta do limitu skryptu …]";
    }

    function getArticleTextBase() {
      const paragraphs = getArticleParagraphElements();
      const joined = paragraphs.map((p) => p.textContent.trim()).filter(Boolean).join("\n\n");
      return normalizeArticleText(joined);
    }

    function getArticleTextReadability() {
      try {
        if (typeof Readability === "undefined") {
          console.warn("Summarizer: Readability (@require) not available.");
          return "";
        }
        const html = document.documentElement.outerHTML;
        const parsed = new DOMParser().parseFromString(html, "text/html");
        const reader = new Readability(parsed);
        const article = reader.parse();
        const raw = article?.textContent || "";
        return normalizeArticleText(raw);
      } catch (err) {
        console.warn("Summarizer: Readability failed.", err);
        return "";
      }
    }

    function articleRootStorageKey() {
      const host = location.hostname || "unknown";
      return `summarizerArticleRoot:${host}`;
    }

    function getTextFromRootSelector(selector) {
      if (!selector || typeof selector !== "string") return "";
      try {
        const el = document.querySelector(selector);
        if (!el) return "";
        return normalizeArticleText(el.innerText || "");
      } catch {
        return "";
      }
    }

    function isSummarizerChromeTarget(el) {
      if (!el || typeof el.closest !== "function") return true;
      return Boolean(
        el.closest("#summaryPanel") ||
          el.closest("#summaryBox") ||
          el.closest("#summarizerPickBanner")
      );
    }

    function buildCssSelector(el) {
      if (!(el instanceof Element)) return "body";
      if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
        return `#${CSS.escape(el.id)}`;
      }
      const parts = [];
      let cur = el;
      for (let depth = 0; cur && cur.nodeType === 1 && cur !== document.documentElement && depth < 12; depth++) {
        if (cur.id && document.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
          parts.unshift(`#${CSS.escape(cur.id)}`);
          break;
        }
        let part = cur.tagName.toLowerCase();
        if (typeof cur.className === "string" && cur.className.trim()) {
          const cls = cur.className
            .trim()
            .split(/\s+/)
            .filter((c) => c && !/^js-/.test(c))
            .slice(0, 2)
            .map((c) => `.${CSS.escape(c)}`);
          if (cls.length) part += cls.join("");
        }
        const parent = cur.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
          if (sameTag.length > 1) {
            const idx = sameTag.indexOf(cur) + 1;
            part += `:nth-of-type(${idx})`;
          }
        }
        parts.unshift(part);
        cur = parent;
      }
      return parts.length ? parts.join(" > ") : "body";
    }

    function pickArticleRootInteractive() {
      return new Promise((resolve) => {
        const banner = document.createElement("div");
        banner.id = "summarizerPickBanner";
        banner.textContent = "Kliknij w główną treść artykułu. Esc — anuluj.";
        document.body.appendChild(banner);

        const finish = (value) => {
          document.removeEventListener("click", onCapClick, true);
          document.removeEventListener("keydown", onKey, true);
          banner.remove();
          resolve(value);
        };

        const onKey = (e) => {
          if (e.key === "Escape") finish("");
        };

        const onCapClick = (e) => {
          if (isSummarizerChromeTarget(e.target)) return;
          e.preventDefault();
          e.stopPropagation();
          const selector = buildCssSelector(e.target);
          finish(selector);
        };

        requestAnimationFrame(() => {
          document.addEventListener("click", onCapClick, true);
          document.addEventListener("keydown", onKey, true);
        });
      });
    }

    function articleTextMeetsMinimum(text) {
      return Boolean(text && text.length >= MIN_ARTICLE_CHARS);
    }

    async function extractArticleText(clickedBtn) {
      let text = getArticleTextBase();
      if (articleTextMeetsMinimum(text)) {
        return { text: clipArticleText(text), method: "base" };
      }

      text = getArticleTextReadability();
      if (articleTextMeetsMinimum(text)) {
        return { text: clipArticleText(text), method: "readability" };
      }

      const key = articleRootStorageKey();
      const stored = GM_getValue(key, "");
      if (stored) {
        text = getTextFromRootSelector(stored);
        if (articleTextMeetsMinimum(text)) {
          return { text: clipArticleText(text), method: "stored-root" };
        }
      }

      const resumeLabel = clickedBtn.textContent;
      clickedBtn.textContent = "Wybierz treść…";
      const selector = await pickArticleRootInteractive();
      clickedBtn.textContent = resumeLabel;

      if (!selector) {
        return { text: "", method: "cancel" };
      }

      GM_setValue(key, selector);
      text = getTextFromRootSelector(selector);
      if (articleTextMeetsMinimum(text)) {
        return { text: clipArticleText(text), method: "user-pick" };
      }
      return { text: clipArticleText(text), method: "user-pick-short" };
    }

    async function runSummarize(clickedBtn, buildUserPrompt) {
      const model = select.value;
      const apiKey = ensureOpenAiApiKey();
      if (!apiKey) return;

      for (const b of actionButtons) {
        b.disabled = true;
      }
      clickedBtn.textContent = `Working (${model})…`;

      const extraction = await extractArticleText(clickedBtn);
      if (!articleTextMeetsMinimum(extraction.text)) {
        const msg =
          extraction.method === "cancel"
            ? "Anulowano wybór treści."
            : "Nie znaleziono wystarczającej treści artykułu (spróbuj wskazać większy fragment strony).";
        alert(msg);
        for (const b of actionButtons) {
          b.disabled = false;
          b.textContent = defaultCaptions[b.id];
        }
        return;
      }
      const articleText = extraction.text;
      console.log(`Summarizer: article text via "${extraction.method}" (${articleText.length} chars)`);

      // 🔖 Pobranie tytułu artykułu
      const articleTitleOriginal =
        document.querySelector("h1")?.innerText?.trim() || "medium-article";
      const articleTitle = articleTitleOriginal
        .toLowerCase()
        .replaceAll(/[^a-z0-9\s\-]/g, "")
        .trim()
        .replaceAll(/\s+/g, "-");

      const articleUrl = window.location.href;

      const userPrompt = buildUserPrompt(articleText);

      try {
        // === 1️⃣ Streszczenie ===
        const res1 = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
              { role: "system", content: "You are a helpful assistant." },
              { role: "user", content: userPrompt },
            ],
          }),
        });
        const data1 = await res1.json();
        const summary = data1?.choices?.[0]?.message?.content || "No summary received.";
        const usage1 = data1?.usage || { prompt_tokens: 0, completion_tokens: 0 };
        const prices = MODEL_PRICING[model];
        const cost1 =
          (usage1.prompt_tokens / 1000) * prices.input +
          (usage1.completion_tokens / 1000) * prices.output;

        console.log(
          `🤖 Summary: input=${usage1.prompt_tokens}, output=${usage1.completion_tokens}, cost=$${cost1.toFixed(6)}`
        );

        // === 2️⃣ Tłumaczenie ===
        clickedBtn.textContent = "Translating...";
        const res2 = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
              { role: "system", content: "You are a professional translator." },
              {
                role: "user",
                content: `Translate the following Markdown text into natural, fluent Polish. Keep formatting and structure:\n\n${summary}`,
              },
            ],
          }),
        });
        const data2 = await res2.json();
        const translated = data2?.choices?.[0]?.message?.content || "No translation received.";
        const usage2 = data2?.usage || { prompt_tokens: 0, completion_tokens: 0 };
        const cost2 =
          (usage2.prompt_tokens / 1000) * prices.input +
          (usage2.completion_tokens / 1000) * prices.output;
        const totalCost = cost1 + cost2;

        console.log(
          `🈯 Translation: input=${usage2.prompt_tokens}, output=${usage2.completion_tokens}, cost=$${cost2.toFixed(6)}`
        );
        console.log(`💰 Total cost ≈ $${totalCost.toFixed(6)}`);

        // 🔔 Powiadomienie
        if (Notification.permission === "granted") {
          new Notification("✅ Summary ready (Polish)", {
            body: `Model: ${model}\nTotal tokens: ${
              usage1.prompt_tokens + usage1.completion_tokens + usage2.prompt_tokens + usage2.completion_tokens
            }\nTotal cost: $${totalCost.toFixed(5)}`,
          });
        } else {
          Notification.requestPermission();
        }

        // 📦 Wyświetl tłumaczenie
        const box = ensureSummaryBox();
        box.classList.remove("summaryBox--collapsed");
        syncSummaryBoxToggle(box);
        box._summarizerState = {
          articleText,
          summaryPl: translated,
          articleUrl,
          articleTitle,
          articleTitleOriginal,
        };
        const inner = getSummaryBoxInner(box);
        inner.replaceChildren();
        updateSummaryBodyDisplay(box, translated);
        attachSummaryExportButtons(inner, box);
      } catch (err) {
        alert("❌ Błąd: " + err.message);
        console.error(err);
      } finally {
        for (const b of actionButtons) {
          b.disabled = false;
          b.textContent = defaultCaptions[b.id];
        }
      }
    }

    btn.addEventListener("click", () => runSummarize(btn, summaryPrompt));
    btnV2.addEventListener("click", () => runSummarize(btnV2, summaryPromptV2));
    btnCustom.addEventListener("click", () => {
      const instruction = panelCustomPrompt.value.trim();
      if (!instruction) {
        alert("Wpisz własną instrukcję streszczenia.");
        return;
      }
      runSummarize(btnCustom, (articleText) => summaryPromptCustom(instruction, articleText));
    });
  })();
