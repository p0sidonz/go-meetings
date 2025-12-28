const socket = io();

// UI Elements
const loginSection = document.getElementById('login-section');
const waitingSection = document.getElementById('waiting-section');
const roomSection = document.getElementById('room-section');
const roomIdInput = document.getElementById('room-id');
const usernameInput = document.getElementById('username');
const joinBtn = document.getElementById('join-btn');
const participantsContainer = document.getElementById('participants-container');
const subtitlesArea = document.getElementById('subtitles-area');
const languageSelect = document.getElementById('language');
const micBtn = document.getElementById('mic-btn');

let recognition;
let isMicOn = false;
let myPeerId;
let amIAdmin = false;
let translatedVoiceOnly = false; // If true, mute original audio and only use TTS

// Host tracking for translation
let hostPeerId = null;
let hostLang = 'en-US';

// Transcript entries storage
let transcriptEntries = [];
let transcriptVisible = false;

// Mediasoup
let device;
let sendTransport;
let recvTransport;
let audioProducer;
let consumerTransports = [];
let audioConsumers = new Map(); // consumerId -> consumer

// Preload speech synthesis voices for reliable TTS
let cachedVoices = [];
function preloadVoices() {
    return new Promise((resolve) => {
        const voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
            cachedVoices = voices;
            resolve(voices);
        } else {
            speechSynthesis.onvoiceschanged = () => {
                cachedVoices = window.speechSynthesis.getVoices();
                resolve(cachedVoices);
            };
        }
    });
}
// Initialize voices on load
preloadVoices();

joinBtn.addEventListener('click', () => {
  const roomId = roomIdInput.value.trim();
  const name = usernameInput.value.trim();
  const lang = languageSelect.value;
  
  if (!roomId || !name) return alert('Please enter Room ID and Name');
  
  socket.emit('join-room', { roomId, name, lang }, async (response) => {
    if (response.joined) {
      // Store host info
      hostPeerId = response.hostId;
      hostLang = response.hostLang || 'en-US';
      
      enterRoom(roomId, response.isAdmin);
      await initMediasoup();
      
      if (response.peers) {
          await handlePeersAndConsumers(response.peers);
      }
    } else if (response.waitingForApproval) {
      showWaiting();
    }
  });
});

socket.on('room-joined', async (data) => {
  // Store host info
  hostPeerId = data.hostId;
  hostLang = data.hostLang || 'en-US';
  
  enterRoom(data.roomId, data.isAdmin);
  // Initialize Mediasoup
  await initMediasoup();
  await handlePeersAndConsumers(data.peers);
});

async function handlePeersAndConsumers(peers) {
  console.log('handlePeersAndConsumers called with peers:', peers);
  updatePeers(peers);
  
  // Consume existing producers
  for (const peer of peers) {
      if (peer.id === socket.id) {
          console.log('Skipping self:', peer.id);
          continue;
      }
      console.log(`Processing peer ${peer.name} (${peer.id}), producers:`, peer.producers);
      if (peer.producers && peer.producers.length > 0) {
          for (const producer of peer.producers) {
              if (producer.kind === 'audio') {
                  console.log(`Consuming audio producer ${producer.id} from ${peer.name}`);
                  await consumeAudio(producer.id, peer.id);
              } else if (producer.kind === 'video') {
                  console.log(`Consuming video producer ${producer.id} from ${peer.name}`);
                  await consumeVideo(producer.id, peer.id);
              }
          }
      } else {
          console.log(`Peer ${peer.name} has no producers`);
      }
  }
  console.log('handlePeersAndConsumers completed');
}

socket.on('new-producer', async (data) => {
    // Someone started producing audio or video
    console.log('new-producer event received:', data);
    
    if (data.peerId === socket.id) {
        console.log('Ignoring own producer');
        return;
    }
    
    if (data.kind === 'audio') {
        console.log(`Attempting to consume audio from peer ${data.peerId}`);
        await consumeAudio(data.producerId, data.peerId);
    } else if (data.kind === 'video') {
        console.log(`Attempting to consume video from peer ${data.peerId}`);
        await consumeVideo(data.producerId, data.peerId);
    }
});

socket.on('consumer-closed', ({ consumerId }) => {
    if (audioConsumers.has(consumerId)) {
        const consumer = audioConsumers.get(consumerId);
        consumer.close();
        audioConsumers.delete(consumerId);
    }
    if (videoConsumers.has(consumerId)) {
        const consumer = videoConsumers.get(consumerId);
        consumer.close();
        videoConsumers.delete(consumerId);
        
        // Remove video element from DOM
        const videoEl = document.getElementById(`share-${consumerId}`);
        if (videoEl) videoEl.remove();
    }
});

socket.on('room-closed', ({ reason }) => {
    alert(`Meeting ended: ${reason}`);
    window.location.reload();
});

socket.on('join-request', (data) => {
  if (amIAdmin) {
    addJoinRequest(data);
  }
});

socket.on('new-peer', (data) => {
  // Simple check to avoid duplicates if necessary, though list refresh is safer
  // For now, let's just append
  addPeerToUI(data);
});

socket.on('peer-left', (data) => {
  const el = document.getElementById(`peer-${data.id}`);
  if (el) {
      el.classList.add('left');
      const timeDiv = el.querySelector('.peer-time');
      if (timeDiv) {
          const leaveTime = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
          timeDiv.innerText = `Left at ${leaveTime}`;
      }
      
      // Move to bottom of list? Optional, but good for active users visibility
      // participantsContainer.appendChild(el); 
  }
});

socket.on('subtitle', async (data) => {
    const myLangFull = languageSelect.value;  // e.g., 'en-US'
    const myLang = myLangFull.split('-')[0];  // e.g., 'en'
    const sourceLang = data.lang.split('-')[0];  // e.g., 'hi'
    
    let displayText = data.text;
    let langLabel = data.lang;
    let wasTranslated = false;

    // Only translate if this is from the HOST
    if (data.isHost) {
        // Show speaking indicator
        updateHostSpeakingIndicator('speaking');
        
        // Only translate and TTS if translate mode is active
        if (translatedVoiceOnly) {
            // Translate host's speech to listener's selected language
            if (myLang !== sourceLang) {
                updateHostSpeakingIndicator('translating');
                try {
                    const translated = await translateText(data.text, sourceLang, myLang);
                    displayText = translated;
                    langLabel = `${sourceLang}→${myLang}`;
                    wasTranslated = true;
                } catch (e) {
                    console.error('Translation failed', e);
                }
            }
            
            // TTS for host speech (only when translate mode is active)
            speakText(displayText, myLangFull);
        }
        // If translatedVoiceOnly is false, user hears original voice via Mediasoup
        
        // Reset indicator after a delay
        setTimeout(() => updateHostSpeakingIndicator('idle'), 3000);
    }
    // Participant voice: no translation, no TTS - just native display
    // Audio plays via Mediasoup (native voice)

    // Add to scrollable transcript
    addTranscriptEntry(data.name, displayText, langLabel, data.isHost, wasTranslated);
});

function speakText(text, langCode) {
    if (!window.speechSynthesis) return;
    
    const utterance = new SpeechSynthesisUtterance(text);
    
    // Set the lang property for the utterance (BCP 47 code like 'en-US')
    utterance.lang = langCode;
    
    // Use cached voices or fetch fresh
    const voices = cachedVoices.length > 0 ? cachedVoices : window.speechSynthesis.getVoices();
    
    // Priority 1: Exact match (e.g., 'en-US' matches 'en-US')
    let voice = voices.find(v => v.lang === langCode);
    
    // Priority 2: Language prefix match (e.g., 'en' matches 'en-GB')
    if (!voice) {
        const shortLang = langCode.split('-')[0];
        voice = voices.find(v => v.lang.startsWith(shortLang));
    }
    
    if (voice) {
        utterance.voice = voice;
        console.log(`TTS using voice: ${voice.name} (${voice.lang}) for target: ${langCode}`);
    } else {
        console.log(`TTS: No matching voice found for ${langCode}, using browser default`);
    }
    
    utterance.rate = 1.0;
    
    utterance.onstart = () => {
        console.log('TTS started, pausing recognition...');
        if (recognition && isMicOn) {
            recognition.stop();
            window.isSpeaking = true;
        }
    };
    
    utterance.onend = () => {
        console.log('TTS ended, resuming recognition...');
        window.isSpeaking = false;
        if (recognition && isMicOn) {
            try { recognition.start(); } catch(e) {}
        }
    };

    window.speechSynthesis.speak(utterance);
}

async function translateText(text, source, target) {
    // Using self-hosted LibreTranslate API
    const url = 'https://translate-api.iankit.me/translate';
    
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                q: text,
                source: source,
                target: target,
                api_key: '6fe28963-c1e1-451b-91a4-985e835bc69c'
            })
        });
        
        const data = await res.json();
        if (data.translatedText) {
            return data.translatedText;
        }
        console.warn('Translation response missing translatedText:', data);
        return text;
    } catch (err) {
        console.error('Translation error:', err);
        return text;
    }
}

micBtn.addEventListener('click', toggleMic);

async function toggleMic() {
    if (isMicOn) {
        // Stop Mic (and recognition)
        if (recognition) recognition.stop();
        
        // Close Mediasoup Producer
        if (audioProducer) {
            audioProducer.close();
            audioProducer = null;
        }
        
        isMicOn = false;
        micBtn.innerHTML = '<span class="material-icons">mic_off</span>';
        micBtn.classList.remove('active');
        // micBtn.style.background = '#007bff';
    } else {
        // Start Mic (and recognition)
        startRecognition();
        
        // Start Mediasoup Producer
        try {
            await produceAudio();
            isMicOn = true;
            micBtn.innerHTML = '<span class="material-icons">mic</span>';
            micBtn.classList.add('active');
            micBtn.classList.remove('off'); // if we had an off class
        } catch (e) {
            console.error('Failed to produce audio:', e);
            console.error('Failed to produce audio:', e);
            alert(`Microphone access failed: ${e.message}\nName: ${e.name}\nPlease ensure you have allowed microphone permissions and are using HTTPS.`);
            recognition.stop(); // Stop STT if audio failed
        }
    }
}


function startRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        alert('Browser does not support Speech API');
        return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = languageSelect.value;
    recognition.continuous = true;
    recognition.interimResults = false;

    let recognitionTimeout;
    let lastSentIndex = 0;
    
    recognition.onresult = (event) => {
        // Collect all transcripts from the last sent index up to the current last result
        let currentBuffer = "";
        
        for (let i = lastSentIndex; i < event.results.length; ++i) {
            if (event.results[i][0].transcript) {
                 currentBuffer += event.results[i][0].transcript + " ";
            }
        }
        
        const finalText = currentBuffer.trim();
        if (!finalText) return;

        console.log('Buffered partial:', finalText);
        
        // Clear existing timeout
        if (recognitionTimeout) clearTimeout(recognitionTimeout);
        
        // Set new timeout (silence detection)
        recognitionTimeout = setTimeout(() => {
            console.log('Final Buffer sending:', finalText);
            
            // If I am host, update speaking indicator
            if (amIAdmin) {
                updateHostSpeakingIndicator('speaking');
                setTimeout(() => updateHostSpeakingIndicator('idle'), 3000);
            }
            
            // Emit to server
            socket.emit('subtitle', { 
                roomId: document.getElementById('current-room-id').innerText,
                text: finalText,
                lang: recognition.lang
            });
            
            // Add own speech to transcript (no translation for self)
            addTranscriptEntry('Me', finalText, recognition.lang, amIAdmin, false);
            
            // Mark these indices as processed
            lastSentIndex = event.results.length;
            
        }, 800); // Reduced from 1500ms for faster response
    };

    recognition.onerror = (event) => {
        console.error('Speech recognition error', event.error);
    };
    
    recognition.onend = () => {
        // Auto restart if mic is supposed to be on AND we are not speaking via TTS
        if (isMicOn && !window.isSpeaking) {
            try {
                 recognition.start();
            } catch (e) {
                console.log('Recognition restart ignored', e);
            }
        }
    };

    recognition.start();
}

// --- Mediasoup Logic ---

async function initMediasoup() {
    console.log('initMediasoup starting...');
    console.log('window.mediasoupClient:', window.mediasoupClient);
    
    if (!window.mediasoupClient) {
        console.error('CRITICAL: mediasoupClient is not defined. Check script loading.');
        return;
    }

    try {
        device = new mediasoupClient.Device();
        console.log('Mediasoup Device created:', device);
        
        // Get Router Capabilities
        const rtpCapabilities = await new Promise((resolve) => {
            socket.emit('getRouterRtpCapabilities', {}, (data) => resolve(data));
        });

        if (!rtpCapabilities) {
            console.error('No RTP Capabilities');
            return;
        }
        
        await device.load({ routerRtpCapabilities: rtpCapabilities });
        console.log('Mediasoup Device loaded');
        
        // Create Transports
        await createSendTransport();
        await createRecvTransport();
        
    } catch (e) {
        console.error('Mediasoup init error:', e);
    }
}

async function createSendTransport() {
    return new Promise((resolve, reject) => {
        socket.emit('createWebRtcTransport', {}, async (params) => {
            if (params.error) {
                console.error(params.error);
                return reject(params.error);
            }
            
            try {
                sendTransport = device.createSendTransport(params);
                
                sendTransport.on('connectionstatechange', (state) => {
                    console.log(`[SendTransport] Connection state changed: ${state}`);
                });
                
                sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                     console.log('[SendTransport] Connecting...');
                     socket.emit('connectTransport', {
                         transportId: sendTransport.id,
                         dtlsParameters
                     }, ({ success }) => {
                         if (success) {
                             console.log('[SendTransport] Connected server-side');
                             callback();
                         } else {
                             console.error('[SendTransport] Server failed to connect');
                             errback();
                         }
                     });
                });
                
                sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
                    console.log(`[SendTransport] Producing ${kind}...`);
                    socket.emit('produce', {
                        transportId: sendTransport.id,
                        kind,
                        rtpParameters
                    }, ({ id }) => {
                        if (id) {
                            console.log(`[SendTransport] Producer created: ${id}`);
                            callback({ id });
                        } else {
                            console.error('[SendTransport] Failed to create producer');
                            errback();
                        }
                    });
                });
                
                resolve();
            } catch (error) {
                console.error('Error creating send transport', error);
                reject(error);
            }
        });
    });
}

async function createRecvTransport() {
    return new Promise((resolve, reject) => {
        socket.emit('createWebRtcTransport', {}, async (params) => {
            if (params.error) {
                console.error(params.error);
                return reject(params.error);
            }
            
            try {
                recvTransport = device.createRecvTransport(params);

                recvTransport.on('connectionstatechange', (state) => {
                    console.log(`[RecvTransport] Connection state changed: ${state}`);
                });
                
                recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                     console.log('[RecvTransport] Connecting...');
                     socket.emit('connectTransport', {
                         transportId: recvTransport.id,
                         dtlsParameters
                     }, ({ success }) => {
                         if (success) {
                             console.log('[RecvTransport] Connected server-side');
                             callback();
                         } else {
                            console.error('[RecvTransport] Server failed to connect');
                             errback();
                         }
                     });
                });
                resolve();
            } catch (error) {
                console.error('Error creating recv transport', error);
                reject(error);
            }
        });
    });
}

async function produceAudio() {
    if (!device.canProduce('audio')) {
        console.error('Device cannot produce audio');
        return;
    }
    
    if (!sendTransport) {
        throw new Error('Send Transport not ready');
    }
    
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        console.error('getUserMedia failed:', err);
        throw err;
    }

    const track = stream.getAudioTracks()[0];
    
    audioProducer = await sendTransport.produce({ track });
    
    audioProducer.on('trackended', () => {
        console.log('Audio track ended');
        // close producer
    });
    
    audioProducer.on('transportclose', () => {
        console.log('Audio transport closed');
    });
}

async function consumeAudio(producerId, peerId) {
    console.log(`consumeAudio called: producerId=${producerId}, peerId=${peerId}`);
    
    if (!device) {
        console.warn('consumeAudio: device is not initialized');
        return;
    }
    if (!device.loaded) {
        console.warn('consumeAudio: device not loaded yet');
        return;
    }
    if (!recvTransport) {
        console.warn('consumeAudio: recvTransport not ready');
        return;
    }
    
    console.log(`consumeAudio: requesting consume for producer ${producerId}`);
    
    socket.emit('consume', {
        consumerTransportId: recvTransport.id,
        producerId,
        rtpCapabilities: device.rtpCapabilities
    }, async (params) => {
        console.log('consume response:', params);
        
        if (params.error) {
            console.error('consume error:', params.error);
            return;
        }
        
        try {
            const consumer = await recvTransport.consume({
                id: params.id,
                producerId: params.producerId,
                kind: params.kind,
                rtpParameters: params.rtpParameters
            });
            
            console.log(`Consumer created: ${consumer.id} for peer ${peerId}`);
            
            audioConsumers.set(consumer.id, consumer);
            
            // Create audio element
            const { track } = consumer;
            const stream = new MediaStream([track]);
            const audio = document.createElement('audio');
            audio.srcObject = stream;
            audio.id = `audio-${peerId}`;
            audio.playsInline = true;
            audio.autoplay = true;
            // Mute if user prefers translated TTS only
            audio.muted = translatedVoiceOnly;
            document.body.appendChild(audio);
            
            console.log(`Audio element created for peer ${peerId}, muted: ${audio.muted}`);
            
            // Resume if needed (server sends paused: true)
            socket.emit('resume', { consumerId: consumer.id }, () => {
                console.log('Resumed consumer', consumer.id);
            });
        } catch (err) {
            console.error('Error creating consumer:', err);
        }
    });
}

async function consumeVideo(producerId, peerId) {
    if (!device) {
        console.warn('consumeVideo: device is not initialized');
        return;
    }
    if (!device.loaded) return;
    
    socket.emit('consume', {
        consumerTransportId: recvTransport.id,
        producerId,
        rtpCapabilities: device.rtpCapabilities
    }, async (params) => {
        if (params.error) return console.error(params.error);
        
        const consumer = await recvTransport.consume({
            id: params.id,
            producerId: params.producerId,
            kind: params.kind,
            rtpParameters: params.rtpParameters
        });
        
        videoConsumers.set(consumer.id, consumer);
        
        // Create video element
        const { track } = consumer;
        const stream = new MediaStream([track]);
        const video = document.createElement('video');
        video.srcObject = stream;
        video.id = `share-${consumer.id}`; 
        video.playsInline = true;
        video.autoplay = true;
        video.style.maxWidth = '100%';
        video.style.border = '2px solid #ccc';
        video.style.borderRadius = '8px';
        
        videoContainer.appendChild(video);
        
        // Resume if needed (server sends paused: true)
        socket.emit('resume', { consumerId: consumer.id }, () => {
            console.log('Resumed video consumer', consumer.id);
        });
        
        consumer.on('transportclose', () => {
           video.remove();
        });
        
        consumer.on('producerclose', () => {
           video.remove(); 
        });
    });
}

function showSubtitle(name, text, lang) {
    const inner = document.getElementById('subtitles-inner');
    const area = document.getElementById('subtitles-area');
    
    inner.innerText = `${name} [${lang}]: ${text}`;
    area.style.display = 'block';
    
    // Hide after 5 seconds
    if (window.subtitleTimeout) clearTimeout(window.subtitleTimeout);
    window.subtitleTimeout = setTimeout(() => {
        subtitlesArea.style.display = 'none';
    }, 5000);
}

// Traffic Signal Speaking Indicator
function updateHostSpeakingIndicator(state) {
    const indicator = document.getElementById('host-speaking-indicator');
    if (!indicator) return;
    
    const light = indicator.querySelector('.signal-light');
    const label = indicator.querySelector('.signal-label');
    
    if (!light || !label) return;
    
    // Remove all state classes
    light.classList.remove('idle', 'speaking', 'translating');
    
    switch (state) {
        case 'speaking':
            light.classList.add('speaking');
            label.textContent = 'Host Speaking';
            break;
        case 'translating':
            light.classList.add('translating');
            label.textContent = 'Translating...';
            break;
        case 'idle':
        default:
            light.classList.add('idle');
            label.textContent = 'Host Idle';
            break;
    }
}

// Add entry to scrollable transcript
function addTranscriptEntry(name, text, langLabel, isHost, wasTranslated) {
    const container = document.getElementById('transcript-container');
    const entries = document.getElementById('transcript-entries');
    
    if (!container || !entries) return;
    
    // Show transcript container if it has content
    container.classList.add('visible');
    transcriptVisible = true;
    
    // Update button state
    const btn = document.getElementById('transcript-btn');
    if (btn) btn.classList.add('active');
    
    // Create timestamp
    const now = new Date();
    const timestamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    // Create entry element
    const entry = document.createElement('div');
    entry.className = 'transcript-entry';
    
    // Build badge HTML
    let badgeHtml = '';
    if (isHost) {
        badgeHtml = wasTranslated 
            ? '<span class="transcript-badge translated">Translated</span>'
            : '<span class="transcript-badge">Host</span>';
    }
    
    entry.innerHTML = `
        <div class="transcript-meta">
            <span class="transcript-name ${isHost ? 'host' : ''}">${name}</span>
            <span class="transcript-time">${timestamp}</span>
            ${badgeHtml}
        </div>
        <div class="transcript-text">${text}</div>
    `;
    
    entries.appendChild(entry);
    
    // Store in array
    transcriptEntries.push({
        name,
        text,
        langLabel,
        isHost,
        wasTranslated,
        timestamp
    });
    
    // Auto-scroll to bottom
    entries.scrollTop = entries.scrollHeight;
}

// Toggle transcript visibility
window.toggleTranscript = function() {
    const container = document.getElementById('transcript-container');
    const btn = document.getElementById('transcript-btn');
    
    if (!container) return;
    
    transcriptVisible = !transcriptVisible;
    
    if (transcriptVisible) {
        container.classList.add('visible');
        if (btn) btn.classList.add('active');
    } else {
        container.classList.remove('visible');
        if (btn) btn.classList.remove('active');
    }
};

function showWaiting() {
  loginSection.classList.add('hidden');
  waitingSection.classList.remove('hidden');
}

function enterRoom(roomId, isAdmin) {
  loginSection.classList.add('hidden');
  waitingSection.classList.add('hidden');
  roomSection.classList.remove('hidden');
  
  // Desktop footer room info
  document.getElementById('current-room-id').innerText = roomId;
  amIAdmin = isAdmin;
  const roleText = isAdmin ? 'Role: HOST (Admin)' : 'Role: Participant';
  document.getElementById('my-role').innerText = roleText;
  
  // Mobile header room info
  const mobileRoomId = document.getElementById('current-room-id-mobile');
  const mobileRole = document.getElementById('my-role-mobile');
  if (mobileRoomId) mobileRoomId.innerText = roomId;
  if (mobileRole) mobileRole.innerText = roleText;
  
  // Show host speaking indicator for all users
  const hostIndicator = document.getElementById('host-speaking-indicator');
  if (hostIndicator) {
      hostIndicator.classList.remove('hidden');
  }
  
  if (isAdmin) {
      // Show Share Button
      document.getElementById('share-btn').classList.remove('hidden');
      
      // Show Mic Button for host
      document.getElementById('mic-btn').classList.remove('hidden');
      
      // Show Admin Controls
      const adminControls = document.getElementById('admin-controls');
      if(adminControls) {
          adminControls.classList.remove('hidden');
          adminControls.style.display = 'flex'; // override hidden class
          
          const toggle = document.getElementById('auto-approve-toggle');
          toggle.addEventListener('change', (e) => {
              const enabled = e.target.checked;
              socket.emit('toggle-auto-approve', { enabled }, (res) => {
                  if (res.error) {
                      alert(res.error);
                      e.target.checked = !enabled; // revert
                  } else {
                      console.log('Auto-approve set to:', res.enabled);
                  }
              });
          });
      }
  } else {
      document.getElementById('share-btn').classList.add('hidden');
      
      // Hide mic button for guests (participants can't speak for now)
      // Functionality still exists if we want to enable it later
      document.getElementById('mic-btn').classList.add('hidden');
      
      const adminControls = document.getElementById('admin-controls');
      if(adminControls) adminControls.classList.add('hidden');
  }
}

function updatePeers(peersList) {
    participantsContainer.innerHTML = '';
    peersList.forEach(peer => addPeerToUI(peer));
}

function addPeerToUI(peer) {
    const div = document.createElement('div');
    div.id = `peer-${peer.id}`;
    div.className = 'peer-item';
    
    const initial = peer.name.charAt(0).toUpperCase();
    const joinedTime = peer.joinedAt ? new Date(peer.joinedAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
    
    // Determine badges
    let badges = '';
    if (peer.isAdmin) badges += `<span class="peer-badge admin">Host</span>`;
    if (peer.id === socket.id) badges += `<span class="peer-badge">You</span>`;

    div.innerHTML = `
        <div class="peer-avatar" style="background-color: ${getColorForName(peer.name)}">${initial}</div>
        <div class="peer-info">
            <div class="peer-name">${peer.name}${badges}</div>
            <div class="peer-time">Joined ${joinedTime}</div>
        </div>
    `;
    participantsContainer.appendChild(div);
}

// Consistent colors for avatars based on name
function getColorForName(name) {
    const colors = ['#1967d2', '#d93025', '#188038', '#e37400', '#673ab7', '#0097a7', '#c2185b'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % colors.length;
    return colors[index];
}

function addJoinRequest(peer) {
    const requestsArea = document.getElementById('join-requests-area');
    if (!requestsArea) return; // Should exist

    const div = document.createElement('div');
    div.id = `request-${peer.socketId}`;
    div.style.background = 'white';
    div.style.color = '#202124';
    div.style.padding = '16px';
    div.style.borderRadius = '8px';
    div.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
    div.style.display = 'flex';
    div.style.flexDirection = 'column';
    div.style.gap = '10px';
    div.style.minWidth = '250px';
    div.style.animation = 'fadeIn 0.3s ease-out';

    div.innerHTML = `
        <div style="font-weight: 500; font-size: 14px;">Someone wants to join</div>
        <div style="font-size: 16px; font-weight: bold;">${peer.name}</div>
        <div style="display: flex; gap: 10px; margin-top: 5px;">
             <!-- Deny button could be added here -->
             <button onclick="approvePeer('${peer.socketId}')" style="flex: 1; padding: 8px; border: none; background: transparent; color: #0b57d0; font-weight: 500; cursor: pointer; border-radius: 4px; text-align: right;">Admit</button>
        </div>
    `;
    
    // Add simple hover effect for button via inline style hack or just leave simple
    const btn = div.querySelector('button');
    btn.onmouseover = () => btn.style.background = '#f0f4fc';
    btn.onmouseout = () => btn.style.background = 'transparent';

    requestsArea.appendChild(div);
    
    // Play a sound? (Optional)
}

const shareBtn = document.getElementById('share-btn');
const videoContainer = document.getElementById('video-container');

let isSharing = false;
let videoProducer;
let videoConsumers = new Map(); // consumerId -> consumer (for video)

shareBtn.addEventListener('click', toggleShare);

async function toggleShare() {
    if (isSharing) {
        // Stop Sharing
        if (videoProducer) {
            const producerId = videoProducer.id;
            videoProducer.close();
            videoProducer = null;
            socket.emit('close-producer', { producerId });
        }
        const localPreview = document.getElementById('local-share-preview');
        if (localPreview) localPreview.remove();
        
        isSharing = false;
        shareBtn.innerHTML = '<span class="material-icons">present_to_all</span>';
        shareBtn.classList.remove('active');
        document.getElementById('sharing-badge').classList.add('hidden');
    } else {
        // Start Sharing
        try {
            await produceVideo();
            isSharing = true;
            shareBtn.innerHTML = '<span class="material-icons" style="color:#8ab4f8">stop_screen_share</span>';
            shareBtn.classList.add('active');
            document.getElementById('sharing-badge').classList.remove('hidden');
        } catch (e) {
            console.error('Failed to share screen:', e);
            alert(`Screen share failed: ${e.message}`);
        }
    }
}

async function produceVideo() {
    if (!device.canProduce('video')) {
        console.error('Device cannot produce video');
        return;
    }
    
    if (!sendTransport) {
        throw new Error('Send Transport not ready');
    }
    
    let stream;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (err) {
        console.error('getDisplayMedia failed:', err);
        throw err;
    }

    const track = stream.getVideoTracks()[0];
    
    // Handle user clicking "Stop sharing" from browser UI
    track.onended = () => {
         if (isSharing) toggleShare(); 
    };
    
    // Encodings for simulcast (optional, but good for screen share quality)
    // For simplicity, we use simple parameters first
    videoProducer = await sendTransport.produce({ 
        track,
        // appData: { share: true } // could use to distinguish camera vs screen
    });
    
    // Add local preview
    const video = document.createElement('video');
    video.srcObject = new MediaStream([track]);
    video.id = 'local-share-preview';
    video.playsInline = true;
    video.autoplay = true;
    video.muted = true; // IMPORTANT: Mute local preview
    video.style.maxWidth = '100%';
    video.style.border = '2px solid #8ab4f8'; // Blue border for self
    video.style.borderRadius = '8px';
    
    videoContainer.appendChild(video);

    track.onended = () => {
         if (isSharing) toggleShare(); 
         video.remove();
    };
    
    videoProducer.on('trackended', () => {
        console.log('Video track ended');
    });
    
    videoProducer.on('transportclose', () => {
        console.log('Video transport closed');
    });
}

window.approvePeer = (targetSocketId) => {
    socket.emit('approve-peer', { targetSocketId }, (res) => {
        if (res.success) {
            const el = document.getElementById(`request-${targetSocketId}`);
            if (el) el.remove();
        }
    });
};

// Toggle audio mode: original voice vs translated TTS only
window.toggleAudioMode = () => {
    translatedVoiceOnly = !translatedVoiceOnly;
    
    const btn = document.getElementById('audio-mode-btn');
    if (btn) {
        if (translatedVoiceOnly) {
            btn.classList.add('active');
            btn.title = 'Translated voice only (click to hear original)';
        } else {
            btn.classList.remove('active');
            btn.title = 'Original voice (click for translated only)';
        }
    }
    
    // Update all existing remote audio elements
    document.querySelectorAll('audio[id^="audio-"]').forEach(audio => {
        audio.muted = translatedVoiceOnly;
    });
    
    console.log('Audio mode:', translatedVoiceOnly ? 'Translated TTS only' : 'Original voice');
};
