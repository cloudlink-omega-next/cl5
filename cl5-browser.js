/*
    CloudLink 5 Browser SDK (vanilla JS)

    A lightweight, browser-ready wrapper around the CL5 concepts:
    - signaling via WebSocket
    - peer discovery / data connections via PeerJS
    - simple event-based API for HTML pages

    Usage:
      <script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"></script>
      <script src="cl5-browser.js"></script>
      <script>
        const cl5 = new CL5();
        await cl5.connect({ serverUrl, auth });
      </script>
*/

(function (root) {
    'use strict';

    if (typeof window === 'undefined') {
        return;
    }

    const DEFAULT_PEERJS_HOST = '0.peerjs.com';
    const DEFAULT_PEERJS_PORT = 443;
    const DEFAULT_PEERJS_PATH = '/';
    const DEFAULT_PEERJS_KEY = 'peerjs';
    const DEFAULT_KEEPALIVE_INTERVAL = 5000;

    function ensurePeerJS() {
        if (typeof window.Peer === 'undefined') {
            throw new Error('CL5 browser SDK requires PeerJS. Include peerjs before cl5-browser.js.');
        }
    }

    function uuid() {
        return Math.random().toString(36).slice(2, 12);
    }

    class EventEmitter {
        on(event, fn) {
            if (!this._events) this._events = {};
            this._events[event] = this._events[event] || [];
            this._events[event].push(fn);
            return this;
        }

        off(event, fn) {
            if (!this._events || !this._events[event]) return this;
            if (!fn) {
                delete this._events[event];
                return this;
            }
            this._events[event] = this._events[event].filter(f => f !== fn);
            return this;
        }

        emit(event, ...args) {
            if (!this._events || !this._events[event]) return this;
            const listeners = this._events[event].slice();
            for (let i = 0; i < listeners.length; i++) {
                try {
                    listeners[i](...args);
                } catch (e) {
                    console.error(`CL5 listener error [${event}]:`, e);
                }
            }
            return this;
        }
    }

    class Encryption {
        constructor() {
            this.publicKey = '';
            this.keyPair = null;
            this.sharedKeys = new Map();
        }

        hasKeyPair() {
            return !!(this.keyPair && this.keyPair.publicKey && this.keyPair.privateKey);
        }

        async generateKeyPair() {
            if (!window.crypto || !window.crypto.subtle) {
                throw new Error('Web Crypto API is not supported in this browser.');
            }
            this.keyPair = await window.crypto.subtle.generateKey(
                { name: 'ECDH', namedCurve: 'P-256' },
                false,
                ['deriveKey', 'deriveBits']
            );
            this.publicKey = await this.exportPublicKey(this.keyPair.publicKey);
        }

        async exportPublicKey(pubKey) {
            if (!window.crypto || !window.crypto.subtle) {
                throw new Error('Web Crypto API is not supported in this browser.');
            }
            const exportedKey = await window.crypto.subtle.exportKey('spki', pubKey);
            return this.arrayBufferToBase64(new Uint8Array(exportedKey));
        }

        async importPublicKey(exportedKey) {
            if (!window.crypto || !window.crypto.subtle) {
                throw new Error('Web Crypto API is not supported in this browser.');
            }
            const exportedKeyArray = this.base64ToArrayBuffer(exportedKey);
            return await window.crypto.subtle.importKey(
                'spki',
                exportedKeyArray,
                { name: 'ECDH', namedCurve: 'P-256' },
                false,
                []
            );
        }

        async deriveSharedKey(publicKey, id) {
            if (!window.crypto || !window.crypto.subtle) {
                throw new Error('Web Crypto API is not supported in this browser.');
            }
            if (!this.hasKeyPair()) {
                throw new Error('No key pair available. Call generateKeyPair() first.');
            }
            if (!publicKey) {
                throw new Error('A remote public key is required to derive a shared key.');
            }
            const pubkey = await this.importPublicKey(publicKey);
            const shared = await window.crypto.subtle.deriveKey(
                { name: 'ECDH', public: pubkey },
                this.keyPair.privateKey,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
            this.sharedKeys.set(id, shared);
        }

        async encrypt(message, id) {
            if (!window.crypto || !window.crypto.subtle) {
                throw new Error('Web Crypto API is not supported in this browser.');
            }
            const shared = this.sharedKeys.get(id);
            if (!shared) {
                throw new Error('No shared key for "' + id + '". Call deriveSharedKey() first.');
            }
            const encodedMessage = new TextEncoder().encode(message);
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const encryptedMessage = await window.crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                shared,
                encodedMessage
            );
            return [this.arrayBufferToBase64(new Uint8Array(encryptedMessage)), this.arrayBufferToBase64(iv)];
        }

        async decrypt(encryptedMessageBase64, ivBase64, id) {
            if (!window.crypto || !window.crypto.subtle) {
                throw new Error('Web Crypto API is not supported in this browser.');
            }
            const shared = this.sharedKeys.get(id);
            if (!shared) {
                throw new Error('No shared key for "' + id + '". Call deriveSharedKey() first.');
            }
            const encryptedMessageArray = this.base64ToArrayBuffer(encryptedMessageBase64);
            const iv = this.base64ToArrayBuffer(ivBase64);
            const decryptedMessage = await window.crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                shared,
                encryptedMessageArray
            );
            return new TextDecoder().decode(decryptedMessage);
        }

        arrayBufferToBase64(buffer) {
            let binary = '';
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
        }

        base64ToArrayBuffer(base64) {
            const binary_string = window.atob(base64);
            const len = binary_string.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binary_string.charCodeAt(i);
            }
            return bytes.buffer;
        }
    }

    class CL5 extends EventEmitter {
        constructor() {
            super();
            this.ws = null;
            this.peer = null;
            this.connections = new Map();
            this.globalChannels = new Map();
            this.voiceCalls = new Map();
            this.localStreams = new Map();
            this.ringing = new Map();
            this.peerIdMapping = new Map();
            this.peerUsernames = new Map();
            this.peerAccountIds = new Map();
            this.lobbyHost = '';
            this.lobbyList = [];
            this.lobbyInfo = {};
            this.relayPeer = '';
            this.instanceId = '';
            this.userId = '';
            this.username = '';
            this.mode = '';
            this.connected = false;
            this.initialized = false;
            this.hasMicPerms = false;
            this.verbose = false;
            this.keepalive = { state: false, delay: 5 };
            this.iceServers = [];
            this.relayOnly = false;
            this.peerJsSettings = {};
            this._keepaliveTimer = null;
            this.lastDisconnected = '';
            this.lastPrivateMessagePeer = '';
            this.lastPrivateMessageChannel = '';
            this.netIdProxies = new Map();
            this.netIdMeta = new Map();
            this.voiceMeta = new Map();
            this.voiceAudio = new Map();
            this.encryption = new Encryption();
            this.lastErrorMessage = '';
            this.lastPeerError = '';
            this._reconnectEnabled = false;
            this._reconnectAttempts = new Map();
        }

        log(...args) {
            if (this.verbose) console.log('[CL5]', ...args);
        }

        _send(payload) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                throw new Error('Signaling socket is not open.');
            }
            this.ws.send(JSON.stringify(payload));
        }

        _createPeer(id) {
            ensurePeerJS();
            const config = {
                config: {
                    sdpSemantics: 'unified-plan',
                    iceServers: this.iceServers.length ? this.iceServers : [{ urls: 'stun:stun.l.google.com:19302' }]
                }
            };
            if (this.relayOnly) config.config.iceTransportPolicy = 'relay';
            if (this.peerJsSettings.host) {
                const secure = /^wss:/i.test(String(this.peerJsSettings.host));
                const url = new URL(String(this.peerJsSettings.host));
                Object.assign(config, {
                    host: url.hostname,
                    port: url.port || (secure ? 443 : 80),
                    path: url.pathname || '/',
                    secure,
                    key: this.peerJsSettings.key || DEFAULT_PEERJS_KEY,
                    pingInterval: (this.peerJsSettings.pingInterval || DEFAULT_KEEPALIVE_INTERVAL)
                });
            }
            if (typeof this.peerJsSettings.debug !== 'undefined') config.debug = this.peerJsSettings.debug;

            this.peer = new window.Peer(id, config);

            this.peer.on('open', (peerId) => {
                this.log('PeerJS open', peerId);
                this.emit('peerOpen', peerId);
            });

            this.peer.on('connection', (conn) => {
                this.log('Incoming data connection', conn.peer);
                this._setupDataConnection(conn.peer, conn);
            });

            this.peer.on('call', (call) => {
                this.log('Incoming voice call', call.peer);
                this.ringing.set(call.peer, call);
                this.emit('voiceCall', call.peer);
            });

            this.peer.on('disconnected', () => {
                this.log('PeerJS disconnected');
                this.emit('peerDisconnected');
            });

            this.peer.on('close', () => {
                this.log('PeerJS closed');
                this.emit('peerClosed');
            });

            this.peer.on('error', (err) => {
                this.lastErrorMessage = String(err && err.message ? err.message : err);
                this.lastPeerError = String(err && err.peerServerId ? err.peerServerId : '');
                this.emit('error', err);
                this.emit('peerError', this.lastErrorMessage, this.lastPeerError);
                if (this._reconnectEnabled && this.lastPeerError) {
                    this._scheduleReconnect(this.lastPeerError);
                }
            });
        }

        _setupDataConnection(peerId, conn) {
            conn.on('open', () => {
                this.log('Data connection open', peerId);
                this.connections.set(peerId, conn);
                this.emit('peerConnect', peerId);
                if (this.username) {
                    this._sendDirect(peerId, 'default', {
                        opcode: 'USERNAME_INFO',
                        payload: {
                            username: this.username,
                            user_id: this.userId,
                            instance_id: this.instanceId
                        }
                    });
                }
            });

            conn.on('close', () => {
                this.log('Data connection closed', peerId);
                this.connections.delete(peerId);
                this._cleanupChannels(peerId);
                if (this.voiceCalls.has(peerId)) {
                    this.voiceCalls.get(peerId).close();
                }
                this.voiceCalls.delete(peerId);
                this.emit('peerDisconnect', peerId);
            });

            conn.on('error', (err) => {
                this.log('Data connection error', peerId, err);
                this.emit('error', err);
            });

            conn.on('data', (raw) => {
                try {
                    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    this._handleData(peerId, data);
                } catch (e) {
                    this.log('Failed to parse data from', peerId, e);
                }
            });
        }

        _cleanupChannels(peerId) {
            if (!this.connections.has(peerId)) return;
            const conn = this.connections.get(peerId);
            if (!conn.channels) return;
            for (const [name, ch] of conn.channels) {
                try { ch.chan.close(); } catch (e) { /* ignore */ }
            }
            conn.channels.clear();
        }

        _getOrCreateChannels(peerId) {
            if (!this.connections.has(peerId)) return null;
            const conn = this.connections.get(peerId);
            if (!conn.channels) conn.channels = new Map();
            return conn;
        }

        _sendDirect(peerId, channel, payload) {
            const conn = this.connections.get(peerId);
            if (!conn) return Promise.reject(new Error('Peer not connected'));
            if (channel !== 'default') {
                const record = conn.channels && conn.channels.get(channel);
                if (!record || !record.chan || record.chan.readyState !== 'open') {
                    return Promise.reject(new Error('Channel not open'));
                }
                record.chan.send(JSON.stringify(payload));
                return Promise.resolve();
            }
            if (conn.send) {
                conn.send(JSON.stringify(payload));
                return Promise.resolve();
            }
            return Promise.reject(new Error('Connection not ready'));
        }

        _handleData(peerId, data) {
            const opcode = data && data.opcode;
            const payload = data && data.payload;

            if (!opcode) return;

            switch (opcode) {
                case 'USERNAME_INFO':
                    if (payload && payload.username) this.peerUsernames.set(peerId, payload.username);
                    if (payload && payload.user_id) this.peerAccountIds.set(peerId, payload.user_id);
                    if (payload && payload.instance_id && payload.instance_id !== peerId) {
                        this.peerIdMapping.set(payload.instance_id, peerId);
                    }
                    break;

                case 'G_MSG': {
                    const globalChannel = payload && payload.channel ? String(payload.channel) : '';
                    if (globalChannel) {
                        this.globalChannels.set(globalChannel, data.payload);
                    }
                    this.emit('broadcast', globalChannel, data.payload);
                    break;
                }

                case 'P_MSG': {
                    const privateChannel = payload && payload.channel ? String(payload.channel) : '';
                    if (data.payload !== undefined) {
                        const target = this.connections.get(peerId);
                        const record = target && target.channels ? target.channels.get(privateChannel) : null;
                        if (record) record.data = data.payload;
                    }
                    this.lastPrivateMessagePeer = String(peerId);
                    this.lastPrivateMessageChannel = privateChannel;
                    this.emit('message', peerId, privateChannel, data.payload);
                    break;
                }

                case 'NEW_CHAN': {
                    const conn = this.connections.get(peerId);
                    if (!conn || !conn.peerConnection || !payload) break;
                    const id = typeof payload.id === 'number' ? payload.id : 0;
                    const label = String(payload.label || 'channel');
                    const ordered = !!payload.ordered;
                    const channel = conn.peerConnection.createDataChannel(label, { ordered, negotiated: true, id });
                    const record = { chan: channel, data: '' };
                    conn.channels = conn.channels || new Map();
                    conn.channels.set(label, record);
                    channel.onopen = () => this.emit('channelOpen', peerId, label);
                    channel.onclose = () => {
                        conn.channels.delete(label);
                        this.emit('channelClose', peerId, label);
                    };
                    channel.onerror = (err) => this.emit('error', err);
                    channel.onmessage = (event) => {
                        try {
                            const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
                            record.data = msg && msg.payload !== undefined ? msg.payload : event.data;
                        } catch (e) {
                            record.data = event.data;
                        }
                        this.emit('channelData', peerId, label, record.data);
                    };
                    break;
                }

                case 'HANGUP':
                    this._cleanupVoice(peerId);
                    break;

                case 'G_LIST':
                case 'P_LIST':
                case 'G_VAR':
                case 'P_VAR':
                    if (data.payload && data.payload.netId) {
                        this._applyNetState(data.payload.netId, data.payload.operation, data.payload.data);
                    }
                    break;

                default:
                    this.log('Unhandled opcode', opcode, 'from', peerId);
                    break;
            }
        }

        _cleanupVoice(peerId) {
            const call = this.voiceCalls.get(peerId);
            if (call) {
                try { call.close(); } catch (e) { /* ignore */ }
            }
            this.voiceCalls.delete(peerId);
            const stream = this.localStreams.get(peerId);
            if (stream) {
                stream.getTracks().forEach(t => t.stop());
            }
            this.localStreams.delete(peerId);
            this._teardownAudioFlow(peerId);
        }

        _teardownAudioFlow(peerId) {
            const audio = this.voiceAudio.get(peerId);
            if (audio) {
                if (audio.pc && typeof audio.pc.removeEventListener === 'function') {
                    try { audio.pc.removeEventListener('track', audio.onTrack); } catch (e) { /* ignore */ }
                }
                if (audio.audioCtx) {
                    try { audio.audioCtx.close(); } catch (e) { /* ignore */ }
                }
                this.voiceAudio.delete(peerId);
            }
            this.voiceMeta.delete(peerId);
        }

        async _ensureMic(peerId) {
            if (this.localStreams.has(peerId)) {
                this.hasMicPerms = true;
                return;
            }
            let stream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (err) {
                throw new Error('Microphone permission denied: ' + err.message);
            }
            this.hasMicPerms = true;
            this.localStreams.set(peerId, stream);
        }

        async _setupAudioFlow(peerId) {
            if (this.voiceAudio.has(peerId)) return;
            await this._ensureMic(peerId);
            const call = this.voiceCalls.get(peerId);
            if (!call) return;
            const localStream = this.localStreams.get(peerId);
            if (!localStream) return;

            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioCtx.createMediaStreamSource(localStream);
            const dest = audioCtx.createMediaStreamDestination();
            source.connect(dest);
            const onTrack = (event) => {
                const remoteStream = event.streams[0];
                const remoteSource = audioCtx.createMediaStreamSource(remoteStream);
                const panner = audioCtx.createPanner();
                panner.panningModel = 'HRTF';
                panner.distanceModel = 'inverse';
                panner.refDistance = 1;
                panner.maxDistance = 10000;
                panner.rolloffFactor = 1;
                panner.positionX.value = 0;
                panner.positionY.value = 0;
                panner.positionZ.value = 0;
                const gain = audioCtx.createGain();
                gain.gain.value = 1;
                remoteSource.connect(panner).connect(gain).connect(audioCtx.destination);
                this.voiceMeta.set(peerId, { audioCtx, panner, gain });
                this.emit('voiceStream', peerId, remoteStream, { audioCtx, panner, gain });
            };
            const pc = call.peerConnection;
            if (pc && typeof pc.addEventListener === 'function') {
                pc.addEventListener('track', onTrack);
            } else if (pc) {
                pc.ontrack = onTrack;
            }
            this.voiceAudio.set(peerId, { audioCtx, pc, onTrack });
        }

        _resolveCallId(id) {
            const target = String(id);
            if (this.voiceCalls.has(target) || this.ringing.has(target)) {
                return target;
            }
            if (this.peerIdMapping.has(target)) {
                const mapped = this.peerIdMapping.get(target);
                if (this.voiceCalls.has(mapped) || this.ringing.has(mapped)) {
                    return mapped;
                }
            }
            for (const [key, value] of this.peerIdMapping) {
                if (value === target && (this.voiceCalls.has(key) || this.ringing.has(key))) {
                    return key;
                }
            }
            return target;
        }

        async connect({ serverUrl, auth }) {
            if (this.ws) {
                throw new Error('Already connected or connecting.');
            }

            return new Promise((resolve, reject) => {
                try {
                    ensurePeerJS();
                } catch (e) {
                    reject(e);
                    return;
                }

                this.ws = new WebSocket(String(serverUrl));
                this.ws.onopen = async () => {
                    this.log('Signaling WebSocket open');
                    let pubKey;
                    try {
                        pubKey = await this._getOrCreatePublicKey();
                    } catch (e) {
                        this.log('E2EE key pair generation failed', e);
                        this.emit('error', e);
                        reject(e);
                        return;
                    }
                    const initPayload = this._buildInitPayload(auth, pubKey);
                    this._send({ opcode: 'INIT', payload: initPayload });
                    this.emit('signalingOpen');
                };

                this.ws.onmessage = async (event) => {
                    let packet;
                    try {
                        packet = JSON.parse(event.data);
                    } catch (e) {
                        this.log('Invalid signaling packet', event.data);
                        return;
                    }
                    await this._handleSignalingMessage(packet, resolve, reject);
                };

                this.ws.onerror = (err) => {
                    this.log('Signaling error', err);
                    this.emit('error', err);
                    if (!this.initialized) reject(err);
                };

                this.ws.onclose = () => {
                    this.log('Signaling closed');
                    this.connected = false;
                    this.initialized = false;
                    this.emit('signalingClose');
                    if (this.peer) {
                        try { this.peer.destroy(); } catch (e) { /* ignore */ }
                        this.peer = null;
                    }
                    if (this._keepaliveTimer) {
                        clearTimeout(this._keepaliveTimer);
                        this._keepaliveTimer = null;
                    }
                };
            });
        }

        async _handleSignalingMessage(packet, resolve, reject) {
            const opcode = packet.opcode;
            const payload = packet.payload;

            switch (opcode) {
                case 'INIT_OK':
                    this.instanceId = payload.instance_id || '';
                    this.userId = payload.user_id || '';
                    this.username = payload.username || '';
                    this.mode = payload.mode || '';
                    this.peerUsernames.set(this.instanceId, this.username);
                    this.peerAccountIds.set(this.instanceId, this.userId);
                    this._createPeer(this.instanceId);
                    this.connected = true;
                    this.initialized = true;
                    this.emit('open', {
                        instanceId: this.instanceId,
                        userId: this.userId,
                        username: this.username,
                        mode: this.mode
                    });
                    this._startKeepalive();
                    resolve();
                    break;

                case 'WARNING':
                    console.warn('[CL5]', payload);
                    this.emit('warning', payload);
                    break;

                case 'VIOLATION':
                    console.error('[CL5]', payload);
                    this.emit('violation', payload);
                    break;

                case 'PEER_JOIN':
                case 'NEW_PEER':
                    this.peerUsernames.set(payload.instance_id, payload.username);
                    this.peerAccountIds.set(payload.instance_id, payload.user_id);
                    this._connectToPeer(payload.instance_id);
                    break;

                case 'PEER_LEFT':
                    this._disconnectPeerSilent(payload);
                    break;

                case 'NEW_HOST':
                    this.peerUsernames.set(payload.instance_id, payload.username);
                    this.peerAccountIds.set(payload.instance_id, payload.user_id);
                    this.lobbyHost = payload.instance_id;
                    break;

                case 'JOIN_ACK':
                    this.mode = payload && payload.mode ? payload.mode : this.mode;
                    this.emit('joined', payload);
                    break;

                case 'CREATE_ACK':
                    this.lobbyList = [];
                    this.emit('hosted', payload);
                    break;

                case 'TRANSITION':
                    this.mode = payload;
                    this.emit('modeChange', payload);
                    break;

                case 'RELAY':
                    this.relayPeer = payload;
                    this._connectToPeer(payload);
                    break;

                case 'KEEPALIVE_ACK':
                    this._scheduleKeepalive();
                    break;

                case 'LIST_ACK':
                    this.lobbyList = payload || [];
                    this.emit('lobbyList', this.lobbyList);
                    break;

                case 'FIND_ACK':
                    this.lobbyInfo = payload === 'not found' ? {} : payload;
                    this.emit('lobbyInfo', this.lobbyInfo);
                    break;

                case 'NEW_LOBBY':
                    if (payload && !this.lobbyList.includes(payload)) {
                        this.lobbyList.push(payload);
                    }
                    break;

                case 'LOBBY_CLOSED':
                    this.emit('lobbyClosed');
                    break;

                case 'MANAGE_ACK':
                    this.emit('manageAck', payload);
                    break;

                default:
                    this.log('Unhandled signaling opcode', opcode);
                    break;
            }
        }

        async _getOrCreatePublicKey() {
            if (this.encryption.hasKeyPair()) {
                return this.encryption.publicKey;
            }
            await this.encryption.generateKeyPair();
            return this.encryption.publicKey;
        }

        _buildInitPayload(auth, pubKey) {
            const base = { pubkey: pubKey };
            switch ((auth && auth.mode) || 'token') {
                case 'token':
                    return Object.assign(base, { token: auth.token });
                case 'name':
                    return Object.assign(base, { token: 'let me in', username: auth.username });
                case 'cookie':
                default:
                    return base;
            }
        }

        async generateEncryptionKeyPair() {
            return this.encryption.generateKeyPair();
        }

        hasEncryptionKeyPair() {
            return this.encryption.hasKeyPair();
        }

        async deriveSharedKey(publicKey, id) {
            return this.encryption.deriveSharedKey(publicKey, id);
        }

        async encryptMessage(message, id) {
            return this.encryption.encrypt(message, id);
        }

        async decryptMessage(encryptedMessageBase64, ivBase64, id) {
            return this.encryption.decrypt(encryptedMessageBase64, ivBase64, id);
        }

        getClientError() {
            return this.lastErrorMessage;
        }

        getClientErrorPeer() {
            return this.lastPeerError;
        }

        setAutoReconnect(enabled) {
            this._reconnectEnabled = !!enabled;
        }

        _startKeepalive() {
            if (!this.keepalive.state) return;
            if (this.verbose) this.log('Keepalive started');
            this._scheduleKeepalive();
        }

        _scheduleKeepalive() {
            if (this._keepaliveTimer) clearTimeout(this._keepaliveTimer);
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            this._keepaliveTimer = setTimeout(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    if (this.verbose) this.log('Keepalive ping');
                    this._send({ opcode: 'KEEPALIVE', payload: null });
                    this._scheduleKeepalive();
                }
            }, this.keepalive.delay * 1000);
        }

        _connectToPeer(peerId) {
            if (!this.peer || !this.connected) return;
            if (this.connections.has(peerId)) return;
            const conn = this.peer.connect(peerId, { label: 'default', reliable: true });
            conn.on('open', () => {
                if (conn.peer && conn.peer !== peerId) {
                    this.peerIdMapping.set(peerId, conn.peer);
                    if (this.peerUsernames.has(peerId)) {
                        this.peerUsernames.set(conn.peer, this.peerUsernames.get(peerId));
                    }
                    if (this.peerAccountIds.has(peerId)) {
                        this.peerAccountIds.set(conn.peer, this.peerAccountIds.get(peerId));
                    }
                }
            });
            conn.on('error', () => {/* noop */ });
            conn.idCounter = 2;
            conn.channels = new Map();
            this._setupDataConnection(peerId, conn);
        }

        _disconnectPeerSilent(peerId) {
            const conn = this.connections.get(peerId);
            if (conn) {
                try { conn.close(); } catch (e) { /* ignore */ }
            }
            this.connections.delete(peerId);
            this._cleanupChannels(peerId);
            this.voiceCalls.delete(peerId);
            this.ringing.delete(peerId);
            this.lastDisconnected = String(peerId);
            this.emit('peerDisconnect', peerId);
        }

        _scheduleReconnect(peerId) {
            if (this._reconnectAttempts.has(peerId)) return;
            this._reconnectAttempts.set(peerId, 0);
            this.log('Scheduling reconnect for', peerId);
            setTimeout(() => {
                this._reconnectAttempts.delete(peerId);
                if (!this.connected || !this.peer || this.connections.has(peerId)) return;
                this.log('Reconnecting to', peerId);
                this._connectToPeer(peerId);
            }, 1000);
        }

        isSignalingConnected() {
            return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
        }

        isConnected() {
            return !!(this.peer && !this.peer.disconnected && !this.peer.destroyed);
        }

        async disconnect() {
            if (!this.ws) return;
            return new Promise((resolve) => {
                const onClose = () => {
                    this.off('signalingClose', onClose);
                    resolve();
                };
                this.on('signalingClose', onClose);
                this.ws.close();
            });
        }

        destroy() {
            if (this.ws) {
                try { this.ws.close(); } catch (e) { /* ignore */ }
                this.ws = null;
            }
            if (this.peer) {
                try { this.peer.destroy(); } catch (e) { /* ignore */ }
                this.peer = null;
            }
            this.connections.clear();
            this.globalChannels.clear();
            this.voiceCalls.forEach(call => { try { call.close(); } catch (e) { /* ignore */ } });
            this.voiceCalls.clear();
            this.voiceAudio.forEach((audio) => {
                try { audio.pc && audio.pc.removeEventListener && audio.pc.removeEventListener('track', audio.onTrack); } catch (e) { /* ignore */ }
                try { audio.audioCtx && audio.audioCtx.close(); } catch (e) { /* ignore */ }
            });
            this.voiceAudio.clear();
            this.voiceMeta.clear();
            this.localStreams.forEach(stream => stream.getTracks().forEach(t => t.stop()));
            this.localStreams.clear();
            this.ringing.clear();
            this.connected = false;
            this.initialized = false;
        }

        getInstanceId() {
            return this.instanceId;
        }

        getUserId() {
            return this.userId;
        }

        getUsername() {
            return this.username;
        }

        getMode() {
            return this.mode;
        }

        getRelayPeer() {
            return this.relayPeer;
        }

        getLobbyHost() {
            return this.lobbyHost;
        }

        getLobbyList() {
            return this.lobbyList.slice();
        }

        getCachedLobbyInfo() {
            return Object.assign({}, this.lobbyInfo);
        }

        async refreshLobbies() {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                throw new Error('Signaling socket is not open.');
            }
            return new Promise((resolve) => {
                const handler = () => {
                    this.off('lobbyList', handler);
                    resolve();
                };
                this.on('lobbyList', handler);
                this._send({ opcode: 'LIST_LOBBIES', payload: null });
            });
        }

        async getLobbyInfo(name) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                throw new Error('Signaling socket is not open.');
            }
            return new Promise((resolve) => {
                const handler = (info) => {
                    this.off('lobbyInfo', handler);
                    resolve(info);
                };
                this.on('lobbyInfo', handler);
                this._send({ opcode: 'FIND_LOBBY', payload: { name: String(name) } });
            });
        }

        async hostLobby(name, options = {}) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                throw new Error('Signaling socket is not open.');
            }
            return new Promise((resolve) => {
                const handler = (result) => {
                    this.off('hosted', handler);
                    resolve(result);
                };
                this.on('hosted', handler);
                this._send({
                    opcode: 'CREATE_LOBBY',
                    payload: {
                        name: String(name),
                        max_players: options.maxPlayers == null ? -1 : Number(options.maxPlayers),
                        password: String(options.password || ''),
                        locked: !!options.locked,
                        enable_relay: !!options.relay
                    }
                });
            });
        }

        async joinLobby(name, password) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                throw new Error('Signaling socket is not open.');
            }
            return new Promise((resolve) => {
                const handler = (result) => {
                    this.off('joined', handler);
                    resolve(result);
                };
                this.on('joined', handler);
                this._send({
                    opcode: 'JOIN_LOBBY',
                    payload: { name: String(name), password: String(password || '') }
                });
            });
        }

        async closeLobby() {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            return new Promise((resolve) => {
                const handler = () => {
                    this.off('manageAck', handler);
                    resolve();
                };
                this.on('manageAck', handler);
                this._send({ opcode: 'MANAGE_LOBBY', payload: { method: 'close_lobby' } });
            });
        }

        async setLock(locked) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            return new Promise((resolve) => {
                const handler = () => {
                    this.off('manageAck', handler);
                    resolve();
                };
                this.on('manageAck', handler);
                this._send({ opcode: 'MANAGE_LOBBY', payload: { method: locked ? 'lock' : 'unlock' } });
            });
        }

        async setPlayerLimit(limit) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            return new Promise((resolve) => {
                const handler = () => {
                    this.off('manageAck', handler);
                    resolve();
                };
                this.on('manageAck', handler);
                this._send({ opcode: 'MANAGE_LOBBY', payload: { method: 'change_max_players', args: Number(limit) } });
            });
        }

        async setPassword(password) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            return new Promise((resolve) => {
                const handler = () => {
                    this.off('manageAck', handler);
                    resolve();
                };
                this.on('manageAck', handler);
                this._send({ opcode: 'MANAGE_LOBBY', payload: { method: 'change_password', args: String(password) } });
            });
        }

        async kick(peerId) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            return new Promise((resolve) => {
                const handler = () => {
                    this.off('manageAck', handler);
                    resolve();
                };
                this.on('manageAck', handler);
                this._send({ opcode: 'MANAGE_LOBBY', payload: { method: 'kick', args: String(peerId) } });
            });
        }

        async transferOwnership(peerId) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            return new Promise((resolve) => {
                const handler = () => {
                    this.off('manageAck', handler);
                    resolve();
                };
                this.on('manageAck', handler);
                this._send({ opcode: 'MANAGE_LOBBY', payload: { method: 'transfer_ownership', args: String(peerId) } });
            });
        }

        isLobbyHost() {
            return this.mode === 'host' && this.lobbyHost && this.lobbyHost === this.instanceId;
        }

        getPeers() {
            return Array.from(this.connections.keys());
        }

        getAllConnectedPeers() {
            return Array.from(this.connections.entries())
                .filter(([, conn]) => !conn.disconnected)
                .map(([peerId]) => peerId);
        }

        getLastDisconnected() {
            return this.lastDisconnected;
        }

        getLastPrivateMessagePeer() {
            return this.lastPrivateMessagePeer;
        }

        getLastPrivateMessageChannel() {
            return this.lastPrivateMessageChannel;
        }

        getPeerUsername(peerId) {
            if (String(peerId) === String(this.instanceId) && this.username) return this.username;
            if (this.peerUsernames.has(peerId)) return this.peerUsernames.get(peerId);
            const mapped = this.peerIdMapping.get(peerId);
            if (mapped && this.peerUsernames.has(mapped)) return this.peerUsernames.get(mapped);
            for (const [key, value] of this.peerIdMapping) {
                if (value === peerId && this.peerUsernames.has(key)) return this.peerUsernames.get(key);
            }
            return '';
        }

        getPeerAccountId(peerId) {
            if (String(peerId) === String(this.instanceId) && this.userId) return this.userId;
            if (this.peerAccountIds.has(peerId)) return this.peerAccountIds.get(peerId);
            const mapped = this.peerIdMapping.get(peerId);
            if (mapped && this.peerAccountIds.has(mapped)) return this.peerAccountIds.get(mapped);
            for (const [key, value] of this.peerIdMapping) {
                if (value === peerId && this.peerAccountIds.has(key)) return this.peerAccountIds.get(key);
            }
            return '';
        }

        getPeerChannels(peerId) {
            const conn = this.connections.get(peerId);
            if (!conn || !conn.channels) return [];
            return Array.from(conn.channels.keys());
        }

        _createNetId(channel, id) {
            return `${channel}::${id}`;
        }

        makeGlobalNetworkedList({ list, channel, id }, callback) {
            const netId = this._createNetId(channel, id);
            const state = {
                length: 0,
                items: [],
                listeners: new Set()
            };
            const proxy = new Proxy(list, {
                get(target, prop) {
                    if (prop === 'length') return state.length;
                    if (prop === 'items') return state.items;
                    if (prop === 'reset') return () => {
                        state.length = 0;
                        state.items = [];
                        this._broadcastNetState(netId, 'reset', null, channel);
                    };
                    if (prop === 'set') return (index, value) => {
                        state.items[index] = value;
                        state.length = Math.max(state.length, index + 1);
                        this._broadcastNetState(netId, 'set', { index, value }, channel);
                    };
                    if (prop === 'replace') return (index, values) => {
                        values.forEach((v, i) => { state.items[index + i] = v; });
                        state.length = Math.max(state.length, index + values.length);
                        this._broadcastNetState(netId, 'replace', { index, values }, channel);
                    };
                    if (prop === 'append') return (values) => {
                        values.forEach((v) => { state.items.push(v); });
                        state.length = state.items.length;
                        this._broadcastNetState(netId, 'append', { values }, channel);
                    };
                    if (prop === 'delete') return (index, count = 1) => {
                        state.items.splice(index, count);
                        state.length = state.items.length;
                        this._broadcastNetState(netId, 'delete', { index, count }, channel);
                    };
                    return target[prop];
                }
            });
            this.netIdProxies.set(netId, proxy);
            this.netIdMeta.set(netId, { channel, type: 'list', state });
            if (callback) this._bindNetCallback(netId, callback);
            return proxy;
        }

        makePrivateNetworkedList({ list, peer, channel, id }, callback) {
            const netId = this._createNetId(channel, id);
            const state = {
                length: 0,
                items: [],
                listeners: new Set()
            };
            const proxy = new Proxy(list, {
                get(target, prop) {
                    if (prop === 'length') return state.length;
                    if (prop === 'items') return state.items;
                    if (prop === 'reset') return () => {
                        state.length = 0;
                        state.items = [];
                        this._sendNetState(netId, 'reset', null, peer, channel);
                    };
                    if (prop === 'set') return (index, value) => {
                        state.items[index] = value;
                        state.length = Math.max(state.length, index + 1);
                        this._sendNetState(netId, 'set', { index, value }, peer, channel);
                    };
                    if (prop === 'replace') return (index, values) => {
                        values.forEach((v, i) => { state.items[index + i] = v; });
                        state.length = Math.max(state.length, index + values.length);
                        this._sendNetState(netId, 'replace', { index, values }, peer, channel);
                    };
                    if (prop === 'append') return (values) => {
                        values.forEach((v) => { state.items.push(v); });
                        state.length = state.items.length;
                        this._sendNetState(netId, 'append', { values }, peer, channel);
                    };
                    if (prop === 'delete') return (index, count = 1) => {
                        state.items.splice(index, count);
                        state.length = state.items.length;
                        this._sendNetState(netId, 'delete', { index, count }, peer, channel);
                    };
                    return target[prop];
                }
            });
            this.netIdProxies.set(netId, proxy);
            this.netIdMeta.set(netId, { channel, type: 'list', peer, state });
            if (callback) this._bindNetCallback(netId, callback);
            return proxy;
        }

        makeGlobalNetworkedVar({ var: variable, channel, id }, callback) {
            const netId = this._createNetId(channel, id);
            const state = { value: null, listeners: new Set() };
            const proxy = new Proxy(variable, {
                get(target, prop) {
                    if (prop === 'value') return state.value;
                    if (prop === 'set') return (value) => {
                        state.value = value;
                        this._broadcastNetState(netId, 'set', { value }, channel);
                    };
                    if (prop === 'change') return (steps) => {
                        state.value = (state.value || 0) + Number(steps);
                        this._broadcastNetState(netId, 'change', { steps }, channel);
                    };
                    return target[prop];
                }
            });
            this.netIdProxies.set(netId, proxy);
            this.netIdMeta.set(netId, { channel, type: 'var', state });
            if (callback) this._bindNetCallback(netId, callback);
            return proxy;
        }

        makePrivateNetworkedVar({ var: variable, peer, channel, id }, callback) {
            const netId = this._createNetId(channel, id);
            const state = { value: null, listeners: new Set() };
            const proxy = new Proxy(variable, {
                get(target, prop) {
                    if (prop === 'value') return state.value;
                    if (prop === 'set') return (value) => {
                        state.value = value;
                        this._sendNetState(netId, 'set', { value }, peer, channel);
                    };
                    if (prop === 'change') return (steps) => {
                        state.value = (state.value || 0) + Number(steps);
                        this._sendNetState(netId, 'change', { steps }, peer, channel);
                    };
                    return target[prop];
                }
            });
            this.netIdProxies.set(netId, proxy);
            this.netIdMeta.set(netId, { channel, type: 'var', peer, state });
            if (callback) this._bindNetCallback(netId, callback);
            return proxy;
        }

        _broadcastNetState(netId, operation, data, channel) {
            const payload = { netId, operation, data };
            this.broadcast(channel, payload, false).catch(() => {});
        }

        _sendNetState(netId, operation, data, peerId, channel) {
            const payload = { netId, operation, data };
            this.send(peerId, channel, payload, false).catch(() => {});
        }

        _bindNetCallback(netId, callback) {
            const meta = this.netIdMeta.get(netId);
            if (!meta || !meta.state) return;
            meta.state.listeners.add(callback);
        }

        _applyNetState(netId, operation, data) {
            const proxy = this.netIdProxies.get(netId);
            const meta = this.netIdMeta.get(netId);
            if (!proxy || !meta || !meta.state) return;
            if (meta.type === 'list') {
                if (operation === 'reset') {
                    meta.state.length = 0;
                    meta.state.items = [];
                } else if (operation === 'set') {
                    meta.state.items[data.index] = data.value;
                    meta.state.length = Math.max(meta.state.length, data.index + 1);
                } else if (operation === 'replace') {
                    data.values.forEach((v, i) => { meta.state.items[data.index + i] = v; });
                    meta.state.length = Math.max(meta.state.length, data.index + data.values.length);
                } else if (operation === 'append') {
                    meta.state.items.push(...data.values);
                    meta.state.length = meta.state.items.length;
                } else if (operation === 'delete') {
                    meta.state.items.splice(data.index, data.count);
                    meta.state.length = meta.state.items.length;
                }
            } else if (meta.type === 'var') {
                if (operation === 'set') {
                    meta.state.value = data.value;
                } else if (operation === 'change') {
                    meta.state.value = (meta.state.value || 0) + Number(data.steps);
                }
            }
            meta.state.listeners.forEach((cb) => {
                try { cb({ netId, operation, data, target: proxy }); } catch (e) { /* ignore */ }
            });
        }

        isPeerConnected(peerId) {
            const conn = this.connections.get(peerId);
            if (conn) return !conn.disconnected;
            if (this.peerIdMapping.has(peerId)) {
                const mapped = this.peerIdMapping.get(peerId);
                const mappedConn = this.connections.get(mapped);
                if (mappedConn) return !mappedConn.disconnected;
            }
            return false;
        }

        disconnectPeer(peerId) {
            const conn = this.connections.get(peerId);
            if (conn) {
                try { conn.close(); } catch (e) { /* ignore */ }
            }
            this._disconnectPeerSilent(peerId);
        }

        async openChannel(peerId, channel, ordered = true) {
            if (!this.isPeerConnected(peerId)) return;
            const conn = this.connections.get(peerId);
            if (!conn || !conn.peerConnection) return;
            const channels = conn.channels || (conn.channels = new Map());
            if (channels.has(channel)) return;
            const create = () => {
                const id = conn.idCounter++;
                const dataChannel = conn.peerConnection.createDataChannel(channel, { ordered, negotiated: true, id });
                const record = { chan: dataChannel, data: '' };
                channels.set(channel, record);
                dataChannel.onopen = () => this.emit('channelOpen', peerId, channel);
                dataChannel.onclose = () => {
                    channels.delete(channel);
                    this.emit('channelClose', peerId, channel);
                };
                dataChannel.onerror = (err) => this.emit('error', err);
                dataChannel.onmessage = (event) => {
                    try {
                        const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
                        record.data = msg && msg.payload !== undefined ? msg.payload : event.data;
                    } catch (e) {
                        record.data = event.data;
                    }
                    this.emit('channelData', peerId, channel, record.data);
                };
                try {
                    if (conn.send) {
                        conn.send(JSON.stringify({ opcode: 'NEW_CHAN', payload: { id, label: channel, ordered } }));
                    }
                } catch (e) {
                    this.log('Failed to announce channel', peerId, channel, e);
                }
            };
            const lockId = 'mikedevcl5_' + peerId + '_' + channel;
            const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
            if (locks && typeof locks.request === 'function') {
                await locks.request(lockId, { ifAvailable: true }, () => { create(); });
            } else {
                create();
            }
        }

        closeChannel(peerId, channel) {
            const conn = this.connections.get(peerId);
            if (!conn || !conn.channels) return;
            const record = conn.channels.get(channel);
            if (!record) return;
            try { record.chan.close(); } catch (e) { /* ignore */ }
            conn.channels.delete(channel);
        }

        async send(peerId, channel, data, wait = true) {
            if (!this.isPeerConnected(peerId)) return;
            const payload = { opcode: 'P_MSG', payload: data, channel };
            if (wait) {
                await this._sendDirect(peerId, channel, payload);
            } else {
                this._sendDirect(peerId, channel, payload).catch(() => {});
            }
        }

        async broadcast(channel, data, wait = true) {
            const payload = { opcode: 'G_MSG', payload: data, channel };
            if (wait) {
                await Promise.all(this.connections.keys().map((peerId) => this._sendDirect(peerId, channel, payload).catch(() => {})));
            } else {
                this.connections.forEach((_, peerId) => {
                    this._sendDirect(peerId, channel, payload).catch(() => {});
                });
            }
        }

        getChannelData(peerId, channel) {
            const conn = this.connections.get(peerId);
            if (!conn || !conn.channels) return '';
            const record = conn.channels.get(channel);
            return record ? record.data : '';
        }

        getGlobalChannelData(channel) {
            const name = String(channel);
            return this.globalChannels.has(name) ? this.globalChannels.get(name) : '';
        }

        async requestMicrophonePermissions() {
            if (this.hasMicPerms) return;
            await navigator.mediaDevices.getUserMedia({ audio: true })
                .then((stream) => {
                    this.hasMicPerms = true;
                    stream.getTracks().forEach(t => t.stop());
                })
                .catch((err) => {
                    throw new Error('Microphone permission denied: ' + err.message);
                });
        }

        hasMicrophonePermissions() {
            return this.hasMicPerms;
        }

        isVoiceConnected(peerId) {
            const resolved = this._resolveCallId(peerId);
            return this.voiceCalls.has(resolved);
        }

        isRinging(peerId) {
            const resolved = this._resolveCallId(peerId);
            return this.ringing.has(resolved);
        }

        isMicrophoneMuted(peerId) {
            const stream = this.localStreams.get(peerId);
            if (!stream) return false;
            return stream.getAudioTracks().every((track) => !track.enabled);
        }

        setMicrophoneMuted(peerId, muted) {
            const stream = this.localStreams.get(peerId);
            if (!stream) return;
            stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
        }

        _getVoiceMeta(peerId) {
            const resolved = this._resolveCallId(peerId);
            const meta = this.voiceMeta.get(resolved) || this.voiceMeta.get(peerId);
            if (!meta) return null;
            return { resolved, meta };
        }

        getCallX(peerId) {
            const found = this._getVoiceMeta(peerId);
            if (!found) return 0;
            return found.meta.panner.positionX.value;
        }

        setCallX(peerId, x) {
            const found = this._getVoiceMeta(peerId);
            if (!found) return;
            found.meta.panner.positionX.value = Number(x);
        }

        changeCallX(peerId, steps) {
            const found = this._getVoiceMeta(peerId);
            if (!found) return;
            found.meta.panner.positionX.value += Number(steps);
        }

        getCallY(peerId) {
            const found = this._getVoiceMeta(peerId);
            if (!found) return 0;
            return found.meta.panner.positionY.value;
        }

        setCallY(peerId, y) {
            const found = this._getVoiceMeta(peerId);
            if (!found) return;
            found.meta.panner.positionY.value = Number(y);
        }

        changeCallY(peerId, steps) {
            const found = this._getVoiceMeta(peerId);
            if (!found) return;
            found.meta.panner.positionY.value += Number(steps);
        }

        getCallZ(peerId) {
            const found = this._getVoiceMeta(peerId);
            if (!found) return 0;
            return found.meta.panner.positionZ.value;
        }

        setCallZ(peerId, z) {
            const found = this._getVoiceMeta(peerId);
            if (!found) return;
            found.meta.panner.positionZ.value = Number(z);
        }

        changeCallZ(peerId, steps) {
            const found = this._getVoiceMeta(peerId);
            if (!found) return;
            found.meta.panner.positionZ.value += Number(steps);
        }

        getCallVolume(peerId) {
            const found = this._getVoiceMeta(peerId);
            if (!found) return 1;
            return found.meta.gain.gain.value;
        }

        setCallVolume(peerId, volume) {
            const found = this._getVoiceMeta(peerId);
            if (!found) return;
            found.meta.gain.gain.value = Number(volume);
        }

        changeCallVolume(peerId, steps) {
            const found = this._getVoiceMeta(peerId);
            if (!found) return;
            found.meta.gain.gain.value += Number(steps);
        }

        _bindVoiceCall(peerId, call) {
            this.voiceCalls.set(peerId, call);
            call.on('close', () => this._cleanupVoice(peerId));
            call.on('error', (err) => {
                this.log('Voice call error', peerId, err);
                this._cleanupVoice(peerId);
            });
            return call.open === false;
        }

        async callPeer(peerId) {
            if (!this.connected) return;
            await this._ensureMic(peerId);
            const localStream = this.localStreams.get(peerId);
            const call = this.peer.call(peerId, localStream);
            if (!call) return;
            if (this._bindVoiceCall(peerId, call)) return;
            await this._setupAudioFlow(peerId);
            await this._sendDirect(peerId, 'default', { opcode: 'CALL' }).catch(() => {});
        }

        async answerCall(peerId) {
            const call = this.ringing.get(peerId);
            if (!call) return;
            await this._ensureMic(peerId);
            const localStream = this.localStreams.get(peerId);
            this.ringing.delete(peerId);
            if (this._bindVoiceCall(peerId, call)) {
                try { call.close(); } catch (e) { /* ignore */ }
                return;
            }
            call.answer(localStream);
            await this._setupAudioFlow(peerId);
            await this._sendDirect(peerId, 'default', { opcode: 'ANSWER' }).catch(() => {});
        }

        declineCall(peerId) {
            const call = this.ringing.get(peerId);
            if (!call) return;
            try { call.close(); } catch (e) { /* ignore */ }
            this.ringing.delete(peerId);
            this._sendDirect(peerId, 'default', { opcode: 'DECLINE' }).catch(() => {});
        }

        async hangup(peerId) {
            if (!this.voiceCalls.has(peerId)) return;
            await this._sendDirect(peerId, 'default', { opcode: 'HANGUP' }).catch(() => {});
            this._cleanupVoice(peerId);
        }

        setVerbose(level) {
            this.verbose = !!level;
            if (this.peer) this.peer.debug = this.verbose ? 3 : 0;
        }

        setPeerJsServer(settings = {}) {
            this.peerJsSettings = {
                host: String(settings.host || ''),
                key: String(settings.key || ''),
                pingInterval: Number(settings.pingInterval || DEFAULT_KEEPALIVE_INTERVAL)
            };
        }

        addStunServer(url) {
            this.iceServers.push({ urls: String(url) });
        }

        addTurnServer(url, username, password) {
            this.iceServers.push({ urls: String(url), username: String(username), credential: String(password) });
        }

        setRelayOnly(enabled) {
            this.relayOnly = !!enabled;
        }

        setKeepalive(state, delay = 5) {
            this.keepalive = { state: !!state, delay: Number(delay) };
            if (this.connected) {
                if (state) this._startKeepalive();
                else if (this._keepaliveTimer) {
                    clearTimeout(this._keepaliveTimer);
                    this._keepaliveTimer = null;
                }
            }
        }

        async queryLobbies() {
            return this.refreshLobbies();
        }

        async queryLobby(name) {
            return this.getLobbyInfo(name);
        }
    }

    root.CL5 = CL5;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = CL5;
    }
})(typeof window !== 'undefined' ? window : this);
