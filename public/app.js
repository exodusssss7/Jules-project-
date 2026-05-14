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
const fullscreenBtn = document.getElementById('fullscreenBtn');
const chatOverlay = document.getElementById('chatOverlay');

// State
let currentRoomId = null;
let isUserAdmin = false;
let myNickname = '';

// --- Navigation & Setup ---

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function showPartyUI(roomId, isAdmin, roomData = {}) {
    currentRoomId = roomId;
    isUserAdmin = isAdmin;

    landingDiv.classList.add('hidden');
    partyDiv.classList.remove('hidden');

    displayRoomId.textContent = roomId;

    setupVideoUI(roomData);
}

// --- Video & Sync Logic ---

let ignoreSyncEvent = false;

function setupVideoUI(roomData) {
    if (isUserAdmin) {
        adminControls.classList.remove('hidden');
        waitingMessage.classList.add('hidden');

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
        setInterval(() => {
            if (!syncPlayer.paused && !ignoreSyncEvent) {
                emitSync('playing');
            }
        }, 3000); // Send sync every 3 seconds

    } else {
        // Normal user
        syncPlayer.controls = false; // Disable default controls
        syncPlayer.style.pointerEvents = 'none'; // Prevent clicking to pause

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


// --- Event Listeners: Landing ---

createBtn.addEventListener('click', () => {
    myNickname = nicknameInput.value.trim();
    if (!myNickname) {
        errorMsg.textContent = 'Please enter a nickname first.';
        return;
    }

    const newRoomId = generateRoomId();
    socket.emit('createRoom', { roomId: newRoomId, nickname: myNickname }, (response) => {
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

    socket.emit('joinRoom', { roomId, nickname: myNickname }, (response) => {
        if (response.success) {
            showPartyUI(roomId, response.isAdmin, response);
        } else {
            errorMsg.textContent = response.message || 'Failed to join room.';
        }
    });
});

// --- Event Listeners: Chat ---

function showOverlayMessage(sender, text) {
    chatOverlay.classList.remove('hidden');

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

    // Automatically remove the message from the DOM after animation completes (4s)
    setTimeout(() => {
        if (chatOverlay.contains(overlayMsg)) {
            chatOverlay.removeChild(overlayMsg);
        }
    }, 4000);
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
        socket.emit('chatMessage', text);
        chatInput.value = '';
    }
});

chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendBtn.click();
    }
});

socket.on('chatMessage', ({ sender, message }) => {
    appendMessage(sender, message);
});

// --- Event Listeners: Leave ---
leaveBtn.addEventListener('click', () => {
    // Refresh the page to reset state completely
    window.location.reload();
});