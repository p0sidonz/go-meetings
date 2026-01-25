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

// Status tracking for smooth UX
let hostSpeakingTimeout = null;
let lastHostStatus = 'idle';

// Mediasoup
let device;
let sendTransport;
let recvTransport;
let audioProducer;
let cameraProducer; // For webcam video
let isCameraOn = false;
let cameraConsumers = new Map(); // consumerId -> consumer (for webcam video)
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
  // Check if user is authenticated
  if (!window.ApiService || !window.ApiService.isAuthenticated()) {
    alert('Please login to join a meeting');
    if (typeof switchTab === 'function') switchTab('login');
    return;
  }

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
        
        // Remove video tile from DOM (check both old and new ID patterns)
        const videoTile = document.getElementById(`video-tile-${consumerId}`);
        if (videoTile) videoTile.remove();
        
        const shareEl = document.getElementById(`share-${consumerId}`);
        if (shareEl) shareEl.remove();
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
  }
  
  // Remove any video tiles from this peer
  document.querySelectorAll(`[id*="${data.id}"]`).forEach(el => {
      if (el.classList.contains('video-tile')) {
          el.remove();
      }
  });
  
  // Also close and remove any consumers for this peer
  videoConsumers.forEach((consumer, consumerId) => {
      const tile = document.getElementById(`video-tile-${consumerId}`);
      if (tile) tile.remove();
  });
});

socket.on('subtitle', async (data) => {
    const myLangFull = languageSelect.value;  // e.g., 'en-US'
    const myLang = myLangFull.split('-')[0];  // e.g., 'en'
    const sourceLang = data.lang.split('-')[0];  // e.g., 'hi'
    
    let displayText = data.text;
    let langLabel = data.lang;
    let wasTranslated = false;
    let ttsAudio = null;  // Server TTS audio (base64)

    // Only translate if this is from the HOST
    if (data.isHost) {
        // Show speaking indicator (already set by host-status, but ensure it's there)
        updateHostSpeakingIndicator('speaking');
        
        // Only translate and TTS if translate mode is active
        if (translatedVoiceOnly) {
            // Translate host's speech to listener's selected language
            if (myLang !== sourceLang) {
                updateHostSpeakingIndicator('translating');
                
                // Send status to server for host feedback
                socket.emit('translation-status', { status: 'translating' });
                
                try {
                    // Use combined translate + TTS endpoint (Supertonic TTS)
                    const result = await translateAndSpeak(data.text, sourceLang, myLang);
                    displayText = result.translatedText;
                    ttsAudio = result.audio;  // May be null if TTS not available for this lang
                    langLabel = `${sourceLang}→${myLang}`;
                    wasTranslated = true;
                } catch (e) {
                    console.error('Translation failed', e);
                }
            }
            
            // TTS for host speech - use server audio if available, else browser TTS
            speakTextWithFeedback(displayText, myLangFull, wasTranslated, ttsAudio);
        } else {
            // Not in translation mode, reset after brief speaking indicator
            clearTimeout(hostSpeakingTimeout);
            hostSpeakingTimeout = setTimeout(() => updateHostSpeakingIndicator('idle'), 2000);
        }
    }
    // Participant voice: no translation, no TTS - just native display
    // Audio plays via Mediasoup (native voice)

    // Add to scrollable transcript
    addTranscriptEntry(data.name, displayText, langLabel, data.isHost, wasTranslated);
});

// Listen for host status updates (immediate indicator)
socket.on('host-status', (data) => {
    if (data.status === 'speaking' && !amIAdmin) {
        updateHostSpeakingIndicator('speaking');
        // Clear any existing timeout
        clearTimeout(hostSpeakingTimeout);
    }
});

// Host receives translation activity feedback
socket.on('translation-activity', (data) => {
    if (amIAdmin) {
        updateHostFeedbackPanel(data);
    }
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

// Enhanced speakText with feedback to server and visual indicator
// Uses Supertonic TTS from server, falls back to browser TTS
async function speakTextWithFeedback(text, langCode, wasTranslated, base64Audio = null) {
    // Pause speech recognition while TTS is playing
    if (recognition && isMicOn) {
        recognition.stop();
        window.isSpeaking = true;
    }
    
    // Show playing indicator
    updateHostSpeakingIndicator('playing');
    showClientAudioIndicator(true);
    
    // Send playing status to server
    if (wasTranslated) {
        socket.emit('translation-status', { status: 'playing' });
    }
    
    console.log('TTS starting, server audio available:', !!base64Audio);
    
    try {
        if (base64Audio) {
            // Use Supertonic TTS audio from server
            await playBase64Audio(base64Audio);
        } else {
            // Fallback to browser Web Speech API
            await speakWithBrowserTTS(text, langCode);
        }
    } catch (err) {
        console.error('TTS playback error:', err);
        // Try browser fallback if server TTS fails
        if (base64Audio) {
            try {
                console.log('Falling back to browser TTS...');
                await speakWithBrowserTTS(text, langCode);
            } catch (e) {
                console.error('Browser TTS fallback also failed:', e);
            }
        }
    } finally {
        console.log('TTS ended');
        window.isSpeaking = false;
        
        // Resume speech recognition
        if (recognition && isMicOn) {
            try { recognition.start(); } catch(e) {}
        }
        
        // Hide playing indicator
        updateHostSpeakingIndicator('idle');
        showClientAudioIndicator(false);
        
        // Send done status to server
        if (wasTranslated) {
            socket.emit('translation-status', { status: 'done' });
        }
    }
}

// Browser SpeechSynthesis TTS (fallback)
function speakWithBrowserTTS(text, langCode) {
    return new Promise((resolve, reject) => {
        if (!window.speechSynthesis) {
            reject(new Error('SpeechSynthesis not available'));
            return;
        }
        
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = langCode;
        
        // Use cached voices or fetch fresh
        const voices = cachedVoices.length > 0 ? cachedVoices : window.speechSynthesis.getVoices();
        
        // Priority 1: Exact match
        let voice = voices.find(v => v.lang === langCode);
        
        // Priority 2: Language prefix match
        if (!voice) {
            const shortLang = langCode.split('-')[0];
            voice = voices.find(v => v.lang.startsWith(shortLang));
        }
        
        if (voice) {
            utterance.voice = voice;
        }
        
        utterance.rate = 1.0;
        utterance.onend = () => resolve();
        utterance.onerror = (e) => reject(e);
        
        window.speechSynthesis.speak(utterance);
    });
}

// Show/hide client audio playing indicator
function showClientAudioIndicator(show) {
    const indicator = document.getElementById('client-audio-indicator');
    if (!indicator) return;
    
    if (show) {
        indicator.classList.remove('hidden');
        indicator.classList.add('visible');
    } else {
        indicator.classList.remove('visible');
        indicator.classList.add('hidden');
    }
}

// Update host feedback panel with translation activity
function updateHostFeedbackPanel(data) {
    const panel = document.getElementById('host-feedback-panel');
    const activeDiv = document.getElementById('active-translations');
    
    if (!panel || !activeDiv) return;
    
    // Show the panel if there's activity
    if (data.summary.count > 0) {
        panel.classList.remove('hidden');
        panel.classList.add('visible');
        
        // Clear and rebuild the list
        activeDiv.innerHTML = '';
        
        data.summary.clients.forEach(client => {
            const item = document.createElement('div');
            item.className = 'translation-item';
            
            let statusIcon = '🔄';
            let statusText = 'Translating';
            if (client.status === 'playing') {
                statusIcon = '🔊';
                statusText = 'Playing';
            }
            
            item.innerHTML = `
                <span class="client-name">${client.name}</span>
                <span class="client-status ${client.status}">${statusIcon} ${statusText}</span>
            `;
            activeDiv.appendChild(item);
        });
    } else {
        panel.classList.remove('visible');
        panel.classList.add('hidden');
    }
}

// ML Service configuration (for translation only, TTS uses browser-native Web Speech API)
const ML_SERVICE_URL = window.ML_SERVICE_URL || 'http://localhost:5001';

async function translateText(text, source, target) {
    // Using self-hosted NLLB-200 translation via ML service
    const url = `${ML_SERVICE_URL}/translate`;
    
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text: text,
                source: source,
                target: target
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
        // Fallback to original text if ML service is unavailable
        return text;
    }
}

// Translate text and get TTS audio in one request (Supertonic TTS)
async function translateAndSpeak(text, source, target) {
    const url = `${ML_SERVICE_URL}/translate-and-speak`;
    
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text: text,
                source: source,
                target: target
            })
        });
        
        const data = await res.json();
        return {
            translatedText: data.translatedText || text,
            audio: data.audio  // Base64 WAV audio (null if TTS not available for this language)
        };
    } catch (err) {
        console.error('Translate-and-speak error:', err);
        return { translatedText: text, audio: null };
    }
}

// Play audio from base64-encoded WAV data
function playBase64Audio(base64Audio) {
    return new Promise((resolve, reject) => {
        try {
            // Decode base64 to binary
            const binaryString = atob(base64Audio);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            
            // Create blob and audio element
            const blob = new Blob([bytes], { type: 'audio/wav' });
            const audioUrl = URL.createObjectURL(blob);
            const audio = new Audio(audioUrl);
            
            audio.onended = () => {
                URL.revokeObjectURL(audioUrl);
                resolve();
            };
            
            audio.onerror = (e) => {
                URL.revokeObjectURL(audioUrl);
                reject(e);
            };
            
            audio.play().catch(reject);
        } catch (err) {
            reject(err);
        }
    });
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

// Camera Button
const cameraBtn = document.getElementById('camera-btn');
let cameraStream = null; // Store stream reference for cleanup

if (cameraBtn) {
    cameraBtn.addEventListener('click', toggleCamera);
}

async function toggleCamera() {
    if (!cameraBtn) return;
    
    if (isCameraOn) {
        // Stop Camera
        
        // First stop the media tracks
        if (cameraStream) {
            cameraStream.getTracks().forEach(track => {
                track.stop();
            });
            cameraStream = null;
        }
        
        // Then close the producer
        if (cameraProducer) {
            const producerId = cameraProducer.id;
            cameraProducer.close();
            cameraProducer = null;
            socket.emit('close-producer', { producerId });
        }
        
        // Remove local preview
        const localPreview = document.getElementById('local-camera-preview');
        if (localPreview) localPreview.remove();
        
        isCameraOn = false;
        cameraBtn.innerHTML = '<span class="material-icons">videocam_off</span>';
        cameraBtn.classList.remove('active');
    } else {
        // Start Camera
        try {
            await produceCamera();
            isCameraOn = true;
            cameraBtn.innerHTML = '<span class="material-icons" style="color:#8ab4f8">videocam</span>';
            cameraBtn.classList.add('active');
        } catch (e) {
            console.error('Failed to produce camera:', e);
            alert(`Camera access failed: ${e.message}\nPlease ensure you have allowed camera permissions and are using HTTPS.`);
        }
    }
}

async function produceCamera() {
    if (!device.canProduce('video')) {
        console.error('Device cannot produce video');
        throw new Error('Device cannot produce video');
    }
    
    if (!sendTransport) {
        throw new Error('Send Transport not ready');
    }
    
    // Clean up any existing camera resources first
    if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
    }
    if (cameraProducer) {
        cameraProducer.close();
        cameraProducer = null;
    }
    
    // Remove any existing preview
    const existingPreview = document.getElementById('local-camera-preview');
    if (existingPreview) existingPreview.remove();
    
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ 
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: 'user'
            }
        });
    } catch (err) {
        console.error('getUserMedia (camera) failed:', err);
        throw err;
    }

    const track = cameraStream.getVideoTracks()[0];
    
    // Create producer with appData to distinguish from screen share
    cameraProducer = await sendTransport.produce({ 
        track,
        appData: { type: 'camera' }
    });
    
    // Add local preview
    const videoContainer = document.getElementById('video-container');
    
    const tile = document.createElement('div');
    tile.id = 'local-camera-preview';
    tile.className = 'video-tile local-preview local';
    
    const video = document.createElement('video');
    video.srcObject = cameraStream;
    video.playsInline = true;
    video.autoplay = true;
    video.muted = true; // Mute local preview
    video.style.transform = 'scaleX(-1)'; // Mirror for self-view
    
    const label = document.createElement('div');
    label.className = 'video-label';
    label.innerHTML = '<span class="material-icons">person</span> You';
    
    tile.appendChild(video);
    tile.appendChild(label);
    videoContainer.appendChild(tile);

    // Handle track ending (e.g., user revokes permission)
    track.onended = () => {
        console.log('Camera track ended externally');
        if (isCameraOn) {
            isCameraOn = false;
            cameraBtn.innerHTML = '<span class="material-icons">videocam_off</span>';
            cameraBtn.classList.remove('active');
            const preview = document.getElementById('local-camera-preview');
            if (preview) preview.remove();
        }
    };
    
    cameraProducer.on('trackended', () => {
        console.log('Camera producer track ended');
    });
    
    cameraProducer.on('transportclose', () => {
        console.log('Camera transport closed');
    });
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
            
            // Explicitly try to play (handles autoplay policy)
            try {
                await audio.play();
                console.log(`Audio playing for peer ${peerId}, muted: ${audio.muted}`);
            } catch (playError) {
                console.warn(`Autoplay blocked for peer ${peerId}, will play on user interaction:`, playError.name);
                // Add one-time click handler to start audio
                const startAudio = () => {
                    audio.play().catch(e => console.error('Audio play failed:', e));
                    document.removeEventListener('click', startAudio);
                };
                document.addEventListener('click', startAudio, { once: true });
            }
            
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
        
        // Get peer name from participants list
        let peerName = 'Participant';
        const peerEl = document.getElementById(`peer-${peerId}`);
        if (peerEl) {
            const nameEl = peerEl.querySelector('.peer-name');
            if (nameEl) peerName = nameEl.innerText;
        }
        
        // Create video tile
        const { track } = consumer;
        const stream = new MediaStream([track]);
        
        const tile = document.createElement('div');
        tile.id = `video-tile-${consumer.id}`;
        tile.className = 'video-tile';
        
        const video = document.createElement('video');
        video.srcObject = stream;
        video.playsInline = true;
        video.autoplay = true;
        
        const label = document.createElement('div');
        label.className = 'video-label';
        label.innerHTML = `<span class="material-icons">person</span> ${peerName}`;
        
        tile.appendChild(video);
        tile.appendChild(label);
        videoContainer.appendChild(tile);
        
        // Resume if needed (server sends paused: true)
        socket.emit('resume', { consumerId: consumer.id }, () => {
            console.log('Resumed video consumer', consumer.id);
        });
        
        consumer.on('transportclose', () => {
           tile.remove();
        });
        
        consumer.on('producerclose', () => {
           tile.remove(); 
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
    
    // Track state for smooth transitions
    if (state === lastHostStatus) return;
    lastHostStatus = state;
    
    // Remove all state classes
    light.classList.remove('idle', 'speaking', 'translating', 'playing');
    indicator.classList.remove('active');
    
    switch (state) {
        case 'speaking':
            light.classList.add('speaking');
            indicator.classList.add('active');
            label.textContent = 'Host Speaking';
            break;
        case 'translating':
            light.classList.add('translating');
            indicator.classList.add('active');
            label.textContent = 'Translating...';
            break;
        case 'playing':
            light.classList.add('playing');
            indicator.classList.add('active');
            label.textContent = '🔊 Playing Audio';
            break;
        case 'idle':
        default:
            light.classList.add('idle');
            label.textContent = 'Listening';
            break;
    }
}

// Add entry to scrollable transcript
function addTranscriptEntry(name, text, langLabel, isHost, wasTranslated) {
    const container = document.getElementById('transcript-container');
    const entries = document.getElementById('transcript-entries');
    
    if (!container || !entries) return;
    
    // Don't auto-show transcript - keep it hidden by default for less clutter
    // User can toggle it with the button when they want to see it
    // Only add content without forcing visibility
    
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
      
      // Participants can use mic and camera
      // Only share screen is restricted to admin
      
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

// ============================================
// Chat Messaging
// ============================================
let unreadCount = 0;
let currentSidebarTab = 'people';

// Switch sidebar tabs
window.switchSidebarTab = (tabName) => {
    currentSidebarTab = tabName;
    
    // Update tab buttons
    document.querySelectorAll('.sidebar-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    // Update tab content
    document.querySelectorAll('.sidebar-tab-content').forEach(content => {
        content.classList.add('hidden');
    });
    
    const activeContent = document.getElementById(`sidebar-${tabName}`);
    if (activeContent) activeContent.classList.remove('hidden');
    
    // Clear unread badge when switching to chat
    if (tabName === 'chat') {
        unreadCount = 0;
        updateUnreadBadge();
    }
};

// Send chat message
window.sendChatMessage = () => {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    
    if (!text) return;
    
    const roomId = document.getElementById('current-room-id')?.innerText;
    if (!roomId) return;
    
    socket.emit('chat-message', { 
        roomId, 
        text,
        name: usernameInput.value
    });
    
    // Add message to local chat (optimistic)
    addChatMessage({
        name: 'You',
        text,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isSelf: true
    });
    
    // Clear input
    input.value = '';
};

// Receive chat message from server
socket.on('chat-message', (data) => {
    // Don't show own messages again (we already added them optimistically)
    if (data.senderId === socket.id) return;
    
    addChatMessage({
        name: data.name,
        text: data.text,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isSelf: false
    });
    
    // Show unread badge if chat tab not active
    if (currentSidebarTab !== 'chat') {
        unreadCount++;
        updateUnreadBadge();
    }
});

// Add message to chat UI
function addChatMessage({ name, text, time, isSelf }) {
    const messagesContainer = document.getElementById('chat-messages');
    if (!messagesContainer) return;
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${isSelf ? 'sent' : 'received'}`;
    
    msgDiv.innerHTML = `
        <div class="sender-name">${name}</div>
        <div class="message-text">${escapeHtml(text)}</div>
        <div class="message-time">${time}</div>
    `;
    
    messagesContainer.appendChild(msgDiv);
    
    // Scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Update unread badge
function updateUnreadBadge() {
    const badge = document.getElementById('chat-unread-badge');
    const peopleDot = document.getElementById('people-unread-dot');
    
    if (unreadCount > 0) {
        if (badge) {
            badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
            badge.classList.remove('hidden');
        }
        // Also show dot on people button
        if (peopleDot) {
            peopleDot.classList.remove('hidden');
        }
    } else {
        if (badge) {
            badge.classList.add('hidden');
        }
        if (peopleDot) {
            peopleDot.classList.add('hidden');
        }
    }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Chat input enter key handler
document.addEventListener('DOMContentLoaded', () => {
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }
});

// ============================================
// Meeting Recording
// ============================================
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingTimerInterval = null;
let recordingBlob = null;

// Toggle recording state
function toggleRecording() {
    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
}

// Start recording the meeting
async function startRecording() {
    try {
        // Collect all available streams
        const streams = [];
        
        // Get local audio from microphone (if available)
        if (audioProducer && audioProducer.track) {
            const audioStream = new MediaStream([audioProducer.track]);
            streams.push(audioStream);
        }
        
        // Get local camera video (if available)
        if (cameraProducer && cameraProducer.track) {
            const videoStream = new MediaStream([cameraProducer.track]);
            streams.push(videoStream);
        }
        
        // Get remote audio streams
        audioConsumers.forEach((consumer) => {
            if (consumer.track) {
                const remoteAudioStream = new MediaStream([consumer.track]);
                streams.push(remoteAudioStream);
            }
        });
        
        // Get remote video streams
        videoConsumers.forEach((consumer) => {
            if (consumer.track) {
                const remoteVideoStream = new MediaStream([consumer.track]);
                streams.push(remoteVideoStream);
            }
        });
        
        // Also get camera consumer streams
        cameraConsumers.forEach((consumer) => {
            if (consumer.track) {
                const remoteCameraStream = new MediaStream([consumer.track]);
                streams.push(remoteCameraStream);
            }
        });
        
        // If no streams available, try to get user media
        if (streams.length === 0) {
            console.warn('No active streams to record. Requesting microphone access...');
            try {
                const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                streams.push(micStream);
            } catch (e) {
                console.error('Failed to get microphone for recording:', e);
                alert('No audio/video streams available to record. Please turn on your microphone or camera first.');
                return;
            }
        }
        
        // Combine all streams using AudioContext for audio mixing
        const combinedStream = await combineStreams(streams);
        
        // Create MediaRecorder
        const options = { mimeType: 'video/webm;codecs=vp9,opus' };
        
        // Check if the preferred mime type is supported
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options.mimeType = 'video/webm;codecs=vp8,opus';
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options.mimeType = 'video/webm';
                if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                    options.mimeType = 'audio/webm';
                }
            }
        }
        
        console.log('Recording with mime type:', options.mimeType);
        
        mediaRecorder = new MediaRecorder(combinedStream, options);
        recordedChunks = [];
        
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
            }
        };
        
        mediaRecorder.onstop = () => {
            // Create blob from recorded chunks
            const mimeType = mediaRecorder.mimeType || 'video/webm';
            recordingBlob = new Blob(recordedChunks, { type: mimeType });
            console.log('Recording stopped. Blob size:', recordingBlob.size);
            
            // Show download modal
            showDownloadModal();
        };
        
        mediaRecorder.onerror = (event) => {
            console.error('MediaRecorder error:', event.error);
            stopRecording();
            alert('Recording error: ' + event.error.message);
        };
        
        // Start recording
        mediaRecorder.start(1000); // Collect data every second
        isRecording = true;
        recordingStartTime = Date.now();
        
        // Update UI
        const recordBtn = document.getElementById('record-btn');
        if (recordBtn) {
            recordBtn.classList.add('recording');
            recordBtn.title = 'Stop recording';
        }
        
        // Show recording indicator
        const indicator = document.getElementById('recording-indicator');
        if (indicator) {
            indicator.classList.remove('hidden');
        }
        
        // Start timer
        startRecordingTimer();
        
        console.log('Recording started');
        
    } catch (error) {
        console.error('Failed to start recording:', error);
        alert('Failed to start recording: ' + error.message);
    }
}

// Stop recording
function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        
        // Stop all tracks in the combined stream
        if (mediaRecorder.stream) {
            mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }
    }
    
    isRecording = false;
    
    // Stop canvas animation
    if (recordingAnimationId) {
        cancelAnimationFrame(recordingAnimationId);
        recordingAnimationId = null;
    }
    recordingCanvas = null;
    recordingCanvasCtx = null;
    
    // Update UI
    const recordBtn = document.getElementById('record-btn');
    if (recordBtn) {
        recordBtn.classList.remove('recording');
        recordBtn.title = 'Record meeting';
    }
    
    // Hide recording indicator
    const indicator = document.getElementById('recording-indicator');
    if (indicator) {
        indicator.classList.add('hidden');
    }
    
    // Stop timer
    stopRecordingTimer();
    
    console.log('Recording stopped');
}

// Combine multiple streams into one with canvas composite for video
let recordingCanvas = null;
let recordingCanvasCtx = null;
let recordingAnimationId = null;

async function combineStreams(streams) {
    const audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    
    const videoElements = [];
    
    // Process each stream
    for (const stream of streams) {
        // Handle audio tracks - mix all audio together
        const audioTracks = stream.getAudioTracks();
        for (const track of audioTracks) {
            try {
                const source = audioContext.createMediaStreamSource(new MediaStream([track]));
                source.connect(destination);
            } catch (e) {
                console.warn('Failed to add audio track:', e);
            }
        }
        
        // Handle video tracks - collect all for canvas composite
        const videoTracks = stream.getVideoTracks();
        for (const track of videoTracks) {
            const video = document.createElement('video');
            video.srcObject = new MediaStream([track]);
            video.muted = true;
            video.playsInline = true;
            video.autoplay = true;
            await video.play().catch(e => console.warn('Video play failed:', e));
            videoElements.push(video);
        }
    }
    
    // Create combined stream
    const combinedStream = new MediaStream();
    
    // Add mixed audio
    const audioTracks = destination.stream.getAudioTracks();
    audioTracks.forEach(track => combinedStream.addTrack(track));
    
    // Create canvas composite for video if we have video streams
    if (videoElements.length > 0) {
        // Create canvas
        recordingCanvas = document.createElement('canvas');
        recordingCanvas.width = 1280;
        recordingCanvas.height = 720;
        recordingCanvasCtx = recordingCanvas.getContext('2d');
        
        // Calculate grid layout
        const cols = Math.ceil(Math.sqrt(videoElements.length));
        const rows = Math.ceil(videoElements.length / cols);
        const cellWidth = recordingCanvas.width / cols;
        const cellHeight = recordingCanvas.height / rows;
        
        // Start drawing loop
        function drawFrame() {
            // Fill background
            recordingCanvasCtx.fillStyle = '#1e1e1e';
            recordingCanvasCtx.fillRect(0, 0, recordingCanvas.width, recordingCanvas.height);
            
            // Draw each video in grid
            videoElements.forEach((video, index) => {
                const col = index % cols;
                const row = Math.floor(index / cols);
                const x = col * cellWidth;
                const y = row * cellHeight;
                
                // Calculate aspect-fit dimensions
                const videoAspect = video.videoWidth / video.videoHeight || 16/9;
                const cellAspect = cellWidth / cellHeight;
                
                let drawWidth, drawHeight, drawX, drawY;
                
                if (videoAspect > cellAspect) {
                    // Video is wider - fit to width
                    drawWidth = cellWidth;
                    drawHeight = cellWidth / videoAspect;
                    drawX = x;
                    drawY = y + (cellHeight - drawHeight) / 2;
                } else {
                    // Video is taller - fit to height
                    drawHeight = cellHeight;
                    drawWidth = cellHeight * videoAspect;
                    drawX = x + (cellWidth - drawWidth) / 2;
                    drawY = y;
                }
                
                try {
                    if (video.readyState >= 2) {
                        recordingCanvasCtx.drawImage(video, drawX, drawY, drawWidth, drawHeight);
                    }
                } catch (e) {
                    // Video frame not ready, skip
                }
                
                // Draw border between cells
                recordingCanvasCtx.strokeStyle = '#333';
                recordingCanvasCtx.lineWidth = 2;
                recordingCanvasCtx.strokeRect(x, y, cellWidth, cellHeight);
            });
            
            // Continue animation if still recording
            if (isRecording) {
                recordingAnimationId = requestAnimationFrame(drawFrame);
            }
        }
        
        // Start drawing
        drawFrame();
        
        // Capture canvas stream at 30fps
        const canvasStream = recordingCanvas.captureStream(30);
        canvasStream.getVideoTracks().forEach(track => combinedStream.addTrack(track));
        
        console.log(`Recording ${videoElements.length} video streams in ${cols}x${rows} grid`);
    } else {
        console.log('No video streams to record');
    }
    
    return combinedStream;
}

// Recording timer
function startRecordingTimer() {
    recordingTimerInterval = setInterval(() => {
        const elapsed = Date.now() - recordingStartTime;
        const seconds = Math.floor((elapsed / 1000) % 60);
        const minutes = Math.floor((elapsed / (1000 * 60)) % 60);
        const hours = Math.floor(elapsed / (1000 * 60 * 60));
        
        let timeStr = 'REC ';
        if (hours > 0) {
            timeStr += `${hours.toString().padStart(2, '0')}:`;
        }
        timeStr += `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        const timeEl = document.getElementById('recording-time');
        if (timeEl) {
            timeEl.textContent = timeStr;
        }
    }, 1000);
}

function stopRecordingTimer() {
    if (recordingTimerInterval) {
        clearInterval(recordingTimerInterval);
        recordingTimerInterval = null;
    }
}

// Show download modal
function showDownloadModal() {
    const modal = document.getElementById('download-recording-modal');
    if (modal) {
        modal.classList.remove('hidden');
        
        // Update info text
        const infoEl = document.getElementById('recording-info');
        if (infoEl && recordingBlob) {
            const sizeMB = (recordingBlob.size / (1024 * 1024)).toFixed(2);
            const duration = formatDuration(Date.now() - recordingStartTime);
            infoEl.textContent = `Duration: ${duration} | Size: ${sizeMB} MB`;
        }
        
        // Setup download button
        const downloadBtn = document.getElementById('download-recording-btn');
        if (downloadBtn) {
            downloadBtn.onclick = downloadRecording;
        }
    }
}

// Dismiss download modal
function dismissDownloadModal() {
    const modal = document.getElementById('download-recording-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
    
    // Clear the blob
    recordingBlob = null;
    recordedChunks = [];
}

// Download the recording
function downloadRecording() {
    if (!recordingBlob) {
        alert('No recording available to download.');
        return;
    }
    
    // Create download link
    const url = URL.createObjectURL(recordingBlob);
    const a = document.createElement('a');
    a.href = url;
    
    // Generate filename with timestamp
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const roomId = document.getElementById('current-room-id')?.textContent || 'meeting';
    const extension = recordingBlob.type.includes('video') ? 'webm' : 'webm';
    a.download = `${roomId}-${timestamp}.${extension}`;
    
    // Trigger download
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    // Cleanup
    URL.revokeObjectURL(url);
    
    // Close modal
    dismissDownloadModal();
}

// Format duration
function formatDuration(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));
    
    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    } else {
        return `${seconds}s`;
    }
}

// Handle room closed - auto stop recording and prompt download
const originalRoomClosedHandler = socket._callbacks && socket._callbacks['$room-closed'];
socket.on('room-closed', ({ reason }) => {
    // If recording, stop it and show download prompt
    if (isRecording) {
        console.log('Room closed while recording, stopping recording...');
        stopRecording();
    }
    
    // The original handler will reload the page after alert
    // We need to show download modal before that
    if (recordingBlob) {
        showDownloadModal();
        // Don't auto-reload, let user download first
        return;
    }
    
    // If no recording, proceed with normal behavior
    alert(`Meeting ended: ${reason}`);
    window.location.reload();
});

// Make functions globally accessible
window.toggleRecording = toggleRecording;
window.dismissDownloadModal = dismissDownloadModal;
window.downloadRecording = downloadRecording;
