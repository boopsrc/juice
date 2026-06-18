// Configuration and Setup
const MAP_SIZE = 3000;
const POSITION_SEND_RATE = 45; // ~22 updates per second

// Game state
let isJoined = false;
let socket = null;
let isChatting = false;

// Room state
let currentRoomId = null;
let currentRoomPassword = '';
let currentRoomName = '';

const localPlayer = {
    id: null,
    name: '',
    color: '#00f0ff',
    imageUrl: '', // optional custom image url
    x: MAP_SIZE / 2 + (Math.random() - 0.5) * 300, // spawn around center
    y: MAP_SIZE / 2 + (Math.random() - 0.5) * 300,
    speed: 280, // px per second
    ping: 0
};

let pingInterval = null;

const MAPS = [
    {
        id: 'neon', name: 'Neon Grid',
        bg: '#080a10', grid: 'rgba(0, 240, 255, 0.025)', border: '#00f0ff', glow: '#ff007f',
        obstacles: [
            // Four small corner pillars
            { x: 300, y: 300, w: 100, h: 100 },
            { x: 1600, y: 300, w: 100, h: 100 },
            { x: 300, y: 1600, w: 100, h: 100 },
            { x: 1600, y: 1600, w: 100, h: 100 },
            // Two central barriers
            { x: 800, y: 950, w: 400, h: 100 }
        ]
    },
    {
        id: 'lava', name: 'Lava Pit',
        bg: '#1a0505', grid: 'rgba(255, 50, 0, 0.05)', border: '#ff3300', glow: '#ff9900',
        obstacles: [
            // Central lava island (safe zone cover)
            { x: 800, y: 800, w: 400, h: 400 },
            // Surrounding bridges/platforms
            { x: 400, y: 900, w: 200, h: 200 },
            { x: 1400, y: 900, w: 200, h: 200 },
            { x: 900, y: 400, w: 200, h: 200 },
            { x: 900, y: 1400, w: 200, h: 200 }
        ]
    },
    {
        id: 'ice', name: 'Ice Cavern',
        bg: '#05101a', grid: 'rgba(0, 150, 255, 0.05)', border: '#00aaff', glow: '#00ffff',
        obstacles: [
            // Narrow icy corridors
            { x: 200, y: 400, w: 700, h: 100 },
            { x: 1100, y: 400, w: 700, h: 100 },
            { x: 200, y: 1500, w: 700, h: 100 },
            { x: 1100, y: 1500, w: 700, h: 100 },
            { x: 950, y: 700, w: 100, h: 600 },
            { x: 500, y: 800, w: 100, h: 400 },
            { x: 1400, y: 800, w: 100, h: 400 }
        ]
    },
    {
        id: 'forest', name: 'Cyber Forest',
        bg: '#051a0a', grid: 'rgba(50, 255, 50, 0.05)', border: '#33ff33', glow: '#aaff00',
        obstacles: [
            // Many scattered "trees"
            { x: 300, y: 300, w: 150, h: 150 }, { x: 800, y: 250, w: 150, h: 150 }, { x: 1500, y: 300, w: 150, h: 150 },
            { x: 400, y: 800, w: 150, h: 150 }, { x: 1400, y: 800, w: 150, h: 150 },
            { x: 300, y: 1500, w: 150, h: 150 }, { x: 900, y: 1450, w: 150, h: 150 }, { x: 1500, y: 1500, w: 150, h: 150 },
            { x: 900, y: 900, w: 200, h: 200 } // Big world tree
        ]
    },
    {
        id: 'arena', name: 'Deathmatch Arena',
        bg: '#101010', grid: 'rgba(255, 255, 255, 0.05)', border: '#ffffff', glow: '#888888',
        obstacles: [
            // Outer cover walls
            { x: 600, y: 400, w: 100, h: 1200 },
            { x: 1300, y: 400, w: 100, h: 1200 },
            { x: 400, y: 600, w: 1200, h: 100 },
            { x: 400, y: 1300, w: 1200, h: 100 },
            // Central cover
            { x: 850, y: 850, w: 300, h: 300 }
        ]
    }
];
let currentMapIndex = 0;

const players = {}; // stores all player states: { id: { id, name, color, imageUrl, x, y, targetX, targetY, chatBubble } }
const camera = { x: 0, y: 0 };

const trails = {}; // playerId -> [{ x, y, t }]
const trailLastSample = {};

const TRAIL = {
    SPACING: 14,
    MAX_AGE: 1750,
    BASE_ALPHA: 0.34,
    WIDTH: 13,
    MAX_POINTS: 90,
    JITTER: 4,
    WOBBLE_STEP: 10
};

// Key states
const keys = {
    w: false,
    a: false,
    s: false,
    d: false,
    ArrowUp: false,
    ArrowDown: false,
    ArrowLeft: false,
    ArrowRight: false
};

// WebRTC variables
let localStream = null;
let isMicEnabled = false;
const peerConnections = {}; // peerId -> RTCPeerConnection
const pendingCandidates = {}; // peerId -> ICE candidates received before remote description set
const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // Free TURN servers for NAT traversal (essential for cross-network connections)
    {
        urls: 'turn:a.relay.metered.ca:80',
        username: 'e8dd65b92f4591b0f3a6e3b0',
        credential: '3JMoSwFfbZigSiMy'
    },
    {
        urls: 'turn:a.relay.metered.ca:80?transport=tcp',
        username: 'e8dd65b92f4591b0f3a6e3b0',
        credential: '3JMoSwFfbZigSiMy'
    },
    {
        urls: 'turn:a.relay.metered.ca:443',
        username: 'e8dd65b92f4591b0f3a6e3b0',
        credential: '3JMoSwFfbZigSiMy'
    },
    {
        urls: 'turns:a.relay.metered.ca:443?transport=tcp',
        username: 'e8dd65b92f4591b0f3a6e3b0',
        credential: '3JMoSwFfbZigSiMy'
    }
];

// Web Audio API context for real-time speaking/volume detection
let audioContext = null;
const speechDetectors = {}; // peerId -> { analyser, dataArray, source }

// Sound effects
const collisionSound = new Audio('slide-release-2.mp3');
collisionSound.volume = 0.5;

function playCollisionSound() {
    try {
        const sound = collisionSound.cloneNode();
        sound.volume = 0.5;
        sound.play().catch(err => {
            console.warn('[Sound] Collision sound play blocked by browser policy:', err);
        });
    } catch (e) {
        console.warn('[Sound] Error playing collision sound:', e);
    }
}

const shotSound = new Audio('shot-3.mp3');
shotSound.volume = 0.5;

function playShotSound() {
    try {
        const sound = shotSound.cloneNode();
        sound.volume = 0.5;
        sound.play().catch(err => {
            console.warn('[Sound] Shot sound play blocked by browser policy:', err);
        });
    } catch (e) {
        console.warn('[Sound] Error playing shot sound:', e);
    }
}

const joinSound = new Audio('hsstroke.wav');
joinSound.volume = 0.5;

function playJoinSound() {
    try {
        const sound = joinSound.cloneNode();
        sound.volume = 0.5;
        sound.play().catch(err => {
            console.warn('[Sound] Join sound play blocked by browser policy:', err);
        });
    } catch (e) {
        console.warn('[Sound] Error playing join sound:', e);
    }
}

// Background Music setup
const bgMusic = new Audio('loop_cminor_124bpm.wav');
bgMusic.loop = true;
bgMusic.volume = 0.2; // 20% of total volume
let isMusicPlaying = true;


const activeCollisions = new Set();

const SPATIAL_AUDIO = {
    FULL_VOLUME_RANGE: 300,
    FADE_DISTANCE: 700,
    SMOOTHING: 0.08
};

function initAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log('[AudioAnalysis] AudioContext initialized.');
    }
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().then(() => {
            console.log('[AudioAnalysis] AudioContext resumed successfully.');
        });
    }
}

function setupAudioAnalysis(peerId, stream) {
    try {
        initAudioContext();
        console.log(`[AudioAnalysis] Setting up volume detection for: ${peerId}`);
        cleanupAudioAnalysis(peerId);
        
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        
        // Do not connect to destination (speakers) here to prevent duplicate playback and echo,
        // as the HTML5 <audio> element is unmuted and plays the sound directly.
        if (peerId !== 'local') {
            console.log(`[AudioAnalysis] Remote peer ${peerId} stream is analyzed (sound played by HTML5 audio element).`);
        }
        
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        speechDetectors[peerId] = {
            analyser,
            dataArray,
            source
        };
    } catch (err) {
        console.error(`[AudioAnalysis] Failed to setup volume detection for ${peerId}:`, err);
    }
}

function cleanupAudioAnalysis(peerId) {
    if (speechDetectors[peerId]) {
        try {
            speechDetectors[peerId].source.disconnect();
        } catch (e) {}
        delete speechDetectors[peerId];
        console.log(`[AudioAnalysis] Cleaned up volume detection for: ${peerId}`);
    }
}

function updateAudioSpeakingStates() {
    if (!audioContext) return;
    
    for (const peerId in speechDetectors) {
        const det = speechDetectors[peerId];
        det.analyser.getByteFrequencyData(det.dataArray);
        
        // Sum frequencies to get average power/volume
        let sum = 0;
        for (let i = 0; i < det.dataArray.length; i++) {
            sum += det.dataArray[i];
        }
        const average = sum / det.dataArray.length;
        
        // Speech threshold: if average frequency amplitude is > 10, player is talking
        const isSpeaking = average > 10;
        
        const targetId = (peerId === 'local') ? localPlayer.id : peerId;
        if (targetId && players[targetId]) {
            players[targetId].isSpeaking = isSpeaking;
        }
    }
}

// WebRTC microphone icon vector drawing
function drawMicrophoneIcon(ctx, x, y, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // Mic capsule (inner vertical pill)
    ctx.beginPath();
    ctx.roundRect(-2.5, -6, 5, 8, 2.5);
    ctx.fill();
    
    // Outer U-stand
    ctx.beginPath();
    ctx.arc(0, -2, 4.5, 0, Math.PI, false);
    ctx.stroke();
    
    // Stand base stem
    ctx.beginPath();
    ctx.moveTo(0, 2.5);
    ctx.lineTo(0, 5);
    ctx.stroke();
    
    // Stand base horizontal plate
    ctx.beginPath();
    ctx.moveTo(-3, 5);
    ctx.lineTo(3, 5);
    ctx.stroke();
    
    ctx.restore();
}

// Custom Avatar Image Cache
const avatarImageCache = {};

function getOrLoadAvatarImage(url) {
    if (!url) return null;
    if (avatarImageCache[url]) {
        return avatarImageCache[url];
    }
    const img = new Image();
    img.crossOrigin = 'anonymous'; // support CORS images
    img.src = url;
    img.loaded = false;
    img.onload = () => {
        img.loaded = true;
        console.log(`[ImageCache] Successfully loaded: ${url}`);
    };
    img.onerror = () => {
        img.loaded = false;
        img.error = true;
        console.error(`[ImageCache] Failed to load image: ${url}`);
    };
    avatarImageCache[url] = img;
    return img;
}

// Canvas elements
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// HTML UI Elements — Setup Screen
const setupScreen = document.getElementById('setup-screen');
const setupForm = document.getElementById('setup-form');
const usernameInput = document.getElementById('username');
const lobbyImageUrlInput = document.getElementById('avatar-image-url');
const btnNextLobby = document.getElementById('btn-next-lobby');

// HTML UI Elements — Room Lobby Screen
const roomLobby = document.getElementById('room-lobby');
const btnBackSetup = document.getElementById('btn-back-setup');
const createRoomForm = document.getElementById('create-room-form');
const roomNameInput = document.getElementById('room-name-input');
const roomPrivateToggle = document.getElementById('room-private-toggle');
const roomPasswordRow = document.getElementById('room-password-row');
const roomPasswordInput = document.getElementById('room-password-input');
const btnCreateRoom = document.getElementById('btn-create-room');
const btnRefreshRooms = document.getElementById('btn-refresh-rooms');
const roomListContainer = document.getElementById('room-list');

// Password Modal
const passwordModal = document.getElementById('password-modal');
const modalPasswordInput = document.getElementById('modal-password-input');
const btnModalCancel = document.getElementById('btn-modal-cancel');
const btnModalEnter = document.getElementById('btn-modal-enter');
let pendingJoinRoomId = null; // Room ID waiting for password

// HTML UI Elements — Game HUD
const btnToggleMic = document.getElementById('btn-toggle-mic');
const voiceStatus = document.getElementById('voice-status');
const voiceIndicator = document.getElementById('voice-indicator');
const btnUpdateImage = document.getElementById('btn-update-image');
const hudImageUrlInput = document.getElementById('hud-image-url');
const btnToggleMusic = document.getElementById('btn-toggle-music');
const btnCopyInvite = document.getElementById('btn-copy-invite');
const btnLeaveRoom = document.getElementById('btn-leave-room');
const hudRoomName = document.getElementById('hud-room-name');

// Show secure context warning if WebRTC microphone access is blocked by browser policies
if (!window.isSecureContext) {
    const warningBanner = document.getElementById('secure-context-warning');
    if (warningBanner) {
        warningBanner.classList.remove('hidden');
    }
}

// Color Picker logic
let selectedColor = '#00f0ff';
const swatches = document.querySelectorAll('.color-swatch');
const customColorInput = document.getElementById('custom-color');
const customColorWrapper = document.querySelector('.custom-color-picker-wrapper');

swatches.forEach(swatch => {
    swatch.addEventListener('click', () => {
        swatches.forEach(s => s.classList.remove('active'));
        customColorWrapper.classList.remove('active');
        
        swatch.classList.add('active');
        selectedColor = swatch.getAttribute('data-color');
    });
});

customColorInput.addEventListener('input', (e) => {
    swatches.forEach(s => s.classList.remove('active'));
    customColorWrapper.classList.add('active');
    selectedColor = e.target.value;
});

// Setup WebSocket Connection
function connectWebSocket(roomId, password) {
    if (!roomId) {
        console.error('[Socket] Cannot connect without a room ID');
        return;
    }
    currentRoomId = roomId;
    currentRoomPassword = password || '';

    const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    let wsUrl = protocol + window.location.host + '/ws?room=' + encodeURIComponent(roomId);
    if (password) {
        wsUrl += '&pwd=' + encodeURIComponent(password);
    }
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log('[Socket] Connection established.');
        
        // Start ping interval
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    type: 'ping',
                    payload: { timestamp: Date.now() }
                }));
            }
        }, 2000);
    };

    socket.onclose = () => {
        console.warn('[Socket] Connection lost. Reconnecting in 3 seconds...');
        isJoined = false;
        
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }

        // Cleanup all peer connections on disconnect
        for (const peerId in peerConnections) {
            peerConnections[peerId].close();
            delete peerConnections[peerId];
            cleanupAudioAnalysis(peerId);
        }
        for (const peerId in pendingCandidates) {
            delete pendingCandidates[peerId];
        }
        document.querySelectorAll('audio').forEach(el => el.remove());
        
        // Show lobby screen again
        document.getElementById('game-container').classList.add('hidden');
        roomLobby.classList.remove('hidden');
        fetchRooms();
    };

    socket.onerror = (error) => {
        console.error('[Socket] Error:', error);
    };

    function teleportToSafeZone(mapIndex) {
        const map = MAPS[mapIndex];
        if (!map.obstacles || map.obstacles.length === 0) return;

        const r = 20;
        let inObstacle = false;
        
        // Check if currently inside any obstacle
        for (const obs of map.obstacles) {
            if (localPlayer.x + r > obs.x && localPlayer.x - r < obs.x + obs.w &&
                localPlayer.y + r > obs.y && localPlayer.y - r < obs.y + obs.h) {
                inObstacle = true;
                break;
            }
        }

        if (inObstacle) {
            console.log('[Map] Player stuck in obstacle, teleporting to safe zone...');
            let found = false;
            for (let i = 0; i < 200; i++) {
                const rx = 100 + Math.random() * (MAP_SIZE - 200);
                const ry = 100 + Math.random() * (MAP_SIZE - 200);
                let clear = true;
                for (const obs of map.obstacles) {
                    if (rx + r > obs.x && rx - r < obs.x + obs.w &&
                        ry + r > obs.y && ry - r < obs.y + obs.h) {
                        clear = false;
                        break;
                    }
                }
                if (clear) {
                    localPlayer.x = rx;
                    localPlayer.y = ry;
                    found = true;
                    break;
                }
            }
            if (!found) {
                localPlayer.x = 50;
                localPlayer.y = 50;
            }
            syncPosition();
        }
    }

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        const data = msg.payload;
        console.log(`[WS Recv] type: ${msg.type}`, data);

        switch (msg.type) {
            case 'welcome':
                localPlayer.id = data.id;
                console.log(`[Welcome] Assigned ID: ${localPlayer.id}`);
                
                // Clear and repopulate existing players
                for (const key in players) delete players[key];
                clearAllTrails();
                
                if (data.players) {
                    for (const id in data.players) {
                        if (id === localPlayer.id) continue;
                        const p = data.players[id];
                        players[id] = {
                            id: p.id,
                            name: p.name,
                            color: p.color,
                            imageUrl: p.imageUrl || '',
                            x: p.x,
                            y: p.y,
                            targetX: p.x,
                            targetY: p.y,
                            chatBubble: null,
                            ping: p.ping || 0
                        };
                        
                        // Prefetch avatar image
                        if (p.imageUrl) {
                            getOrLoadAvatarImage(p.imageUrl);
                        }

                        // Initiate WebRTC peer connection
                        createPeerConnection(id);
                    }
                }
                
                // Update room name in HUD
                if (data.roomName) {
                    currentRoomName = data.roomName;
                    hudRoomName.innerText = data.roomName;
                }
                if (data.roomId) {
                    currentRoomId = data.roomId;
                }
                if (data.currentMap !== undefined) {
                    currentMapIndex = data.currentMap % MAPS.length;
                    hudRoomName.innerText = `${currentRoomName} - ${MAPS[currentMapIndex].name}`;
                    document.body.style.backgroundColor = MAPS[currentMapIndex].bg;
                    teleportToSafeZone(currentMapIndex);
                }
                break;

            case 'change_map':
                if (data.mapId !== undefined) {
                    currentMapIndex = data.mapId % MAPS.length;
                    hudRoomName.innerText = `${currentRoomName} - ${MAPS[currentMapIndex].name}`;
                    document.body.style.backgroundColor = MAPS[currentMapIndex].bg;
                    playJoinSound(); // Little beep to signify map change
                    teleportToSafeZone(currentMapIndex);
                }
                break;

            case 'join':
                console.log(`[Join] Player entered: ${data.name} (${data.id})`);
                
                const isNewPlayer = !players[data.id];
                
                if (data.id !== localPlayer.id && isNewPlayer) {
                    playJoinSound();
                }
                
                players[data.id] = {
                    id: data.id,
                    name: data.name,
                    color: data.color,
                    imageUrl: data.imageUrl || '',
                    x: data.x,
                    y: data.y,
                    targetX: data.x,
                    targetY: data.y,
                    chatBubble: null,
                    ping: data.ping || 0
                };

                // Prefetch avatar image
                if (data.imageUrl) {
                    getOrLoadAvatarImage(data.imageUrl);
                }

                updatePlayersHUD();

                // If this is a remote player and they just entered, hook up WebRTC
                if (data.id !== localPlayer.id && isNewPlayer) {
                    createPeerConnection(data.id);
                }
                break;

            case 'move':
                if (data.id !== localPlayer.id) {
                    const p = players[data.id];
                    if (p) {
                        p.targetX = data.x;
                        p.targetY = data.y;
                    }
                }
                break;

            case 'chat':
                console.log(`[Chat] Message received for: ${data.id} -> "${data.message}"`);
                const sender = players[data.id];
                if (sender) {
                    sender.chatBubble = {
                        text: data.message,
                        timer: 5.0 // display message above head for 5 seconds
                    };
                }
                if (data.message && data.message.trim().toLowerCase() === '/tiro') {
                    playShotSound();
                }
                break;

            case 'signal':
                if (data.from && data.signal) {
                    handleSignal(data.from, data.signal);
                }
                break;

            case 'ping':
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({
                        type: 'pong',
                        payload: { timestamp: data.timestamp }
                    }));
                }
                break;

            case 'pong':
                if (data.timestamp) {
                    const pingTime = Date.now() - data.timestamp;
                    localPlayer.ping = pingTime;
                    if (players[localPlayer.id]) {
                        players[localPlayer.id].ping = pingTime;
                    }
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({
                            type: 'update_ping',
                            payload: { ping: pingTime }
                        }));
                    }
                }
                break;

            case 'update_ping':
                if (players[data.id]) {
                    players[data.id].ping = data.ping;
                }
                break;

            case 'leave':
                console.log(`[Leave] Player disconnected: ${data.id}`);
                
                // Cleanup WebRTC connection
                if (peerConnections[data.id]) {
                    console.log(`[WebRTC] Closing peer connection for: ${data.id}`);
                    peerConnections[data.id].close();
                    delete peerConnections[data.id];
                }
                delete pendingCandidates[data.id];
                const audioEl = document.getElementById('audio-' + data.id);
                if (audioEl) {
                    audioEl.remove();
                }

                // Cleanup audio analysis
                cleanupAudioAnalysis(data.id);

                clearPlayerTrail(data.id);
                delete players[data.id];
                updatePlayersHUD();
                break;
        }
    };
}

// WebRTC Signaling and Handshake logic
function sendSignal(to, signal) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'signal',
            payload: {
                to: to,
                signal: signal
            }
        }));
    }
}

function createPeerConnection(peerId) {
    if (peerConnections[peerId]) {
        // If the existing connection is failed/closed, destroy and recreate
        const existingState = peerConnections[peerId].iceConnectionState;
        if (existingState !== 'failed' && existingState !== 'closed' && existingState !== 'disconnected') {
            return peerConnections[peerId];
        }
        console.log(`[WebRTC] Existing connection to ${peerId} is ${existingState}, recreating...`);
        peerConnections[peerId].close();
        delete peerConnections[peerId];
        cleanupAudioAnalysis(peerId);
    }

    console.log(`[WebRTC] Creating RTCPeerConnection for peer: ${peerId}`);
    const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: 'all', // Allow both relay and direct connections
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
    });
    peerConnections[peerId] = pc;
    pendingCandidates[peerId] = []; // Initialize candidate buffer

    // Attach local stream tracks if mic is currently allowed/active
    if (localStream) {
        localStream.getTracks().forEach(track => {
            console.log(`[WebRTC] Attaching local audio track to: ${peerId}`);
            pc.addTrack(track, localStream);
        });
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`[WebRTC] Sending ICE candidate to ${peerId}: ${event.candidate.candidate.substring(0, 50)}...`);
            sendSignal(peerId, { candidate: event.candidate });
        } else {
            console.log(`[WebRTC] ICE gathering complete for: ${peerId}`);
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[WebRTC] ICE connection state for ${peerId}: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
            console.warn(`[WebRTC] ICE connection FAILED for ${peerId}. Attempting ICE restart...`);
            // Attempt ICE restart instead of full reconnect
            if (localPlayer.id < peerId) {
                pc.createOffer({ iceRestart: true }).then(offer => {
                    return pc.setLocalDescription(offer);
                }).then(() => {
                    sendSignal(peerId, { sdp: pc.localDescription });
                }).catch(err => {
                    console.error('[WebRTC] ICE restart failed:', err);
                });
            }
        } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            console.log(`[WebRTC] ✅ Successfully connected to peer: ${peerId}`);
        } else if (pc.iceConnectionState === 'disconnected') {
            console.warn(`[WebRTC] Peer ${peerId} disconnected, waiting for reconnection...`);
        }
    };

    pc.ontrack = (event) => {
        console.log(`[WebRTC] Received remote stream track from: ${peerId}`);
        const stream = event.streams[0];
        if (stream) {
            playRemoteStream(peerId, stream);
            setupAudioAnalysis(peerId, stream);
        } else {
            // Fallback: create a new MediaStream from the track
            const fallbackStream = new MediaStream([event.track]);
            playRemoteStream(peerId, fallbackStream);
            setupAudioAnalysis(peerId, fallbackStream);
        }
    };

    pc.makingOffer = false;
    pc.ignoreOffer = false;

    pc.onnegotiationneeded = async () => {
        try {
            pc.makingOffer = true;
            console.log(`[WebRTC] Negotiation needed for: ${peerId}`);
            // Force offerToReceiveAudio so that audio is always bidirectional even if mic is muted
            const offer = await pc.createOffer({ offerToReceiveAudio: true });
            if (pc.signalingState !== 'stable') return;
            await pc.setLocalDescription(offer);
            sendSignal(peerId, { sdp: pc.localDescription });
        } catch (err) {
            console.error('[WebRTC] Offer generation error:', err);
        } finally {
            pc.makingOffer = false;
        }
    };

    return pc;
}

function playRemoteStream(peerId, stream) {
    let audio = document.getElementById('audio-' + peerId);
    if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'audio-' + peerId;
        audio.autoplay = true;
        audio.muted = false; // Unmuted so Chrome decodes and plays the remote WebRTC audio stream
        audio.volume = 1;
        document.body.appendChild(audio);
    }
    audio.srcObject = stream;
    updateRemoteAudioVolume(peerId);
    audio.play().catch(e => console.warn('[Audio] HTML5 audio play error:', e));
}

function getSpatialAudioVolume(distance) {
    if (distance <= SPATIAL_AUDIO.FULL_VOLUME_RANGE) return 1;

    const fadeProgress = (distance - SPATIAL_AUDIO.FULL_VOLUME_RANGE) / SPATIAL_AUDIO.FADE_DISTANCE;
    return Math.max(0, Math.min(1, 1 - fadeProgress));
}

function updateRemoteAudioVolume(peerId) {
    if (!localPlayer.id || peerId === localPlayer.id) return;

    const audio = document.getElementById('audio-' + peerId);
    const peer = players[peerId];
    if (!audio || !peer) return;

    const dx = peer.x - localPlayer.x;
    const dy = peer.y - localPlayer.y;
    const distance = Math.hypot(dx, dy);
    const targetVolume = getSpatialAudioVolume(distance);
    audio.volume += (targetVolume - audio.volume) * SPATIAL_AUDIO.SMOOTHING;
}

function updateSpatialAudioVolumes() {
    for (const peerId in peerConnections) {
        updateRemoteAudioVolume(peerId);
    }
}

async function handleSignal(from, signal) {
    const pc = createPeerConnection(from);

    try {
        if (signal.sdp) {
            console.log(`[WebRTC] Setting remote SDP (${signal.sdp.type}) from peer: ${from}`);
            const description = new RTCSessionDescription(signal.sdp);
            
            // Perfect Negotiation Logic
            const polite = localPlayer.id > from;
            const offerCollision = description.type === 'offer' && (pc.makingOffer || pc.signalingState !== 'stable');
            
            pc.ignoreOffer = !polite && offerCollision;
            if (pc.ignoreOffer) {
                console.log(`[WebRTC] Ignoring colliding offer from ${from} (impolite)`);
                return;
            }
            
            if (offerCollision) {
                console.log(`[WebRTC] Collision resolved by rolling back (polite)`);
                await Promise.all([
                    pc.setLocalDescription({ type: 'rollback' }),
                    pc.setRemoteDescription(description)
                ]);
            } else {
                await pc.setRemoteDescription(description);
            }
            
            // Flush any buffered ICE candidates now that remote description is set
            if (pendingCandidates[from] && pendingCandidates[from].length > 0) {
                console.log(`[WebRTC] Flushing ${pendingCandidates[from].length} buffered ICE candidates for: ${from}`);
                for (const candidate of pendingCandidates[from]) {
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate(candidate));
                    } catch (e) {
                        console.warn('[WebRTC] Failed to add buffered candidate:', e);
                    }
                }
                pendingCandidates[from] = [];
            }
            
            if (description.type === 'offer') {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                sendSignal(from, { sdp: pc.localDescription });
            }
        } else if (signal.candidate) {
            try {
                // Try to add directly if remote description is set
                if (pc.remoteDescription && pc.remoteDescription.type) {
                    console.log(`[WebRTC] Adding remote ICE candidate from peer: ${from}`);
                    await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
                } else {
                    throw new Error('Remote description not set');
                }
            } catch (err) {
                if (!pc.ignoreOffer) {
                    console.log(`[WebRTC] Buffering ICE candidate from ${from}`);
                    if (!pendingCandidates[from]) pendingCandidates[from] = [];
                    pendingCandidates[from].push(signal.candidate);
                }
            }
        }
    } catch (err) {
        console.error(`[WebRTC] Signaling handshake error with ${from}:`, err);
    }
}

// Microphone Toggle Control
async function toggleMicrophone() {
    if (!localStream) {
        try {
            btnToggleMic.disabled = true;
            btnToggleMic.innerText = 'Permitindo...';
            console.log('[WebRTC] Requesting local audio device...');
            
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            localStream = stream;
            isMicEnabled = true;

            // Setup local speaking volume analysis
            setupAudioAnalysis('local', localStream);

            // Add audio tracks to all existing peer connections
            stream.getTracks().forEach(track => {
                for (const peerId in peerConnections) {
                    const pc = peerConnections[peerId];
                    const senders = pc.getSenders();
                    const hasTrack = senders.some(s => s.track && s.track.kind === track.kind);
                    if (!hasTrack) {
                        console.log(`[WebRTC] Adding audio track to connection: ${peerId}`);
                        pc.addTrack(track, localStream);
                    }
                }
            });

            btnToggleMic.disabled = false;
            btnToggleMic.innerText = 'Mutar Microfone';
            btnToggleMic.className = 'btn-hud mic-on';
            voiceStatus.innerText = 'Ativo';
            voiceIndicator.className = 'pulse-indicator-voice voice-active';
        } catch (err) {
            console.error('[WebRTC] Accessing mic failed:', err);
            btnToggleMic.disabled = false;
            btnToggleMic.innerText = 'Permitir Microfone';
            btnToggleMic.className = 'btn-hud mic-off';
            voiceStatus.innerText = 'Sem Permissão';
            alert('Não foi possível obter acesso ao microfone. Conceda as permissões de gravação.');
        }
    } else {
        // Toggle active tracks
        isMicEnabled = !isMicEnabled;
        localStream.getAudioTracks().forEach(track => {
            track.enabled = isMicEnabled;
        });

        if (isMicEnabled) {
            setupAudioAnalysis('local', localStream);
            btnToggleMic.innerText = 'Mutar Microfone';
            btnToggleMic.className = 'btn-hud mic-on';
            voiceStatus.innerText = 'Ativo';
            voiceIndicator.className = 'pulse-indicator-voice voice-active';
        } else {
            cleanupAudioAnalysis('local');
            if (players[localPlayer.id]) {
                players[localPlayer.id].isSpeaking = false;
            }
            btnToggleMic.innerText = 'Ativar Microfone';
            btnToggleMic.className = 'btn-hud mic-off';
            voiceStatus.innerText = 'Mutado';
            voiceIndicator.className = 'pulse-indicator-voice voice-muted';
        }
    }
}

btnToggleMic.addEventListener('click', toggleMicrophone);

// Music Toggle Setup
const btnMusic = document.getElementById('btn-toggle-music');
btnMusic.addEventListener('click', () => {
    if (bgMusic.paused) {
        bgMusic.play().catch(e => console.warn('Music playback failed:', e));
        btnMusic.innerText = 'Música: Ligada';
        btnMusic.className = 'btn-hud music-on';
    } else {
        bgMusic.pause();
        btnMusic.innerText = 'Música: Desligada';
        btnMusic.className = 'btn-hud mic-off';
    }
});

// Map Change Button
const btnChangeMap = document.getElementById('btn-change-map');
if (btnChangeMap) {
    btnChangeMap.addEventListener('click', () => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const nextMap = (currentMapIndex + 1) % MAPS.length;
        socket.send(JSON.stringify({
            type: 'change_map',
            payload: { mapId: nextMap }
        }));
    });
}

// ----------------------------------------------------
// UI Logic for Joining / Creating Rooms

// Resume AudioContext on user interaction to comply with autoplay policy
const resumeAudioOnGesture = () => {
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().then(() => {
            console.log('[AudioContext] Resumed AudioContext via user interaction.');
        });
    }
    // Also attempt to play any HTML5 audio tags that were blocked by autoplay policy
    document.querySelectorAll('audio').forEach(audioEl => {
        if (audioEl.paused && audioEl.srcObject) {
            audioEl.play().catch(() => {});
        }
    });
};
window.addEventListener('click', resumeAudioOnGesture);
window.addEventListener('keydown', resumeAudioOnGesture);

// Live Image URL update from HUD
btnUpdateImage.addEventListener('click', () => {
    const newUrl = hudImageUrlInput.value.trim();
    localPlayer.imageUrl = newUrl;
    
    // Broadcast own update by sending a join event with updated imageUrl
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'join',
            payload: {
                id: localPlayer.id,
                name: localPlayer.name,
                color: localPlayer.color,
                imageUrl: localPlayer.imageUrl,
                x: localPlayer.x,
                y: localPlayer.y
            }
        }));
    }
    
    if (players[localPlayer.id]) {
        players[localPlayer.id].imageUrl = newUrl;
    }
    
    // Prefetch immediately
    if (newUrl) {
        getOrLoadAvatarImage(newUrl);
    }
    
    console.log('[HUD Settings] Updated own avatar image to:', newUrl);
});

// ============================================================
// ROOM LOBBY LOGIC
// ============================================================

// Fetch available rooms from the server
async function fetchRooms() {
    try {
        const res = await fetch('/api/rooms');
        const rooms = await res.json();
        renderRoomList(rooms);
    } catch (err) {
        console.error('[Lobby] Failed to fetch rooms:', err);
        roomListContainer.innerHTML = '<div class="room-list-empty">Erro ao carregar salas.</div>';
    }
}

function renderRoomList(rooms) {
    if (!rooms || rooms.length === 0) {
        roomListContainer.innerHTML = '<div class="room-list-empty">Nenhuma sala criada ainda. Crie a primeira!</div>';
        return;
    }

    roomListContainer.innerHTML = rooms.map(room => `
        <div class="room-item" data-room-id="${room.id}" data-private="${room.isPrivate}">
            <div class="room-item-info">
                <div class="room-item-name">${escapeHtml(room.name)}</div>
                <div class="room-item-meta">
                    <span class="room-badge ${room.isPrivate ? 'private' : 'public'}">
                        ${room.isPrivate ? '🔒 Privada' : '🌐 Pública'}
                    </span>
                    <span class="room-players-count">${room.playerCount} jogador${room.playerCount !== 1 ? 'es' : ''}</span>
                </div>
            </div>
            <div class="room-item-action">
                <button class="btn-join-room" onclick="event.stopPropagation(); handleJoinRoomClick('${room.id}', ${room.isPrivate})">Entrar</button>
            </div>
        </div>
    `).join('');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Create a new room
async function createRoom(name, isPrivate, password) {
    try {
        btnCreateRoom.disabled = true;
        btnCreateRoom.innerText = 'Criando...';

        const res = await fetch('/api/rooms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, isPrivate, password })
        });

        if (!res.ok) {
            throw new Error('Failed to create room');
        }

        const room = await res.json();
        console.log('[Lobby] Room created:', room);

        // Auto-join the room we just created
        joinRoom(room.id, isPrivate ? password : '');
    } catch (err) {
        console.error('[Lobby] Failed to create room:', err);
        alert('Erro ao criar sala. Tente novamente.');
    } finally {
        btnCreateRoom.disabled = false;
        btnCreateRoom.innerText = 'Criar Sala';
    }
}

// Handle join room click (may prompt for password)
function handleJoinRoomClick(roomId, isPrivate) {
    if (isPrivate) {
        // Show password modal
        pendingJoinRoomId = roomId;
        modalPasswordInput.value = '';
        passwordModal.classList.remove('hidden');
        modalPasswordInput.focus();
    } else {
        joinRoom(roomId, '');
    }
}

// Join a room — connect WebSocket and transition to game
async function joinRoom(roomId, password) {
    // Prompt for mic access
    try {
        console.log('[Lobby] Prompting for microphone permission...');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStream = stream;
        isMicEnabled = false;
        stream.getTracks().forEach(t => t.enabled = false);
        setupAudioAnalysis('local', localStream);

        btnToggleMic.innerText = 'Ativar Microfone';
        btnToggleMic.className = 'btn-hud mic-off';
        voiceStatus.innerText = 'Mutado';
        voiceIndicator.className = 'pulse-indicator-voice voice-muted';
        console.log('[Lobby] Microphone permission granted. Starting muted.');
    } catch (err) {
        console.warn('[Lobby] Microphone permission denied or unavailable:', err);
        localStream = null;
        isMicEnabled = false;
        btnToggleMic.disabled = true;
        btnToggleMic.innerText = 'Microfone Indisponível';
        btnToggleMic.className = 'btn-hud mic-off';
        voiceStatus.innerText = 'Desativado';
        voiceIndicator.className = 'pulse-indicator-voice voice-muted';
    }

    // Connect to room WebSocket
    connectWebSocket(roomId, password);

    // Wait for WebSocket to be ready and for welcome message
    await new Promise((resolve) => {
        const checkReady = setInterval(() => {
            if (localPlayer.id) {
                clearInterval(checkReady);
                resolve();
            }
        }, 100);
        // Timeout after 5 seconds
        setTimeout(() => {
            clearInterval(checkReady);
            resolve();
        }, 5000);
    });

    if (!localPlayer.id) {
        alert('Não foi possível conectar à sala. Tente novamente.');
        return;
    }

    const imageUrl = lobbyImageUrlInput.value.trim();
    localPlayer.name = usernameInput.value.trim();
    localPlayer.color = selectedColor;
    localPlayer.imageUrl = imageUrl;
    hudImageUrlInput.value = imageUrl;

    if (imageUrl) {
        getOrLoadAvatarImage(imageUrl);
    }

    // Send Join Message to Server
    socket.send(JSON.stringify({
        type: 'join',
        payload: {
            id: localPlayer.id,
            name: localPlayer.name,
            color: localPlayer.color,
            imageUrl: localPlayer.imageUrl,
            x: localPlayer.x,
            y: localPlayer.y
        }
    }));

    // Register self in local players map
    players[localPlayer.id] = {
        id: localPlayer.id,
        name: localPlayer.name,
        color: localPlayer.color,
        imageUrl: localPlayer.imageUrl,
        x: localPlayer.x,
        y: localPlayer.y,
        targetX: localPlayer.x,
        targetY: localPlayer.y,
        chatBubble: null,
        ping: 0
    };

    // Transition to game
    roomLobby.classList.add('hidden');
    setupScreen.classList.add('hidden');
    document.getElementById('game-container').classList.remove('hidden');

    // Update URL with room ID (without reload)
    const newUrl = new URL(window.location);
    newUrl.searchParams.set('room', currentRoomId);
    window.history.replaceState({}, '', newUrl);

    updatePlayersHUD();
    isJoined = true;

    playJoinSound();

    if (isMusicPlaying) {
        bgMusic.play().catch(err => {
            console.warn('[Sound] Background music play blocked by browser policy:', err);
        });
    }

    for (const id in players) {
        if (id !== localPlayer.id) {
            createPeerConnection(id);
        }
    }

    window.focus();
    requestAnimationFrame(gameLoop);
}

// Leave room and return to lobby
function leaveRoom() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
    }
    socket = null;
    isJoined = false;
    localPlayer.id = null;
    currentRoomId = null;
    currentRoomPassword = '';
    currentRoomName = '';

    // Cleanup peer connections
    for (const peerId in peerConnections) {
        peerConnections[peerId].close();
        delete peerConnections[peerId];
        cleanupAudioAnalysis(peerId);
    }
    for (const peerId in pendingCandidates) {
        delete pendingCandidates[peerId];
    }
    document.querySelectorAll('audio').forEach(el => el.remove());

    // Clear players
    for (const key in players) delete players[key];

    // Stop background music
    bgMusic.pause();
    bgMusic.currentTime = 0;

    // Clear URL params
    const newUrl = new URL(window.location);
    newUrl.searchParams.delete('room');
    window.history.replaceState({}, '', newUrl);

    // Transition back to lobby
    document.getElementById('game-container').classList.add('hidden');
    roomLobby.classList.remove('hidden');
    fetchRooms();
}

// ============================================================
// EVENT LISTENERS — Room Lobby
// ============================================================

// Step 1: Setup form → go to lobby
setupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const nickname = usernameInput.value.trim();
    if (!nickname) return;

    localPlayer.name = nickname;
    localPlayer.color = selectedColor;
    localPlayer.imageUrl = lobbyImageUrlInput.value.trim();

    // Transition to lobby
    setupScreen.classList.add('hidden');
    roomLobby.classList.remove('hidden');
    fetchRooms();
});

// Back button
btnBackSetup.addEventListener('click', () => {
    roomLobby.classList.add('hidden');
    setupScreen.classList.remove('hidden');
});

// Toggle password field visibility
roomPrivateToggle.addEventListener('change', () => {
    if (roomPrivateToggle.checked) {
        roomPasswordRow.classList.remove('hidden');
        roomPasswordInput.focus();
    } else {
        roomPasswordRow.classList.add('hidden');
        roomPasswordInput.value = '';
    }
});

// Create room form
createRoomForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = roomNameInput.value.trim() || 'Sala sem nome';
    const isPrivate = roomPrivateToggle.checked;
    const password = roomPasswordInput.value.trim();

    if (isPrivate && !password) {
        alert('Defina uma senha para salas privadas.');
        return;
    }

    createRoom(name, isPrivate, password);
});

// Refresh rooms
btnRefreshRooms.addEventListener('click', fetchRooms);

// Password modal
btnModalCancel.addEventListener('click', () => {
    passwordModal.classList.add('hidden');
    pendingJoinRoomId = null;
});

btnModalEnter.addEventListener('click', () => {
    const pwd = modalPasswordInput.value.trim();
    if (!pwd) return;
    passwordModal.classList.add('hidden');
    if (pendingJoinRoomId) {
        joinRoom(pendingJoinRoomId, pwd);
        pendingJoinRoomId = null;
    }
});

modalPasswordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        btnModalEnter.click();
    }
});

// Copy invite link
btnCopyInvite.addEventListener('click', () => {
    if (!currentRoomId) return;
    const url = new URL(window.location);
    url.searchParams.set('room', currentRoomId);
    // Remove password from invite link for security
    url.searchParams.delete('pwd');
    navigator.clipboard.writeText(url.toString()).then(() => {
        btnCopyInvite.innerText = '✅ Link Copiado!';
        btnCopyInvite.classList.add('copied');
        setTimeout(() => {
            btnCopyInvite.innerText = '📋 Copiar Link de Convite';
            btnCopyInvite.classList.remove('copied');
        }, 2000);
    }).catch(() => {
        // Fallback
        prompt('Copie o link de convite:', url.toString());
    });
});

// Leave room
btnLeaveRoom.addEventListener('click', leaveRoom);

// ============================================================
// AUTO-JOIN via URL ?room=ID
// ============================================================

function checkAutoJoin() {
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get('room');
    if (roomId) {
        // If user hasn't filled setup yet, show setup with auto-join flag
        const nickname = usernameInput.value.trim();
        if (!nickname) {
            // Store room ID and wait for setup completion
            window._autoJoinRoomId = roomId;
            // Show setup screen normally, user needs to enter a name first
            return;
        }
        // If nickname is already set, go straight to joining
        localPlayer.name = nickname;
        localPlayer.color = selectedColor;
        localPlayer.imageUrl = lobbyImageUrlInput.value.trim();
        setupScreen.classList.add('hidden');
        joinRoom(roomId, '');
    }
}

// Override setup form to handle auto-join
const originalSetupListener = setupForm.onsubmit;
setupForm.addEventListener('submit', () => {
    if (window._autoJoinRoomId) {
        const roomId = window._autoJoinRoomId;
        delete window._autoJoinRoomId;
        setTimeout(() => {
            setupScreen.classList.add('hidden');
            joinRoom(roomId, '');
        }, 50);
    }
});

// Update Side Panel Info
function updatePlayersHUD() {
    const listContainer = document.getElementById('players-list');
    const countSpan = document.getElementById('player-count');
    
    const activeCount = Object.keys(players).length;
    countSpan.innerText = activeCount;
    
    listContainer.innerHTML = '';
    
    for (const id in players) {
        const p = players[id];
        const isSelf = id === localPlayer.id;
        
        const item = document.createElement('div');
        item.className = 'player-item' + (isSelf ? ' self' : '');
        
        const badge = document.createElement('div');
        badge.className = 'player-badge';
        badge.style.setProperty('--badge-color', p.color);
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'player-item-name';
        nameSpan.innerText = p.name;
        
        item.appendChild(badge);
        item.appendChild(nameSpan);
        listContainer.appendChild(item);
    }
}

// Keyboard Input Handlers
window.addEventListener('keydown', (e) => {
    if (isChatting) {
        if (e.key === 'Escape') {
            closeChat(false);
        }
        return; // Don't move while typing
    }

    if (e.key === 'Enter') {
        openChat();
        e.preventDefault();
        return;
    }

    if (e.key in keys) {
        keys[e.key] = true;
    }
    if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        keys[e.key] = true;
    }
});

window.addEventListener('keyup', (e) => {
    if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        keys[e.key] = false;
    }
});

// Blur focus closure
canvas.addEventListener('mousedown', () => {
    if (isChatting) {
        closeChat(false);
    }
});

// Chat management
const chatInputContainer = document.getElementById('chat-input-container');
const chatTriggerInfo = document.getElementById('chat-trigger-info');
const chatInput = document.getElementById('chat-input');

function openChat() {
    isChatting = true;
    chatInputContainer.classList.remove('hidden');
    chatTriggerInfo.classList.add('hidden');
    chatInput.value = '';
    chatInput.focus();
    
    // Clear moving keys to avoid stuck running behavior
    for (const key in keys) {
        keys[key] = false;
    }
}

function closeChat(sendMsg = true) {
    isChatting = false;
    chatInputContainer.classList.add('hidden');
    chatTriggerInfo.classList.remove('hidden');

    if (sendMsg) {
        const text = chatInput.value.trim();
        if (text.length > 0) {
            console.log(`[Chat Send] Sending text: "${text}"`);
            socket.send(JSON.stringify({
                type: 'chat',
                payload: {
                    message: text
                }
            }));
        }
    }
    chatInput.value = '';
    window.focus();
}

chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        closeChat(true);
        e.preventDefault();
    }
});

// Position sync timer
let lastSentPosition = { x: 0, y: 0 };
let lastSendTime = 0;

function syncPosition() {
    const now = Date.now();
    if (now - lastSendTime > POSITION_SEND_RATE) {
        if (localPlayer.x !== lastSentPosition.x || localPlayer.y !== lastSentPosition.y) {
            socket.send(JSON.stringify({
                type: 'move',
                payload: {
                    x: localPlayer.x,
                    y: localPlayer.y
                }
            }));
            lastSentPosition.x = localPlayer.x;
            lastSentPosition.y = localPlayer.y;
            lastSendTime = now;
        }
    }
}

// Word wrapping inside bubble utility
function wrapText(ctx, text, maxWidth) {
    if (!text) return [''];
    const words = text.split(' ');
    const lines = [];
    let currentLine = words[0];

    for (let i = 1; i < words.length; i++) {
        const word = words[i];
        const width = ctx.measureText(currentLine + " " + word).width;
        if (width < maxWidth) {
            currentLine += " " + word;
        } else {
            lines.push(currentLine);
            currentLine = word;
        }
    }
    lines.push(currentLine);
    return lines;
}

function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lightenHex(hex, amount = 0.32) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    const mix = (channel) => Math.round(channel + (255 - channel) * amount);
    return `#${mix(r).toString(16).padStart(2, '0')}${mix(g).toString(16).padStart(2, '0')}${mix(b).toString(16).padStart(2, '0')}`;
}

function addTrailPoint(playerId, x, y) {
    const last = trailLastSample[playerId];
    if (last) {
        const dx = x - last.x;
        const dy = y - last.y;
        if (dx * dx + dy * dy < TRAIL.SPACING * TRAIL.SPACING) return;
    }

    if (!trails[playerId]) trails[playerId] = [];
    trails[playerId].push({ x, y, t: performance.now() });
    trailLastSample[playerId] = { x, y };
}

function pruneTrails() {
    const now = performance.now();
    for (const playerId in trails) {
        const points = trails[playerId];
        while (points.length > 0 && now - points[0].t > TRAIL.MAX_AGE) {
            points.shift();
        }
        while (points.length > TRAIL.MAX_POINTS) {
            points.shift();
        }
        if (points.length === 0) {
            delete trails[playerId];
        }
    }
}

function clearPlayerTrail(playerId) {
    delete trails[playerId];
    delete trailLastSample[playerId];
}

function clearAllTrails() {
    for (const key in trails) delete trails[key];
    for (const key in trailLastSample) delete trailLastSample[key];
}

function drawWobblyTrailPath(x0, y0, x1, y1, jitter, timeOffset = 0) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const distance = Math.hypot(dx, dy);
    if (distance <= 0.001) return;

    const normalX = -dy / distance;
    const normalY = dx / distance;
    const steps = Math.max(2, Math.ceil(distance / TRAIL.WOBBLE_STEP));

    ctx.moveTo(x0, y0);
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const edgeFade = Math.sin(Math.PI * t);
        const wobble = (
            Math.sin(t * 18 + timeOffset) +
            Math.sin(t * 43 + timeOffset * 0.7) * 0.45
        ) * jitter * edgeFade;

        ctx.lineTo(
            x0 + dx * t + normalX * wobble,
            y0 + dy * t + normalY * wobble
        );
    }
}

function strokeNeonTrailSegment(x0, y0, x1, y1, color, alpha, width, timeOffset) {
    ctx.shadowColor = color;

    // Outer neon halo
    ctx.beginPath();
    drawWobblyTrailPath(x0, y0, x1, y1, TRAIL.JITTER * 1.2, timeOffset);
    ctx.strokeStyle = hexToRgba(color, alpha * 0.16);
    ctx.lineWidth = width * 2.4;
    ctx.shadowBlur = 30 * alpha;
    ctx.stroke();

    // Mid glow
    ctx.beginPath();
    drawWobblyTrailPath(x0, y0, x1, y1, TRAIL.JITTER, timeOffset + 1.7);
    ctx.strokeStyle = hexToRgba(color, alpha * 0.36);
    ctx.lineWidth = width * 1.5;
    ctx.shadowBlur = 18 * alpha;
    ctx.stroke();

    // Bright core
    ctx.beginPath();
    drawWobblyTrailPath(x0, y0, x1, y1, TRAIL.JITTER * 0.55, timeOffset + 3.1);
    ctx.strokeStyle = hexToRgba(color, alpha * 0.78);
    ctx.lineWidth = width * 0.45;
    ctx.shadowBlur = 10 * alpha;
    ctx.stroke();
}

function drawTrails() {
    const now = performance.now();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';

    for (const playerId in trails) {
        const points = trails[playerId];
        const player = players[playerId];
        if (!player || points.length < 2) continue;

        const color = lightenHex(player.color);

        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[i];
            const p1 = points[i + 1];
            const age = now - p0.t;
            if (age > TRAIL.MAX_AGE) continue;

            const alpha = TRAIL.BASE_ALPHA * (1 - age / TRAIL.MAX_AGE);
            if (alpha <= 0) continue;

            const width = TRAIL.WIDTH * (0.6 + 0.4 * alpha);
            strokeNeonTrailSegment(p0.x, p0.y, p1.x, p1.y, color, alpha, width, now * 0.012 + i);
        }
    }

    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
}

// Game loop physics/state updates
function update(dt) {
    if (!isJoined) return;

    // 1. Calculate local player movement
    let moveX = 0;
    let moveY = 0;

    if (keys['w'] || keys['ArrowUp'] || keys['W']) moveY -= 1;
    if (keys['s'] || keys['ArrowDown'] || keys['S']) moveY += 1;
    if (keys['a'] || keys['ArrowLeft'] || keys['A']) moveX -= 1;
    if (keys['d'] || keys['ArrowRight'] || keys['D']) moveX += 1;

    const localIsMoving = moveX !== 0 || moveY !== 0;

    if (localIsMoving) {
        // Normalize speed diagonally
        const length = Math.sqrt(moveX * moveX + moveY * moveY);
        const dx = (moveX / length) * localPlayer.speed * dt;
        const dy = (moveY / length) * localPlayer.speed * dt;

        let targetX = localPlayer.x + dx;
        let targetY = localPlayer.y + dy;

        // Constraint check (map boundaries)
        targetX = Math.max(20, Math.min(targetX, MAP_SIZE - 20));
        targetY = Math.max(20, Math.min(targetY, MAP_SIZE - 20));

        // Obstacles collision check
        const map = MAPS[currentMapIndex];
        if (map.obstacles) {
            for (const obs of map.obstacles) {
                const r = 20; // player radius
                // AABB Collision test
                if (targetX + r > obs.x && targetX - r < obs.x + obs.w &&
                    targetY + r > obs.y && targetY - r < obs.y + obs.h) {
                    
                    // Simple resolution: check which axis caused the overlap
                    const collisionX = (localPlayer.x + r > obs.x && localPlayer.x - r < obs.x + obs.w);
                    const collisionY = (localPlayer.y + r > obs.y && localPlayer.y - r < obs.y + obs.h);
                    
                    if (!collisionY) targetY = localPlayer.y;
                    else if (!collisionX) targetX = localPlayer.x;
                    else {
                        targetX = localPlayer.x;
                        targetY = localPlayer.y;
                    }
                }
            }
        }

        localPlayer.x = targetX;
        localPlayer.y = targetY;

        // Update self in the global players storage
        if (players[localPlayer.id]) {
            players[localPlayer.id].x = localPlayer.x;
            players[localPlayer.id].y = localPlayer.y;
        }

        // Broadcast position changes throttled
        syncPosition();
    }

    // Update real-time WebRTC speech activity statuses
    updateAudioSpeakingStates();

    // 2. Interpolate other players movement smoothly (lerping), calculate movement state, anim phases and decrement chat timers
    for (const id in players) {
        const p = players[id];

        // Determine movement status
        let playerIsMoving = false;
        if (id === localPlayer.id) {
            playerIsMoving = localIsMoving;
        } else {
            // Check remote movement by calculating delta distance to target coordinate
            const dx = p.targetX - p.x;
            const dy = p.targetY - p.y;
            playerIsMoving = (dx * dx + dy * dy) > 2.0;

            // Lerp position for remote players
            p.x += dx * 0.15;
            p.y += dy * 0.15;
        }

        p.isMoving = playerIsMoving;

        // Accumulate player animation cycle phase
        const animSpeed = playerIsMoving ? 15.0 : 3.0; // 15 rad/s walking, 3 rad/s idle breathing
        p.animPhase = (p.animPhase || 0) + animSpeed * dt;
        if (p.animPhase > Math.PI * 2) {
            p.animPhase -= Math.PI * 2;
        }

        // Fade bubbles
        if (p.chatBubble) {
            p.chatBubble.timer -= dt;
            if (p.chatBubble.timer <= 0) {
                p.chatBubble = null;
            }
        }

        if (p.isMoving) {
            addTrailPoint(id, p.x, p.y);
        }
    }

    updateSpatialAudioVolumes();
    pruneTrails();

    // 3. Collision detection between players (squares of size 40x40)
    const currentCollisions = new Set();
    const playerIds = Object.keys(players);
    for (let i = 0; i < playerIds.length; i++) {
        for (let j = i + 1; j < playerIds.length; j++) {
            const idA = playerIds[i];
            const idB = playerIds[j];
            const pA = players[idA];
            const pB = players[idB];
            
            // Overlap check (within 40px on both X and Y axes)
            if (Math.abs(pA.x - pB.x) < 40 && Math.abs(pA.y - pB.y) < 40) {
                const collisionKey = idA < idB ? `${idA}_${idB}` : `${idB}_${idA}`;
                currentCollisions.add(collisionKey);
            }
        }
    }
    
    // Play sound on collision start
    for (const key of currentCollisions) {
        if (!activeCollisions.has(key)) {
            playCollisionSound();
        }
    }
    
    // Retain only currently active collisions
    activeCollisions.clear();
    for (const key of currentCollisions) {
        activeCollisions.add(key);
    }
}

// Render 2D space
function draw() {
    const map = MAPS[currentMapIndex];

    // Clear canvas and fill with map background
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = map.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!isJoined) return;

    // 1. Position Camera following the local player
    camera.x = localPlayer.x - canvas.width / 2;
    camera.y = localPlayer.y - canvas.height / 2;

    // Constrain camera view to map boundaries
    camera.x = Math.max(0, Math.min(camera.x, MAP_SIZE - canvas.width));
    camera.y = Math.max(0, Math.min(camera.y, MAP_SIZE - canvas.height));

    ctx.save();
    // Offset standard drawings by camera coordinates
    ctx.translate(-camera.x, -camera.y);

    // 2. Draw cyber grid lines
    ctx.strokeStyle = map.grid;
    ctx.lineWidth = 1;
    const gridSpacing = 100;
    
    // Draw vertical grid
    for (let x = 0; x <= MAP_SIZE; x += gridSpacing) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, MAP_SIZE);
        ctx.stroke();
    }
    // Draw horizontal grid
    for (let y = 0; y <= MAP_SIZE; y += gridSpacing) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(MAP_SIZE, y);
        ctx.stroke();
    }

    // 3. Draw map boundaries double glowing neon borders
    ctx.shadowColor = map.border;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = map.grid; // inner soft border
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, MAP_SIZE, MAP_SIZE);

    ctx.shadowColor = map.glow;
    ctx.shadowBlur = 15;
    ctx.strokeStyle = map.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(-4, -4, MAP_SIZE + 8, MAP_SIZE + 8);

    ctx.shadowBlur = 0; // Reset shadow glow for avatars and text

    // 3.5 Draw Obstacles
    if (map.obstacles) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.strokeStyle = map.border;
        ctx.lineWidth = 2;
        ctx.shadowColor = map.glow;
        ctx.shadowBlur = 5;
        for (const obs of map.obstacles) {
            ctx.fillRect(obs.x, obs.y, obs.w, obs.h);
            ctx.strokeRect(obs.x, obs.y, obs.w, obs.h);
        }
        ctx.shadowBlur = 0;
    }

    // 3.6 Draw movement trails
    drawTrails();

    // 4. Draw players (boxes, name labels, and floating chat bubbles)
    for (const id in players) {
        const p = players[id];

        // Determine player specific animation offsets (Squash and Stretch + Hop/Breathing)
        let bounce = 0;
        let scaleX = 1.0;
        let scaleY = 1.0;
        
        const phase = p.animPhase || 0;
        
        if (p.isMoving) {
            // Hopping walk cycle: Hop Y offset and Squash/Stretch
            bounce = -Math.abs(Math.sin(phase)) * 12; // hop up to 12px
            
            const airPhase = Math.sin(phase);
            scaleX = 1.0 - airPhase * 0.08;
            scaleY = 1.0 + airPhase * 0.12;
        } else {
            // Idle breathing cycle
            bounce = Math.sin(phase) * 1.5;
            scaleX = 1.0 + Math.sin(phase) * 0.02;
            scaleY = 1.0 - Math.sin(phase) * 0.02;
        }

        ctx.save();
        // Translate to player position, applying the bounce to Y coordinate
        ctx.translate(p.x, p.y + bounce);

        // Draw Player Square Avatar (scale applied individually for Squash and Stretch animation)
        ctx.save();
        ctx.scale(scaleX, scaleY);
        
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 15;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.roundRect(-20, -20, 40, 40, 8); // Size 40x40 centered
        ctx.fill();
        ctx.shadowBlur = 0; // Reset glow for text

        // Render dynamic image if custom URL is provided
        if (p.imageUrl) {
            const img = getOrLoadAvatarImage(p.imageUrl);
            if (img && img.loaded) {
                ctx.save();
                ctx.beginPath();
                ctx.roundRect(-20, -20, 40, 40, 8);
                ctx.clip();
                ctx.drawImage(img, -20, -20, 40, 40);
                ctx.restore();
            }
        }
        ctx.restore(); // Restore scale to normal so text and indicators remain crisp

        // Draw Name Label Pill
        ctx.font = 'bold 12px Outfit';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const nameWidth = ctx.measureText(p.name).width;
        let pillWidth = nameWidth + 16;
        let textXOffset = 0;

        if (p.isSpeaking) {
            pillWidth += 16; // Widen pill for micro icon
            textXOffset = 8; // Offset name to the right
        }

        const pillHeight = 18;
        const pillY = -37;

        ctx.fillStyle = 'rgba(10, 12, 19, 0.8)';
        ctx.strokeStyle = p.isSpeaking ? '#39ff14' : 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = p.isSpeaking ? 1.5 : 1;
        ctx.beginPath();
        ctx.roundRect(-pillWidth / 2, pillY - pillHeight / 2, pillWidth, pillHeight, 9);
        ctx.fill();
        ctx.stroke();

        // If speaking, draw a tiny green vector microphone on the left
        if (p.isSpeaking) {
            const micX = -pillWidth / 2 + 10;
            const micY = pillY;
            drawMicrophoneIcon(ctx, micX, micY - 2, '#39ff14');
        }

        // White username inside pill
        ctx.fillStyle = '#ffffff';
        ctx.fillText(p.name, textXOffset, pillY);

        // Draw Ping under user
        if (p.ping !== undefined) {
            ctx.font = 'bold 10px Outfit';
            ctx.fillStyle = p.ping < 100 ? '#39ff14' : (p.ping < 200 ? '#ffea00' : '#ff3333');
            ctx.textAlign = 'center';
            ctx.shadowColor = '#000000';
            ctx.shadowBlur = 4;
            ctx.fillText(`${p.ping} ms`, 0, 32); // Draw below the 40x40 square
            ctx.shadowBlur = 0;
        }

        // Draw Player Chat Bubble (if active)
        if (p.chatBubble && p.chatBubble.timer > 0) {
            ctx.save();

            
            // Fading bubble in the last second
            let alpha = 1.0;
            if (p.chatBubble.timer < 1.0) {
                alpha = p.chatBubble.timer;
            }
            ctx.globalAlpha = alpha;

            ctx.font = '500 13px Outfit';
            ctx.textBaseline = 'top';
            ctx.textAlign = 'left';

            const bubbleLines = wrapText(ctx, p.chatBubble.text, 200);
            const bubbleLineHeight = 18;
            
            let maxLineW = 0;
            bubbleLines.forEach(line => {
                const w = ctx.measureText(line).width;
                if (w > maxLineW) maxLineW = w;
            });

            const chatWidth = maxLineW + 24;
            const chatHeight = (bubbleLines.length * bubbleLineHeight) + 16;
            
            const chatX = -chatWidth / 2;
            const chatY = -55 - chatHeight; // sit above the name pill

            // Bubble body
            ctx.fillStyle = 'rgba(8, 10, 16, 0.95)';
            ctx.strokeStyle = p.color; // border matches player color
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.roundRect(chatX, chatY, chatWidth, chatHeight, 10);
            ctx.fill();
            ctx.stroke();

            // Bubble tail pointer
            ctx.fillStyle = 'rgba(8, 10, 16, 0.95)';
            ctx.beginPath();
            ctx.moveTo(-8, chatY + chatHeight);
            ctx.lineTo(0, chatY + chatHeight + 8);
            ctx.lineTo(8, chatY + chatHeight);
            ctx.closePath();
            ctx.fill();

            // Tail border lines
            ctx.strokeStyle = p.color;
            ctx.beginPath();
            ctx.moveTo(-8, chatY + chatHeight);
            ctx.lineTo(0, chatY + chatHeight + 8);
            ctx.lineTo(8, chatY + chatHeight);
            ctx.stroke();

            // Text content
            ctx.fillStyle = '#f0f3f8';
            bubbleLines.forEach((line, idx) => {
                ctx.fillText(line, chatX + 12, chatY + 8 + idx * bubbleLineHeight);
            });

            ctx.restore();
        }

        ctx.restore();
    }

    ctx.restore();
}

let lastTime = 0;
function gameLoop(timestamp) {
    if (!lastTime) lastTime = timestamp;
    const dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;

    update(dt);
    draw();

    if (isJoined) {
        requestAnimationFrame(gameLoop);
    }
}

// Bootstrap — check if URL contains ?room=ID for auto-join
checkAutoJoin();
