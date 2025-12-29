const https = require('https');
const fs = require('fs');
const express = require('express');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');
const config = require('./config');

const app = express();
let httpsServer;

try {
  let useHttps = fs.existsSync(config.sslKey) && fs.existsSync(config.sslCrt);
  
  // Force HTTP in production (behind proxy like Dokploy/Vercel)
  if (process.env.NODE_ENV === 'production') {
    useHttps = false;
  }

  if (useHttps) {
    const options = {
      key: fs.readFileSync(config.sslKey),
      cert: fs.readFileSync(config.sslCrt),
    };
    httpsServer = https.createServer(options, app);
  } else {
    // throw new Error('Certificates not found'); // Removed throw to allow fallback
    console.log('Using HTTP Server (Production or No Certs)');
    const http = require('http');
    httpsServer = http.createServer(app);
  }
} catch (err) {
  console.log('Error setting up server:', err);
  console.log('Falling back to HTTP');
  const http = require('http');
  httpsServer = http.createServer(app);
}

const io = socketIo(httpsServer);

app.use(express.static('public'));

let worker;

async function runMediasoupWorker() {
  let announcedIp = config.mediasoup.webRtcTransport.listenIps[0].announcedIp;
  if (announcedIp === '127.0.0.1' && process.env.NODE_ENV === 'production') {
    try {
      console.log('Fetching public IP...');
      const publicIp = await new Promise((resolve, reject) => {
        https.get('https://api.ipify.org', (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });
      console.log('Detected Public IP:', publicIp);
      config.mediasoup.webRtcTransport.listenIps[0].announcedIp = publicIp;
    } catch (err) {
      console.error('Failed to fetch public IP, using fallback:', announcedIp);
    }
  }

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

  socket.on('join-room', async ({ roomId, name, lang }, callback) => {
    let room = rooms.get(roomId);
    
    // Create room if not exists
    if (!room) {
      room = new Room(roomId, worker, io);
      await room.createRouter();
      rooms.set(roomId, room);
      console.log(`Created new room: ${roomId}`);
    }

    // Add peer with their selected language
    const result = room.addPeer(socket, name, lang || 'en-US');
    
    // Callback with status
    callback({
        joined: result.joined,
        isAdmin: result.isAdmin,
        hostId: result.hostId,
        hostLang: result.hostLang,
        peers: result.peers,
        waitingForApproval: !result.joined && !result.isAdmin
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        
        const peer = room.peers.get(socket.id);
        const isAdmin = peer && peer.isAdmin;

        if (isAdmin) {
            console.log('Admin left, destroying room...');
            room.destroy();
            rooms.delete(roomId);
        } else {
            room.removePeer(socket.id);
            if (room.peers.size === 0 && room.pendingPeers.size === 0) {
                rooms.delete(roomId);
                console.log(`Room ${roomId} deleted (empty)`);
            } else {
                 room.broadcast('peer-left', { id: socket.id });
            }
        }
    });

    // Admin approval listener
    socket.on('approve-peer', ({ targetSocketId }, cb) => {
        const success = room.approvePeer(socket.id, targetSocketId);
        if (cb) cb({ success });
    });

    // Subtitle relay
    socket.on('subtitle', (data) => {
        const isHost = room.isHost(socket.id);
        const hostInfo = room.getHostInfo();
        
        // If host is speaking, broadcast status to all clients first
        if (isHost) {
            room.broadcast('host-status', {
                status: 'speaking',
                hostName: name,
                timestamp: Date.now()
            });
        }
        
        // Broadcast to everyone else in the room
        room.broadcast('subtitle', {
            id: socket.id,
            name: name, // from closure
            text: data.text,
            lang: data.lang,
            isHost: isHost,
            hostLang: hostInfo.hostLang
        }, socket.id);
    });
    
    // Client sends back translation status feedback (for host awareness)
    socket.on('translation-status', (data) => {
        const summary = room.updateTranslationStatus(socket.id, name, data.status);
        
        // Notify host about translation activity
        room.notifyAdmins('translation-activity', {
            clientId: socket.id,
            clientName: name,
            status: data.status, // 'translating' | 'playing' | 'done'
            summary: summary
        });
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

    socket.on('close-producer', ({ producerId }, callback) => {
        const peer = room.peers.get(socket.id);
        if (!peer) return;
        const producer = peer.producers.get(producerId);
        if (producer) {
            producer.close(); // This triggers producer.on('close') which triggers consumer.on('producerclose')
            peer.producers.delete(producerId);
            if(callback) callback({ success: true });
        }
    });

    socket.on('toggle-auto-approve', ({ enabled }, callback) => {
        const peer = room.peers.get(socket.id);
        if (peer && peer.isAdmin) {
            const newState = room.toggleAutoApprove(enabled);
            callback({ enabled: newState });
        } else {
             callback({ error: 'Unauthorized' });
        }
    });
  });
});
