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

// Set up multer for video uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        // Use roomId to name the file
        cb(null, req.params.roomId + path.extname(file.originalname));
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 4 * 1024 * 1024 * 1024 } // 4GB limit
});

// In-memory store for rooms
// Structure: roomId -> { admin: socketId, users: Set<socketId>, videoTime: number, videoStatus: 'playing' | 'paused', hasVideo: boolean, videoPath: string }
const rooms = {};

// --- Express Endpoints for Video Upload & Streaming ---

app.post('/upload/:roomId', upload.single('video'), (req, res) => {
    const roomId = req.params.roomId;
    if (!rooms[roomId]) {
        return res.status(404).json({ error: 'Room not found' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'No video file uploaded' });
    }

    // Update room state
    rooms[roomId].hasVideo = true;
    rooms[roomId].videoPath = req.file.path;

    // Notify all users in the room that video is ready
    io.to(roomId).emit('videoReady');

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

    socket.on('createRoom', ({ roomId, nickname }, callback) => {
        if (rooms[roomId]) {
            return callback({ success: false, message: 'Room already exists.' });
        }

        rooms[roomId] = {
            admin: socket.id,
            users: new Set([socket.id]),
            videoTime: 0,
            videoStatus: 'paused',
            hasVideo: false
        };

        socket.join(roomId);
        socket.data.nickname = nickname;
        socket.data.roomId = roomId;

        console.log(`Room ${roomId} created by ${socket.id} (${nickname})`);
        callback({ success: true, isAdmin: true });
    });

    socket.on('joinRoom', ({ roomId, nickname }, callback) => {
        const room = rooms[roomId];
        if (!room) {
            return callback({ success: false, message: 'Room does not exist.' });
        }

        room.users.add(socket.id);
        socket.join(roomId);
        socket.data.nickname = nickname;
        socket.data.roomId = roomId;

        console.log(`User ${socket.id} (${nickname}) joined room ${roomId}`);

        // Notify others in the room
        socket.to(roomId).emit('chatMessage', { sender: 'System', message: `${nickname} joined the party!` });

        callback({
            success: true,
            isAdmin: false,
            hasVideo: room.hasVideo,
            videoTime: room.videoTime,
            videoStatus: room.videoStatus
        });
    });

    socket.on('chatMessage', (message) => {
        const roomId = socket.data.roomId;
        if (roomId && rooms[roomId]) {
            io.to(roomId).emit('chatMessage', { sender: socket.data.nickname, message });
        }
    });

    // Admin video controls sync
    socket.on('syncVideo', ({ time, status }) => {
        const roomId = socket.data.roomId;
        if (roomId && rooms[roomId] && rooms[roomId].admin === socket.id) {
            rooms[roomId].videoTime = time;
            rooms[roomId].videoStatus = status;

            // Broadcast to everyone else in the room
            socket.to(roomId).emit('syncVideo', { time, status });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        const roomId = socket.data.roomId;

        if (roomId && rooms[roomId]) {
            rooms[roomId].users.delete(socket.id);
            socket.to(roomId).emit('chatMessage', { sender: 'System', message: `${socket.data.nickname} left the party.` });

            if (rooms[roomId].admin === socket.id) {
                // Admin left, you might want to reassign admin or close room
                socket.to(roomId).emit('chatMessage', { sender: 'System', message: 'The Admin has left the party. The room might be closed.' });
                // For simplicity, let's just delete the room if admin leaves, or we could keep it.
                // delete rooms[roomId];
            } else if (rooms[roomId].users.size === 0) {
                // Clean up empty room
                delete rooms[roomId];
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
