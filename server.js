const https = require('https');
const fs = require('fs');
const express = require('express');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');
const config = require('./config');

const app = express();
let httpsServer;

try {
  if (fs.existsSync(config.sslKey) && fs.existsSync(config.sslCrt)) {
    const options = {
      key: fs.readFileSync(config.sslKey),
      cert: fs.readFileSync(config.sslCrt),
    };
    httpsServer = https.createServer(options, app);
  } else {
    throw new Error('Certificates not found');
  }
} catch (err) {
  console.log('SSL certificates not found or invalid, falling back to HTTP (suitable for Vercel/proxies)');
  const http = require('http');
  httpsServer = http.createServer(app);
}

const io = socketIo(httpsServer);

app.use(express.static('public'));

let worker;

async function runMediasoupWorker() {
  worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });

  console.log('Mediasoup Worker created [pid:%d]', worker.pid);
}

// Global rooms map
// Map<roomId, Room>
const rooms = new Map();

const Room = require('./src/room');

(async () => {
  try {
    await runMediasoupWorker();
    
    const port = process.env.PORT || config.listenPort;
    httpsServer.listen(port, () => {
      console.log(`Server running at ${port} (https: ${!!httpsServer.key})`);
    });
  } catch (err) {
    console.error(err);
  }
})();

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('join-room', async ({ roomId, name }, callback) => {
    let room = rooms.get(roomId);
    
    // Create room if not exists
    if (!room) {
      room = new Room(roomId, worker, io);
      await room.createRouter();
      rooms.set(roomId, room);
      console.log(`Created new room: ${roomId}`);
    }

    // Add peer
    const result = room.addPeer(socket, name);
    
    // Callback with status
    callback({
        joined: result.joined,
        isAdmin: result.isAdmin,
        waitingForApproval: !result.joined && !result.isAdmin
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        room.removePeer(socket.id);
        if (room.peers.size === 0 && room.pendingPeers.size === 0) {
            rooms.delete(roomId);
            console.log(`Room ${roomId} deleted (empty)`);
        } else {
             room.broadcast('peer-left', { id: socket.id });
        }
    });

    // Admin approval listener
    socket.on('approve-peer', ({ targetSocketId }, cb) => {
        const success = room.approvePeer(socket.id, targetSocketId);
        if (cb) cb({ success });
    });

    // Subtitle relay
    socket.on('subtitle', (data) => {
        // Broadcast to everyone else in the room
        room.broadcast('subtitle', {
            id: socket.id,
            name: name, // from closure
            text: data.text,
            lang: data.lang
        }, socket.id);
    });
    
    // --- Mediasoup Signaling ---
    
    socket.on('getRouterRtpCapabilities', (data, callback) => {
        if (room.router) {
            callback(room.router.rtpCapabilities);
        } else {
            callback(null);
        }
    });

    socket.on('createWebRtcTransport', async (data, callback) => {
        try {
            const params = await room.createWebRtcTransport(socket.id);
            callback(params);
        } catch (err) {
            console.error(err);
            callback({ error: err.message });
        }
    });

    socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
        try {
            await room.connectTransport(socket.id, transportId, dtlsParameters);
            callback({ success: true });
        } catch (err) {
            console.error(err);
            callback({ error: err.message });
        }
    });

    socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
        try {
            const { id } = await room.produce(socket.id, transportId, kind, rtpParameters);
            callback({ id });
        } catch (err) {
            console.error(err);
            callback({ error: err.message });
        }
    });

    socket.on('consume', async ({ consumerTransportId, producerId, rtpCapabilities }, callback) => {
        try {
            const params = await room.consume(socket.id, consumerTransportId, producerId, rtpCapabilities);
            callback(params);
        } catch (err) {
            console.error(err);
            callback({ error: err.message });
        }
    });
    
    socket.on('resume', async ({ consumerId }, callback) => {
        // Implement resume logic if needed (consumer.resume())
        // For simplicity, we can auto-resume on client side or implement here
        const peer = room.peers.get(socket.id);
        const consumer = peer.consumers.get(consumerId);
        if (consumer) {
            await consumer.resume();
            callback({ success: true });
        }
    });
  });
});
