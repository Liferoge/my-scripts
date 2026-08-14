// ==UserScript==
// @name         AMQ Auto Module Loader (GitHub)
// @namespace    https://github.com/Liferoge/amqscripts
// @version      6.1.0
// @description  Carrega automaticamente módulos JavaScript do repositório GitHub Liferoge/amqscripts
// @match        https://*.animemusicquiz.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_info
// @require      https://github.com/joske2865/AMQ-Scripts/raw/master/common/amqScriptInfo.js
// @connect      github.com
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @connect      githubusercontent.com
// @connect      cdnjs.cloudflare.com
// @connect      files.catbox.moe
// @connect      catbox.video
// @connect      myanimelist.net
// @connect      animemusicquiz.com
// ==/UserScript==

(() => {
    'use strict';
GM_setValue('githubToken', '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');

    if (unsafeWindow.__AMQ_AUTO_MODULE_LOADER__) return;
    unsafeWindow.__AMQ_AUTO_MODULE_LOADER__ = true;

    const CONFIG = Object.freeze({
    owner: 'Liferoge',
    repo: 'amqscripts',
    branch: 'main',
    modulesDir: '',
    settingsFile: 'settings.json',
    settingsDebounceMs: 750,
    requestTimeoutMs: 30000,
    waitTimeoutMs: 90000,
    requestConcurrency: 8
});

    const API_BASE = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}`;
    const RAW_BASE = `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}`;

    const RESOURCE_ALIASES = Object.freeze({
        songdb: 'songDb',
        groupdb: 'groupDb',
        groupversions: 'artistBaseDb',
        artistbasedb: 'artistBaseDb'
    });

    const state = {
    bootPromise: null,
    bootRetryCount: 0,
    bootRetryTimer: null,
    bootRetryDelayMs: 3000,
    bootRetryMax: 3,
    ready: false,
    storage: {
        loadingPromise: null,
        loaded: false,
        nativeStorage: null,
        proxy: null,
        data: Object.create(null),
        managedKeys: new Set(),
        dirty: false,
        saving: null,
        saveTimer: null,
        sha: ''
    },
    resources: Object.create(null),
    resourceJson: Object.create(null),
    discoveredFiles: [],
    loadedModules: [],
    errors: []
};

    const scriptCache = new Map();
const resourceCache = new Map();

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function getCurrentListener() {
    return unsafeWindow.Listener || (typeof Listener !== 'undefined' ? Listener : null);
}

function resolveRuntimeGlobal(name, fallback = null) {
    try {
        const fromPage = unsafeWindow?.[name];
        if (fromPage !== undefined) return fromPage;
    } catch {
        // ignora
    }

    try {
        if (typeof globalThis !== 'undefined' && name in globalThis) {
            return globalThis[name];
        }
    } catch {
        // ignora
    }

    return fallback;
}

function defineRuntimeAlias(target, key, getter) {
    try {
        Object.defineProperty(target, key, {
            configurable: true,
            enumerable: true,
            get: getter
        });
        return true;
    } catch {
        return false;
    }
}

    const API = unsafeWindow.AMQ_AUTO_MODULE_LOADER ?? {};
    unsafeWindow.AMQ_AUTO_MODULE_LOADER = API;

    Object.assign(API, {
        version: '2.0.0',
        config: CONFIG,
        state,
        boot,
        discoverModules,
        loadResources,
        loadRequires,
        ensureScript,
        loadModules,
        parseUserScriptMetadata,
        stripUserScriptMetadata,
        getResourceText,
        getResourceJson,
        registerModule,
        publishRuntimeGlobals
    });

    function stamp() {
        return new Date().toISOString();
    }

    function log(level, ...args) {
        const prefix = '[AMQ Auto Module Loader]';
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        fn(prefix, ...args);
    }

    async function group(title, fn) {
        if (typeof console.groupCollapsed === 'function' && typeof console.groupEnd === 'function') {
            console.groupCollapsed(`[AMQ Auto Module Loader] ${title}`);
            try {
                return await fn();
            } finally {
                console.groupEnd();
            }
        }
        return await fn();
    }

    function normalizeName(name) {
        return String(name ?? '').trim();
    }

    function normalizeUrl(url) {
        return String(url ?? '').trim();
    }

function rewriteRequireUrl(url) {
    const normalized = normalizeUrl(url);

    const githubRaw = normalized.match(
        /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/i
    );

    if (githubRaw) {
        return `https://raw.githubusercontent.com/${githubRaw[1]}/${githubRaw[2]}/${githubRaw[3]}/${githubRaw[4]}`;
    }

    return normalized;
}

    function safeSourceURL(input) {
        return String(input ?? '')
            .replace(/[\r\n]+/g, '')
            .replace(/\*\//g, '*_/');
    }

    function resolveResourceName(name) {
        const raw = normalizeName(name);
        if (!raw) return '';

        const lower = raw.toLowerCase();
        return RESOURCE_ALIASES[lower] ?? raw;
    }

    function commitResourceText(name, text, sourceUrl = '') {
        const resolved = resolveResourceName(name);
        if (!resolved) return;

        const previous = state.resources[resolved];
        if (typeof previous === 'string' && previous && previous !== text) {
            log('warn', `Recurso "${resolved}" sobrescrito por ${sourceUrl || 'origem desconhecida'}.`);
        }

        state.resources[resolved] = text;
        state.resources[resolved.toLowerCase()] = text;
        delete state.resourceJson[resolved];
        delete state.resourceJson[resolved.toLowerCase()];
    }

    function getResourceText(name) {
        const resolved = resolveResourceName(name);
        if (!resolved) return '';

        if (Object.prototype.hasOwnProperty.call(state.resources, resolved)) {
            return state.resources[resolved] ?? '';
        }

        const lower = resolved.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(state.resources, lower)) {
            return state.resources[lower] ?? '';
        }

        return '';
    }

    function getResourceJson(name) {
        const resolved = resolveResourceName(name);
        if (!resolved) return null;

        if (Object.prototype.hasOwnProperty.call(state.resourceJson, resolved)) {
            return state.resourceJson[resolved];
        }

        const text = getResourceText(resolved);
        if (!text) return null;

        try {
            const parsed = JSON.parse(text);
            state.resourceJson[resolved] = parsed;
            state.resourceJson[resolved.toLowerCase()] = parsed;
            return parsed;
        } catch (err) {
            state.errors.push({
                kind: 'resource-json',
                name: resolved,
                error: String(err?.message || err)
            });
            return null;
        }
    }

    function registerModule(moduleInfo) {
    if (!moduleInfo || typeof moduleInfo !== 'object') {
        throw new TypeError('registerModule() espera um objeto');
    }

    return upsertLoadedModuleEntry({
        id: normalizeName(moduleInfo.id || moduleInfo.path || moduleInfo.name),
        name: normalizeName(moduleInfo.name || moduleInfo.id),
        version: normalizeName(moduleInfo.version),
        path: normalizeName(moduleInfo.path),
        status: normalizeName(moduleInfo.status || 'registered'),
        meta: moduleInfo
    });
}

function upsertLoadedModuleEntry(moduleInfo, patch = {}) {
    if (!moduleInfo || typeof moduleInfo !== 'object') {
        throw new TypeError('upsertLoadedModuleEntry() espera um objeto');
    }

    const id = normalizeName(moduleInfo.id || moduleInfo.path || moduleInfo.name);
    const path = normalizeName(moduleInfo.path);
    const name = normalizeName(moduleInfo.name || moduleInfo.id || moduleInfo.path);
    const index = state.loadedModules.findIndex(entry => {
        if (!entry || typeof entry !== 'object') return false;
        if (id && entry.id === id) return true;
        if (path && entry.path === path) return true;
        return false;
    });

    const previous = index >= 0 ? state.loadedModules[index] : Object.create(null);
    const entry = {
        id: id || path || name,
        name: name || id || path,
        version: normalizeName(moduleInfo.version || previous.version),
        path: path || previous.path || '',
        status: normalizeName(patch.status || moduleInfo.status || previous.status || 'registered'),
        meta: moduleInfo.meta ?? previous.meta ?? moduleInfo
    };

    if (patch.loadedAt !== undefined) entry.loadedAt = patch.loadedAt;
    if (patch.durationMs !== undefined) entry.durationMs = patch.durationMs;
    if (patch.error !== undefined) entry.error = patch.error;

    if (index >= 0) {
        state.loadedModules[index] = entry;
    } else {
        state.loadedModules.push(entry);
    }

    return entry;
}

function resetBootRetryState() {
    if (state.bootRetryTimer) {
        clearTimeout(state.bootRetryTimer);
        state.bootRetryTimer = null;
    }
    state.bootRetryCount = 0;
}

function scheduleBootRetry(reason = null) {
    if (state.ready) return;
    if (state.bootRetryTimer) return;

    if (state.bootRetryCount >= state.bootRetryMax) {
        log('error', 'Limite de retentativas do boot atingido.', reason || '');
        return;
    }

    state.bootRetryCount += 1;

    const delay = Math.min(
        state.bootRetryDelayMs * state.bootRetryCount,
        15000
    );

    log(
        'warn',
        `Agendando nova tentativa do boot em ${Math.round(delay / 1000)}s (${state.bootRetryCount}/${state.bootRetryMax}).`,
        reason || ''
    );

    state.bootRetryTimer = setTimeout(() => {
        state.bootRetryTimer = null;
        state.bootPromise = null;
        void boot();
    }, delay);
}

function finalizeLoader() {
    if (state.bootRetryTimer) {
        clearTimeout(state.bootRetryTimer);
        state.bootRetryTimer = null;
    }

    if (state.storage?.saveTimer) {
        clearTimeout(state.storage.saveTimer);
        state.storage.saveTimer = null;
    }

    if (state.storage?.dirty) {
        void flushRemoteStorageSave();
    }
}

function installFinalizationHooks() {
    const handler = () => {
        try {
            finalizeLoader();
        } catch {
            // ignora
        }
    };

    try {
        unsafeWindow.addEventListener('pagehide', handler, { once: true });
    } catch {
        // ignora
    }

    try {
        unsafeWindow.addEventListener('beforeunload', handler, { once: true });
    } catch {
        // ignora
    }
}

async function runWithConcurrency(items = [], limit = CONFIG.requestConcurrency, mapper = async () => null) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return [];

    const concurrency = Math.max(1, Number(limit) || 1);
    const results = new Array(list.length);
    let nextIndex = 0;

    const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
        while (true) {
            const currentIndex = nextIndex++;
            if (currentIndex >= list.length) break;
            results[currentIndex] = await mapper(list[currentIndex], currentIndex, list);
        }
    });

    await Promise.all(workers);
    return results;
}

    function gmRequest({
    method = 'GET',
    url,
    data = null,
    headers = {},
    timeout = CONFIG.requestTimeoutMs,
    responseType = 'text',
    onload,
    onerror,
    ontimeout,
    onabort,
    onreadystatechange,
    onprogress
} = {}) {
    let requestHandle = null;

    const promise = new Promise((resolve, reject) => {
        if (!url) {
            reject(new Error('URL vazia em GM_xmlhttpRequest'));
            return;
        }

        const settleSuccess = response => {
            try {
                if (typeof onload === 'function') onload(response);
            } catch {
                // ignora callback quebrada
            }
            resolve(response);
        };

        const settleFailure = (response, kind) => {
            const error =
                response instanceof Error
                    ? response
                    : new Error(
                        kind === 'timeout'
                            ? `Timeout em ${url}`
                            : kind === 'abort'
                                ? `Requisição abortada em ${url}`
                                : `Falha na requisição (${response?.status ?? 'erro'}) em ${url}`
                    );

            try {
                if (kind === 'timeout' && typeof ontimeout === 'function') {
                    ontimeout(response);
                } else if (kind === 'abort' && typeof onabort === 'function') {
                    onabort(response);
                } else if (typeof onerror === 'function') {
                    onerror(response);
                }
            } catch {
                // ignora callback quebrada
            }

            reject(error);
        };

        try {
            requestHandle = GM_xmlhttpRequest({
                method,
                url,
                data,
                headers,
                timeout,
                responseType,
                onload: response => settleSuccess(response),
                onerror: response => settleFailure(response, 'error'),
                ontimeout: response => settleFailure(response, 'timeout'),
                onabort: response => settleFailure(response, 'abort'),
                onreadystatechange: response => {
                    try {
                        if (typeof onreadystatechange === 'function') onreadystatechange(response);
                    } catch {
                        // ignora callback quebrada
                    }
                },
                onprogress: response => {
                    try {
                        if (typeof onprogress === 'function') onprogress(response);
                    } catch {
                        // ignora callback quebrada
                    }
                }
            });
        } catch (err) {
            reject(err);
        }
    });

    promise.abort = () => {
        try {
            requestHandle?.abort?.();
        } catch {
            // ignora
        }
    };

    return promise;
}

    async function requestText(url, options = {}) {
    const token = getGitHubToken();

    const headers = {
        Accept: 'application/vnd.github+json',
        ...options.headers
    };

    if (token && /^https:\/\/api\.github\.com\//i.test(url)) {
        headers.Authorization = `Bearer ${token}`;
        headers['X-GitHub-Api-Version'] = '2022-11-28';
    }

    const response = await gmRequest({
        url,
        responseType: 'text',
        ...options,
        headers
    });

    const status = Number(response?.status ?? 0);

    if (status < 200 || status >= 300) {
        throw new Error(`HTTP ${status} ao ler ${url}`);
    }

    return typeof response.responseText === 'string'
        ? response.responseText
        : '';
}

    async function requestJson(url) {
        const text = await requestText(url);

        try {
            return JSON.parse(text);
        } catch (err) {
            throw new Error(`JSON inválido em ${url}: ${err.message}`);
        }
    }

    function encodeRepoPath(path = '') {
        return String(path)
            .split('/')
            .filter(Boolean)
            .map(encodeURIComponent)
            .join('/');
    }

    function buildContentsUrl(path = '') {
        const encoded = encodeRepoPath(path);
        return encoded
            ? `${API_BASE}/contents/${encoded}?ref=${encodeURIComponent(CONFIG.branch)}`
            : `${API_BASE}/contents?ref=${encodeURIComponent(CONFIG.branch)}`;
    }

    function buildRawUrl(path = '') {
        return `${RAW_BASE}/${encodeRepoPath(path)}`;
    }

    function buildTreesUrl() {
        return `${API_BASE}/git/trees/${encodeURIComponent(CONFIG.branch)}?recursive=1`;
    }

    function base64ToUtf8(input = '') {
    const normalized = String(input ?? '').replace(/\s+/g, '');
    if (!normalized) return '';

    try {
        if (typeof atob === 'function') {
            const binary = atob(normalized);

            if (typeof TextDecoder !== 'undefined') {
                const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
                return new TextDecoder('utf-8').decode(bytes);
            }

            try {
                return decodeURIComponent(escape(binary));
            } catch {
                return binary;
            }
        }
    } catch {
        // ignora
    }

    return '';
}

async function requestRepoFile(path) {
    const payload = await requestJson(buildContentsUrl(path));

    if (!payload || payload.type !== 'file' || typeof payload.content !== 'string') {
        throw new Error(`Arquivo inválido ou não encontrado: ${path}`);
    }

    return base64ToUtf8(payload.content);
}

function utf8ToBase64(input = '') {
    const text = String(input ?? '');
    if (!text) return '';

    try {
        if (typeof TextEncoder !== 'undefined' && typeof btoa === 'function') {
            const bytes = new TextEncoder().encode(text);
            let binary = '';
            for (const byte of bytes) {
                binary += String.fromCharCode(byte);
            }
            return btoa(binary);
        }

        return btoa(unescape(encodeURIComponent(text)));
    } catch {
        return '';
    }
}

function normalizeRemoteStoragePayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return Object.create(null);
    }

    const output = Object.create(null);
    for (const [key, rawValue] of Object.entries(value)) {
        if (!key) continue;
        output[String(key)] = String(rawValue ?? '');
    }
    return output;
}

function cloneStorageObject(value) {
    return normalizeRemoteStoragePayload(value);
}

function getStorageSnapshot() {
    return cloneStorageObject(state.storage?.data ?? Object.create(null));
}

function getUnionStorageKeys() {
    const keys = new Set();

    if (state.storage?.data && typeof state.storage.data === 'object') {
        for (const key of Object.keys(state.storage.data)) {
            keys.add(key);
        }
    }

    const nativeStorage = state.storage?.nativeStorage;
    try {
        if (nativeStorage && typeof nativeStorage.length === 'number' && typeof nativeStorage.key === 'function') {
            for (let i = 0; i < nativeStorage.length; i++) {
                const k = nativeStorage.key(i);
                if (k !== null && k !== undefined) {
                    keys.add(String(k));
                }
            }
        }
    } catch {
        // ignora
    }

    return [...keys].sort((a, b) => a.localeCompare(b, 'en'));
}

function serializeRemoteStoragePayload(value) {
    const normalized = normalizeRemoteStoragePayload(value);
    const ordered = Object.create(null);

    for (const key of Object.keys(normalized).sort((a, b) => a.localeCompare(b, 'en'))) {
        ordered[key] = normalized[key];
    }

    return JSON.stringify(ordered, null, 2) + '\n';
}

function getGitHubToken() {
    try {
        if (typeof GM_getValue === 'function') {
            const fromGM = GM_getValue('githubToken', '');
            if (String(fromGM ?? '').trim()) {
                return String(fromGM).trim();
            }
        }
    } catch {
        // ignora
    }

    try {
        const fromStorage = unsafeWindow.localStorage?.getItem('githubToken') ?? '';
        return String(fromStorage).trim();
    } catch {
        return '';
    }
}

function mergeRemoteStoragePayloads(remoteValue = {}, localValue = {}) {
    const merged = normalizeRemoteStoragePayload(remoteValue);
    const local = normalizeRemoteStoragePayload(localValue);

    for (const [key, value] of Object.entries(local)) {
        merged[key] = value;
    }

    return merged;
}

function applyRemoteStorageSnapshot(nextValue = {}) {
    const normalized = normalizeRemoteStoragePayload(nextValue);
    const nextKeys = new Set(Object.keys(normalized));
    const previousKeys = state.storage?.managedKeys instanceof Set ? [...state.storage.managedKeys] : [];

    for (const key of previousKeys) {
        if (!nextKeys.has(key)) {
            removeNativeLocalStorageItem(key);
        }
    }

    for (const [key, value] of Object.entries(normalized)) {
        writeNativeLocalStorageItem(key, value);
    }

    state.storage.data = normalized;
    state.storage.managedKeys = nextKeys;

    return normalized;
}

function storageSnapshotsEqual(leftValue = {}, rightValue = {}) {
    return serializeRemoteStoragePayload(leftValue) === serializeRemoteStoragePayload(rightValue);
}

    function stripUserScriptMetadata(source) {
        const text = String(source ?? '').replace(/^\uFEFF/, '');
        const lines = text.split(/\r?\n/);
        let start = -1;
        let end = -1;

        for (let i = 0; i < lines.length; i++) {
            if (/^\s*\/\/\s*==UserScript==\s*$/.test(lines[i])) {
                start = i;
                break;
            }
        }

        if (start < 0) return text;

        for (let i = start + 1; i < lines.length; i++) {
            if (/^\s*\/\/\s*==\/UserScript==\s*$/.test(lines[i])) {
                end = i;
                break;
            }
        }

        if (end < 0) return text;

        return lines.slice(end + 1).join('\n');
    }

    function parseUserScriptMetadata(source) {
    const text = String(source ?? '').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    const meta = {
        hasHeader: false,
        requires: [],
        resources: [],
        grants: [],
        matches: [],
        connects: [],
        raw: Object.create(null)
    };

    let inside = false;

    for (const line of lines) {
        if (!inside) {
            if (/^\s*\/\/\s*==UserScript==\s*$/.test(line)) {
                inside = true;
                meta.hasHeader = true;
            }
            continue;
        }

        if (/^\s*\/\/\s*==\/UserScript==\s*$/.test(line)) {
            break;
        }

        const match = line.match(/^\s*\/\/\s*@([^\s]+)\s*(.*)$/);
        if (!match) continue;

        const key = match[1].toLowerCase();
        const value = match[2].trim();

        switch (key) {
            case 'require':
                if (value) meta.requires.push(value);
                break;
            case 'resource': {
                const resourceMatch = value.match(/^(\S+)\s+(.+)$/);
                if (resourceMatch) {
                    meta.resources.push({
                        name: resourceMatch[1].trim(),
                        url: resourceMatch[2].trim()
                    });
                }
                break;
            }
            case 'grant':
                if (value) meta.grants.push(value);
                break;
            case 'match':
                if (value) meta.matches.push(value);
                break;
            case 'connect':
                if (value) meta.connects.push(value);
                break;
            default: {
                if (!meta.raw[key]) meta.raw[key] = [];
                meta.raw[key].push(value);
                break;
            }
        }
    }

    return meta;
}

    async function waitFor(conditionFn, timeoutMs = CONFIG.waitTimeoutMs, intervalMs = 50) {
        const startedAt = Date.now();

        while (true) {
            try {
                if (conditionFn()) return true;
            } catch {
                // continua aguardando
            }

            if (Date.now() - startedAt >= timeoutMs) {
                throw new Error('Tempo esgotado aguardando o AMQ ficar pronto');
            }

            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
    }

async function waitForAMQReady() {
    await waitFor(() => {
        const hasBody = !!unsafeWindow.document?.body;
        const hasListener = !!getCurrentListener();
        const domReady = unsafeWindow.document?.readyState !== 'loading';
        return hasBody && hasListener && domReady;
    });
}

async function waitForRuntimeGlobals() {
    await waitFor(() => {
        const hasAMQWindow = !!resolveRuntimeGlobal('AMQWindow');
        const hasValidateLocalStorage = !!resolveRuntimeGlobal('validateLocalStorage');
        const hasLoadHotkey = !!resolveRuntimeGlobal('loadHotkey');
        const hasJQuery = !!resolveRuntimeGlobal('$') || !!resolveRuntimeGlobal('jQuery');

        return hasAMQWindow && hasValidateLocalStorage && hasLoadHotkey && hasJQuery;
    }, Math.min(CONFIG.waitTimeoutMs, 15000));
}

    async function discoverModules() {
    // Busca todos os arquivos do repositório e executa somente userscripts.
    // O próprio loader é explicitamente ignorado.
    let tree = [];

    try {
        const payload = await requestJson(buildTreesUrl());
        tree = Array.isArray(payload?.tree) ? payload.tree : [];
    } catch (err) {
        log('warn', 'Falha ao listar árvore do repo via git trees; tentando listagem de diretório.', err);

        try {
            const direct = await requestJson(buildContentsUrl(''));
            tree = Array.isArray(direct)
                ? direct
                : (direct && typeof direct === 'object' ? [direct] : []);
        } catch (err2) {
            log('error', 'Falha também na listagem do repositório.', err2);
            return [];
        }
    }

    const files = tree
        .filter(item => item && item.type === 'blob')
        // Somente Userscripts
        .filter(item => /\.user\.js$/i.test(item.path || ''))
        // Nunca carregar o próprio loader
        .filter(item => !/\/?amqAutoModuleLoader\.user\.js$/i.test(item.path || ''))
        .map(item => ({
    name: item.path.split('/').pop(),
    path: item.path,
    downloadUrl: buildContentsUrl(item.path)
}));

    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));

    state.discoveredFiles = files;
    return files;
}

        function readNativeLocalStorageItem(key) {
        try {
            return state.storage.nativeStorage?.getItem(key) ?? null;
        } catch {
            return null;
        }
    }

    function writeNativeLocalStorageItem(key, value) {
        try {
            state.storage.nativeStorage?.setItem(key, value);
        } catch {
            // ignora
        }
    }

    function removeNativeLocalStorageItem(key) {
        try {
            state.storage.nativeStorage?.removeItem(key);
        } catch {
            // ignora
        }
    }

    function scheduleRemoteStorageSave() {
        if (state.storage.saveTimer) {
            clearTimeout(state.storage.saveTimer);
        }

        state.storage.saveTimer = setTimeout(() => {
            state.storage.saveTimer = null;
            void flushRemoteStorageSave();
        }, CONFIG.settingsDebounceMs);
    }

    async function loadRemoteStorageFile() {
    const url = buildContentsUrl(CONFIG.settingsFile);
    const response = await gmRequest({
        method: 'GET',
        url,
        responseType: 'text'
    });

    const status = Number(response?.status ?? 0);

    if (status === 404) {
        return { sha: '', data: Object.create(null) };
    }

    if (status < 200 || status >= 300) {
        throw new Error(`HTTP ${status} ao ler ${CONFIG.settingsFile}`);
    }

    let payload;
    try {
        payload = JSON.parse(response.responseText || '{}');
    } catch (err) {
        throw new Error(`JSON inválido em ${CONFIG.settingsFile}: ${err.message}`);
    }

    const content = typeof payload?.content === 'string' ? base64ToUtf8(payload.content) : '';
    let parsed = {};

    if (content) {
        try {
            parsed = JSON.parse(content);
        } catch (err) {
            throw new Error(`Conteúdo inválido em ${CONFIG.settingsFile}: ${err.message}`);
        }
    }

    return {
        sha: normalizeName(payload?.sha),
        data: normalizeRemoteStoragePayload(parsed)
    };
}

    async function flushRemoteStorageSave() {
    if (!state.storage.loaded) return false;
    if (!state.storage.dirty) return false;
    if (state.storage.saving) return state.storage.saving;

    const token = getGitHubToken();
    if (!token) {
        log('warn', `Token do GitHub ausente. Salvamento remoto de "${CONFIG.settingsFile}" desativado.`);
        return false;
    }

    const saveOnce = async ({ snapshot, sha, allowConflictRetry = true }) => {
        const payloadText = serializeRemoteStoragePayload(snapshot);
        const body = {
            branch: CONFIG.branch,
            message: `Update ${CONFIG.settingsFile} via AMQ Auto Module Loader`,
            content: utf8ToBase64(payloadText)
        };

        if (sha) {
            body.sha = sha;
        }

        const response = await gmRequest({
            method: 'PUT',
            url: buildContentsUrl(CONFIG.settingsFile),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            data: JSON.stringify(body),
            responseType: 'text'
        });

        const status = Number(response?.status ?? 0);

        if (status === 409 || status === 412) {
            if (!allowConflictRetry) {
                throw new Error(`Conflito de SHA ao salvar ${CONFIG.settingsFile}`);
            }

            const latest = await loadRemoteStorageFile();
            state.storage.sha = latest.sha || '';

            const merged = mergeRemoteStoragePayloads(latest.data, snapshot);
            applyRemoteStorageSnapshot(merged);

            return saveOnce({
                snapshot: merged,
                sha: state.storage.sha,
                allowConflictRetry: false
            });
        }

        if (status < 200 || status >= 300) {
            throw new Error(`HTTP ${status} ao salvar ${CONFIG.settingsFile}`);
        }

        try {
            const result = JSON.parse(response.responseText || '{}');
            const nextSha = result?.content?.sha || result?.sha;
            if (nextSha) {
                state.storage.sha = String(nextSha);
            }
        } catch {
            // ignora
        }

        const currentSnapshot = getStorageSnapshot();
        state.storage.dirty = !storageSnapshotsEqual(currentSnapshot, snapshot);

        if (state.storage.dirty) {
            scheduleRemoteStorageSave();
        }

        return true;
    };

    state.storage.saving = (async () => {
        const snapshot = getStorageSnapshot();

        try {
            return await saveOnce({
                snapshot,
                sha: state.storage.sha,
                allowConflictRetry: true
            });
        } catch (err) {
            state.errors.push({
                kind: 'settings-save',
                file: CONFIG.settingsFile,
                error: String(err?.stack || err?.message || err)
            });
            log('error', `Falha ao salvar ${CONFIG.settingsFile}:`, err);
            state.storage.dirty = true;
            scheduleRemoteStorageSave();
            throw err;
        } finally {
            state.storage.saving = null;
        }
    })();

    return state.storage.saving;
}

    async function initializeRemoteStorage() {
    if (state.storage.loadingPromise) return state.storage.loadingPromise;

    state.storage.loadingPromise = (async () => {
        state.storage.nativeStorage = (() => {
            try {
                return unsafeWindow.localStorage ?? null;
            } catch {
                return null;
            }
        })();

        let loaded = {
            sha: '',
            data: Object.create(null)
        };

                try {
            loaded = await loadRemoteStorageFile();
        } catch (err) {
            state.errors.push({
                kind: 'settings-load',
                file: CONFIG.settingsFile,
                error: String(err?.stack || err?.message || err)
            });
            log('warn', `Falha ao carregar ${CONFIG.settingsFile}; usando storage vazio.`, err);
            loaded = {
                sha: '',
                data: Object.create(null)
            };
        }

        state.storage.sha = loaded.sha || '';
        state.storage.data = cloneStorageObject(loaded.data);
        state.storage.managedKeys = new Set(Object.keys(state.storage.data));
        state.storage.loaded = true;
        state.storage.dirty = false;

        const handler = {
            get(target, prop, receiver) {
                if (prop === Symbol.toStringTag) return 'Storage';
                if (prop === 'length') return getUnionStorageKeys().length;
                if (prop === 'key') {
                    return index => getUnionStorageKeys()[Number(index)] ?? null;
                }
                if (prop === 'getItem') {
                    return key => {
                        const name = String(key);
                        if (Object.prototype.hasOwnProperty.call(state.storage.data, name)) {
                            return state.storage.data[name];
                        }
                        return readNativeLocalStorageItem(name);
                    };
                }
                if (prop === 'setItem') {
                    return (key, value) => {
                        const name = String(key);
                        const text = String(value);
                        state.storage.managedKeys.add(name);
                        state.storage.data[name] = text;
                        writeNativeLocalStorageItem(name, text);
                        state.storage.dirty = true;
                        scheduleRemoteStorageSave();
                    };
                }
                if (prop === 'removeItem') {
                    return key => {
                        const name = String(key);
                        state.storage.managedKeys.delete(name);
                        delete state.storage.data[name];
                        removeNativeLocalStorageItem(name);
                        state.storage.dirty = true;
                        scheduleRemoteStorageSave();
                    };
                }
                if (prop === 'clear') {
                    return () => {
                        for (const key of [...state.storage.managedKeys]) {
                            removeNativeLocalStorageItem(key);
                        }
                        state.storage.managedKeys.clear();
                        state.storage.data = Object.create(null);
                        state.storage.dirty = true;
                        scheduleRemoteStorageSave();
                    };
                }
                if (prop === 'toJSON') {
                    return () => getStorageSnapshot();
                }
                if (typeof prop === 'string') {
                    if (Object.prototype.hasOwnProperty.call(state.storage.data, prop)) {
                        return state.storage.data[prop];
                    }
                    const native = readNativeLocalStorageItem(prop);
                    if (native !== null) return native;
                }
                return Reflect.get(target, prop, receiver);
            },
            set(target, prop, value) {
                if (typeof prop === 'string') {
                    const text = String(value);
                    state.storage.managedKeys.add(prop);
                    state.storage.data[prop] = text;
                    writeNativeLocalStorageItem(prop, text);
                    state.storage.dirty = true;
                    scheduleRemoteStorageSave();
                    return true;
                }
                return Reflect.set(target, prop, value);
            },
            deleteProperty(target, prop) {
                if (typeof prop === 'string') {
                    state.storage.managedKeys.delete(prop);
                    delete state.storage.data[prop];
                    removeNativeLocalStorageItem(prop);
                    state.storage.dirty = true;
                    scheduleRemoteStorageSave();
                    return true;
                }
                return Reflect.deleteProperty(target, prop);
            },
            ownKeys() {
                return getUnionStorageKeys();
            },
            has(target, prop) {
                if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(state.storage.data, prop)) {
                    return true;
                }
                try {
                    return prop in (state.storage.nativeStorage || {});
                } catch {
                    return false;
                }
            },
            getOwnPropertyDescriptor(target, prop) {
                if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(state.storage.data, prop)) {
                    return {
                        enumerable: true,
                        configurable: true,
                        writable: true,
                        value: state.storage.data[prop]
                    };
                }
                return Object.getOwnPropertyDescriptor(target, prop);
            }
        };

        const proxyTarget = {};
        const proxy = new Proxy(proxyTarget, handler);
        state.storage.proxy = proxy;

        try {
            unsafeWindow.__AMQ_VIRTUAL_LOCAL_STORAGE__ = proxy;
        } catch {
            // ignora
        }

        try {
            Object.defineProperty(unsafeWindow, 'localStorage', {
                configurable: true,
                enumerable: true,
                get: () => proxy
            });
        } catch {
            try {
                unsafeWindow.localStorage = proxy;
            } catch {
                // ignora
            }
        }

        return proxy;
        })().catch(err => {
        state.errors.push({
            kind: 'settings-load',
            file: CONFIG.settingsFile,
            error: String(err?.stack || err?.message || err)
        });
        log('error', `Falha inesperada ao inicializar ${CONFIG.settingsFile}:`, err);
        state.storage.loaded = true;
        state.storage.dirty = false;
        return state.storage.proxy ?? state.storage.nativeStorage ?? null;
    });

    return state.storage.loadingPromise;
}

function publishRuntimeGlobals() {
    const runtime = Object.create(null);
    const publishedLocalStorage = state.storage?.proxy ?? state.storage?.nativeStorage ?? null;

    Object.defineProperties(runtime, {
        unsafeWindow: {
            enumerable: true,
            value: unsafeWindow
        },
        document: {
            enumerable: true,
            get: () => unsafeWindow.document ?? (typeof document !== 'undefined' ? document : null)
        },
        window: {
            enumerable: true,
            value: unsafeWindow
        },
        GM_addStyle: {
            enumerable: true,
            value: typeof GM_addStyle === 'function' ? GM_addStyle : null
        },
        GM_xmlhttpRequest: {
            enumerable: true,
            value: gmRequest
        },
        GM_getValue: {
            enumerable: true,
            value: typeof GM_getValue === 'function' ? GM_getValue : null
        },
        GM_setValue: {
            enumerable: true,
            value: typeof GM_setValue === 'function' ? GM_setValue : null
        },
        GM_getResourceText: {
            enumerable: true,
            value: typeof getResourceText === 'function' ? getResourceText : null
        },
        GM_getResourceJson: {
            enumerable: true,
            value: typeof getResourceJson === 'function' ? getResourceJson : null
        },
        GM_info: {
            enumerable: true,
            value: typeof GM_info !== 'undefined' ? GM_info : null
        },
        Listener: {
            enumerable: true,
            get: () => getCurrentListener()
        },
        AMQWindow: {
            enumerable: true,
            get: () => resolveRuntimeGlobal('AMQWindow', null)
        },
        validateLocalStorage: {
            enumerable: true,
            get: () => resolveRuntimeGlobal('validateLocalStorage', null)
        },
        loadHotkey: {
            enumerable: true,
            get: () => resolveRuntimeGlobal('loadHotkey', null)
        },
        AMQ_addScriptData: {
            enumerable: true,
            get: () => resolveRuntimeGlobal('AMQ_addScriptData', null)
        },
        gameChat: {
            enumerable: true,
            get: () => resolveRuntimeGlobal('gameChat', null)
        },
        hostModal: {
            enumerable: true,
            get: () => resolveRuntimeGlobal('hostModal', null)
        },
        quiz: {
            enumerable: true,
            get: () => resolveRuntimeGlobal('quiz', null)
        },
        socket: {
            enumerable: true,
            get: () => resolveRuntimeGlobal('socket', null)
        },
        selfName: {
            enumerable: true,
            get: () => resolveRuntimeGlobal('selfName', null)
        },
        localStorage: {
            enumerable: true,
            value: publishedLocalStorage
        },
        $: {
            enumerable: true,
            get: () => resolveRuntimeGlobal('$', resolveRuntimeGlobal('jQuery', null))
        },
        jQuery: {
            enumerable: true,
            get: () => resolveRuntimeGlobal('jQuery', resolveRuntimeGlobal('$', null))
        }
    });

    try {
        unsafeWindow.__AMQ_AUTO_MODULE_RUNTIME__ = runtime;
    } catch {
        // ignora
    }

    const liveAliases = [
        'Listener',
        'AMQWindow',
        'validateLocalStorage',
        'loadHotkey',
        'AMQ_addScriptData',
        'gameChat',
        'hostModal',
        'quiz',
        'socket',
        'selfName',
        '$',
        'jQuery'
    ];

    for (const key of liveAliases) {
        defineRuntimeAlias(unsafeWindow, key, () => runtime[key]);
    }

    try {
        Object.defineProperty(unsafeWindow, 'localStorage', {
            configurable: true,
            enumerable: true,
            value: publishedLocalStorage,
            writable: true
        });
    } catch {
        try {
            unsafeWindow.localStorage = publishedLocalStorage;
        } catch {
            // ignora
        }
    }

    const directAssignments = [
        'GM_addStyle',
        'GM_xmlhttpRequest',
        'GM_getValue',
        'GM_setValue',
        'GM_getResourceText',
        'GM_getResourceJson',
        'GM_info'
    ];

    for (const key of directAssignments) {
        try {
            unsafeWindow[key] = runtime[key];
        } catch {
            // ignora
        }
    }

    return runtime;
}

async function runSourceInPageScope(source, filePath) {
    publishRuntimeGlobals();

    const cleanSource = stripUserScriptMetadata(source);
    const code = `${cleanSource}\n//# sourceURL=${safeSourceURL(filePath)}\n`;

    await new Promise((resolve, reject) => {
        const blob = new Blob([code], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        const script = document.createElement('script');

        const cleanup = () => {
            script.remove();
            URL.revokeObjectURL(blobUrl);
        };

        script.src = blobUrl;
        script.async = false;
        script.onload = () => {
            cleanup();
            resolve();
        };
        script.onerror = () => {
            cleanup();
            reject(new Error(`Falha ao executar @require em contexto de página: ${filePath}`));
        };

        (document.head || document.documentElement).appendChild(script);
    });
}

async function loadTextResource(url) {
    const normalized = rewriteRequireUrl(url);
    if (!normalized) throw new Error('URL de recurso vazia');

    if (resourceCache.has(normalized)) {
        return resourceCache.get(normalized);
    }

    const promise = requestText(normalized).catch(err => {
        resourceCache.delete(normalized);
        throw err;
    });

    resourceCache.set(normalized, promise);
    return promise;
}

    async function loadResources(resourceEntries = []) {
        const entries = Array.isArray(resourceEntries) ? resourceEntries : [];
        const groups = new Map();

        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            const name = normalizeName(entry.name);
            const url = normalizeUrl(entry.url);
            if (!name || !url) continue;

            const bucket = groups.get(url);
            if (bucket) {
                bucket.push(name);
            } else {
                groups.set(url, [name]);
            }
        }

        const results = await Promise.allSettled(
            [...groups.entries()].map(async ([url, names]) => {
                try {
                    const text = await loadTextResource(url);
                    for (const name of names) {
                        commitResourceText(name, text, url);
                    }
                    return { ok: true, url, names };
                } catch (err) {
                    for (const name of names) {
                        commitResourceText(name, '', url);
                    }
                    state.errors.push({
                        kind: 'resource',
                        url,
                        names,
                        error: String(err?.stack || err?.message || err)
                    });
                    return { ok: false, url, names, error: err };
                }
            })
        );

        return results;
    }

async function ensureScript(scriptUrl, { kind = 'require', parent = '' } = {}, stack = []) {
    const normalized = rewriteRequireUrl(scriptUrl);
    if (!normalized) throw new Error('URL de script vazia');

    if (stack.includes(normalized)) {
        throw new Error(`Ciclo de dependência detectado: ${[...stack, normalized].join(' -> ')}`);
    }

    if (scriptCache.has(normalized)) {
        return scriptCache.get(normalized);
    }

        const promise = (async () => {
            let source;

if (normalized.startsWith(`${RAW_BASE}/`)) {
    const repoPath = normalized.slice(`${RAW_BASE}/`.length);
    source = await requestRepoFile(repoPath);
} else {
    source = await requestText(normalized);
}
            const meta = parseUserScriptMetadata(source);

            if (meta.resources.length) {
                await loadResources(meta.resources);
            }

            if (meta.requires.length) {
                await loadRequires(meta.requires, normalized, stack.concat(normalized));
            }

if (kind === 'require') {
    await runSourceInPageScope(source, normalized);
}

            return { url: normalized, source, meta };
        })().catch(err => {
            scriptCache.delete(normalized);
            throw err;
        });

        scriptCache.set(normalized, promise);
        return promise;
    }

    async function loadRequires(requireUrls = [], parent = '', stack = []) {
        const seen = new Set();

        for (const requireUrl of requireUrls) {
            const normalized = rewriteRequireUrl(requireUrl);
            if (!normalized || seen.has(normalized)) continue;
            seen.add(normalized);
            await ensureScript(normalized, { kind: 'require', parent }, stack);
        }
    }

    async function fetchModuleBundle(file) {
        const startedAt = performance.now();
        try {
            const source = await requestRepoFile(file.path);
            const meta = parseUserScriptMetadata(source);
            return {
                file,
                source,
                meta,
                durationMs: Math.round(performance.now() - startedAt)
            };
        } catch (error) {
            return {
                file,
                error,
                durationMs: Math.round(performance.now() - startedAt)
            };
        }
    }

async function executeModuleSource(source, filePath) {
    const runtime = publishRuntimeGlobals();
    const cleanSource = stripUserScriptMetadata(source);

    const executor = new AsyncFunction(
        'unsafeWindow',
        'window',
        'document',
        'GM_addStyle',
        'GM_xmlhttpRequest',
        'GM_getValue',
        'GM_setValue',
        'GM_getResourceText',
        'GM_getResourceJson',
        'GM_info',
        'Listener',
        'AMQWindow',
        'validateLocalStorage',
        'loadHotkey',
        'AMQ_addScriptData',
        'gameChat',
        'hostModal',
        'quiz',
        'socket',
        'selfName',
        '$',
        'jQuery',
        `
"use strict";
${cleanSource}
//# sourceURL=${safeSourceURL(filePath)}
`
    );

    const result = executor(
        runtime.unsafeWindow,
        runtime.unsafeWindow,
        runtime.unsafeWindow.document,
        runtime.GM_addStyle,
        runtime.GM_xmlhttpRequest,
        runtime.GM_getValue,
        runtime.GM_setValue,
        runtime.GM_getResourceText,
        runtime.GM_getResourceJson,
        runtime.GM_info,
        runtime.Listener,
        runtime.AMQWindow,
        runtime.validateLocalStorage,
        runtime.loadHotkey,
        runtime.AMQ_addScriptData,
        runtime.gameChat,
        runtime.hostModal,
        runtime.quiz,
        runtime.socket,
        runtime.selfName,
        runtime.$,
        runtime.jQuery
    );

    if (result && typeof result.then === 'function') {
        await result;
    }
}

    async function installModuleBundle(bundle) {
        const { file, source, meta, durationMs } = bundle;

        try {
            if (meta.resources.length) {
                await loadResources(meta.resources);
            }

            if (meta.requires.length) {
                await loadRequires(meta.requires, file.path, [file.downloadUrl]);
            }

            await executeModuleSource(source, file.path);

                        upsertLoadedModuleEntry({
                id: file.path,
                name: file.name,
                path: file.path,
                version: normalizeName(meta?.version),
                status: 'loaded',
                meta: {
                    file,
                    meta
                }
            }, {
                loadedAt: stamp(),
                durationMs
            });

            log('log', `Módulo carregado: ${file.path}`);
        } catch (err) {
            state.errors.push({
                kind: 'module',
                path: file.path,
                error: String(err?.stack || err?.message || err)
            });
            log('error', `Erro ao executar ${file.path}:`, err);
        }
    }

    async function loadModules(files) {
    const bundles = await runWithConcurrency(files, CONFIG.requestConcurrency, fetchModuleBundle);

    for (const bundle of bundles) {
        if (!bundle) continue;

        if (bundle.error) {
            state.errors.push({
                kind: 'module-fetch',
                path: bundle.file.path,
                error: String(bundle.error?.stack || bundle.error?.message || bundle.error)
            });
            log('warn', `Falha ao baixar ${bundle.file.path}:`, bundle.error);
            continue;
        }

        await installModuleBundle(bundle);
    }
}

    async function boot() {
    if (state.ready) return state.bootPromise ?? Promise.resolve();
    if (state.bootPromise) return state.bootPromise;

    state.bootPromise = (async () => {
        if (state.ready) return;

        log('log', 'Inicializando storage remoto...');
        try {
            await initializeRemoteStorage();
        } catch (err) {
            state.errors.push({
                kind: 'settings-load',
                file: CONFIG.settingsFile,
                error: String(err?.stack || err?.message || err)
            });
            log('warn', 'Storage remoto indisponível; continuando boot sem ele.', err);
        }

        log('log', 'Aguardando AMQ e Listener...');
        await waitForAMQReady();

        log('log', 'Aguardando globals do runtime...');
        try {
            await waitForRuntimeGlobals();
        } catch (err) {
            state.errors.push({
                kind: 'runtime',
                error: String(err?.stack || err?.message || err)
            });
            log('warn', 'Runtime ainda incompleto; seguindo com aliases reativos.', err);
        }

        publishRuntimeGlobals();

        log('log', `Descobrindo módulos em "${CONFIG.modulesDir}"...`);
        const files = await discoverModules(CONFIG.modulesDir);

        if (!files.length) {
            log('warn', `Nenhum arquivo .js ou .user.js encontrado no repo.`);
            state.ready = true;
            resetBootRetryState();
            return;
        }

        log('log', `Encontrados ${files.length} módulo(s).`);
        await group(`Execução dos módulos (${files.length})`, async () => {
            await loadModules(files);
        });

        state.ready = true;
        resetBootRetryState();

        log('log', 'Loader finalizado.', {
            discovered: state.discoveredFiles.length,
            loaded: state.loadedModules.length,
            errors: state.errors.length
        });
    })().catch(err => {
        state.errors.push({
            kind: 'fatal',
            error: String(err?.stack || err?.message || err)
        });
        log('error', 'Erro fatal no loader:', err);
        scheduleBootRetry(err);
    }).finally(() => {
        state.bootPromise = null;
    });

    return state.bootPromise;
}

        installFinalizationHooks();
    boot();
})();
