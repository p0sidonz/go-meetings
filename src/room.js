const config = require('../config');

class Room {
  constructor(roomId, worker, io) {
    this.id = roomId;
    this.worker = worker;
    this.io = io;
    this.router = null;
    
    // Peers: { socketId: { id, name, isAdmin, transports, producers, consumers, rtpCapabilities } }
    this.peers = new Map();
    
    // Pending Peers (waiting for approval): { socketId: { id, name, ... } }
    this.pendingPeers = new Map();
  }

  async createRouter() {
    this.router = await this.worker.createRouter({
      mediaCodecs: config.mediasoup.router.mediaCodecs
    });
    return this.router;
  }

  addPeer(socket, name) {
    // If first peer, they are Admin
    const isAdmin = this.peers.size === 0;
    
    const peer = {
      id: socket.id,
      socket: socket,
      name: name,
      isAdmin: isAdmin,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      rtpCapabilities: null
    };

    if (isAdmin) {
      this.peers.set(socket.id, peer);
      console.log(`Peer ${name} (${socket.id}) joined room ${this.id} as Admin`);
      return { joined: true, isAdmin: true };
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
  
  approvePeer(adminSocketId, targetSocketId) {
    const admin = this.peers.get(adminSocketId);
    if (!admin || !admin.isAdmin) return false;
    
    const targetPeer = this.pendingPeers.get(targetSocketId);
    if (!targetPeer) return false;
    
    // Move from pending to peers
    this.pendingPeers.delete(targetSocketId);
    this.peers.set(targetSocketId, targetPeer);
    
    console.log(`Peer ${targetPeer.name} (${targetSocketId}) approved by Admin`);
    
    // Notify the user they are accepted
    targetPeer.socket.emit('room-joined', { 
        roomId: this.id, 
        isAdmin: false,
        peers: this.getPeerList()
    });

    // Notify others
    this.broadcast('new-peer', { id: targetSocketId, name: targetPeer.name });
    
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
              producers: producers
          });
      }
      return list;
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
