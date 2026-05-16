const socket = io();

// DOM Elements - Landing
const landingDiv = document.getElementById('landing');
const partyDiv = document.getElementById('party');
const nicknameInput = document.getElementById('nickname');
const createBtn = document.getElementById('createBtn');
const joinRoomIdInput = document.getElementById('joinRoomId');
const joinBtn = document.getElementById('joinBtn');
const errorMsg = document.getElementById('errorMsg');

// DOM Elements - Party
const displayRoomId = document.getElementById('displayRoomId');
const leaveBtn = document.getElementById('leaveBtn');
const chatBox = document.getElementById('chatBox');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');

// DOM Elements - Video
const adminControls = document.getElementById('adminControls');
const playerContainer = document.getElementById('playerContainer');
const videoWrapper = document.getElementById('videoWrapper');
const waitingMessage = document.getElementById('waitingMessage');
const videoUpload = document.getElementById('videoUpload');
const uploadBtn = document.getElementById('uploadBtn');
const uploadStatus = document.getElementById('uploadStatus');
const syncPlayer = document.getElementById('syncPlayer');
const chatOverlay = document.getElementById('chatOverlay');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const themeToggle = document.getElementById('themeToggle');
const exitFsBtn = document.getElementById('exitFsBtn');
const fsChatInput = document.getElementById('fsChatInput');
const fsSendBtn = document.getElementById('fsSendBtn');

// State
let currentRoomId = null;
let isUserAdmin = false;
let myNickname = '';
let myUserId = null;

// --- Session Logic ---
function getOrCreateUserId() {
    let id = localStorage.getItem('syncstream_userId');
    if (!id) {
        id = 'user_' + Math.random().toString(36).substring(2, 10);
        localStorage.setItem('syncstream_userId', id);
    }
    return id;
}

myUserId = getOrCreateUserId();

// --- Theme Toggle ---
themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    if (document.body.classList.contains('dark-mode')) {
        themeToggle.textContent = '☀️ Light Mode';
    } else {
        themeToggle.textContent = '🌙 Dark Mode';
    }
});

// --- Navigation & Setup ---

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function showPartyUI(roomId, isAdmin, roomData = {}) {
    localStorage.setItem('syncstream_lastRoomId', roomId);
    localStorage.setItem('syncstream_nickname', myNickname);
    currentRoomId = roomId;
    isUserAdmin = isAdmin;

    landingDiv.classList.add('hidden');
    partyDiv.classList.remove('hidden');

    displayRoomId.textContent = roomId;

    setupVideoUI(roomData);
}

// --- Video & Sync Logic ---

let ignoreSyncEvent = false;
let syncInterval = null;
let isVideoUIInitialized = false;

function setupVideoUI(roomData) {
    if (!isVideoUIInitialized) {
        if (isUserAdmin) {
            // Admin controls events
            syncPlayer.addEventListener('play', () => {
                if(!ignoreSyncEvent) emitSync('playing');
            });
            syncPlayer.addEventListener('pause', () => {
                if(!ignoreSyncEvent) emitSync('paused');
            });
            syncPlayer.addEventListener('seeked', () => {
                if(!ignoreSyncEvent) emitSync(syncPlayer.paused ? 'paused' : 'playing');
            });

            // Periodic sync to keep everyone perfectly aligned and help late-joiners
            syncInterval = setInterval(() => {
                if (!syncPlayer.paused && !ignoreSyncEvent) {
                    emitSync('playing');
                }
            }, 3000); // Send sync every 3 seconds

        } else {
            // Normal user
            syncPlayer.controls = false; // Disable default controls
            syncPlayer.style.pointerEvents = 'none'; // Prevent clicking to pause
        }
        isVideoUIInitialized = true;
    }

    // Always check for existing video state when setting up (e.g., reconnecting)
    if (isUserAdmin) {
        // If the admin is returning and a video was already uploaded, load it immediately
        if (roomData.hasVideo) {
            loadVideo(roomData.videoTime, roomData.videoStatus);
        } else {
            adminControls.classList.remove('hidden');
            waitingMessage.classList.add('hidden');
        }
    } else {
        if (roomData.hasVideo) {
            loadVideo(roomData.videoTime, roomData.videoStatus);
        }
    }
}

function emitSync(status) {
    socket.emit('syncVideo', {
        time: syncPlayer.currentTime,
        status: status
    });
}

function loadVideo(startTime = 0, initialStatus = 'paused') {
    adminControls.classList.add('hidden');
    waitingMessage.classList.add('hidden');
    playerContainer.classList.remove('hidden');

    syncPlayer.src = `/video/${currentRoomId}`;

    syncPlayer.onloadedmetadata = () => {
        syncPlayer.currentTime = startTime;
        if (initialStatus === 'playing') {
            // Need user interaction to autoplay in modern browsers,
            // but we'll try our best
            syncPlayer.play().catch(e => console.log("Autoplay prevented:", e));
        }
    };
}

// Handle video upload (Admin only)
uploadBtn.addEventListener('click', async () => {
    const file = videoUpload.files[0];
    if (!file) {
        uploadStatus.textContent = 'Please select a file first.';
        return;
    }

    const formData = new FormData();
    formData.append('video', file);

    uploadBtn.disabled = true;
    uploadStatus.textContent = 'Uploading... This might take a while for large files.';

    try {
        const response = await fetch(`/upload/${currentRoomId}`, {
            method: 'POST',
            body: formData
        });

        const result = await response.json();
        if (result.success) {
            uploadStatus.textContent = 'Upload complete!';
            loadVideo();
        } else {
            uploadStatus.textContent = 'Upload failed: ' + result.error;
            uploadBtn.disabled = false;
        }
    } catch (error) {
        uploadStatus.textContent = 'Upload error: ' + error.message;
        uploadBtn.disabled = false;
    }
});

// Socket Events for Video Sync
socket.on('videoReady', () => {
    if (!isUserAdmin) {
        appendMessage('System', 'The Admin has uploaded the video. Video is ready!');
        loadVideo();
    }
});

socket.on('syncVideo', ({ time, status }) => {
    if (isUserAdmin) return; // Admin is the source of truth

    ignoreSyncEvent = true;

    // Force sync if we are too far off (e.g. > 1 second difference due to buffering)
    const timeDiff = Math.abs(syncPlayer.currentTime - time);
    if (timeDiff > 1.0) {
        syncPlayer.currentTime = time;
    }

    if (status === 'playing' && syncPlayer.paused) {
        syncPlayer.play().catch(e => console.log("Play prevented:", e));
    } else if (status === 'paused' && !syncPlayer.paused) {
        syncPlayer.pause();
    }

    setTimeout(() => { ignoreSyncEvent = false; }, 100);
});

// --- Event Listeners: Fullscreen ---
fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
        if (videoWrapper.requestFullscreen) {
            videoWrapper.requestFullscreen();
        } else if (videoWrapper.webkitRequestFullscreen) { /* Safari */
            videoWrapper.webkitRequestFullscreen();
        } else if (videoWrapper.msRequestFullscreen) { /* IE11 */
            videoWrapper.msRequestFullscreen();
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) { /* Safari */
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) { /* IE11 */
            document.msExitFullscreen();
        }
    }
});

// Update button text depending on fullscreen state
document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
        fullscreenBtn.textContent = 'Exit Fullscreen';
    } else {
        fullscreenBtn.textContent = 'Toggle Fullscreen';
    }
});

exitFsBtn.addEventListener('click', () => {
    if (document.exitFullscreen) {
        document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
    } else if (document.msExitFullscreen) {
        document.msExitFullscreen();
    }
});


// --- Event Listeners: Landing ---

createBtn.addEventListener('click', () => {
    myNickname = nicknameInput.value.trim();
    if (!myNickname) {
        errorMsg.textContent = 'Please enter a nickname first.';
        return;
    }

    const newRoomId = generateRoomId();
    socket.emit('createRoom', { roomId: newRoomId, nickname: myNickname, userId: myUserId }, (response) => {
        if (response.success) {
            showPartyUI(newRoomId, response.isAdmin);
        } else {
            errorMsg.textContent = response.message || 'Failed to create room.';
        }
    });
});

joinBtn.addEventListener('click', () => {
    myNickname = nicknameInput.value.trim();
    const roomId = joinRoomIdInput.value.trim().toUpperCase();

    if (!myNickname) {
        errorMsg.textContent = 'Please enter a nickname first.';
        return;
    }
    if (!roomId) {
        errorMsg.textContent = 'Please enter a room ID.';
        return;
    }

    socket.emit('joinRoom', { roomId, nickname: myNickname, userId: myUserId }, (response) => {
        if (response.success) {
            showPartyUI(roomId, response.isAdmin, response);
        } else {
            errorMsg.textContent = response.message || 'Failed to join room.';
            // If the room doesn't exist anymore, clear auto-join info
            localStorage.removeItem('syncstream_lastRoomId');
        }
    });
});

// --- Anti-Sleep Heartbeat ---
// Render free tier sleeps after 15 minutes of HTTP inactivity.
// Pinging via standard fetch keeps the server awake while watching a long movie.
setInterval(() => {
    fetch('/ping').catch(err => console.log('Ping failed:', err));
}, 5 * 60 * 1000); // 5 minutes

// Auto-rejoin logic on socket connect/reconnect
// This handles both the initial page load AND background reconnects when wifi drops
socket.on('connect', () => {
    console.log('Socket connected/reconnected with ID:', socket.id);

    const lastRoomId = localStorage.getItem('syncstream_lastRoomId');
    const lastNickname = localStorage.getItem('syncstream_nickname');

    // Only auto-join if we have the credentials AND we aren't currently explicitly sitting on the landing page
    if (lastRoomId && lastNickname) {
        nicknameInput.value = lastNickname;
        joinRoomIdInput.value = lastRoomId;

        // Attempt to auto join
        socket.emit('joinRoom', { roomId: lastRoomId, nickname: lastNickname, userId: myUserId }, (response) => {
            if (response.success) {
                myNickname = lastNickname;
                showPartyUI(lastRoomId, response.isAdmin, response);
                appendMessage('System', 'You were automatically reconnected to the room.');
            } else {
                // If it fails (e.g., room was deleted because server slept), clear storage and show error
                localStorage.removeItem('syncstream_lastRoomId');
                errorMsg.textContent = "The room no longer exists (the server might have restarted). Please create a new one.";
                landingDiv.classList.remove('hidden');
                partyDiv.classList.add('hidden');
            }
        });
    }
});

// --- Event Listeners: Chat ---

function sendChatMessage(text) {
    if (text) {
        socket.emit('chatMessage', text);
    }
}

let overlayIdleTimer = null;

function showOverlayMessage(sender, text) {
    chatOverlay.classList.remove('hidden');
    chatOverlay.classList.remove('idle');

    const overlayMsg = document.createElement('div');
    overlayMsg.classList.add('overlay-msg');

    if (sender === 'System') {
        overlayMsg.style.fontStyle = 'italic';
        overlayMsg.textContent = text;
    } else {
        const strong = document.createElement('strong');
        strong.textContent = `${sender}: `;
        overlayMsg.appendChild(strong);
        overlayMsg.appendChild(document.createTextNode(text));
    }

    chatOverlay.appendChild(overlayMsg);

    // Cap at exactly 4 messages max
    while (chatOverlay.childElementCount > 4) {
        chatOverlay.removeChild(chatOverlay.firstElementChild);
    }

    // Reset global idle timer
    clearTimeout(overlayIdleTimer);
    overlayIdleTimer = setTimeout(() => {
        chatOverlay.classList.add('idle');
    }, 6000); // Wait 6 seconds before fading out the whole stack
}

function appendMessage(sender, text) {
    // Add to standard chat box
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message');
    if (sender === 'System') {
        msgDiv.classList.add('system');
        msgDiv.textContent = text;
    } else {
        const strong = document.createElement('strong');
        strong.textContent = `${sender}:`;
        msgDiv.appendChild(strong);
        msgDiv.appendChild(document.createTextNode(` ${text}`));
    }
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;

    // Also show it on the video overlay
    showOverlayMessage(sender, text);
}

sendBtn.addEventListener('click', () => {
    const text = chatInput.value.trim();
    if (text) {
        sendChatMessage(text);
        chatInput.value = '';
    }
});

chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendBtn.click();
    }
});

// Fast Reply in Fullscreen
fsSendBtn.addEventListener('click', () => {
    const text = fsChatInput.value.trim();
    if (text) {
        sendChatMessage(text);
        fsChatInput.value = '';
    }
});

fsChatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        fsSendBtn.click();
    }
});

socket.on('chatMessage', ({ sender, message }) => {
    appendMessage(sender, message);
});

leaveBtn.addEventListener('click', () => {
    // Clear session so we don't auto-rejoin
    localStorage.removeItem('syncstream_lastRoomId');
    // Refresh the page to reset state completely
    window.location.reload();
});
