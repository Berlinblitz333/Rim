/**
 * CAPTION - ASL Translation Script
 * Integrated with PeerJS, TensorFlow.js Handpose, and Web Speech API
 * Enhanced with Calibration, Bounding Boxes, and Confidence Scoring
 */

// --- Variables ---
let localStream, peer, dataConn, handDetector, recognition;
let isSignOn = false, isVoiceOn = false, myPeerId = null;
let isMicMuted = false, isCamOff = false, isRecording = false;
let isSignToSpeechOn = false, lastSpokenGesture = "", lastSpeechTime = 0;
let isFlashOn = false; 
let sessionLog = [], voices = [];
let currentFacingMode = "user"; 

// --- Calibration Variables ---
let calibratedDistances = null;
let isCalibrating = false;
let lastGesture = "";
let lastGestureTime = 0;

// --- Cute Sound Effect ---
const bubbleSound = new Audio('bubble.mp3');
bubbleSound.volume = 0.5;

// --- DOM Elements ---
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const signCaption = document.getElementById('signCaption');       
const remoteSignCaption = document.getElementById('remoteSignCaption'); 
const speechCaption = document.getElementById('speechCaption');
const remoteSpeechCaption = document.getElementById('remoteSpeechCaption'); 
const statusDiv = document.getElementById('status');
const canvas = document.getElementById('overlayCanvas');
const copyIdBtn = document.getElementById('copyIdBtn');
const shareLinkBtn = document.getElementById('shareLinkBtn');
const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const remoteLoading = document.getElementById('remoteLoading');
const historyContent = document.getElementById('historyContent');
const voiceSelect = document.getElementById('voiceSelect');
const flashBtn = document.getElementById('toggleFlash');
const ctx = canvas.getContext('2d');

const splashScreen = document.getElementById('splash-screen');
const startAppBtn = document.getElementById('startAppBtn');

function updateStatus(msg) {
    if (statusDiv) statusDiv.textContent = msg;
    console.log(msg);
}

// --- VOICE INITIALIZATION ---
function loadVoices() {
    voices = window.speechSynthesis.getVoices();
    if (voiceSelect) {
        voiceSelect.innerHTML = '';
        voices.forEach((voice, i) => {
            const option = document.createElement('option');
            option.value = i;
            option.textContent = `${voice.name} (${voice.lang})`;
            if (voice.default || voice.lang === 'en-US') option.selected = true;
            voiceSelect.appendChild(option);
        });
    }
}

if (window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = loadVoices;
}

// --- SPLASH & INITIALIZATION ---
if (startAppBtn) {
    startAppBtn.addEventListener('click', async () => {
        splashScreen.classList.add('fade-out');
        if ("Notification" in window) {
            await Notification.requestPermission();
        }
        if (!localStream) startLocalVideo();
    });
}

// --- NOTIFICATION LOGIC ---
function showIncomingCallNotification(title, message) {
    if (Notification.permission === "granted") {
        bubbleSound.play().catch(e => console.log("Sound blocked"));
        navigator.serviceWorker.ready.then((registration) => {
            registration.showNotification(title, {
                body: message,
                icon: 'icon-512.png',
                tag: 'incoming-call',
                renotify: true,
                silent: true,
                actions: [
                    { action: 'join', title: 'Call (Auto-Join)' },
                    { action: 'close', title: 'Dismiss' }
                ]
            });
        });
    }
}

// --- FLASH / TORCH LOGIC ---
async function toggleFlash() {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    const capabilities = track.getCapabilities();
    if (!capabilities.torch) return;

    try {
        isFlashOn = !isFlashOn;
        await track.applyConstraints({ advanced: [{ torch: isFlashOn }] });
        flashBtn.classList.toggle('active', isFlashOn);
    } catch (e) { console.error(e); }
}

function updateFlashButtonVisibility() {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    const capabilities = track.getCapabilities();
    if (flashBtn) flashBtn.style.display = capabilities.torch ? "flex" : "none";
}

// --- FLOATING CONTROL TOGGLES (MIC & CAM) ---
document.getElementById('toggleMic').addEventListener('click', (e) => {
    isMicMuted = !isMicMuted;
    if (localStream) {
        localStream.getAudioTracks()[0].enabled = !isMicMuted;
    }
    const btn = e.currentTarget;
    btn.classList.toggle('off', isMicMuted);
    btn.innerHTML = isMicMuted ? "🚫" : "🎙️";
    updateStatus(isMicMuted ? "Microphone Muted" : "Microphone On");
});

document.getElementById('toggleCam').addEventListener('click', (e) => {
    isCamOff = !isCamOff;
    if (localStream) {
        localStream.getVideoTracks()[0].enabled = !isCamOff;
    }
    const btn = e.currentTarget;
    btn.classList.toggle('off', isCamOff);
    btn.innerHTML = isCamOff ? "✖" : "📷";
    updateStatus(isCamOff ? "Camera Stopped" : "Camera On");
});

// --- CAMERA SWITCH LOGIC ---
async function switchCamera() {
    if (!localStream) return;
    if (isFlashOn) await toggleFlash();

    currentFacingMode = (currentFacingMode === "user") ? "environment" : "user";
    localVideo.classList.toggle('no-mirror', currentFacingMode === "environment");
    canvas.classList.toggle('no-mirror', currentFacingMode === "environment");

    try {
        const videoTrack = localStream.getVideoTracks()[0];
        videoTrack.stop(); 

        const newStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: currentFacingMode },
            audio: true
        });

        const newVideoTrack = newStream.getVideoTracks()[0];
        
        if (peer && peer.connections) {
            Object.values(peer.connections).forEach(conns => {
                conns.forEach(conn => {
                    if (conn.peerConnection) {
                        const sender = conn.peerConnection.getSenders().find(s => s.track.kind === 'video');
                        if (sender) sender.replaceTrack(newVideoTrack);
                    }
                });
            });
        }

        localStream.removeTrack(videoTrack);
        localStream.addTrack(newVideoTrack);
        localVideo.srcObject = localStream;
        localStream.getAudioTracks()[0].enabled = !isMicMuted;
        
        setTimeout(updateFlashButtonVisibility, 500);
    } catch (e) { updateStatus("Error: " + e.message); }
}

// --- PEERJS LOGIC ---
function initPeer() {
    peer = new Peer(); 

    peer.on('open', (id) => {
        myPeerId = id;
        updateStatus("ID: " + id);
        copyIdBtn.style.display = "inline-block";
        shareLinkBtn.style.display = "inline-block";

        const roomToJoin = new URLSearchParams(window.location.search).get('room');
        if (roomToJoin) setTimeout(() => handleJoinCall(roomToJoin), 2000);
    });

    peer.on('connection', (conn) => {
        dataConn = conn;
        setupDataListeners();
    });

    peer.on('call', (call) => {
        if (document.visibilityState !== 'visible') {
            showIncomingCallNotification("CAPTION IS READY", "Someone is calling you!");
        }
        remoteLoading.style.display = "block";
        call.answer(localStream);
        call.on('stream', (remoteStream) => {
            remoteLoading.style.display = "none";
            remoteVideo.srcObject = remoteStream;
            document.getElementById('endCall').disabled = false;
        });
    });
}

function handleJoinCall(targetId) {
    updateStatus("Connecting...");
    remoteLoading.style.display = "block";
    dataConn = peer.connect(targetId);
    setupDataListeners();
    const call = peer.call(targetId, localStream);
    call.on('stream', (remoteStream) => {
        remoteLoading.style.display = "none";
        remoteVideo.srcObject = remoteStream;
        document.getElementById('endCall').disabled = false;
    });
}

function setupDataListeners() {
    dataConn.on('data', (data) => {
        if (data.type === 'sign') remoteSignCaption.textContent = data.value;
        if (data.type === 'speech') remoteSpeechCaption.textContent = data.value;
        if (data.type === 'chat') appendMessage("Remote", data.value);
    });
}

// --- BUTTONS & UTILS ---
document.getElementById('switchCam').addEventListener('click', switchCamera);
if (flashBtn) flashBtn.addEventListener('click', toggleFlash);

document.getElementById('shareLinkBtn').addEventListener('click', () => {
    const inviteLink = `${window.location.origin}${window.location.pathname}?room=${myPeerId}`;
    navigator.clipboard.writeText(inviteLink);
    alert("Link copied!");
});

function initTheme() {
    const btn = document.getElementById('themeToggle');
    const apply = (t) => {
        document.documentElement.setAttribute('data-theme', t);
        localStorage.setItem('caption-theme', t);
        if (btn) btn.textContent = t === 'dark' ? "☀️ Light Mode" : "🌙 Dark Mode";
    };
    apply(localStorage.getItem('caption-theme') || "light");
    btn?.addEventListener('click', () => apply(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
}

function appendMessage(sender, text) {
    const msgEl = document.createElement('p');
    msgEl.innerHTML = `<b>${sender}:</b> ${text}`;
    chatLog.appendChild(msgEl);
    chatLog.scrollTop = chatLog.scrollHeight;
}

function sendChatMessage() {
    const message = chatInput.value.trim();
    if (message && dataConn?.open) {
        dataConn.send({ type: 'chat', value: message });
        appendMessage("You", message);
        chatInput.value = "";
    }
}

// --- AI ENGINE & VISUALS ---
async function initHandDetection() {
    try {
        const model = handPoseDetection.SupportedModels.MediaPipeHands;
        handDetector = await handPoseDetection.createDetector(model, { runtime: 'tfjs', modelType: 'full' });
        updateStatus("AI Active!");
    } catch (err) { updateStatus("AI Error"); }
}

// Geometry tool to find distance between two points
function getDist(p1, p2) {
    if (!p1 || !p2) return 0;
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

// Helper to draw bounding box and skeleton dots
function drawHandVisuals(hand) {
    const keypoints = hand.keypoints;
    const xCoords = keypoints.map(p => p.x);
    const yCoords = keypoints.map(p => p.y);
    const minX = Math.min(...xCoords) - 20;
    const maxX = Math.max(...xCoords) + 20;
    const minY = Math.min(...yCoords) - 20;
    const maxY = Math.max(...yCoords) + 20;

    // Draw Bounding Box (Green)
    ctx.strokeStyle = "#00FF00";
    ctx.lineWidth = 3;
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

    // Draw Labels
    ctx.fillStyle = "#00FF00";
    ctx.font = "bold 16px Arial";
    const confidence = (hand.score * 100).toFixed(1);
    ctx.fillText(`Prediction: ${signCaption.textContent}`, minX, minY - 25);
    ctx.fillText(`Confidence: ${confidence}%`, minX, minY - 5);

    // Draw Skeleton Joints (Red)
    keypoints.forEach(pt => {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 4, 0, 2 * Math.PI);
        ctx.fillStyle = "#FF0000";
        ctx.fill();
    });
}

// --- MAIN AI LOOP ---
async function detectHands() {
    if (!isSignOn || !handDetector || !localVideo) return;
    
    if (localVideo.readyState === 4) {
        // FIXED: This part ensures the Canvas draws exactly where the video pixels are
        if (canvas.width !== localVideo.videoWidth || canvas.height !== localVideo.videoHeight) {
            canvas.width = localVideo.videoWidth;
            canvas.height = localVideo.videoHeight;
        }
        
        const hands = await handDetector.estimateHands(localVideo);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (hands?.length > 0) {
            // Support mirroring for visual drawing
            if (currentFacingMode === "user") {
                ctx.save();
                ctx.scale(-1, 1);
                ctx.translate(-canvas.width, 0);
            }

            for (const hand of hands) {
                const keypoints = hand.keypoints;

                // 1. Draw UI visuals
                drawHandVisuals(hand);

                // 2. Handle Calibration
                if (isCalibrating) {
                    calibrateUserHand(keypoints);
                    isCalibrating = false;
                }

                // 3. Detect Gesture
                const gesture = detectGesture(keypoints);
                if (gesture && gesture !== lastGesture) {
                    signCaption.textContent = gesture;
                    if (dataConn?.open) dataConn.send({ type: 'sign', value: gesture });
                    speakGesture(gesture);
                    lastGesture = gesture;
                }
            }

            if (currentFacingMode === "user") ctx.restore();
        }
    }
    requestAnimationFrame(detectHands);
}

// 1. Function to Calibrate (Learns YOUR hand's proportions)
function calibrateUserHand(landmarks) {
    const measurements = {
        palmSize: getDist(landmarks[0], landmarks[5]),
        index: getDist(landmarks[5], landmarks[8]),
        middle: getDist(landmarks[9], landmarks[12]),
        ring: getDist(landmarks[13], landmarks[16]),
        pinky: getDist(landmarks[17], landmarks[20]),
        thumb: getDist(landmarks[0], landmarks[4])
    };
    calibratedDistances = measurements;
    updateStatus("Fine-Tuning Complete! Ready.");
}

// 2. Updated detectGesture (High accuracy logic)
function detectGesture(posList) {
    if (!calibratedDistances) return "Need Calibration";

    // Landmarks: Tip vs Knuckle (PIP)
    const isIndexUp = posList[8].y < posList[6].y;
    const isMiddleUp = posList[12].y < posList[10].y;
    const isRingUp = posList[16].y < posList[14].y;
    const isPinkyUp = posList[20].y < posList[18].y;
    const isThumbUp = posList[4].y < posList[2].y;

    // "HELLO" (All fingers extended)
    if (isIndexUp && isMiddleUp && isRingUp && isPinkyUp) return "HELLO";

    // "I LOVE YOU" (Thumb, Index, Pinky Up)
    if (isThumbUp && isIndexUp && isPinkyUp && !isMiddleUp && !isRingUp) return "I LOVE YOU";
    
    // "PEACE" (Index and Middle Up)
    if (isIndexUp && isMiddleUp && !isRingUp && !isPinkyUp) return "PEACE";

    // "A" (Fist shape)
    if (!isIndexUp && !isMiddleUp && !isRingUp && !isPinkyUp) return "A";

    return "";
}

// 3. Audio Feedback
function speakGesture(gesture) {
    if (!isSignToSpeechOn || !gesture || gesture === "Need Calibration") return;
    
    const now = Date.now();
    if (gesture !== lastSpokenGesture || (now - lastSpeechTime > 3000)) {
        const utterance = new SpeechSynthesisUtterance(gesture);
        const selectedVoiceIndex = voiceSelect.value;
        if (voices[selectedVoiceIndex]) utterance.voice = voices[selectedVoiceIndex];

        window.speechSynthesis.speak(utterance);
        lastSpokenGesture = gesture;
        lastSpeechTime = now;
    }
}

// --- CALIBRATION INTERFACE ---
document.getElementById('calibrateBtn').addEventListener('click', () => {
    isCalibrating = true;
    updateStatus("Calibrating... Hold Sign 'A' (Fist)");
    bubbleSound.play().catch(() => {});
});

// --- TOGGLES ---
document.getElementById('toggleSign').addEventListener('click', (e) => {
    isSignOn = !isSignOn;
    e.target.style.background = isSignOn ? "var(--brand-blue)" : "";
    if (isSignOn) detectHands();
});

document.getElementById('toggleSignToSpeech').addEventListener('click', (e) => {
    isSignToSpeechOn = !isSignToSpeechOn;
    e.target.textContent = `🔊 Sign-to-Speech: ${isSignToSpeechOn ? 'ON' : 'OFF'}`;
    e.target.style.background = isSignToSpeechOn ? "#27ae60" : "#9C27B0";
});

document.getElementById('sendChat').addEventListener('click', sendChatMessage);
document.getElementById('endCall').addEventListener('click', () => location.reload());

async function startLocalVideo() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: true });
        localVideo.srcObject = localStream;
        initTheme(); 
        initPeer();
        initHandDetection();
        loadVoices();
        setTimeout(updateFlashButtonVisibility, 1000);
    } catch (e) { updateStatus("Camera Error"); }
}

// --- MOBILE APP DOWNLOAD LOGIC ---
function initDownloadButton() {
    const downloadBtn = document.getElementById('downloadAppBtn');
    if (!downloadBtn) return;
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;
    const isAndroid = /android/i.test(userAgent);
    const isIOS = /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream;

    if (isAndroid || isIOS) {
        downloadBtn.style.display = "block";
    }
}

window.addEventListener('DOMContentLoaded', initDownloadButton);

let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const downloadBtn = document.getElementById('downloadAppBtn');
    if (downloadBtn) {
        downloadBtn.style.display = 'block';
        downloadBtn.textContent = "📲 INSTALL APP";
    }
});

function handleDownloadClick() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') console.log('User installed CAPTION');
            deferredPrompt = null;
        });
    } else {
        const userAgent = navigator.userAgent || navigator.vendor || window.opera;
        if (/android/i.test(userAgent)) {
            window.open("https://play.google.com/store/apps/details?id=YOUR_APP_ID", "_blank");
        } else if (/iPad|iPhone|iPod/.test(userAgent)) {
            window.open("https://apps.apple.com/app/YOUR_APP_ID", "_blank");
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const downloadBtn = document.getElementById('downloadAppBtn');
    if (downloadBtn) downloadBtn.addEventListener('click', handleDownloadClick);
});

// --- MENU & ABOUT PAGE LOGIC ---
const sideMenu = document.getElementById('side-menu');
const menuOverlay = document.getElementById('menu-overlay');
const aboutOverlay = document.getElementById('aboutOverlay');
const helpOverlay = document.getElementById('helpOverlay');

document.getElementById('openMenu').addEventListener('click', () => {
    sideMenu.classList.add('active');
    menuOverlay.style.display = 'block';
});

function closeAllMenus() {
    sideMenu.classList.remove('active');
    menuOverlay.style.display = 'none';
    aboutOverlay.style.display = 'none';
    if(helpOverlay) helpOverlay.style.display = 'none';
}

document.getElementById('closeMenu').addEventListener('click', closeAllMenus);
menuOverlay.addEventListener('click', closeAllMenus);

document.getElementById('showAbout').addEventListener('click', () => {
    aboutOverlay.style.display = 'flex';
    sideMenu.classList.remove('active');
});

document.getElementById('closeAbout').addEventListener('click', closeAllMenus);

if (document.getElementById('showHelp')) {
    document.getElementById('showHelp').addEventListener('click', () => {
        helpOverlay.style.display = 'flex';
        sideMenu.classList.remove('active');
        menuOverlay.style.display = 'none';
    });
}

if (document.getElementById('closeHelp')) {
    document.getElementById('closeHelp').addEventListener('click', () => {
        helpOverlay.style.display = 'none';
    });
}

if (document.getElementById('contactSupport')) {
    document.getElementById('contactSupport').addEventListener('click', () => {
        const subject = encodeURIComponent("CAPTION App Support Request");
        const body = encodeURIComponent("Hello CAPTION Team,\n\nI need help with...");
        window.location.href = `mailto:support@captionapp.com?subject=${subject}&body=${body}`;
    });
}

let statsInterval;

function startConnectionMonitoring(connection) {
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    if (statsInterval) clearInterval(statsInterval);

    statsInterval = setInterval(async () => {
        if (!connection || !connection.peerConnection) return;

        const stats = await connection.peerConnection.getStats();
        let rtt = 0;

        stats.forEach(report => {
            // Look for the active candidate pair to find the Round Trip Time
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                rtt = report.currentRoundTripTime * 1000; // Convert to milliseconds
            }
        });

        // Update UI based on RTT
        statusDot.className = ''; // Reset classes
        if (rtt === 0) {
            statusDot.style.backgroundColor = '#bbb';
            statusText.innerText = 'Connecting...';
        } else if (rtt < 150) {
            statusDot.classList.add('status-good');
            statusText.innerText = 'Excellent';
        } else if (rtt < 300) {
            statusDot.classList.add('status-poor');
            statusText.innerText = 'Fair';
        } else {
            statusDot.classList.add('status-bad');
            statusText.innerText = 'Poor';
        }
    }, 2000); // Check every 2 seconds
}

// Trigger this when a call is accepted or started:
// Example: peer.on('call', (call) => { ... startConnectionMonitoring(call); });

// --- DARK MODE LOGIC ---
const themeToggle = document.getElementById('themeToggle');

// Check for saved user preference on load
const savedTheme = localStorage.getItem('theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
updateThemeButton(savedTheme);

themeToggle.addEventListener('click', () => {
    // Get current theme
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    // Apply new theme
    document.documentElement.setAttribute('data-theme', newTheme);
    
    // Save preference
    localStorage.getItem('theme', newTheme);
    
    // Update button text/icon
    updateThemeButton(newTheme);
});

function updateThemeButton(theme) {
    if (theme === 'dark') {
        themeToggle.innerHTML = '☀️ Light Mode';
    } else {
        themeToggle.innerHTML = '🌙 Dark Mode';
    }
}