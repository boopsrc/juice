// Configuration and Setup
const MAP_SIZE = 3000;
const POSITION_SEND_RATE = 45; // ~22 updates per second

// Game state
let isJoined = false;
let socket = null;
let isChatting = false;

const localPlayer = {
    id: null,
    name: '',
    color: '#00f0ff',
    imageUrl: '', // optional custom image url
    x: MAP_SIZE / 2 + (Math.random() - 0.5) * 300, // spawn around center
    y: MAP_SIZE / 2 + (Math.random() - 0.5) * 300,
    speed: 280, // px per second
};

const players = {}; // stores all player states: { id: { id, name, color, imageUrl, x, y, targetX, targetY, chatBubble } }
const camera = { x: 0, y: 0 };

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
const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

// Web Audio API context for real-time speaking/volume detection
let audioContext = null;
const speechDetectors = {}; // peerId -> { analyser, dataArray, source }

function initAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log('[AudioAnalysis] AudioContext initialized.');
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

// HTML UI Elements
const setupScreen = document.getElementById('setup-screen');
const setupForm = document.getElementById('setup-form');
const usernameInput = document.getElementById('username');
const lobbyImageUrlInput = document.getElementById('avatar-image-url');
const btnJoin = document.getElementById('btn-join');

const btnToggleMic = document.getElementById('btn-toggle-mic');
const voiceStatus = document.getElementById('voice-status');
const voiceIndicator = document.getElementById('voice-indicator');

const btnUpdateImage = document.getElementById('btn-update-image');
const hudImageUrlInput = document.getElementById('hud-image-url');

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
function connectWebSocket() {
    // Disable join until websocket is ready
    btnJoin.disabled = true;
    btnJoin.innerText = 'Conectando ao Servidor...';

    const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    const wsUrl = protocol + window.location.host + '/ws';
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log('[Socket] Connection established.');
    };

    socket.onclose = () => {
        console.warn('[Socket] Connection lost. Reconnecting in 3 seconds...');
        isJoined = false;
        btnJoin.disabled = true;
        btnJoin.innerText = 'Reconectando...';
        
        // Cleanup all peer connections on disconnect
        for (const peerId in peerConnections) {
            peerConnections[peerId].close();
            delete peerConnections[peerId];
        }
        document.querySelectorAll('audio').forEach(el => el.remove());
        
        // Show setup screen again
        document.getElementById('game-container').classList.add('hidden');
        setupScreen.classList.remove('hidden');
        
        setTimeout(connectWebSocket, 3000);
    };

    socket.onerror = (error) => {
        console.error('[Socket] Error:', error);
    };

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
                            chatBubble: null
                        };
                        
                        // Prefetch avatar image
                        if (p.imageUrl) {
                            getOrLoadAvatarImage(p.imageUrl);
                        }

                        // Initiate WebRTC peer connection
                        createPeerConnection(id);
                    }
                }
                
                btnJoin.disabled = false;
                btnJoin.innerText = 'Entrar no Universo';
                break;

            case 'join':
                console.log(`[Join] Player entered: ${data.name} (${data.id})`);
                
                const isNewPlayer = !players[data.id];
                
                players[data.id] = {
                    id: data.id,
                    name: data.name,
                    color: data.color,
                    imageUrl: data.imageUrl || '',
                    x: data.x,
                    y: data.y,
                    targetX: data.x,
                    targetY: data.y,
                    chatBubble: null
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
                break;

            case 'signal':
                if (data.from && data.signal) {
                    handleSignal(data.from, data.signal);
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
                const audioEl = document.getElementById('audio-' + data.id);
                if (audioEl) {
                    audioEl.remove();
                }

                // Cleanup audio analysis
                cleanupAudioAnalysis(data.id);

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
    if (peerConnections[peerId]) return peerConnections[peerId];

    console.log(`[WebRTC] Creating RTCPeerConnection for peer: ${peerId}`);
    const pc = new RTCPeerConnection({ iceServers });
    peerConnections[peerId] = pc;

    // Attach local stream tracks if mic is currently allowed/active
    if (localStream) {
        localStream.getTracks().forEach(track => {
            console.log(`[WebRTC] Attacking local audio track to: ${peerId}`);
            pc.addTrack(track, localStream);
        });
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignal(peerId, { candidate: event.candidate });
        }
    };

    pc.ontrack = (event) => {
        console.log(`[WebRTC] Received remote stream track from: ${peerId}`);
        const stream = event.streams[0];
        playRemoteStream(peerId, stream);
        setupAudioAnalysis(peerId, stream);
    };

    pc.onnegotiationneeded = async () => {
        // Glare prevention: only the peer with lexicographically smaller ID initiates offers
        if (localPlayer.id < peerId) {
            try {
                console.log(`[WebRTC] Negotiation needed. Creating offer for: ${peerId}`);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                sendSignal(peerId, { sdp: pc.localDescription });
            } catch (err) {
                console.error('[WebRTC] Offer generation error:', err);
            }
        } else {
            console.log(`[WebRTC] Negotiation needed. Waiting for peer (${peerId}) to call.`);
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
        document.body.appendChild(audio);
    }
    audio.srcObject = stream;
}

async function handleSignal(from, signal) {
    const pc = createPeerConnection(from);

    try {
        if (signal.sdp) {
            console.log(`[WebRTC] Setting remote SDP description from peer: ${from}`);
            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            if (signal.sdp.type === 'offer') {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                sendSignal(from, { sdp: pc.localDescription });
            }
        } else if (signal.candidate) {
            console.log(`[WebRTC] Adding remote ICE candidate from peer: ${from}`);
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
    } catch (err) {
        console.error('[WebRTC] Signaling handshake error:', err);
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

// Handle lobby submission
setupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const nickname = usernameInput.value.trim();
    const imageUrl = lobbyImageUrlInput.value.trim();
    if (!nickname || !localPlayer.id) return;

    // Initialize local player details
    localPlayer.name = nickname;
    localPlayer.color = selectedColor;
    localPlayer.imageUrl = imageUrl;
    
    // Set initial URL inside dynamic HUD setting
    hudImageUrlInput.value = imageUrl;

    // Prefetch image
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
        chatBubble: null
    };

    // Transition panels
    setupScreen.classList.add('hidden');
    document.getElementById('game-container').classList.remove('hidden');
    
    updatePlayersHUD();
    isJoined = true;
    
    window.focus();
    requestAnimationFrame(gameLoop);
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

        localPlayer.x += dx;
        localPlayer.y += dy;

        // Constraint check
        localPlayer.x = Math.max(20, Math.min(localPlayer.x, MAP_SIZE - 20));
        localPlayer.y = Math.max(20, Math.min(localPlayer.y, MAP_SIZE - 20));

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
    }
}

// Render 2D space
function draw() {
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

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
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.025)';
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
    ctx.shadowColor = '#00f0ff';
    ctx.shadowBlur = 10;
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.2)';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, MAP_SIZE, MAP_SIZE);

    ctx.shadowColor = '#ff007f';
    ctx.shadowBlur = 15;
    ctx.strokeStyle = 'rgba(255, 0, 127, 0.1)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-4, -4, MAP_SIZE + 8, MAP_SIZE + 8);

    ctx.shadowBlur = 0; // Reset shadow glow for avatars and text

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

// Bootstrap
connectWebSocket();
