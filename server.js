const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Middleware to serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
// Middleware to parse JSON
app.use(express.json());

// Ensure uploads directory exists
if (!fs.existsSync('uploads/')){
    fs.mkdirSync('uploads/', { recursive: true });
}

// In-memory store for rooms
// Structure: roomId -> {
//   adminId: string (userId of admin),
//   users: Map<userId, {socketId, nickname}>,
//   videoTime: number,
//   videoStatus: 'playing' | 'paused',
//   hasVideo: boolean,
//   videoPath: string,
//   videoUrl: string | null,
//   cleanupTimer: NodeJS.Timeout | null
// }
const rooms = {};

// Set up multer for video uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        // Sanitize roomId to prevent path traversal attacks
        const safeRoomId = path.basename(req.params.roomId);
        cb(null, safeRoomId + path.extname(file.originalname));
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 4 * 1024 * 1024 * 1024 } // 4GB limit
});

// Middleware to check if room exists before processing upload
const checkRoomExists = (req, res, next) => {
    const safeRoomId = path.basename(req.params.roomId);
    if (!rooms[safeRoomId]) {
        return res.status(404).json({ error: 'Room not found' });
    }
    // Update req.params.roomId to strictly be the safe version for multer
    req.params.roomId = safeRoomId;
    next();
};

// --- Express Endpoints for Video Upload & Streaming ---

// Keep-alive endpoint to prevent Render from sleeping
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

app.post('/upload/:roomId', checkRoomExists, upload.single('video'), (req, res) => {
    const roomId = req.params.roomId;

    if (!req.file) {
        return res.status(400).json({ error: 'No video file uploaded' });
    }

    // Update room state
    rooms[roomId].hasVideo = true;
    rooms[roomId].videoPath = req.file.path;

    // Notify all users in the room that video is ready
    // Add a small delay to ensure file system has flushed the file and it's readable
    setTimeout(() => {
        io.to(roomId).emit('videoReady');
    }, 500);

    res.json({ success: true, message: 'Video uploaded successfully' });
});

app.get('/video/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    const room = rooms[roomId];

    if (!room || !room.hasVideo || !room.videoPath) {
        return res.status(404).send('Video not found');
    }

    const videoPath = room.videoPath;
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (start >= fileSize) {
            res.status(416).send('Requested range not satisfiable\n' + start + ' >= ' + fileSize);
            return;
        }

        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(videoPath, { start, end });

        const ext = path.extname(videoPath).toLowerCase();
        let mimeType = 'video/mp4';
        if (ext === '.webm') mimeType = 'video/webm';
        else if (ext === '.ogg' || ext === '.ogv') mimeType = 'video/ogg';
        else if (ext === '.mkv') mimeType = 'video/x-matroska';

        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': mimeType,
        };

        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const ext = path.extname(videoPath).toLowerCase();
        let mimeType = 'video/mp4';
        if (ext === '.webm') mimeType = 'video/webm';
        else if (ext === '.ogg' || ext === '.ogv') mimeType = 'video/ogg';
        else if (ext === '.mkv') mimeType = 'video/x-matroska';

        const head = {
            'Content-Length': fileSize,
            'Content-Type': mimeType,
        };
        res.writeHead(200, head);
        fs.createReadStream(videoPath).pipe(res);
    }
});


io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('createRoom', ({ roomId, nickname, userId }, callback) => {
        if (rooms[roomId]) {
            return callback({ success: false, message: 'Room already exists.' });
        }

        rooms[roomId] = {
            adminId: userId,
            users: new Map(),
            videoTime: 0,
            videoStatus: 'paused',
            hasVideo: false,
            videoUrl: null,
            cleanupTimer: null
        };

        rooms[roomId].users.set(userId, { socketId: socket.id, nickname });

        socket.join(roomId);
        socket.data.nickname = nickname;
        socket.data.roomId = roomId;
        socket.data.userId = userId;

        console.log(`Room ${roomId} created by ${userId} (${nickname})`);
        callback({ success: true, isAdmin: true });
    });

    socket.on('joinRoom', ({ roomId, nickname, userId }, callback) => {
        const room = rooms[roomId];
        if (!room) {
            return callback({ success: false, message: 'Room does not exist.' });
        }

        // Clear cleanup timer if someone joins
        if (room.cleanupTimer) {
            clearTimeout(room.cleanupTimer);
            room.cleanupTimer = null;
        }

        room.users.set(userId, { socketId: socket.id, nickname });
        socket.join(roomId);
        socket.data.nickname = nickname;
        socket.data.roomId = roomId;
        socket.data.userId = userId;

        const isAdmin = (room.adminId === userId);

        console.log(`User ${userId} (${nickname}) joined room ${roomId}. Is Admin? ${isAdmin}`);

        // Notify others in the room
        socket.to(roomId).emit('chatMessage', { sender: 'System', message: `${nickname} joined the party!` });

        callback({
            success: true,
            isAdmin: isAdmin,
            hasVideo: room.hasVideo,
            videoTime: room.videoTime,
            videoStatus: room.videoStatus,
            videoUrl: room.videoUrl
        });
    });

    socket.on('chatMessage', (message) => {
        const roomId = socket.data.roomId;
        if (roomId && rooms[roomId]) {
            io.to(roomId).emit('chatMessage', { sender: socket.data.nickname, message });
        }
    });



    socket.on('sendReaction', ({ emoji }) => {
        const roomId = socket.data.roomId;
        if (roomId && rooms[roomId]) {
            io.to(roomId).emit('receiveReaction', { emoji });
        }
    });

    // Admin sets external video URL
    socket.on('setVideoUrl', ({ url }) => {
        const roomId = socket.data.roomId;
        const userId = socket.data.userId;

        if (roomId && rooms[roomId] && rooms[roomId].adminId === userId) {
            rooms[roomId].hasVideo = true;
            rooms[roomId].videoUrl = url;
            // Clear any local path if they switched to URL
            rooms[roomId].videoPath = null;

            io.to(roomId).emit('videoReady', { url: url });
        }
    });

    // Admin video controls sync
    socket.on('syncVideo', ({ time, status }) => {
        const roomId = socket.data.roomId;
        const userId = socket.data.userId;

        if (roomId && rooms[roomId] && rooms[roomId].adminId === userId) {
            rooms[roomId].videoTime = time;
            rooms[roomId].videoStatus = status;

            // Broadcast to everyone else in the room
            socket.to(roomId).emit('syncVideo', { time, status });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        const roomId = socket.data.roomId;
        const userId = socket.data.userId;

        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];

            // Only remove them if the socket matches (in case they reconnected on a new socket before the old one timed out)
            const userData = room.users.get(userId);
            if (userData && userData.socketId === socket.id) {
                room.users.delete(userId);
                socket.to(roomId).emit('chatMessage', { sender: 'System', message: `${socket.data.nickname} disconnected (they might be refreshing).` });

                // If room is empty, start the 2-minute cleanup timer
                if (room.users.size === 0) {
                    console.log(`Room ${roomId} is empty. Starting 2-minute cleanup timer.`);
                    room.cleanupTimer = setTimeout(() => {
                        console.log(`Cleaning up empty room: ${roomId}`);
                        if (rooms[roomId].hasVideo && rooms[roomId].videoPath) {
                            try {
                                fs.unlinkSync(rooms[roomId].videoPath);
                                console.log(`Deleted video file: ${rooms[roomId].videoPath}`);
                            } catch (err) {
                                console.error(`Error deleting video file for room ${roomId}:`, err);
                            }
                        }
                        delete rooms[roomId];
                    }, 2 * 60 * 1000); // 2 minutes
                }
            }
        }
    });
});

// Ensure we listen on all interfaces for Render or other hostings
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
console.log("Ready for deployment!");
