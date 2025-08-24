const pcMap = {}; // peerId -> RTCPeerConnection
const dcMap = {}; // peerId -> DataChannel
const candidateQueue = {}; // peerId -> [candidate, ...]
const config = { iceServers: [] }; // Optional: leer fürs LAN, später TURN eintragen

const roomInput = document.getElementById('roomId');
const joinBtn = document.getElementById('joinBtn');
const logPre = document.getElementById('log');
let ws = null;
let peers = [];
let myId = null;

// Hilfsfunktion: WebSocket-URL bauen
function getWebSocketUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}`;
}

// Logging-Funktion
function log(text, obj) {
    const ts = new Date().toISOString();
    let line = `[${ts}] ${text}`;
    if (obj) line += ' ' + JSON.stringify(obj, null, 2);
    logPre.textContent += line + '\n';
    logPre.scrollTop = logPre.scrollHeight;
}

// Sende-Helfer
function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// Peer-Liste aktualisieren
function updatePeers(list) {
    peers = list;
    log('Peers:', peers);
}

// Join-Button-Handler
joinBtn.onclick = () => {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    joinBtn.disabled = true;
    ws = new WebSocket(getWebSocketUrl());

    ws.onopen = () => {
        log('WebSocket open');
        send({ type: 'join', room: roomInput.value });
        // Button bleibt disabled bis close
    };

    ws.onmessage = async e => {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
            case 'hello':
                myId = msg.id;
                log('myId', myId);
                break;
            case 'joined':
                updatePeers(msg.peers || []);
                log('joined', msg);
                (msg.peers || []).forEach(id => {
                    if (!pcMap[id]) {
                        const isInitiator = myId < id;
                        createPeerConnection(id, isInitiator);
                    }
                });
                break;
            case 'peer-joined':
                peers.push(msg.id);
                log('peer-joined', msg);
                updatePeers(peers);
                if (!pcMap[msg.id]) {
                    const isInitiator = myId < msg.id;
                    createPeerConnection(msg.id, isInitiator);
                }
                break;
            case 'peer-left':
                peers = peers.filter(id => id !== msg.id);
                log('peer-left', msg);
                updatePeers(peers);
                break;
            case 'signal':
                log('signal', msg);
                log('signal RX', { from: msg.from, dataType: msg.data.type, sdpType: msg.data.sdp ? msg.data.sdp.type : undefined });
                const from = msg.from || msg.to;
                let pc = pcMap[from];
                if (!pc) {
                    const isInitiator = myId < from;
                    await createPeerConnection(from, isInitiator);
                    pc = pcMap[from];
                }
                // SDP-Handling
                if (msg.data.type === 'sdp') {
                    if (msg.data.sdp.type === 'offer') {
                        if (!pc) {
                            await createPeerConnection(from, false);
                            pc = pcMap[from];
                        }
                        await pc.setRemoteDescription(new RTCSessionDescription(msg.data.sdp));
                        // Nach setRemoteDescription: gepufferte ICE-Kandidaten verarbeiten
                        if (candidateQueue[from] && candidateQueue[from].length) {
                            for (const c of candidateQueue[from]) {
                                try { await pc.addIceCandidate(new RTCIceCandidate(c)); }
                                catch(e){ log('queued ICE add failed', e); }
                            }
                            delete candidateQueue[from];
                        }
                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);
                        send({
                            type: 'signal',
                            to: from,
                            data: { type: 'sdp', sdp: pc.localDescription }
                        });
                    } else if (msg.data.sdp.type === 'answer') {
                        if (pc) {
                            await pc.setRemoteDescription(new RTCSessionDescription(msg.data.sdp));
                            // Nach setRemoteDescription: gepufferte ICE-Kandidaten verarbeiten
                            if (candidateQueue[from] && candidateQueue[from].length) {
                                for (const c of candidateQueue[from]) {
                                    try { await pc.addIceCandidate(new RTCIceCandidate(c)); }
                                    catch(e){ log('queued ICE add failed', e); }
                                }
                                delete candidateQueue[from];
                            }
                        }
                    }
                }
                // ICE-Handling
                if (msg.data.type === 'ice') {
                    if (!pc) {
                        await createPeerConnection(from, false);
                        pc = pcMap[from];
                    }
                    // Falls remoteDescription noch nicht gesetzt ist, puffern
                    if (!pc.remoteDescription || !pc.remoteDescription.type) {
                        candidateQueue[from] = candidateQueue[from] || [];
                        candidateQueue[from].push(msg.data.candidate);
                    } else {
                        try {
                            await pc.addIceCandidate(new RTCIceCandidate(msg.data.candidate));
                        } catch (err) {
                            log('ICE add error', err);
                        }
                    }
                }
                break;
            default:
                log('unknown message', msg);
        }
    };

    ws.onerror = err => {
        log('WebSocket error', err);
    };

    ws.onclose = () => {
        log('WebSocket closed');
        peers = [];
        updatePeers(peers);
        joinBtn.disabled = false;
    };
};

async function createPeerConnection(peerId, isInitiator) {
    const pc = new RTCPeerConnection(config);
    pcMap[peerId] = pc;

    // Logging für Verbindungsstatus
    pc.onconnectionstatechange = () => log(`PC ${peerId} state: ${pc.connectionState}`);
    pc.oniceconnectionstatechange = () => log(`PC ${peerId} ICE: ${pc.iceConnectionState}`);
    pc.onsignalingstatechange = () => log(`PC ${peerId} signaling: ${pc.signalingState}`);

    // ICE-Kandidaten weiterleiten
    pc.onicecandidate = e => {
        if (e.candidate) {
            send({
                type: 'signal',
                to: peerId,
                data: { type: 'ice', candidate: e.candidate }
            });
        }
    };

    // Eingehende DataChannels behandeln
    pc.ondatachannel = ev => {
        setupDataChannel(peerId, ev.channel, false);
    };

    if (isInitiator) {
        const dc = pc.createDataChannel('file');
        setupDataChannel(peerId, dc, true);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({
            type: 'signal',
            to: peerId,
            data: { type: 'sdp', sdp:  pc.localDescription }
        });
    }
}

function setupDataChannel(peerId, dc, isLocalSender) {
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
        log(`DC open (${peerId}) state=${dc.readyState}`);
        // Hier könntest du z.B. einen Sende-Button aktivieren
    };

    dc.onmessage = ev => {
        console.log('msg from', peerId, ev.data);
        log(`DataChannel message from ${peerId}: ${typeof ev.data === 'string' ? ev.data : '[binary data]'}`);
    };

    dc.onclose = () => {
        log(`DataChannel closed with ${peerId}`);
    };

    dc.onerror = err => {
        log(`DataChannel error with ${peerId}`, err);
    };

    dcMap[peerId] = dc;
}