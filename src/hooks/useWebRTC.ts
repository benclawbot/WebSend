import { useState, useEffect, useRef, useCallback } from 'react';

export interface Peer {
  id: string;
  name: string;
  deviceType: string;
}

export interface Transfer {
  id: string;
  file: File | null;
  fileName: string;
  fileSize: number;
  fileType: string;
  progress: number;
  status: 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled';
  direction: 'send' | 'receive';
  targetPeerId: string;
}

export function useWebRTC() {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [myId, setMyId] = useState<string | null>(null);
  const [myName, setMyName] = useState<string>('');
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});
  const [incomingRequest, setIncomingRequest] = useState<Transfer | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({});
  const dataChannelsRef = useRef<Record<string, RTCDataChannel>>({});
  
  // File transfer state per transferId
  const receiveBuffersRef = useRef<Record<string, ArrayBuffer[]>>({});
  const receivedSizesRef = useRef<Record<string, number>>({});

  const connectWebSocket = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Connected to signaling server');
      const defaultName = `Device-${Math.floor(Math.random() * 10000)}`;
      setMyName(defaultName);
      ws.send(JSON.stringify({
        type: 'update-info',
        name: defaultName,
        deviceType: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop'
      }));
    };

    ws.onmessage = async (event) => {
      const message = JSON.parse(event.data);

      switch (message.type) {
        case 'welcome':
          setMyId(message.id);
          break;
        case 'peers':
          setPeers(message.peers);
          break;
        case 'offer':
          await handleOffer(message);
          break;
        case 'answer':
          await handleAnswer(message);
          break;
        case 'ice-candidate':
          await handleIceCandidate(message);
          break;
        case 'transfer-request':
          handleTransferRequest(message);
          break;
        case 'transfer-response':
          handleTransferResponse(message);
          break;
        case 'transfer-progress':
          updateTransferProgress(message.transferId, message.progress);
          break;
        case 'transfer-complete':
          completeTransfer(message.transferId);
          break;
        case 'transfer-cancel':
          cancelTransfer(message.transferId);
          break;
      }
    };

    ws.onclose = () => {
      console.log('Disconnected from signaling server, reconnecting...');
      setTimeout(connectWebSocket, 3000);
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connectWebSocket]);

  const createPeerConnection = (transferId: string, targetPeerId: string) => {
    if (peerConnectionsRef.current[transferId]) {
      return peerConnectionsRef.current[transferId];
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
      ]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current) {
        wsRef.current.send(JSON.stringify({
          type: 'ice-candidate',
          target: targetPeerId,
          transferId,
          candidate: event.candidate
        }));
      }
    };

    pc.ondatachannel = (event) => {
      setupDataChannel(event.channel, transferId, targetPeerId);
    };

    peerConnectionsRef.current[transferId] = pc;
    return pc;
  };

  const setupDataChannel = (channel: RTCDataChannel, transferId: string, targetPeerId: string) => {
    channel.binaryType = 'arraybuffer';
    
    channel.onopen = () => console.log(`Data channel open for transfer ${transferId}`);
    channel.onclose = () => console.log(`Data channel closed for transfer ${transferId}`);
    
    channel.onmessage = (event) => {
      setTransfers(prev => {
        const transfer = prev[transferId];
        if (!transfer) return prev;

        if (!receiveBuffersRef.current[transferId]) {
          receiveBuffersRef.current[transferId] = [];
          receivedSizesRef.current[transferId] = 0;
        }

        receiveBuffersRef.current[transferId].push(event.data);
        receivedSizesRef.current[transferId] += event.data.byteLength;

        const currentSize = receivedSizesRef.current[transferId];
        const progress = Math.round((currentSize / transfer.fileSize) * 100);
        
        // Notify sender of progress occasionally
        if (progress % 5 === 0 && wsRef.current) {
          wsRef.current.send(JSON.stringify({
            type: 'transfer-progress',
            target: targetPeerId,
            transferId,
            progress
          }));
        }

        if (currentSize >= transfer.fileSize) {
          // Transfer complete
          const blob = new Blob(receiveBuffersRef.current[transferId]);
          const url = URL.createObjectURL(blob);
          
          const a = document.createElement('a');
          a.href = url;
          a.download = transfer.fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1000);

          if (wsRef.current) {
            wsRef.current.send(JSON.stringify({
              type: 'transfer-complete',
              target: targetPeerId,
              transferId
            }));
          }

          // Cleanup
          delete receiveBuffersRef.current[transferId];
          delete receivedSizesRef.current[transferId];
          
          const pc = peerConnectionsRef.current[transferId];
          if (pc) {
            pc.close();
            delete peerConnectionsRef.current[transferId];
          }

          return {
            ...prev,
            [transferId]: { ...transfer, status: 'completed', progress: 100 }
          };
        }

        return {
          ...prev,
          [transferId]: { ...transfer, progress }
        };
      });
    };

    dataChannelsRef.current[transferId] = channel;
  };

  const handleOffer = async (message: any) => {
    const pc = createPeerConnection(message.transferId, message.from);
    await pc.setRemoteDescription(new RTCSessionDescription(message.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'answer',
        target: message.from,
        transferId: message.transferId,
        answer
      }));
    }
  };

  const handleAnswer = async (message: any) => {
    const pc = peerConnectionsRef.current[message.transferId];
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(message.answer));
    }
  };

  const handleIceCandidate = async (message: any) => {
    const pc = peerConnectionsRef.current[message.transferId];
    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
      } catch (e) {
        console.error('Error adding received ice candidate', e);
      }
    }
  };

  const sendFile = async (file: File, targetPeerId: string) => {
    const transferId = Math.random().toString(36).substring(2, 15);
    
    const newTransfer: Transfer = {
      id: transferId,
      file,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      progress: 0,
      status: 'pending',
      direction: 'send',
      targetPeerId
    };

    setTransfers(prev => ({ ...prev, [transferId]: newTransfer }));

    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'transfer-request',
        target: targetPeerId,
        transferId,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type
      }));
    }
  };

  const handleTransferRequest = (message: any) => {
    setIncomingRequest({
      id: message.transferId,
      file: null,
      fileName: message.fileName,
      fileSize: message.fileSize,
      fileType: message.fileType,
      progress: 0,
      status: 'pending',
      direction: 'receive',
      targetPeerId: message.from
    });
  };

  const acceptTransfer = async (transferId: string) => {
    if (!incomingRequest) return;
    
    setTransfers(prev => ({ ...prev, [transferId]: { ...incomingRequest, status: 'transferring' } }));
    
    receiveBuffersRef.current[transferId] = [];
    receivedSizesRef.current[transferId] = 0;
    
    const targetPeerId = incomingRequest.targetPeerId;
    setIncomingRequest(null);

    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'transfer-response',
        target: targetPeerId,
        transferId,
        accepted: true
      }));
    }
  };

  const rejectTransfer = (transferId: string) => {
    if (!incomingRequest) return;
    
    const targetPeerId = incomingRequest.targetPeerId;
    setIncomingRequest(null);

    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'transfer-response',
        target: targetPeerId,
        transferId,
        accepted: false
      }));
    }
  };

  const handleTransferResponse = async (message: any) => {
    const { transferId, accepted, from } = message;
    
    if (!accepted) {
      setTransfers(prev => ({
        ...prev,
        [transferId]: { ...prev[transferId], status: 'cancelled' }
      }));
      return;
    }

    setTransfers(prev => ({
      ...prev,
      [transferId]: { ...prev[transferId], status: 'transferring' }
    }));

    const pc = createPeerConnection(transferId, from);
    const dataChannel = pc.createDataChannel('fileTransfer', {
      ordered: true
    });
    setupDataChannel(dataChannel, transferId, from);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (wsRef.current) {
        wsRef.current.send(JSON.stringify({
          type: 'offer',
          target: from,
          transferId,
          offer
        }));
      }
    } catch (e) {
      console.error('Error creating offer', e);
    }

    const startSending = () => {
      setTransfers(prev => {
        const transfer = prev[transferId];
        if (!transfer || !transfer.file) return prev;

        const file = transfer.file;
        const chunkSize = 16384;
        let offset = 0;

        const readSlice = (o: number) => {
          const slice = file.slice(o, o + chunkSize);
          const reader = new FileReader();
          reader.onload = (e) => {
            if (dataChannel.readyState === 'open' && e.target?.result) {
              try {
                dataChannel.send(e.target.result as ArrayBuffer);
                offset += chunkSize;
                
                const progress = Math.round((offset / file.size) * 100);
                setTransfers(curr => ({
                  ...curr,
                  [transferId]: { ...curr[transferId], progress: Math.min(progress, 100) }
                }));

                if (offset < file.size) {
                  if (dataChannel.bufferedAmount > chunkSize * 64) {
                    const drainListener = () => {
                      dataChannel.removeEventListener('bufferedamountlow', drainListener);
                      readSlice(offset);
                    };
                    dataChannel.addEventListener('bufferedamountlow', drainListener);
                  } else {
                    setTimeout(() => readSlice(offset), 0);
                  }
                }
              } catch (error) {
                console.error('Error sending data:', error);
              }
            }
          };
          reader.readAsArrayBuffer(slice);
        };

        dataChannel.bufferedAmountLowThreshold = chunkSize * 16;
        readSlice(0);
        return prev;
      });
    };

    if (dataChannel.readyState === 'open') {
      startSending();
    } else {
      dataChannel.onopen = startSending;
    }
  };

  const updateTransferProgress = (transferId: string, progress: number) => {
    setTransfers(prev => {
      if (!prev[transferId]) return prev;
      return {
        ...prev,
        [transferId]: { ...prev[transferId], progress }
      };
    });
  };

  const completeTransfer = (transferId: string) => {
    setTransfers(prev => {
      if (!prev[transferId]) return prev;
      return {
        ...prev,
        [transferId]: { ...prev[transferId], status: 'completed', progress: 100 }
      };
    });
    
    const pc = peerConnectionsRef.current[transferId];
    if (pc) {
      pc.close();
      delete peerConnectionsRef.current[transferId];
    }
  };

  const cancelTransfer = (transferId: string) => {
    setTransfers(prev => {
      const transfer = prev[transferId];
      if (!transfer) return prev;
      
      if (wsRef.current && (transfer.status === 'pending' || transfer.status === 'transferring')) {
        wsRef.current.send(JSON.stringify({
          type: 'transfer-cancel',
          target: transfer.targetPeerId,
          transferId
        }));
      }

      return {
        ...prev,
        [transferId]: { ...transfer, status: 'cancelled' }
      };
    });
    
    const pc = peerConnectionsRef.current[transferId];
    if (pc) {
      pc.close();
      delete peerConnectionsRef.current[transferId];
    }
    delete receiveBuffersRef.current[transferId];
    delete receivedSizesRef.current[transferId];
  };

  const removeTransfer = (transferId: string) => {
    setTransfers(prev => {
      const newTransfers = { ...prev };
      delete newTransfers[transferId];
      return newTransfers;
    });
  };

  const updateMyInfo = (name: string) => {
    setMyName(name);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'update-info',
        name,
        deviceType: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop'
      }));
    }
  };

  return {
    peers: peers.filter(p => p.id !== myId),
    myId,
    myName,
    updateMyInfo,
    transfers: Object.values(transfers) as Transfer[],
    incomingRequest,
    sendFile,
    acceptTransfer,
    rejectTransfer,
    cancelTransfer,
    removeTransfer
  };
}
