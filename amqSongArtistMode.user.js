// ==UserScript==
// @name               AMQ Song Artist Mode
// @namespace          http://tampermonkey.net/
// @version            2.3
// @description        Makes you able to play song/artist with other people who have this script installed
// @author             Liferoge
// @match              https://animemusicquiz.com/*
// @resource           songDb https://files.catbox.moe/4d1ikt.json
// @resource           artistBaseDb https://raw.githubusercontent.com/Liferoge/databases/refs/heads/main/groupversion.json
// @resource           groupDb https://raw.githubusercontent.com/Liferoge/databases/refs/heads/main/groups.json
// @grant              GM_getResourceText
// @grant              GM_getValue
// @grant              GM_setValue
// @grant              unsafeWindow
// @downloadURL        https://raw.githubusercontent.com/Liferoge/amqscripts/refs/heads/main/amqSongArtistMode.user.js
// @updateURL          https://raw.githubusercontent.com/Liferoge/amqscripts/refs/heads/main/amqSongArtistMode.user.js
// @require            https://raw.githubusercontent.com/Liferoge/databases/refs/heads/main/emojiHelper.js
// @require            https://cdn.socket.io/4.8.1/socket.io.min.js
// ==/UserScript==

(() => {
    const SCRIPT_VERSION =
          (typeof GM_info !== "undefined" && GM_info.script?.version) ||
          "0.0.0";
    class SAMSocketTransport {
        #url;
        #socket = null;

        constructor({ url }) {
            this.#url = url;
        }

        connect() {
            if (this.#socket) return this.#socket;
            const ioFactory = globalThis.io ?? unsafeWindow.io;
            if (typeof ioFactory !== "function") throw new Error("Socket.io client não carregado");
            this.#socket = ioFactory(this.#url, {
                transports: ["websocket"],
                reconnection: true,
                timeout: 10000
            });
            return this.#socket;
        }

        onConnect(callback) {
            this.connect().on("connect", callback);
        }

        onMessage(callback) {
            this.connect().on("message", callback);
        }

        on(event, callback) {
            this.connect().on(event, callback);
        }

        identify(payload) {
            this.connect().emit("identify", payload);
            return Promise.resolve(true);
        }

        send(payload) {
            this.connect().emit("message", payload);
            return Promise.resolve(true);
        }
    }

    class SongArtistMode {
        // =========================
        // CONSTANTS
        // =========================
        #SIGNATURE = "sa-";
        #HEADERS = Object.freeze({
            song: "s",
            artist: "a",
            reveal: "r",
            team: "t",
            hash: "h",
            preview: "p",
            hint: "i"
        });


#HISTORY_KEY = "sa_answer_history";
#SCOREBOARD_KEY = "sa_scoreboard";
#SCOREBOARD_POS_KEY = "sa_scoreboard_pos";
#updateRequired = false;
#updateNoticeShown = false;
#updateNoticeAnnounced = false;
#latestVersion = "";
#downloadURL = "";

        // =========================
        // STATE
        // =========================
        #transport;
        #enabled = false;
        #socketServerUrl;

        #interfaceContainer = null;
        #scoreboardElement = null;
        #scoreboardBody = null;
        #scoreboardVisible = true;
        #hintButton = null;
        #splitHintButton = null;
        #hintStatusElement = null;
        #answerAreaRetry = null;
        #hintVisibilityInterval = null;

        #songField = null;
        #artistField = null;

        #currentSong = "";
        #currentArtist = "";

        // Unified containers: song/artist
        #playerContainers = new Map();
        #playerTeams = new Map();
        #playerAnswers = { song: new Map(), artist: new Map() };
        #playerScores = { song: new Map(), artist: new Map() };
        #playerHashes = { song: new Map(), artist: new Map() };
        #playerHashesLocked = { song: new Map(), artist: new Map() };
        #pendingReveals = { song: new Map(), artist: new Map() };
        #revealFlushed = { song: false, artist: false };

        #selfHintedArtists = new Map();
        #teamHintedArtists = new Map();
        #selfDetectedArtists = new Set();

        #lastDraftSent = { song: "", artist: "" };
        #draftSendTimer = { song: null, artist: null };
        #previousRanking = [];

        #songDb = {};
        #groupDb = {};
        #localDb = {};
        #artistBaseDb = {};
        #answerHistory = { songs: {}, artists: {} };

        #artistEntryCache = { round: "", entries: [] };
        #artistClusterCache = { answer: "", round: "", value: null };

        // =========================
        // CONSTRUCTOR
        // =========================
        constructor() {
            this.#socketServerUrl = GM_getValue("sa_socket_url", "amqsyncserver-production.up.railway.app");
            this.#transport = new SAMSocketTransport({ url: this.#socketServerUrl });

            if (this.#socketServerUrl) {
                this.#transport.onConnect(() => this.#identifySocket());
                this.#transport.onMessage((payload) => this.#handleSocketMessage(payload));
                this.#transport.on("version:status", (payload) => this.#handleVersionStatus(payload));
                this.#transport.connect();
                void this.#identifySocket();
            }

            this.#patchChatFilters();
            this.#bindGameListeners();
            void this.#init();   // <-- continua chamando #init()
        }

        // =========================
        // INIT & DATABASES
        // =========================
        async #init() {
    try { this.#createScoreboard(); } catch (e) {}

    await this.#loadDatabases();

    if (unsafeWindow.quiz?.players) {
        await this.#setupPlayers();
    }

    this.#setupSAMButton();

    this.#hintVisibilityInterval = setInterval(() => {
        this.#syncHintButtonVisibility();
        this.#recoverRuntime();
    }, 500);

    this.#ensurePartialAnswerStyle();
}

        async #loadDatabases() {
            const readJson = (text) => {
                try { return JSON.parse(text || "{}"); } catch { return {}; }
            };

            const loadResource = ({ resourceName, cacheKey }) => {
                const text = GM_getResourceText(resourceName);
                if (text) {
                    const parsed = readJson(text);
                    if (Object.keys(parsed || {}).length) {
                        GM_setValue(cacheKey, text);
                        return parsed;
                    }
                }
                const cached = GM_getValue(cacheKey, "");
                return cached ? readJson(cached) : {};
            };

            this.#localDb = GM_getValue("local", {});
            this.#songDb = loadResource({ resourceName: "songDb", cacheKey: "sa_songDbRaw" });
            this.#artistBaseDb = loadResource({ resourceName: "artistBaseDb", cacheKey: "sa_artistBaseDbRaw" });
            this.#groupDb = loadResource({ resourceName: "groupDb", cacheKey: "sa_groupDbRaw" });
        }

        // =========================
        // SOCKET
        // =========================
        #identifySocket() {
            if (!this.#socketServerUrl) return;
            const playerKey = String(unsafeWindow.quiz?.ownGamePlayerId ?? "").trim();
            const displayName = String(unsafeWindow.selfName ?? "").trim();
            if (!playerKey) return;

            const payload = {
                roomId: "global",
                playerKey,
                gamePlayerId: playerKey,
                username: displayName || playerKey,
                displayName: displayName || playerKey,
                teamNumber: Number(unsafeWindow.quiz?.players?.[playerKey]?.teamNumber ?? 1) || 1,
                client: "browser",
                userscript: "AMQ Song Artist Mode",
                version: SCRIPT_VERSION
            };
            this.#transport.identify(payload);
        }

        #handleSocketMessage(payload = {}) {
            const player = String(payload?.displayName ?? payload?.player ?? payload?.playerKey ?? "").trim();
            const teamNumber = Number(payload?.teamNumber ?? NaN);
            const message = String(payload?.message ?? "");
            if (!player || !message) return;
            this.#handleMessages([{ sender: player, teamNumber: Number.isFinite(teamNumber) ? teamNumber : null, message }]);
        }

        #compareVersions(leftVersion, rightVersion) {
            const left = String(leftVersion ?? "")
            .trim()
            .split(".")
            .map((part) => Number.parseInt(part, 10) || 0);

            const right = String(rightVersion ?? "")
            .trim()
            .split(".")
            .map((part) => Number.parseInt(part, 10) || 0);

            const length = Math.max(left.length, right.length);
            for (let i = 0; i < length; i++) {
                const diff = (left[i] ?? 0) - (right[i] ?? 0);
                if (diff !== 0) return diff;
            }
            return 0;
        }

#handleVersionStatus(payload = {}) {
    const latestVersion = String(payload?.latestVersion ?? "").trim();
    const clientVersion = String(payload?.clientVersion ?? SCRIPT_VERSION).trim();
    const downloadURL = String(payload?.downloadURL ?? "").trim();

    if (!latestVersion) return;

    const updateRequired = Boolean(payload?.updateRequired) || this.#compareVersions(clientVersion, latestVersion) < 0;
    if (!updateRequired) return;

    this.#showUpdateRequired(latestVersion, downloadURL);
}

#showUpdateRequired(latestVersion, downloadURL = "") {
    this.#updateRequired = true;
    this.#updateNoticeShown = true;
    this.#latestVersion = latestVersion;
    this.#downloadURL = downloadURL;

    this.#enabled = false;
    this.#clearDraftTimers();

    if (this.#interfaceContainer) this.#interfaceContainer.style.display = "none";
    if (this.#scoreboardElement) this.#scoreboardElement.style.display = "none";
    if (this.#songField) this.#songField.disabled = true;
    if (this.#artistField) this.#artistField.disabled = true;
    if (this.#hintButton) this.#hintButton.disabled = true;

    this.#syncHintButtonVisibility();

    // Avisa o usuário assim que soubermos que o update é necessário,
    // em vez de esperar o próximo /sam (evita a corrida em que o
    // primeiro /sam chega antes da resposta "version:status" do servidor).
    void this.#announceUpdateRequired();
}

#announceUpdateRequired = async () => {
    if (this.#updateNoticeAnnounced) return;
    this.#updateNoticeAnnounced = true;
    await new Promise((resolve) => setTimeout(resolve, 50));

    if (this.#latestVersion) {
        unsafeWindow.gameChat?.systemMessage?.(
            `S/A: update required. Your version is ${SCRIPT_VERSION} and the latest version is ${this.#latestVersion}. Please update the script to continue.`
        );
    }

    if (this.#downloadURL) {
        unsafeWindow.gameChat?.systemMessage?.(
            `<a href="${this.#downloadURL}" target="_blank" rel="noopener noreferrer">${this.#downloadURL}</a>`
        );
    }
};

        // =========================
        // CHAT & GAME LISTENERS
        // =========================
        #patchChatFilters() {
            const chat = unsafeWindow.gameChat;
            if (!chat) return;

            const patch = (key, filterFn) => {
                const listener = chat[key];
                if (!listener?.callback || listener.__saPatched) return;
                const original = listener.callback;
                listener.callback = (payload) => {
                    try { if (filterFn(payload) === false) return; } catch {}
                    return original.call(listener, payload);
                };
                listener.__saPatched = true;
            };

            patch("_chatUpdateListener", (payload) => {
                if (!Array.isArray(payload?.messages)) return true;
                payload.messages = payload.messages.filter(
                    ({ message }) => !String(message ?? "").startsWith(this.#SIGNATURE)
                );
                return true;
            });

            patch("_newMessageListner", (payload) => {
                return !String(payload?.message ?? "").startsWith(this.#SIGNATURE);
            });
        }

        #bindGameListeners() {
            if (this._gameListenersBound) return;
            this._gameListenersBound = true;

            const bind = (event, handler) => {
                new unsafeWindow.Listener(event, handler).bindListener();
            };

            bind("game chat update", ({ messages }) => this.#handleMessages(messages));
            bind("Game Chat Message", (message) => this.#handleMessages([message]));
            bind("answer results", ({ songInfo }) => this.#answerResults(songInfo));
            bind("guess phase over", () => this.#autoSubmit());
            bind("player answers", (payload) => this.#answerReveal(payload));
            bind("quiz ready", () => this.#reset());
            bind("Game Starting", (payload) => this.#handleGameStartOrJoin(payload));
            bind("Join Game", (payload) => this.#handleGameStartOrJoin(payload));
            bind("play next song", () => this.#reset());
        }

        async #handleGameStartOrJoin(payload = {}) {
            this.#patchChatFilters();
            this.#reset();
            this.#rebuildScoreboard();

            const quizState = payload.quizState ?? payload;
            await this.#setupPlayers(quizState ?? {});
            await this.#identifySocket();
        }

        async #setupPlayers({ players } = {}) {
            while (unsafeWindow.quiz?.players === undefined || unsafeWindow.quiz?.players === null) {
                await this.#wait(250);
            }

            const list = Array.isArray(players)
            ? players
            : Object.entries(unsafeWindow.quiz.players ?? {}).map(([id, p]) => ({
                gamePlayerId: id,
                name: p?.name ?? p?.playerName ?? p?.username ?? String(id)
            }));

            // Limpa containers antigos
            this.#playerContainers.forEach((slot) => {
                slot.$songAnswerContainer?.remove?.();
                slot.$artistAnswerContainer?.remove?.();
            });
            this.#playerContainers.clear();
            this.#playerTeams.clear();

            list.forEach(({ gamePlayerId, name }) => {
                const player = unsafeWindow.quiz.players?.[gamePlayerId];
                if (!player) return;

                const team = Number(player.teamNumber ?? 1);
                this.#playerTeams.set(name, team);
                this.#ensurePlayerInScoreboard(name);

                const avatarSlot = player.avatarSlot;
                if (!avatarSlot) return;

                const animeContainer = avatarSlot.$answerContainer?.[0];
                if (!animeContainer) return;

                // Cria display para Song
                const songEl = animeContainer.cloneNode(true);
                songEl.style.top = "20px";
                avatarSlot.$innerContainer[0].appendChild(songEl);
                const $song = $(songEl);
                $song.addClass("hide");
                avatarSlot.$songAnswerContainer = $song;
                avatarSlot.$songAnswerContainerText = $song.find(".qpAvatarAnswerText");

                // Cria display para Artist
                const artistEl = animeContainer.cloneNode(true);
                artistEl.style.top = "60px";
                avatarSlot.$innerContainer[0].appendChild(artistEl);
                const $artist = $(artistEl);
                $artist.addClass("hide");
                avatarSlot.$artistAnswerContainer = $artist;
                avatarSlot.$artistAnswerContainerText = $artist.find(".qpAvatarAnswerText");

                this.#playerContainers.set(name, avatarSlot);
            });

            this.#updateScoreboard();
        }

        #recoverRuntime() {
            this.#patchChatFilters();

            if (!this.#interfaceContainer?.isConnected ||
                !this.#songField?.isConnected ||
                !this.#artistField?.isConnected) {
                this.#interfaceContainer = null;
                this.#songField = null;
                this.#artistField = null;
                this.#setupAnswerArea();
                this.#setupTabNavigation();
            }

            // NOVO: Se o jogo está ativo mas ainda não temos containers de jogador, cria agora
            if (this.#playerContainers.size === 0 && unsafeWindow.quiz?.players) {
                void this.#setupPlayers();
                this.#setupTabNavigation();
                return; // evita checagens desnecessárias logo após a criação
            }

            let uiLost = false;
            this.#playerContainers.forEach((slot) => {
                if (!slot?.$songAnswerContainer?.[0]?.isConnected ||
                    !slot?.$artistAnswerContainer?.[0]?.isConnected) {
                    uiLost = true;
                }
            });
            if (uiLost && unsafeWindow.quiz?.players) void this.#setupPlayers();
        }

        #reset() {
            this.#clearDraftTimers();

            this.#playerHashes.song.clear();
            this.#playerHashes.artist.clear();
            this.#playerHashesLocked.song.clear();
            this.#playerHashesLocked.artist.clear();
            this.#playerAnswers.song.clear();
            this.#playerAnswers.artist.clear();
            this.#pendingReveals.song.clear();
            this.#pendingReveals.artist.clear();
            this.#revealFlushed.song = false;
            this.#revealFlushed.artist = false;

            this.#selfHintedArtists.clear();
            this.#teamHintedArtists.clear();
            this.#selfDetectedArtists = new Set();
            this.#invalidateArtistCache();

            this.#currentSong = "";
            this.#currentArtist = "";

            this.#setupAnswerArea();

            if (this.#songField && this.#artistField) {
                this.#songField.disabled = false;
                this.#artistField.disabled = false;
                this.#songField.value = "";
                this.#artistField.value = "";
            }
            if (this.#hintButton) this.#hintButton.disabled = false;
            this.#renderHintStatus("Hint: -");

            // Limpa avatares
            this.#playerContainers.forEach((slot) => {
                [
                    slot.$songAnswerContainer,
                    slot.$artistAnswerContainer
                ].forEach(($cont, idx) => {
                    if (!$cont?.[0]) return;
                    const $text = idx === 0
                    ? slot.$songAnswerContainerText
                    : slot.$artistAnswerContainerText;

                    $cont[0].classList.add("hide");
                    $cont[0].classList.remove(
                        "wrongAnswer", "rightAnswer",
                        "partialAnswer", "memberCompleteAnswer", "typingAnswer"
                    );
                    if ($text?.[0]) {
                        $text[0].textContent = "";
                        $text[0].classList.remove(
                            "wrongAnswer", "rightAnswer",
                            "partialAnswer", "memberCompleteAnswer", "typingAnswer"
                        );
                    }
                });
            });

            this.#syncHintButtonVisibility();
        }

        // =========================
        // UI: ANSWER INPUTS
        // =========================
        #setupAnswerArea() {
            try {
                const existing = document.getElementById("songartist");
                if (existing?.isConnected) {
                    const songInput = existing.querySelector("#song input");
                    const artistInput = existing.querySelector("#artist input");
                    if (songInput && artistInput) {
                        this.#interfaceContainer = existing;
                        this.#songField = songInput;
                        this.#artistField = artistInput;
                        existing.style.display = this.#enabled ? "" : "none";
                        return true;
                    }
                    existing.remove();
                }

                const answerInput = document.getElementById("qpAnswerInputContainer");
                const parent = document.getElementById("qpAnimeCenterContainer");
                if (!answerInput || !parent) {
                    this.#answerAreaRetry = setTimeout(() => {
                        this.#answerAreaRetry = null;
                        this.#setupAnswerArea();
                    }, 250);
                    return false;
                }

                const container = document.createElement("div");
                container.id = "songartist";

                const createField = (placeholder, id) => {
                    const wrapper = document.createElement("div");
                    wrapper.id = id;
                    const clone = answerInput.cloneNode(true);
                    const input = clone.querySelector("input");
                    input.placeholder = placeholder;
                    input.maxLength = String(150 - this.#SIGNATURE.length - 2);
                    clone.removeChild(clone.childNodes[1]); // remove button
                    wrapper.appendChild(clone);
                    container.appendChild(wrapper);
                    return input;
                };

                this.#songField = createField("Song Name", "song");
                this.#artistField = createField("Artist", "artist");
                parent.appendChild(container);

                this.#interfaceContainer = container;
                container.style.display = this.#enabled ? "" : "none";

                const bindField = (field, kind) => {
                    field.addEventListener("input", () => {
                        applyEmojiShortcodes(field);

                        const text = String(field.value ?? "");

                        if (unsafeWindow.quiz?.teamMode) {
                            this.#playerAnswers[kind].set(unsafeWindow.selfName, text);
                            this.#showPlayerAnswer(unsafeWindow.selfName, text, kind, "typing");
                        }

                        if (kind === "artist") {
                            this.#updateSelfDetectedArtists();
                            this.#renderHintStatusForSender(unsafeWindow.selfName);
                        }

                        this.#queueDraftSend(kind, text);
                    });

                    field.disabled = false;
                    field.value = "";
                };

                bindField(this.#songField, "song");
                bindField(this.#artistField, "artist");
                this.#setupTabNavigation();

                return true;
            } catch (err) {
                throw err;
            }
        }

        #setupTabNavigation() {
            const animeInput = document.getElementById("qpAnswerInput");
            if (!animeInput || !this.#songField || !this.#artistField) return;

            const inputs = [animeInput, this.#songField, this.#artistField];

            const handleTab = (e) => {
                if (e.key === "Tab") {
                    e.preventDefault();
                    e.stopImmediatePropagation(); // impede que outros listeners processem o evento
                    const currentIndex = inputs.indexOf(document.activeElement);
                    const direction = e.shiftKey ? -1 : 1;
                    const nextIndex = (currentIndex + direction + inputs.length) % inputs.length;
                    inputs[nextIndex].focus();
                    inputs[nextIndex].select();
                }
            };

            // Remove listeners antigos (com as mesmas opções de captura)
            for (const input of inputs) {
                input.removeEventListener("keydown", handleTab, { capture: true });
                input.addEventListener("keydown", handleTab, { capture: true });
            }
        }

#toggleSAM = async () => {
    if (this.#updateRequired || this.#updateNoticeShown) {
        this.#enabled = false;
        if (this.#interfaceContainer) this.#interfaceContainer.style.display = "none";
        if (this.#scoreboardElement) this.#scoreboardElement.style.display = "none";
        await this.#announceUpdateRequired();
        return;
    }

    this.#enabled = !this.#enabled;
    if (!this.#enabled) {
        this.#clearDraftTimers();
    } else {
        this.#setupAnswerArea();
        if (unsafeWindow.quiz?.players) {
            await this.#setupPlayers({
                players: Object.entries(unsafeWindow.quiz.players).map(([id, p]) => ({
                    gamePlayerId: id,
                    name: p?.name ?? p?.playerName ?? p?.username ?? String(id)
                }))
            });
        }
    }

    this.#syncHintButtonVisibility();
    if (this.#interfaceContainer) this.#interfaceContainer.style.display = this.#enabled ? "" : "none";
    if (this.#scoreboardElement) this.#scoreboardElement.style.display = this.#enabled ? "block" : "none";

    await new Promise((resolve) => setTimeout(resolve, 50));
    unsafeWindow.gameChat.systemMessage(`S/A: ${this.#enabled ? "✅" : "❌"}`);
};

#setupSAMButton() {
    const $container = $("#qpOptionContainer");
    if (!$container.length) {
        setTimeout(() => this.#setupSAMButton(), 500);
        return;
    }

    if (document.getElementById("qpSAM")) return;

    const $btn = $("<div>", {
        id: "qpSAM",
        class: "clickAble qpOption",
    });

    const el = $btn[0];
    el.style.setProperty("width", "30px", "important");
    el.style.setProperty("height", "30px", "important");
    el.style.setProperty("margin-right", "5px", "important");
    el.style.setProperty("padding", "0", "important");
    el.style.setProperty("display", "flex", "important");
    el.style.setProperty("align-items", "center", "important");
    el.style.setProperty("justify-content", "center", "important");
    el.style.setProperty("box-sizing", "border-box", "important");
    el.style.setProperty("line-height", "1", "important");
    el.style.setProperty("font-weight", "bold", "important");
    el.style.setProperty("font-size", "15px", "important");
    el.style.setProperty("letter-spacing", "0", "important");
    el.style.setProperty("text-align", "center", "important");

    $("<span>", { text: "S/A" })
        .css({
            display: "block",
            width: "100%",
            textAlign: "center",
            lineHeight: "1",
            transform: "translateY(0px)"
        })
        .appendTo($btn);

    $btn.on("click", () => {
        void this.#toggleSAM().catch(() => {});
    }).popover({
        content: "Song/Artist Mode",
        trigger: "hover",
        placement: "bottom"
    });

    $container
        .width((i, w) => w + 35)
        .children("div")
        .append($btn);
}

        // =========================
        // MESSAGE HANDLING
        // =========================
        #handleMessages(messages = []) {
            if (!Array.isArray(messages)) return;
            for (const { message, sender, teamNumber } of messages) {
                const text = String(message ?? "");
                if (sender === unsafeWindow.selfName && text.trim().toLowerCase() === "/sam") {
                    void this.#toggleSAM().catch(() => {});
                    continue;
                }
                if (!text.startsWith(this.#SIGNATURE)) continue;
                this.#processSignedMessage(sender, text.substring(this.#SIGNATURE.length), teamNumber ?? null);
            }
        }

        #processSignedMessage(sender, content, teamNumber = null) {
            const header = content.substring(0, 2);
            const body = content.substring(2);
            const h = this.#HEADERS;

            const actions = {
                [`${h.hint}${h.artist}`]:  () => this.#handleHintArtist(sender, body, teamNumber),
                [`${h.hash}${h.song}`]:    () => this.#playerHashes.song.set(sender, body),
                [`${h.hash}${h.artist}`]:  () => this.#playerHashes.artist.set(sender, body),
                [`${h.reveal}${h.song}`]:   () => this.#handleReveal(sender, body, "song"),
                [`${h.reveal}${h.artist}`]: () => this.#handleReveal(sender, body, "artist"),
                [`${h.team}${h.song}`]:     () => this.#handleTeamReveal(sender, body, "song"),
                [`${h.team}${h.artist}`]:   () => this.#handleTeamReveal(sender, body, "artist"),
                [`${h.preview}${h.song}`]:  () => this.#handleTeamPreview(sender, body, "song"),
                [`${h.preview}${h.artist}`]:() => this.#handleTeamPreview(sender, body, "artist")
            };

            if (actions[header]) actions[header]();
        }

        #handleReveal(sender, content, kind) {
            this.#playerAnswers[kind].set(sender, content);
            this.#pendingReveals[kind].set(sender, content);
            this.#flushPendingReveal(kind);
        }

        #handleTeamReveal(sender, content, kind) {
            this.#playerAnswers[kind].set(sender, content);
            this.#showPlayerAnswer(sender, content, kind);

            if (unsafeWindow.quiz?.teamMode && kind === "artist" && this.#isInMyTeam(sender)) {
                this.#refreshHintUI(unsafeWindow.selfName);
            }
        }

        #handleTeamPreview(sender, content, kind) {
            if (sender === unsafeWindow.selfName) return;

            this.#playerAnswers[kind].set(sender, content);

            if (this.#isInMyTeam(sender)) {
                this.#showPlayerAnswer(sender, content, kind, "typing");
            }

            if (unsafeWindow.quiz?.teamMode && kind === "artist" && this.#isInMyTeam(sender)) {
                this.#refreshHintUI(unsafeWindow.selfName);
            }
        }

        #flushPendingReveal(kind) {
            const pending = this.#pendingReveals[kind];
            const hashes = this.#playerHashes[kind];
            if (this.#revealFlushed[kind] || !pending.size || pending.size < hashes.size) return;

            hashes.forEach((_, player) => {
                if (pending.has(player)) this.#showPlayerAnswer(player, pending.get(player), kind);
            });
            pending.clear();
            this.#revealFlushed[kind] = true;
        }

        // =========================
        // ANSWER SUBMISSION
        // =========================
        #autoSubmit() {
            const song = this.#songField.value.trim();
            const artist = this.#artistField.value.trim();
            if (song && !this.#currentSong) this.#submitAnswer("song", song);
            if (artist && !this.#currentArtist) this.#submitAnswer("artist", artist);
        }

        #submitAnswer(kind, value) {
            const text = String(value ?? "").trim();
            this.#clearDraftTimer(kind);
            if (kind === "artist") this.#updateSelfDetectedArtists();
            this.#saveAnswerHistory(kind, text);

            const header = `${this.#HEADERS.hash}${this.#HEADERS[kind]}`;
            this.#doSubmit(header, text).then(() => {
                if (unsafeWindow.quiz?.teamMode) {
                    const teamMsg = Object.values(unsafeWindow.quiz.players).some(p => p.teamNumber !== 1);
                    this.#sendMessage(
                        this.#SIGNATURE + this.#HEADERS.team + this.#HEADERS[kind] + text,
                        teamMsg
                    );
                }
            });

            if (kind === "song") this.#currentSong = text;
            else this.#currentArtist = text;
        }

        #doSubmit(header, value) {
            const timestamp = Date.now().toString(16).toUpperCase();
            const hash = this.#hash(value, unsafeWindow.selfName, timestamp);
            const message = this.#SIGNATURE + header + hash + timestamp;
            return this.#sendMessage(message);
        }

        #answerReveal() {
            this.#lockAnswers();

            const template = (kind, val) =>
            `${this.#SIGNATURE}${this.#HEADERS.reveal}${this.#HEADERS[kind]}${val}`;

            const song = String(this.#currentSong ?? "").trim();
            const artist = String(this.#currentArtist ?? "").trim();

            if (song) this.#sendMessage(template("song", song));
            if (artist) this.#sendMessage(template("artist", artist));
        }

        #lockAnswers() {
            this.#playerHashesLocked.song = new Map(this.#playerHashes.song);
            this.#playerHashesLocked.artist = new Map(this.#playerHashes.artist);
            this.#songField.disabled = true;
            this.#artistField.disabled = true;
            if (this.#hintButton) this.#hintButton.disabled = true;
        }

    #sendMessage(msg, teamMessage = false) {
    if (this.#updateRequired || this.#updateNoticeShown) return Promise.resolve(false);

    // Tenta socket primeiro
    if (this.#socketServerUrl && this.#transport) {
        try {
            this.#transport.send({ player: unsafeWindow.selfName, message: msg });
            return Promise.resolve(true);
        } catch (e) {
            // fallback
        }
    }

    // Fallback chat
    try {
        if (typeof unsafeWindow.gameChat?.sendMessage === 'function') {
            unsafeWindow.gameChat.sendMessage(msg);
            return Promise.resolve(true);
        }
    } catch (e) {}
    return Promise.resolve(false);
}

        // =========================
        // TEAM DRAFT
        // =========================
        #sendTeamDraft(kind, value) {
            if (!unsafeWindow.quiz?.teamMode) return;
            const text = String(value ?? "");
            if (this.#lastDraftSent[kind] === text) return;
            this.#lastDraftSent[kind] = text;

            this.#playerAnswers[kind].set(unsafeWindow.selfName, text);
            this.#showPlayerAnswer(unsafeWindow.selfName, text, kind, "typing");

            const header = `${this.#HEADERS.preview}${this.#HEADERS[kind]}`;
            this.#sendMessage(this.#SIGNATURE + header + text, true);
        }

        #queueDraftSend(kind, value) {
            if (!unsafeWindow.quiz?.teamMode) return;
            const text = String(value ?? "");
            clearTimeout(this.#draftSendTimer[kind]);
            this.#draftSendTimer[kind] = setTimeout(() => {
                this.#draftSendTimer[kind] = null;
                this.#sendTeamDraft(kind, text);
            }, 10);
        }

        #clearDraftTimer(kind) {
            clearTimeout(this.#draftSendTimer[kind]);
            this.#draftSendTimer[kind] = null;
        }

        #clearDraftTimers() {
            clearTimeout(this.#draftSendTimer.song);
            clearTimeout(this.#draftSendTimer.artist);
            this.#draftSendTimer = { song: null, artist: null };
            this.#lastDraftSent = { song: "", artist: "" };
        }

        // =========================
        // DISPLAY ON AVATARS
        // =========================
        #showPlayerAnswer(player, value, kind, state) {
            const slot = this.#playerContainers.get(player);
            if (!slot) return;
            const $container = kind === "song"
            ? slot.$songAnswerContainer
            : slot.$artistAnswerContainer;
            const $text = kind === "song"
            ? slot.$songAnswerContainerText
            : slot.$artistAnswerContainerText;
            this.#showAnswerOnElement($container, $text, value, state);
        }

        #showAnswerOnElement($container, $text, value, state) {
            if (!$container?.[0] || !$text?.[0]) return;
            const el = $container[0];
            const textEl = $text[0];

            if (value === undefined || value === "") {
                el.classList.add("hide");
            } else {
                el.classList.remove("hide");
            }
            $text.text(value);

            const classMap = {
                true: "rightAnswer",
                false: "wrongAnswer",
                partial: "partialAnswer",
                memberComplete: "memberCompleteAnswer",
                typing: "typingAnswer"
            };

            el.classList.remove(...Object.values(classMap));
            textEl.classList.remove(...Object.values(classMap));

            el.style.removeProperty("color");
            el.style.removeProperty("filter");

            const textStyleProps = [
                "color", "filter", "text-shadow",
                "-webkit-text-stroke", "-webkit-text-fill-color",
                "background-clip", "-webkit-background-clip",
                "opacity", "font-weight", "font-style"
            ];
            for (const prop of textStyleProps) {
                textEl.style.removeProperty(prop);
            }

            if (state !== undefined && classMap[state]) {
                if (state === "partial" || state === "memberComplete") {
                    this.#ensurePartialAnswerStyle();
                }
                textEl.classList.add(classMap[state]);
            }

            unsafeWindow.fitTextToContainer($text, $container, 23, 9);
        }

        #showSong(player, value, state) {
            this.#showPlayerAnswer(player, value, "song", state);
        }

        #showArtist(player, value, state) {
            this.#showPlayerAnswer(player, value, "artist", state);
        }

        // =========================
        // ANSWER RESULTS & SCORING
        // =========================
        #answerResults({ artist, songName }) {
            this.#evaluateAndScore("artist", artist);
            this.#evaluateAndScore("song", songName);
            this.#updateScoreboard();
            this.#invalidateArtistCache();
        }

        #evaluateAndScore(kind, correctValue) {
            const hashes = this.#playerHashes[kind];
            const scores = this.#playerScores[kind];
            const answers = this.#playerAnswers[kind];
            const isSong = kind === "song";
            const teamMode = !!unsafeWindow.quiz?.teamMode;
            const processed = new Map(); // team -> { songs: Set, artists: Set }

            hashes.forEach((_, player) => {
                const answer = String(answers.get(player) ?? correctValue ?? "");
                const team = teamMode ? this.#getPlayerTeamNumber(player) : null;

                if (teamMode) {
                    if (!processed.has(team)) processed.set(team, { songs: new Set(), artists: new Set() });
                }

                if (isSong) {
                    const normalized = this.#normalizeAnswer(answer);
                    const correct = this.#validateSongAnswer(answer);
                    const teamState = teamMode ? processed.get(team) : null;
                    if (correct && (!teamMode || !teamState.songs.has(normalized))) {
                        scores.set(player, (scores.get(player) || 0) + 1);
                        if (teamMode) teamState.songs.add(normalized);
                    }
                    this.#showSong(player, answer, correct);
                } else {
                    this.#scoreArtistAnswer(player, answer, teamMode, processed);
                }
            });
        }

        #scoreArtistAnswer(player, answer, teamMode, processed) {
            const scores = this.#playerScores.artist;
            const evaluation = this.#getArtistAnswerEvaluation(answer);
            const state = evaluation.state;
            const { matchedKeys, satisfiedKeys, clusters } = this.#buildArtistAnswerClusters(answer);

            const hinted = this.#getHintedMap(player);
            const submitTs = this.#getArtistSubmitTimestamp(player);
            const teamState = teamMode ? processed.get(this.#getPlayerTeamNumber(player)) : null;

            let gained = 0;
            const credited = new Set();
            let hasMemberCluster = false;
            let allMemberClustersComplete = true;

            const addCredit = (entry, amount = 1) => {
                const key = this.#getArtistEntryEntityKey(entry);
                if (!key || credited.has(key) || (teamMode && teamState.artists.has(key))) return;
                credited.add(key);
                const hintTs = hinted.get(key);
                const multiplier = (typeof hintTs === "number" && submitTs !== null && hintTs <= submitTs) ? 0.5 : 1;
                gained += amount * multiplier;
                if (teamMode) teamState.artists.add(key);
            };

            for (const cluster of clusters.values()) {
                const result = this.#evaluateArtistCluster(cluster, matchedKeys, satisfiedKeys);
                const realMembers = cluster.members.filter(m => !m.isGroupAlias);

                if (!realMembers.length) {
                    if (result.satisfied) addCredit(cluster.groupPrimary || cluster.primaries[0], 1);
                    continue;
                }

                hasMemberCluster = true;
                if (result.satisfiedRealMembers.length !== realMembers.length) allMemberClustersComplete = false;

                if (result.matchedRealMembers.length) {
                    result.matchedRealMembers.forEach(m => addCredit(m, 1));
                } else if (result.groupMatched || result.matchedGroupAliasMembers.length || result.matchedPrimaries.length) {
                    addCredit(cluster.groupPrimary || cluster.primaries[0], 1);
                }
            }

            if (gained > 0) scores.set(player, (scores.get(player) || 0) + gained);

            const visualAnswer = teamMode ? this.#getTeamMergedArtistAnswer(player) : answer;
            const visualState = teamMode
            ? this.#getArtistAnswerEvaluation(visualAnswer).state
            : state;

            this.#showArtist(player, answer, visualState);
        }

        #getPlayerTeamNumber(sender) {
            const team = Number(this.#playerTeams.get(sender) ?? 1);
            return Number.isFinite(team) ? team : 1;
        }

        #getTeamMembers(sender) {
            const teamNumber = this.#getPlayerTeamNumber(sender);
            const members = [...this.#playerTeams.entries()]
            .filter(([, num]) => Number(num ?? 1) === teamNumber)
            .map(([name]) => name);
            return members.length ? members : [sender];
        }

        #getTeamMergedArtistAnswer(player = unsafeWindow.selfName) {
            if (!unsafeWindow.quiz?.teamMode) {
                return String(this.#artistField?.value ?? "");
            }

            const members = this.#getTeamMembers(player);
            return members
                .map(member => String(this.#playerAnswers.artist.get(member) ?? ""))
                .filter(Boolean)
                .join(" ");
        }

        // =========================
        // HINT SYSTEM
        // =========================
        #getHintScopeKey(player, teamNumber = null) {
            if (unsafeWindow.quiz?.teamMode) {
                const team = Number.isFinite(teamNumber) ? Number(teamNumber) : this.#getPlayerTeamNumber(player);
                return `team:${team}`;
            }
            return `solo:${player ?? unsafeWindow.selfName}`;
        }

        #handleHintArtist(sender, content, teamNumber = null) {
            if (sender === unsafeWindow.selfName) return;

            let data = null;
            try {
                data = JSON.parse(String(content ?? ""));
            } catch {
                data = null;
            }

            const myTeam = this.#getPlayerTeamNumber(unsafeWindow.selfName);
            const senderTeam = Number.isFinite(Number(data?.teamNumber))
            ? Number(data.teamNumber)
            : Number.isFinite(Number(teamNumber))
            ? Number(teamNumber)
            : this.#getPlayerTeamNumber(sender);

            let roundKey = String(data?.roundKey ?? "").trim();
            let artistKey = String(data?.artistKey ?? "").trim();
            const hintTs = Number(data?.hintTs ?? 0) || Date.now();

            if (!roundKey) roundKey = this.#getRoundKey() ?? "";
            if (!artistKey) artistKey = this.#getRemainingHintArtistKey(sender) ?? "";

            if (!roundKey || !artistKey) return;

            this.#applyHint(
                sender,
                roundKey,
                artistKey,
                hintTs,
                unsafeWindow.quiz?.teamMode ? senderTeam === myTeam : false,
                senderTeam
            );
        }

        #useHint(kind = "primary", propagate = true) {
            this.#updateSelfDetectedArtists();

            const candidates = this.#getAvailableHintEntries(kind);
            if (!candidates.length) {
                this.#renderHintStatusForSender(unsafeWindow.selfName, "done ✔️");
                this.#syncHintButtonVisibility();
                return;
            }

            const roundKey = this.#getRoundKey();
            if (!roundKey) {
                this.#renderHintStatus("Hint: sem música atual");
                return;
            }

            const chosen = candidates[0];
            const hintTs = Date.now();
            const teamNumber = unsafeWindow.quiz?.teamMode ? this.#getPlayerTeamNumber(unsafeWindow.selfName) : null;

            this.#applyHint(unsafeWindow.selfName, roundKey, chosen.key, hintTs, true, teamNumber);

            if (propagate) {
                const payload = JSON.stringify({
                    kind,
                    roundKey,
                    artistKey: chosen.key,
                    hintTs,
                    teamNumber
                });

                this.#sendMessage(
                    this.#SIGNATURE + this.#HEADERS.hint + this.#HEADERS.artist + payload
                );
            }
        }

        #isInMyTeam(player) {
            if (!unsafeWindow.quiz?.teamMode) return player === unsafeWindow.selfName;
            return this.#getPlayerTeamNumber(player) === this.#getPlayerTeamNumber(unsafeWindow.selfName);
        }

        #applyHint(player, roundKey, artistKey, hintTs, showStatus = true, teamNumber = null) {
            if (!roundKey || roundKey !== this.#getRoundKey()) return;

            const entry = this.#getArtistEntryByKey(String(artistKey ?? "").trim());
            if (!entry) {
                return;
            }

            const entityKey = this.#getArtistEntryEntityKey(entry);
            if (!entityKey) return;

            const hinted = this.#getHintedMap(player, teamNumber);
            hinted.set(entityKey, Number(hintTs) || Date.now());
            const scope = unsafeWindow.quiz?.teamMode ? `time ${this.#getPlayerTeamNumber(player)}` : player;

            if (showStatus) {
                this.#refreshHintUI(unsafeWindow.quiz?.teamMode ? unsafeWindow.selfName : player);
            } else {
                this.#syncHintButtonVisibility();
            }
        }

        #getHintedMap(player, teamNumber = null) {
            const scopeKey = this.#getHintScopeKey(player, teamNumber);

            if (unsafeWindow.quiz?.teamMode) {
                if (!this.#teamHintedArtists.has(scopeKey)) {
                    this.#teamHintedArtists.set(scopeKey, new Map());
                }
                return this.#teamHintedArtists.get(scopeKey);
            }

            if (!this.#selfHintedArtists.has(scopeKey)) {
                this.#selfHintedArtists.set(scopeKey, new Map());
            }
            return this.#selfHintedArtists.get(scopeKey);
        }

        #getAvailableHintEntries(kind = "primary") {
            const hinted = this.#getHintedMap(unsafeWindow.selfName);

            return this.#getEntriesByKind(kind).filter(entry => {
                if (kind === "member" && entry.isGroupAlias) return false;

                const entityKey = this.#getArtistEntryEntityKey(entry);
                return (
                    entityKey &&
                    !hinted.has(entityKey) &&
                    !this.#selfDetectedArtists.has(entityKey)
                );
            });
        }

        #getRemainingHintArtistKey(sender) {
            const allEntries = this.#buildArtistEntries();
            const hinted = this.#getHintedMap(sender);
            const teamAnswer = this.#getTeamMergedArtistAnswer(sender);
            const solvedEntityKeys = teamAnswer
            ? this.#getDetectedArtistEntityKeys(teamAnswer)
            : new Set();

            const remaining = allEntries.filter(entry => {
                const entityKey = this.#getArtistEntryEntityKey(entry);
                return entityKey && !hinted.has(entityKey) && !solvedEntityKeys.has(entityKey);
            });

            return remaining[0]?.key ?? null;
        }

        #buildHintStatusText(sender, extraSuffix = "") {
            const hinted = this.#getHintedMap(sender);
            const entriesByEntityKey = new Map(
                this.#buildArtistEntries().map(entry => [
                    this.#getArtistEntryEntityKey(entry),
                    entry
                ])
            );

            const labels = [];
            if (hinted) {
                hinted.forEach((_, entityKey) => {
                    const entry = entriesByEntityKey.get(entityKey);
                    if (!entry) return;

                    const isDetected =
                          sender === unsafeWindow.selfName &&
                          this.#selfDetectedArtists.has(entityKey);

                    const label = this.#escapeHtml(this.#formatHintLabel(entry.display));

                    if (isDetected) {
                        labels.push("✅");
                    } else if (entry.isNestedGroup) {
                        labels.push(`<span style="color:#6ad66a;font-weight:bold;">${label}</span>`);
                    } else if (entry.kind === "member") {
                        labels.push(`<span style="color:#73b9ff;">${label}</span>`);
                    } else {
                        labels.push(label);
                    }
                });
            }

            let text = labels.length ? `Hint: ${labels.join(", ")}` : "Hint: -";
            if (extraSuffix) {
                const suffix = this.#escapeHtml(extraSuffix);
                text = text === "Hint: -" ? `Hint: ${suffix}` : `${text}, ${suffix}`;
            }
            return text;
        }

        #renderHintStatusForSender(sender, extraSuffix = "") {
            this.#renderHintStatusHtml(this.#buildHintStatusText(sender, extraSuffix));
        }

        #refreshHintUI(sender = unsafeWindow.selfName, extraSuffix = "") {
            this.#updateSelfDetectedArtists();
            this.#renderHintStatusForSender(sender, extraSuffix);
            this.#syncHintButtonVisibility();
        }

        #getArtistSubmitTimestamp(player) {
            const hash =
                  this.#playerHashes.artist.get(player) ??
                  this.#playerHashesLocked.artist.get(player);
            if (!hash || hash.length <= 16) return null;
            const ts = parseInt(hash.substring(16), 16);
            return Number.isFinite(ts) ? ts : null;
        }

        #updateSelfDetectedArtists() {
            const value = unsafeWindow.quiz?.teamMode
            ? this.#getTeamMergedArtistAnswer(unsafeWindow.selfName)
            : (this.#artistField?.value ?? "");

            this.#selfDetectedArtists = this.#getDetectedArtistEntityKeys(value);
        }

        // =========================
        // HINT UI STATUS
        // =========================
        #renderHintStatus(text = "Hint: -") {
            if (this.#hintStatusElement) this.#hintStatusElement.textContent = text;
        }

        #renderHintStatusHtml(html) {
            if (this.#hintStatusElement) this.#hintStatusElement.innerHTML = html;
        }

        #formatHintLabel(artistName) {
    const initials = String(artistName ?? "")
        .trim()
        .split(" ")
        .filter(Boolean)
        .map(word => word[0])
        .join(" ");
    return initials || artistName;
}

        // =========================
        // SCOREBOARD UI
        // =========================
        #createScoreboard() {
            const existing = document.getElementById("saScoreboard");
            if (existing) {
                this.#scoreboardElement = existing;
                this.#hintButton = existing.querySelector("button[title='Hint']");
                this.#splitHintButton = existing.querySelector("button[title='Members']");
                this.#hintStatusElement = existing.children?.[1] ?? null;
                this.#scoreboardBody =
                    existing.querySelector(".sa-scoreboard-body") ||
                    existing.lastElementChild;

                this.#loadScoreboardPosition();
                this.#syncHintButtonVisibility();

                const header = existing.firstElementChild;
                if (header && !header.__saDraggableBound) {
                    header.__saDraggableBound = true;
                    this.#makeScoreboardDraggable(header);
                }
                if (this.#scoreboardBody) {
                    this.#scoreboardBody.style.display = this.#scoreboardVisible
                        ? "block"
                    : "none";
                }
                existing.style.display = "none";
                return;
            }

            const container = document.createElement("div");
            container.id = "saScoreboard";
            Object.assign(container.style, {
                position: "fixed",
                top: "120px",
                right: "20px",
                width: "260px",
                maxHeight: "500px",
                overflowY: "auto",
                background: "#424242",
                border: "1px solid #666",
                boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
                padding: "10px",
                zIndex: "999999",
                fontSize: "12px",
                color: "#fff",
                borderRadius: "8px"
            });

            const header = document.createElement("div");
            Object.assign(header.style, {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                marginBottom: "10px",
                cursor: "move",
                userSelect: "none"
            });

            const title = document.createElement("div");
            title.textContent = "Song Artist Ranking";
            Object.assign(title.style, {
                fontWeight: "bold",
                flex: "1"
            });

            const buttons = document.createElement("div");
            Object.assign(buttons.style, {
                display: "flex",
                gap: "4px",
                alignItems: "center"
            });

            const hint = document.createElement("button");
            hint.textContent = "💀";
            hint.title = "Hint";
            Object.assign(hint.style, {
                background: "transparent",
                border: "none",
                color: "#fff",
                fontSize: "16px",
                fontWeight: "bold",
                lineHeight: "1",
                padding: "0",
                width: "24px",
                height: "20px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transform: "translateY(2.39px)"
            });
            hint.onclick = () => this.#useHint("primary");

            const splitHint = document.createElement("button");
            splitHint.textContent = "👥";
            splitHint.title = "Members";
            Object.assign(splitHint.style, {
                background: "transparent",
                border: "none",
                color: "#fff",
                fontSize: "16px",
                fontWeight: "bold",
                lineHeight: "1",
                padding: "0",
                width: "24px",
                height: "20px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center"
            });
            splitHint.onclick = () => this.#useHint("member");

            const toggle = document.createElement("button");
            toggle.textContent = "-";
            Object.assign(toggle.style, {
                background: "transparent",
                border: "none",
                color: "#fff",
                fontSize: "20px",
                fontWeight: "bold",
                lineHeight: "1",
                padding: "0",
                width: "20px",
                height: "20px",
                cursor: "pointer"
            });

            const hintStatus = document.createElement("div");
            Object.assign(hintStatus.style, {
                marginBottom: "8px",
                fontSize: "13px",
                lineHeight: "1.25",
                minHeight: "16px"
            });
            hintStatus.textContent = "Hint: -";

            this.#hintButton = hint;
            this.#splitHintButton = splitHint;
            this.#hintStatusElement = hintStatus;

            const body = document.createElement("div");
            body.style.display = this.#scoreboardVisible ? "block" : "none";

            toggle.onclick = () => {
                this.#scoreboardVisible = !this.#scoreboardVisible;
                body.style.display = this.#scoreboardVisible ? "block" : "none";
                toggle.textContent = this.#scoreboardVisible ? "-" : "+";
            };

            buttons.appendChild(hint);
            buttons.appendChild(splitHint);
            buttons.appendChild(toggle);
            header.appendChild(title);
            header.appendChild(buttons);
            container.appendChild(header);
            container.appendChild(hintStatus);
            container.appendChild(body);
            document.body.appendChild(container);
            container.style.display = "none";

            this.#scoreboardElement = container;
            this.#scoreboardBody = body;

            this.#loadScoreboardPosition();
            this.#makeScoreboardDraggable(header);
            this.#syncHintButtonVisibility();
        }

        #updateScoreboard() {
            if (!this.#scoreboardBody) return;

            const oldPositions = {};
            this.#previousRanking.forEach((name, index) => {
                oldPositions[name] = index;
            });

            const rows = [];
            const quizPlayers = Object.values(unsafeWindow.quiz?.players || {});

            if (unsafeWindow.quiz?.teamMode) {
                const teams = new Map();

                quizPlayers.forEach(player => {
                    const teamNumber = Number(player.teamNumber ?? 1);
                    const teamName = `Team ${teamNumber}`;
                    const memberName = player.name || "";

                    if (!teams.has(teamName)) {
                        teams.set(teamName, {
                            name: teamName,
                            members: [],
                            song: 0,
                            artist: 0,
                            total: 0
                        });
                    }
                    const team = teams.get(teamName);
                    const song = Number(this.#playerScores.song.get(memberName) ?? 0);
                    const artist = Number(this.#playerScores.artist.get(memberName) ?? 0);
                    team.members.push(memberName);
                    team.song += song;
                    team.artist += artist;
                    team.total += song + artist;
                });

                rows.push(
                    ...[...teams.values()].sort((a, b) => b.total - a.total)
                );
            } else {
                const names = new Set([
                    ...this.#playerScores.song.keys(),
                    ...this.#playerScores.artist.keys()
                ]);

                names.forEach(name => {
                    const song = Number(this.#playerScores.song.get(name) ?? 0);
                    const artist = Number(this.#playerScores.artist.get(name) ?? 0);
                    rows.push({
                        name,
                        song,
                        artist,
                        total: song + artist
                    });
                });

                rows.sort((a, b) => b.total - a.total);
            }

            this.#previousRanking = rows.map(item => item.name);
            this.#scoreboardBody.innerHTML = "";

            rows.forEach((item, index) => {
                const row = document.createElement("div");
                const oldPos = oldPositions[item.name];

                if (oldPos !== undefined && oldPos > index) {
                    row.animate(
                        [
                            { transform: "translateY(12px)" },
                            { transform: "translateY(0px)" }
                        ],
                        {
                            duration: 300,
                            easing: "ease-out"
                        }
                    );
                }
                row.style.marginBottom = "4px";

                if (unsafeWindow.quiz?.teamMode) {
                    const members = (item.members || [])
                    .filter(Boolean)
                    .sort()
                    .join(", ");
                    if (index === 0) {
                        row.innerHTML =
                            `${index + 1}. <span style="color:#ffd700;font-weight:bold;">${item.name}</span> <span style="font-size:11px;">[${members}]</span> | Total:${item.total} | S:${item.song} A:${item.artist}`;
                    } else {
                        row.textContent =
                            `${index + 1}. ${item.name} [${members}] | Total:${item.total} | S:${item.song} A:${item.artist}`;
                    }
                } else {
                    if (index === 0) {
                        row.innerHTML =
                            `${index + 1}. <span style="color:#ffd700;font-weight:bold;">${item.name}</span> | Total:${item.total} | S:${item.song} A:${item.artist}`;
                    } else {
                        row.textContent =
                            `${index + 1}. ${item.name} | Total:${item.total} | S:${item.song} A:${item.artist}`;
                    }
                }

                this.#scoreboardBody.appendChild(row);
            });

            this.#saveScoreboard();
            this.#syncHintButtonVisibility();
        }

        #ensurePlayerInScoreboard(name) {
            if (!this.#playerScores.song.has(name))
                this.#playerScores.song.set(name, 0);
            if (!this.#playerScores.artist.has(name))
                this.#playerScores.artist.set(name, 0);
            this.#updateScoreboard();
        }

        #rebuildScoreboard() {
            this.#playerScores.song.clear();
            this.#playerScores.artist.clear();
            const names = new Set();
            Object.values(unsafeWindow.quiz.players || {}).forEach(p => names.add(p.name));
            names.forEach(name => {
                this.#playerScores.song.set(name, 0);
                this.#playerScores.artist.set(name, 0);
            });
            this.#playerTeams.clear();
            this.#updateScoreboard();
        }

        #saveScoreboard() {
            const data = {
                song: Object.fromEntries(this.#playerScores.song),
                artist: Object.fromEntries(this.#playerScores.artist)
            };
            localStorage.setItem(this.#SCOREBOARD_KEY, JSON.stringify(data));
        }

        #loadScoreboard() {
            try {
                const raw = localStorage.getItem(this.#SCOREBOARD_KEY);
                if (!raw) return;
                const data = JSON.parse(raw);
                this.#playerScores.song = new Map(
                    Object.entries(data.song || {}).map(([k, v]) => [k, Number(v) || 0])
                );
                this.#playerScores.artist = new Map(
                    Object.entries(data.artist || {}).map(([k, v]) => [k, Number(v) || 0])
                );
            } catch (e) {}
        }

        #saveScoreboardPosition() {
            if (!this.#scoreboardElement) return;
            const rect = this.#scoreboardElement.getBoundingClientRect();
            localStorage.setItem(
                this.#SCOREBOARD_POS_KEY,
                JSON.stringify({
                    left: Math.round(rect.left),
                    top: Math.round(rect.top)
                })
            );
        }

        #loadScoreboardPosition() {
            try {
                const raw = localStorage.getItem(this.#SCOREBOARD_POS_KEY);
                if (!raw || !this.#scoreboardElement) return;
                const pos = JSON.parse(raw);
                if (typeof pos.left === "number" && typeof pos.top === "number") {
                    this.#scoreboardElement.style.left = `${pos.left}px`;
                    this.#scoreboardElement.style.top = `${pos.top}px`;
                    this.#scoreboardElement.style.right = "auto";
                    this.#scoreboardElement.style.bottom = "auto";
                }
            } catch (e) {}
        }

        #makeScoreboardDraggable(handle) {
            const container = this.#scoreboardElement;
            if (!container || !handle) return;

            handle.addEventListener("pointerdown", (event) => {
                if (event.target.closest("button")) return;
                this._draggingScoreboard = true;

                const rect = container.getBoundingClientRect();
                this._dragOffsetX = event.clientX - rect.left;
                this._dragOffsetY = event.clientY - rect.top;

                container.style.left = `${rect.left}px`;
                container.style.top = `${rect.top}px`;
                container.style.right = "auto";
                container.style.bottom = "auto";

                handle.setPointerCapture?.(event.pointerId);
            });

            document.addEventListener("pointermove", (event) => {
                if (!this._draggingScoreboard) return;
                if (!this.#scoreboardElement) return;

                const maxX = unsafeWindow.innerWidth - container.offsetWidth;
                const maxY = unsafeWindow.innerHeight - container.offsetHeight;

                const left = Math.max(0, Math.min(event.clientX - this._dragOffsetX, maxX));
                const top = Math.max(0, Math.min(event.clientY - this._dragOffsetY, maxY));

                container.style.left = `${left}px`;
                container.style.top = `${top}px`;
            });

            document.addEventListener("pointerup", () => {
                if (!this._draggingScoreboard) return;
                this._draggingScoreboard = false;
                this.#saveScoreboardPosition();
            });
        }

        #syncHintButtonVisibility() {
            if (!this.#hintButton) return;

            const hasSongData = !!this.#getSongData();
            const hasGroupMembers = this.#hasGroupMembersForCurrentSong();
            const hintButton = this.#hintButton;

            if (!this.#enabled) {
                hintButton.style.display = "none";
                hintButton.disabled = false;
                if (this.#splitHintButton) {
                    this.#splitHintButton.style.display = "none";
                    this.#splitHintButton.disabled = false;
                }
                return;
            }

            Object.assign(hintButton.style, {
                display: "flex",
                width: "24px",
                height: "20px",
                alignItems: "center",
                justifyContent: "center"
            });
            hintButton.textContent = hasSongData ? "👤" : "💀";
            hintButton.title = hasSongData ? "Hint" : "No database entry";
            hintButton.style.fontSize = hasSongData ? "13.2px" : "16px";
            hintButton.disabled = !hasSongData;
            hintButton.style.opacity = hasSongData ? "1" : "0.5";
            hintButton.style.pointerEvents = hasSongData ? "auto" : "none";

            if (this.#splitHintButton) {
                this.#splitHintButton.style.display = hasGroupMembers ? "" : "none";
                this.#splitHintButton.title = "Members";
                this.#splitHintButton.disabled = false;
            }
        }

        #ensurePartialAnswerStyle() {
            if (document.getElementById("saPartialAnswerStyle")) return;
            const style = document.createElement("style");
            style.id = "saPartialAnswerStyle";
            style.textContent = `
                .partialAnswer {
                    color: rgba(255, 255, 255, 0.60) !important;
                    filter: drop-shadow(0 0 4px rgba(255,255,0,.98))
                            drop-shadow(0 0 14px rgba(255,255,0,.92))
                            drop-shadow(0 0 24px rgba(255,255,0,.72))
                            drop-shadow(0 0 38px rgba(255,255,0,.48));
                }
                .memberCompleteAnswer {
                    filter: drop-shadow(0 0 4px rgba(115,185,255,.95))
                            drop-shadow(0 0 14px rgba(115,185,255,.90))
                            drop-shadow(0 0 24px rgba(115,185,255,.70))
                            drop-shadow(0 0 38px rgba(115,185,255,.45));
                }
                .typingAnswer {
                    color: inherit !important;
                    font-style: normal;
                    opacity: 1;
                }
            `;
            document.head.appendChild(style);
        }

// =========================
// SONG DATA
// =========================
#getVideoList() {
    const player = quizVideoController.getCurrentPlayer();
    if (!player) return [];
    const host = player.videoMap.catbox || player.videoMap.openingsmoe;
    if (!host) return [];
    return [host["720"], host["480"], host["0"]].filter(Boolean);
}

#getSongData() {
    for (const id of this.#getVideoList()) {
        let song = this.#songDb[id] || this.#localDb[id];
        while (typeof song === "string") {
            song = this.#songDb[song] || this.#localDb[song];
        }
        if (song) return song;
    }
    return null;
}

#getRoundKey() {
    return this.#currentSong + "|" + this.#currentArtist;
}

#validateSongAnswer(answer) {
    const song = this.#getSongData();
    if (!song) return false;
    const official = this.#normalizeAnswer(song[1]);
    const player = this.#normalizeAnswer(answer);
    return (
        official === player ||
        official.replace(/\s+/g, "") === player.replace(/\s+/g, "")
    );
}

#saveAnswerHistory(type, value) {
    const normalized = this.#normalizeAnswer(value);
    if (!normalized) return;
    const storage = type === "song" ? this.#answerHistory.songs : this.#answerHistory.artists;
    if (!storage[normalized]) storage[normalized] = { original: value, count: 0 };
    storage[normalized].count++;
    localStorage.setItem(this.#HISTORY_KEY, JSON.stringify(this.#answerHistory));
}

// =========================
// ARTIST PARSING & EVALUATION
// =========================
#getArtistEntryEntityKey(entry) {
    return entry?.entityKey ?? entry?.key ?? null;
}

#getArtistEntryByKey(key) {
    const targetKey = String(key ?? "").trim();
    if (!targetKey) return null;
    return this.#buildArtistEntries().find(entry => entry.key === targetKey) ?? null;
}

#getDetectedArtistEntityKeys(answer) {
    const { matchedEntries, matchedKeys, satisfiedKeys, clusters } =
          this.#buildArtistAnswerClusters(answer);
    const detected = new Set();

    for (const entry of matchedEntries) {
        const entityKey = this.#getArtistEntryEntityKey(entry);
        if (entityKey) detected.add(entityKey);
    }

    for (const cluster of clusters.values()) {
        const groupPrimary = cluster.groupPrimary ?? cluster.primaries[0] ?? null;
        const groupEntityKey = this.#getArtistEntryEntityKey(groupPrimary);
        const realMembers = cluster.members.filter(m => !m.isGroupAlias);
        if (!realMembers.length) continue;

        const matchedReal = realMembers.filter(m => satisfiedKeys.has(m.key));
        const matchedGroupAliases = cluster.members.filter(
            m => m.isGroupAlias && matchedKeys.has(m.key)
        );
        const matchedPrimaries = cluster.primaries.filter(p => matchedKeys.has(p.key));

        const groupDetected =
              Boolean(groupEntityKey) &&
              (matchedPrimaries.length > 0 ||
               matchedGroupAliases.length > 0 ||
               matchedReal.length === realMembers.length);

        if (groupDetected) {
            detected.add(groupEntityKey);
            realMembers.forEach(m => {
                const k = this.#getArtistEntryEntityKey(m);
                if (k) detected.add(k);
            });
            continue;
        }

        matchedReal.forEach(m => {
            const k = this.#getArtistEntryEntityKey(m);
            if (k) detected.add(k);
        });
    }
    return detected;
}

#extractMatchedArtistEntries(answer) {
    const answerWords = this.#normalizeAnswer(answer)
    .split(" ")
    .filter(Boolean);

    if (!answerWords.length) return [];

    return this.#buildArtistEntries().filter(entry =>
                                             this.#artistEntryMatchesAnswer(answerWords, entry)
                                            );
}

#artistEntryMatchesAnswer(answerWords, entry) {
    const answerCollapsed = answerWords.join("");
    const answerCompact = this.#normalizeCompactAnswer(answerWords.join(" "));

    return entry.aliases.some(alias => {
        const aliasRaw = String(alias ?? "");

        const aliasWords = this.#normalizeAnswer(aliasRaw)
        .split(" ")
        .filter(Boolean);

        if (!aliasWords.length) return false;

        const reversedAliasWords = [...aliasWords].reverse();
        const aliasCollapsedWords = String(aliasRaw)
        .trim()
        .split(/\s+/)
        .map(part => this.#normalizeAnswer(part).replace(/\s+/g, ""))
        .filter(Boolean);
        const reversedAliasCollapsedWords = [...aliasCollapsedWords].reverse();

        const aliasCollapsed = aliasCollapsedWords.join("");
        const reversedAliasCollapsed = reversedAliasCollapsedWords.join("");
        const aliasCompact = this.#normalizeCompactAnswer(aliasRaw);
        const isShortAlias = aliasCompact.length <= 2;

        if (isShortAlias) {
            return answerWords.includes(aliasCompact);
        }

        return (
            this.#containsSequence(answerWords, aliasWords) ||
            this.#containsSequence(answerWords, reversedAliasWords) ||
            this.#containsSequence(answerWords, aliasCollapsedWords) ||
            this.#containsSequence(answerWords, reversedAliasCollapsedWords) ||
            answerCollapsed.includes(aliasCollapsed) ||
            answerCollapsed.includes(reversedAliasCollapsed) ||
            answerCompact.includes(aliasCompact)
        );
    });
}

#containsSequence(haystack, needle) {
    if (!needle.length || needle.length > haystack.length) return false;

    for (let i = 0; i <= haystack.length - needle.length; i++) {
        let ok = true;
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) {
                ok = false;
                break;
            }
        }
        if (ok) return true;
    }

    return false;
}

#buildArtistAnswerClusters(answer) {
    const allEntries = this.#buildArtistEntries();
    const matchedEntries = this.#extractMatchedArtistEntries(answer);
    const matchedKeys = new Set(matchedEntries.map(e => e.key));
    const clusters = new Map();

    for (const entry of allEntries) {
        const clusterKey = entry.clusterKey ?? entry.key;
        if (!clusters.has(clusterKey)) {
            clusters.set(clusterKey, {
                groupPrimary: null,
                members: [],
                primaries: []
            });
        }
        const cluster = clusters.get(clusterKey);
        if (entry.kind === "member") {
            cluster.members.push(entry);
        } else {
            cluster.primaries.push(entry);
            if (entry.isGroupPrimary) cluster.groupPrimary = entry;
        }
    }

    const satisfiedKeys = new Set(matchedKeys);
    let changed = true;
    while (changed) {
        changed = false;
        for (const cluster of clusters.values()) {
            const members = cluster.members ?? [];
            for (const entry of members) {
                if (!satisfiedKeys.has(entry.key)) continue;
                const satisfiesMemberSignatures = entry.satisfiesMemberSignatures;
                if (!satisfiesMemberSignatures?.size) continue;
                for (const candidate of members) {
                    if (
                        !satisfiedKeys.has(candidate.key) &&
                        satisfiesMemberSignatures.has(candidate.signature)
                    ) {
                        satisfiedKeys.add(candidate.key);
                        changed = true;
                    }
                }
            }
        }
    }

    return { allEntries, matchedEntries, matchedKeys, satisfiedKeys, clusters };
}

#evaluateArtistCluster(cluster, matchedKeys, satisfiedKeys = matchedKeys) {
    const groupMatched =
          Boolean(cluster.groupPrimary && matchedKeys.has(cluster.groupPrimary.key));

    const realMembers = cluster.members.filter(m => !m.isGroupAlias);
    const groupAliasMembers = cluster.members.filter(m => m.isGroupAlias);

    const matchedRealMembers = realMembers.filter(m => matchedKeys.has(m.key));
    const satisfiedRealMembers = realMembers.filter(m => satisfiedKeys.has(m.key));
    const matchedGroupAliasMembers = groupAliasMembers.filter(m => matchedKeys.has(m.key));
    const matchedPrimaries = cluster.primaries.filter(p => matchedKeys.has(p.key));

    const matched =
          groupMatched ||
          matchedRealMembers.length > 0 ||
          matchedGroupAliasMembers.length > 0 ||
          matchedPrimaries.length > 0;

    let satisfied = false;
    let score = 0;

    if (realMembers.length > 0) {
        const matchedCount = matchedRealMembers.length;

        if (
            groupMatched ||
            matchedGroupAliasMembers.length > 0 ||
            matchedPrimaries.length > 0 ||
            satisfiedRealMembers.length === realMembers.length
        ) {
            satisfied = true;
            score = matchedCount;
        } else if (matchedRealMembers.length > 0) {
            satisfied = false;
            score = matchedCount;
        }
    } else {
        if (
            groupMatched ||
            matchedGroupAliasMembers.length > 0 ||
            matchedPrimaries.length > 0
        ) {
            satisfied = true;
            score = 1;
        }
    }

    return {
        matched,
        satisfied,
        score,
        groupMatched,
        matchedMembers: [...matchedRealMembers, ...matchedGroupAliasMembers],
        matchedRealMembers,
        satisfiedRealMembers,
        matchedGroupAliasMembers,
        matchedPrimaries
    };
}

#getArtistAnswerEvaluation(answer) {
    const { matchedKeys, satisfiedKeys, clusters } =
          this.#buildArtistAnswerClusters(answer);

    if (!clusters.size) return { state: false, score: 0 };

    let anyMatch = false;
    let allSatisfied = true;
    let hasMemberCluster = false;
    let allMembersComplete = true;
    let totalScore = 0;

    for (const cluster of clusters.values()) {
        const result = this.#evaluateArtistCluster(cluster, matchedKeys, satisfiedKeys);

        if (result.matched) anyMatch = true;
        if (!result.satisfied) allSatisfied = false;

        const realMembers = cluster.members.filter(m => !m.isGroupAlias);
        if (!realMembers.length) {
            totalScore += result.score;
            continue;
        }

        hasMemberCluster = true;
        totalScore += result.score;

        if (result.satisfiedRealMembers.length !== realMembers.length)
            allMembersComplete = false;
    }

    if (!anyMatch) return { state: false, score: 0 };
    if (hasMemberCluster && allMembersComplete)
        return { state: "memberComplete", score: totalScore };
    if (allSatisfied) return { state: true, score: totalScore };
    return { state: "partial", score: totalScore };
}

#getEntriesByKind(kind) {
    const entries = this.#buildArtistEntries().filter(entry => entry.kind === kind);
    if (kind !== "member") return entries;

    return entries.sort((a, b) => {
        const aGroup = a.isNestedGroup ? 1 : 0;
        const bGroup = b.isNestedGroup ? 1 : 0;
        return bGroup - aGroup;
    });
}

#hasGroupMembersForCurrentSong() {
    return this.#buildArtistEntries().some(
        entry => entry.kind === "member" && !entry.isGroupAlias
    );
}

#expandAliasTree(aliases, songTitle = "", trail = new Set()) {
    const toAliasList = value =>
    (Array.isArray(value) ? value : [value])
    .map(a => String(a ?? "").trim())
    .filter(Boolean);

    const mergeUniqueAliases = (...lists) => {
        const merged = [];
        const used = new Set();
        for (const list of lists) {
            for (const alias of toAliasList(list)) {
                const norm = this.#normalizeAnswer(alias);
                if (!norm || used.has(norm)) continue;
                used.add(norm);
                merged.push(alias);
            }
        }
        return merged;
    };

    const normalizedSong = this.#normalizeAnswer(songTitle);

    const resolveDefinition = nodeAliases => {
        for (const alias of toAliasList(nodeAliases)) {
            const artistName = String(alias).trim();
            if (!artistName) continue;
            const normArtist = this.#normalizeAnswer(artistName);

            const blocks = this.#artistBaseDb[artistName] ?? this.#artistBaseDb[normArtist] ?? null;
            if (Array.isArray(blocks)) {
                const exact = blocks.find(
                    b =>
                    Array.isArray(b.songs) &&
                    b.songs.some(s => this.#normalizeAnswer(s) === normalizedSong)
                );
                if (exact?.members?.length) return exact.members;
            }

            const groupMembers = this.#groupDb[artistName] ?? this.#groupDb[normArtist] ?? null;
            if (Array.isArray(groupMembers) && groupMembers.length) return groupMembers;
        }
        return null;
    };

    const expand = (nodeAliases, currentTrail = trail) => {
        const nodeList = toAliasList(nodeAliases);
        if (!nodeList.length) return [];

        const normalizedNode = nodeList.map(a => this.#normalizeAnswer(a)).filter(Boolean);
        if (normalizedNode.some(n => currentTrail.has(n))) return [nodeList];

        const nextTrail = new Set(currentTrail);
        normalizedNode.forEach(n => nextTrail.add(n));

        const definition = resolveDefinition(nodeList);
        if (!definition) return [nodeList];

        const definitionList = Array.isArray(definition) ? definition : [definition];
        const nodeSet = new Set(normalizedNode);

        const aliasOnlyDef =
              definitionList.length === 1 &&
              toAliasList(definitionList[0]).some(a => nodeSet.has(this.#normalizeAnswer(a)));

        if (aliasOnlyDef) return [mergeUniqueAliases(nodeList, definitionList[0])];

        const expanded = [nodeList];
        for (const member of definitionList) expanded.push(...expand(member, nextTrail));

        const deduped = [];
        const seen = new Set();
        for (const item of expanded) {
            const itemList = toAliasList(item);
            const signature = itemList
            .map(a => this.#normalizeAnswer(a))
            .sort()
            .join("|");
            if (!signature || seen.has(signature)) continue;
            seen.add(signature);
            deduped.push(itemList);
        }
        return deduped;
    };

    return expand(aliases);
}

#getGroupMembersForCurrentSong() {
    const song = this.#getSongData();
    if (!song) return [];
    const songTitle = String(song[1] ?? "").trim();
    const normalizedSong = this.#normalizeAnswer(songTitle);
    const songGroups = Array.isArray(song[3]) && song[3].length ? song[3] : [[String(song[2] ?? "").trim()]];

    const members = [];
    const seenMembers = new Set();

    for (const aliases of songGroups) {
        const groupAliases = Array.isArray(aliases) ? aliases : [aliases];
        let groupMembers = [];

        for (const alias of groupAliases) {
            const groupName = String(alias).trim();
            if (!groupName) continue;
            const normGroup = this.#normalizeAnswer(groupName);

            const blocks = this.#artistBaseDb[groupName] ?? this.#artistBaseDb[normGroup] ?? null;
            if (Array.isArray(blocks)) {
                const exact = blocks.find(
                    b =>
                    Array.isArray(b.songs) &&
                    b.songs.some(s => this.#normalizeAnswer(s) === normalizedSong)
                );
                if (exact?.members?.length) {
                    groupMembers = exact.members;
                    break;
                }
            }

            groupMembers = this.#groupDb[groupName] ?? this.#groupDb[normGroup] ?? [];
            if (groupMembers.length) break;
        }

        for (const member of groupMembers) {
            const aliases = Array.isArray(member) ? member : [member];
            const key = aliases.map(a => this.#normalizeAnswer(a)).sort().join("|");
            if (seenMembers.has(key)) continue;
            seenMembers.add(key);
            members.push(aliases);
        }
    }

    return members;
}

#buildArtistEntries() {
    const song = this.#getSongData();
    if (!song) return [];

    const entries = [];
    const seen = new Set();

    const toAliasList = value =>
    (Array.isArray(value) ? value : [value])
    .map(a => String(a ?? "").trim())
    .filter(Boolean);

    const mergeUniqueAliases = (...lists) => {
        const merged = [];
        const used = new Set();
        for (const list of lists) {
            for (const alias of toAliasList(list)) {
                const norm = this.#normalizeAnswer(alias);
                if (!norm || used.has(norm)) continue;
                used.add(norm);
                merged.push(alias);
            }
        }
        return merged;
    };

    const getAliasSignature = aliases =>
    toAliasList(aliases)
    .map(a => this.#normalizeAnswer(a))
    .sort()
    .join("|");

    const addEntry = entry => {
        const signature =
              `${entry.clusterKey ?? ""}:${entry.signature ?? getAliasSignature(entry.aliases)}`;
        if (!signature || seen.has(signature)) return;
        seen.add(signature);
        entries.push(entry);
    };

    const songTitle = String(song[1] ?? "").trim();
    const primaryBlocks = Array.isArray(song[3]) && song[3].length
    ? song[3]
    : [[String(song[2] ?? "").trim()]];

    const resolveSoloAliasesForBlock = aliases => {
        const resolved = this.#expandAliasTree(aliases, songTitle);
        return resolved.length === 1 ? resolved[0] : null;
    };

    const resolveMembersForBlock = aliases => {
        const resolved = this.#expandAliasTree(aliases, songTitle);
        return resolved.length > 1 ? resolved : [];
    };

    primaryBlocks.forEach((block, index) => {
        const aliases = toAliasList(block);
        if (!aliases.length) return;

        const blockSignature = aliases
        .map(a => this.#normalizeAnswer(a))
        .sort()
        .join("|");
        const clusterKey = `c:${index}:${blockSignature}`;

        const groupMembersRaw = resolveMembersForBlock(aliases);
        const isGroup = groupMembersRaw.length > 0;
        const soloAliases = !isGroup ? resolveSoloAliasesForBlock(aliases) : null;

        const primaryEntityKey = `${isGroup ? "group" : "solo"}:${index}:${blockSignature}`;
        const entryAliases = soloAliases ? mergeUniqueAliases(aliases, soloAliases) : aliases;

        addEntry({
            key: `p:${index}:${blockSignature}`,
            kind: "primary",
            entityKind: isGroup ? "group" : "solo",
            entityKey: primaryEntityKey,
            clusterKey,
            signature: getAliasSignature(entryAliases),
            display: entryAliases[0],
            aliases: entryAliases,
            isGroupPrimary: isGroup
        });

        const pendingMembers = [];
        const normalizedPrimaryAliases = entryAliases.map(a => this.#normalizeAnswer(a));

        groupMembersRaw.forEach((member, memberIndex) => {
            const memberAliases = toAliasList(member);
            if (!memberAliases.length) return;

            const normalizedAliases = memberAliases
            .map(a => this.#normalizeAnswer(a))
            .filter(Boolean);

            if (!normalizedAliases.length) return;

            const memberSignature = normalizedAliases.slice().sort().join("|");
            const nestedMembersRaw = resolveMembersForBlock(memberAliases);
            const nestedMemberSignatures = new Set(
                nestedMembersRaw.length > 1
                ? nestedMembersRaw
                .slice(1)
                .map(na => getAliasSignature(na))
                .filter(Boolean)
                : []
            );
            const isNestedGroup = nestedMembersRaw.length > 1;

            const isAliasOnlyMember = memberAliases.every(a =>
                                                          normalizedPrimaryAliases.includes(this.#normalizeAnswer(a))
                                                         );
            if (isAliasOnlyMember) return;

            const isGroupAlias = memberAliases.some(a =>
                                                    normalizedPrimaryAliases.includes(this.#normalizeAnswer(a))
                                                   );

            pendingMembers.push({
                key: `m:${index}:${memberIndex}:${memberSignature}`,
                kind: "member",
                entityKind: "member",
                entityKey: `member:${index}:${memberIndex}:${memberSignature}`,
                parentEntityKey: primaryEntityKey,
                clusterKey,
                signature: memberSignature,
                satisfiesMemberSignatures: nestedMemberSignatures,
                group: entryAliases[0],
                display: memberAliases[0],
                aliases: memberAliases,
                normalizedAliases,
                isGroupAlias,
                isNestedGroup,
                isGroupPrimary: false
            });
        });

        pendingMembers
            .sort((a, b) => {
            if (a.normalizedAliases.length !== b.normalizedAliases.length) {
                return a.normalizedAliases.length - b.normalizedAliases.length;
            }
            if (a.isNestedGroup !== b.isNestedGroup) return a.isNestedGroup ? 1 : -1;
            if (a.isGroupAlias !== b.isGroupAlias) return a.isGroupAlias ? 1 : -1;
            return a.signature.localeCompare(b.signature);
        })
            .forEach(candidate => {
            const candidateHead = candidate.normalizedAliases[0] ?? "";
            const candidateSet = new Set(candidate.normalizedAliases);

            const redundant = entries.some(prev => {
                if (prev.clusterKey !== clusterKey || prev.kind !== "member") return false;

                const prevHead =
                      (prev.normalizedAliases?.[0] ?? this.#normalizeAnswer(prev.display ?? "")) || "";
                if (prevHead !== candidateHead) return false;

                const prevNormals = (prev.normalizedAliases ??
                                     (prev.aliases || [])
                                     .map(a => this.#normalizeAnswer(a))
                                     .filter(Boolean));

                return prevNormals.length > 0 && prevNormals.every(n => candidateSet.has(n));
            });

            if (redundant) return;
            addEntry(candidate);
        });
    });

    return entries;
}

#invalidateArtistCache() {
    this.#artistEntryCache.round = "";
    this.#artistEntryCache.entries = [];
    this.#artistClusterCache.round = "";
    this.#artistClusterCache.answer = "";
    this.#artistClusterCache.value = null;
}

// =========================
// UTILITIES
// =========================
#wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

#hash(inputString, sender, timestamp) {
    const norm = this.#normalizeAnswer(inputString);
    const first = this.#hashCode(sender + norm + timestamp + "alphanumeric");
    const reverse = this.#hashCode(
        sender + norm.split("").reverse().join("") + timestamp + "alphanumeric"
    );
    const radix = 16;
    return (first.toString(radix).padEnd(8, "0") + reverse.toString(radix).padEnd(8, "0")).toUpperCase();
}

#hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

#normalizeAnswer(text) {
    return String(text ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\b(feat|featuring|ft)\.?\b/gi, "")
        .replace(/[^\w\s]/g, " ")
        .toLowerCase()
        .replace(/([aeiou])\1/g, "$1")
        .replace(/ou/g, "o")
        .replace(/\s+/g, " ")
        .trim();
}

#normalizeCompactAnswer(text) {
    return String(text ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\b(feat|featuring|ft)\.?\b/gi, "")
        .replace(/[^\w\s]/g, " ")
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/([aeiou])\1/g, "$1")
        .replace(/ou/g, "o")
        .trim();
}

#escapeHtml(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
}

// =========================
// BOOTSTRAP
// =========================
const start = () => {
    if (
        typeof unsafeWindow.Listener === "undefined" ||
        typeof unsafeWindow.socket === "undefined"
    ) {
        setTimeout(start, 5000);
        return;
    }
    unsafeWindow.songArtist = new SongArtistMode();
};
start();
})();