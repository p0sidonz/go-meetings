const config = require('../config');

class Room {
  constructor(roomId, worker, io) {
    this.id = roomId;
    this.worker = worker;
    this.io = io;
    this.router = null;
    
    // Peers: { socketId: { id, name, isAdmin, transports, producers, consumers, rtpCapabilities, lang } }
    this.peers = new Map();
    
    // Pending Peers (waiting for approval): { socketId: { id, name, ... } }
    this.pendingPeers = new Map();
    
    this.autoApprove = false;
    
    // Host tracking for translation
    this.hostId = null;
    this.hostLang = 'en-US'; // Default host language
    
    // Track active translation sessions for host feedback
    this.activeTranslations = new Map(); // socketId -> { name, status, timestamp }
  }
  
  // Translation tracking methods
  updateTranslationStatus(socketId, name, status) {
    if (status === 'done' || status === 'idle') {
      this.activeTranslations.delete(socketId);
    } else {
      this.activeTranslations.set(socketId, { 
        name, 
        status, 
        timestamp: Date.now() 
      });
    }
    return this.getActiveTranslationSummary();
  }
  
  getActiveTranslationSummary() {
    const summary = {
      count: this.activeTranslations.size,
      clients: []
    };
    for (const [id, data] of this.activeTranslations) {
      summary.clients.push({ id, ...data });
    }
    return summary;
  }
  
  toggleAutoApprove(enabled) {
      this.autoApprove = enabled;
      console.log(`Room ${this.id} auto-approve set to ${enabled}`);
      
      // If enabled, approve all currently pending
      if (enabled) {
          for (const socketId of this.pendingPeers.keys()) {
              this.approvePeer(this.getAdminId(), socketId);
          }
      }
      return this.autoApprove;
  }
  
  getAdminId() {
      for (const peer of this.peers.values()) {
          if (peer.isAdmin) return peer.id;
      }
      return null;
  }

  async createRouter() {
    this.router = await this.worker.createRouter({
      mediaCodecs: config.mediasoup.router.mediaCodecs
    });
    return this.router;
  }

  addPeer(socket, name, lang = 'en-US') {
    // If first peer, they are Admin
    const isAdmin = this.peers.size === 0;
    
    const peer = {
      id: socket.id,
      socket: socket,
      name: name,
      isAdmin: isAdmin,
      lang: lang, // User's selected language
      joinedAt: Date.now(),
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      rtpCapabilities: null
    };

    if (isAdmin || this.autoApprove) {
      this.peers.set(socket.id, peer);
      const role = isAdmin ? 'Admin' : 'Participant (Auto-Approved)';
      console.log(`Peer ${name} (${socket.id}) joined room ${this.id} as ${role}`);
      
      // If this is the host (admin), store host info
      if (isAdmin) {
        this.hostId = socket.id;
        this.hostLang = lang;
        console.log(`Host language set to: ${lang}`);
      }
      
      // Notify others
      this.broadcast('new-peer', { 
          id: socket.id, 
          name: name,
          isAdmin: isAdmin,
          joinedAt: peer.joinedAt
      });
      
      return { 
          joined: true, 
          isAdmin: isAdmin,
          hostId: this.hostId,
          hostLang: this.hostLang,
          peers: this.getPeerList()
      };
    } else {
      // If not admin, add to pending
      this.pendingPeers.set(socket.id, peer);
      console.log(`Peer ${name} (${socket.id}) requesting to join room ${this.id}`);
      
      // Notify Admin(s)
      this.notifyAdmins('join-request', { socketId: socket.id, name: name });
      
      return { joined: false, isAdmin: false };
    }
  }

  removePeer(socketId) {
    if (this.peers.has(socketId)) {
        this.peers.delete(socketId);
        // TODO: Close transports/producers
    }
    if (this.pendingPeers.has(socketId)) {
        this.pendingPeers.delete(socketId);
    }
  }

  destroy() {
      // 1. Notify all peers
      this.broadcast('room-closed', { reason: 'Host ended the meeting' });

      // 2. Close router
      if (this.router && !this.router.closed) {
          this.router.close();
      }

      // 3. Clear peers
      this.peers.clear();
      this.pendingPeers.clear();
      
      console.log(`Room ${this.id} destroyed by Admin`);
  }

  approvePeer(adminSocketId, targetSocketId) {
    const admin = this.peers.get(adminSocketId);
    if (!admin || !admin.isAdmin) return false;
    
    const targetPeer = this.pendingPeers.get(targetSocketId);
    if (!targetPeer) return false;
    
    // Move from pending to peers
    this.pendingPeers.delete(targetSocketId);
    this.peers.set(targetSocketId, targetPeer);
    
    // Set joinedAt to now (approval time)
    targetPeer.joinedAt = Date.now();
    
    console.log(`Peer ${targetPeer.name} (${targetSocketId}) approved by Admin`);
    
    // Notify the user they are accepted
    targetPeer.socket.emit('room-joined', { 
        roomId: this.id, 
        isAdmin: false,
        hostId: this.hostId,
        hostLang: this.hostLang,
        peers: this.getPeerList()
    });

    // Notify others
    this.broadcast('new-peer', { 
        id: targetSocketId, 
        name: targetPeer.name,
        joinedAt: targetPeer.joinedAt
    });
    
    return true;
  }

  notifyAdmins(event, data) {
    for (const peer of this.peers.values()) {
      if (peer.isAdmin) {
        peer.socket.emit(event, data);
      }
    }
  }

  broadcast(event, data, excludeSocketId = null) {
      for (const peer of this.peers.values()) {
          if (peer.id !== excludeSocketId) {
              peer.socket.emit(event, data);
          }
      }
  }

  getPeerList() {
      const list = [];
      for (const peer of this.peers.values()) {
          const producers = [];
          for (const producer of peer.producers.values()) {
              producers.push({
                  id: producer.id,
                  kind: producer.kind
              });
          }
          list.push({ 
              id: peer.id, 
              name: peer.name, 
              isAdmin: peer.isAdmin,
              lang: peer.lang,
              joinedAt: peer.joinedAt,
              producers: producers
          });
      }
      return list;
  }
  
  getHostInfo() {
      return {
          hostId: this.hostId,
          hostLang: this.hostLang
      };
  }
  
  isHost(socketId) {
      return socketId === this.hostId;
  }

  // --- Mediasoup Methods ---

  async createWebRtcTransport(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer) throw new Error('Peer not found');

    const transport = await this.router.createWebRtcTransport({
      listenIps: config.mediasoup.webRtcTransport.listenIps,
      initialAvailableOutgoingBitrate: config.mediasoup.webRtcTransport.initialAvailableOutgoingBitrate,
      maxIncomingBitrate: config.mediasoup.webRtcTransport.maxIncomingBitrate,
    });

    transport.on('dtlsstatechange', (dtlsState) => {
      if (dtlsState === 'closed') transport.close();
    });

    transport.on('close', () => {
      console.log('Transport closed', transport.id);
    });

    peer.transports.set(transport.id, transport);

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectTransport(socketId, transportId, dtlsParameters) {
    const peer = this.peers.get(socketId);
    if (!peer) throw new Error('Peer not found');
    
    const transport = peer.transports.get(transportId);
    if (!transport) throw new Error(`Transport ${transportId} not found`);

    await transport.connect({ dtlsParameters });
  }

  async produce(socketId, transportId, kind, rtpParameters) {
    const peer = this.peers.get(socketId);
    if (!peer) throw new Error('Peer not found');

    const transport = peer.transports.get(transportId);
    if (!transport) throw new Error(`Transport ${transportId} not found`);

    const producer = await transport.produce({ kind, rtpParameters });

    peer.producers.set(producer.id, producer);

    producer.on('transportclose', () => {
      producer.close();
      peer.producers.delete(producer.id);
    });
    
    producer.on('close', () => {
        console.log('Producer closed', producer.id);
        peer.producers.delete(producer.id);
    });

    // Announce to others
    this.broadcast('new-producer', {
        producerId: producer.id,
        peerId: socketId,
        kind: kind
    }, socketId);

    return { id: producer.id };
  }

  async consume(socketId, consumerTransportId, producerId, rtpCapabilities) {
    const peer = this.peers.get(socketId);
    if (!peer) throw new Error('Peer not found');

    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      console.warn('Cannot consume', { producerId, rtpCapabilities });
      return null;
    }

    const transport = peer.transports.get(consumerTransportId);
    if (!transport) throw new Error(`Transport ${consumerTransportId} not found`);

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true // Start paused, waiting for client
    });

    peer.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => {
      consumer.close();
      peer.consumers.delete(consumer.id);
    });

    consumer.on('producerclose', () => {
        consumer.close();
        peer.consumers.delete(consumer.id);
        peer.socket.emit('consumer-closed', { consumerId: consumer.id });
    });

    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused
    };
  }
}

module.exports = Room;
