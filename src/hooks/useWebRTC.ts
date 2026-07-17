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

type IncomingChunk = ArrayBuffer | ArrayBufferView | Blob;

export function useWebRTC() {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [myId, setMyId] = useState<string | null>(null);
  const [myName, setMyName] = useState<string>('');
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});
  const [incomingRequest, setIncomingRequest] = useState<Transfer | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({});
  const dataChannelsRef = useRef<Record<string, RTCDataChannel>>({});

  const receiveBuffersRef = useRef<Record<string, ArrayBuffer[]>>({});
  const receivedSizesRef = useRef<Record<string, number>>({});

  const closePeerConnection = (transferId: string) => {
    const channel = dataChannelsRef.current[transferId];
    if (channel && channel.readyState !== 'closed') {
      channel.close();
    }
    delete dataChannelsRef.current[transferId];

    const connection = peerConnectionsRef.current[transferId];
    if (connection) {
      connection.close();
    }
    delete peerConnectionsRef.current[transferId];
  };

  const clearReceiveState = (transferId: string) => {
    delete receiveBuffersRef.current[transferId];
    delete receivedSizesRef.current[transferId];
  };

  const toArrayBuffer = async (data: IncomingChunk): Promise<ArrayBuffer> => {
    if (data instanceof ArrayBuffer) {
      return data;
    }

    if (data instanceof Blob) {
      return data.arrayBuffer();
    }

    if (ArrayBuffer.isView(data)) {
      return data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer;
    }

    throw new TypeError('Unsupported WebRTC data channel payload');
  };

  const downloadReceivedFile = (transfer: Transfer, chunks: ArrayBuffer[]) => {
    const blob = new Blob(chunks, {
      type: transfer.fileType || 'application/octet-stream',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = transfer.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const updateTransferProgress = (transferId: string, progress: number) => {
    setTransfers(prev => {
      if (!prev[transferId]) return prev;
      return {
        ...prev,
        [transferId]: {
          ...prev[transferId],
          progress: Math.max(0, Math.min(progress, 100)),
        },
      };
    });
  };

  const completeTransfer = (transferId: string) => {
    setTransfers(prev => {
      if (!prev[transferId]) return prev;
      return {
        ...prev,
        [transferId]: { ...prev[transferId], status: 'completed', progress: 100 },
      };
    });
    closePeerConnection(transferId);
  };

  const cancelTransfer = (transferId: string) => {
    setTransfers(prev => {
      const transfer = prev[transferId];
      if (!transfer) return prev;

      if (
        wsRef.current?.readyState === WebSocket.OPEN &&
        (transfer.status === 'pending' || transfer.status === 'transferring')
      ) {
        wsRef.current.send(JSON.stringify({
          type: 'transfer-cancel',
          target: transfer.targetPeerId,
          transferId,
        }));
      }

      return {
        ...prev,
        [transferId]: { ...transfer, status: 'cancelled' },
      };
    });

    closePeerConnection(transferId);
    clearReceiveState(transferId);
  };

  const setupDataChannel = (
    channel: RTCDataChannel,
    transferId: string,
    targetPeerId: string,
  ) => {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => console.log(`Data channel open for transfer ${transferId}`);
    channel.onclose = () => console.log(`Data channel closed for transfer ${transferId}`);
    channel.onerror = error => {
      console.error(`Data channel error for transfer ${transferId}`, error);
      setTransfers(prev => {
        const transfer = prev[transferId];
        if (!transfer || transfer.status === 'completed') return prev;
        return {
          ...prev,
          [transferId]: { ...transfer, status: 'failed' },
        };
      });
    };

    channel.onmessage = async event => {
      let chunk: ArrayBuffer;

      try {
        chunk = await toArrayBuffer(event.data as IncomingChunk);
      } catch (error) {
        console.error('Failed to normalize received file chunk', error);
        setTransfers(prev => {
          const transfer = prev[transferId];
          if (!transfer) return prev;
          return {
            ...prev,
            [transferId]: { ...transfer, status: 'failed' },
          };
        });
        closePeerConnection(transferId);
        clearReceiveState(transferId);
        return;
      }

      setTransfers(prev => {
        const transfer = prev[transferId];
        if (!transfer || transfer.direction !== 'receive') return prev;

        const chunks = receiveBuffersRef.current[transferId] ?? [];
        const previousSize = receivedSizesRef.current[transferId] ?? 0;
        const currentSize = previousSize + chunk.byteLength;

        if (currentSize > transfer.fileSize) {
          console.error(
            `Transfer ${transferId} exceeded expected size: ${currentSize}/${transfer.fileSize}`,
          );
          closePeerConnection(transferId);
          clearReceiveState(transferId);
          return {
            ...prev,
            [transferId]: { ...transfer, status: 'failed' },
          };
        }

        chunks.push(chunk);
        receiveBuffersRef.current[transferId] = chunks;
        receivedSizesRef.current[transferId] = currentSize;

        const progress = transfer.fileSize === 0
          ? 100
          : Math.round((currentSize / transfer.fileSize) * 100);

        if (progress % 5 === 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'transfer-progress',
            target: targetPeerId,
            transferId,
            progress,
          }));
        }

        if (currentSize === transfer.fileSize) {
          downloadReceivedFile(transfer, chunks);

          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'transfer-complete',
              target: targetPeerId,
              transferId,
            }));
          }

          clearReceiveState(transferId);
          closePeerConnection(transferId);

          return {
            ...prev,
            [transferId]: { ...transfer, status: 'completed', progress: 100 },
          };
        }

        return {
          ...prev,
          [transferId]: { ...transfer, progress },
        };
      });
    };

    dataChannelsRef.current[transferId] = channel;
  };

  const createPeerConnection = (transferId: string, targetPeerId: string) => {
    if (peerConnectionsRef.current[transferId]) {
      return peerConnectionsRef.current[transferId];
    }

    const connection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    connection.onicecandidate = event => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'ice-candidate',
          target: targetPeerId,
          transferId,
          candidate: event.candidate,
        }));
      }
    };

    connection.ondatachannel = event => {
      setupDataChannel(event.channel, transferId, targetPeerId);
    };

    peerConnectionsRef.current[transferId] = connection;
    return connection;
  };

  const handleOffer = async (message: any) => {
    const connection = createPeerConnection(message.transferId, message.from);
    await connection.setRemoteDescription(new RTCSessionDescription(message.offer));
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'answer',
        target: message.from,
        transferId: message.transferId,
        answer,
      }));
    }
  };

  const handleAnswer = async (message: any) => {
    const connection = peerConnectionsRef.current[message.transferId];
    if (connection) {
      await connection.setRemoteDescription(new RTCSessionDescription(message.answer));
    }
  };

  const handleIceCandidate = async (message: any) => {
    const connection = peerConnectionsRef.current[message.transferId];
    if (!connection) return;

    try {
      await connection.addIceCandidate(new RTCIceCandidate(message.candidate));
    } catch (error) {
      console.error('Error adding received ICE candidate', error);
    }
  };

  const handleTransferRequest = (message: any) => {
    setIncomingRequest({
      id: message.transferId,
      file: null,
      fileName: message.fileName,
      fileSize: message.fileSize,
      fileType: message.fileType || 'application/octet-stream',
      progress: 0,
      status: 'pending',
      direction: 'receive',
      targetPeerId: message.from,
    });
  };

  const sendFile = async (file: File, targetPeerId: string) => {
    const transferId = Math.random().toString(36).substring(2, 15);
    const newTransfer: Transfer = {
      id: transferId,
      file,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || 'application/octet-stream',
      progress: 0,
      status: 'pending',
      direction: 'send',
      targetPeerId,
    };

    setTransfers(prev => ({ ...prev, [transferId]: newTransfer }));

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'transfer-request',
        target: targetPeerId,
        transferId,
        fileName: file.name,
        fileSize: file.size,
        fileType: newTransfer.fileType,
      }));
    }
  };

  const acceptTransfer = async (transferId: string) => {
    if (!incomingRequest) return;

    setTransfers(prev => ({
      ...prev,
      [transferId]: { ...incomingRequest, status: 'transferring' },
    }));
    receiveBuffersRef.current[transferId] = [];
    receivedSizesRef.current[transferId] = 0;

    const targetPeerId = incomingRequest.targetPeerId;
    const fileSize = incomingRequest.fileSize;
    setIncomingRequest(null);

    if (fileSize === 0) {
      downloadReceivedFile(incomingRequest, []);
      setTransfers(prev => ({
        ...prev,
        [transferId]: { ...incomingRequest, status: 'completed', progress: 100 },
      }));
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'transfer-response',
        target: targetPeerId,
        transferId,
        accepted: true,
      }));
    }
  };

  const rejectTransfer = (transferId: string) => {
    if (!incomingRequest) return;

    const targetPeerId = incomingRequest.targetPeerId;
    setIncomingRequest(null);

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'transfer-response',
        target: targetPeerId,
        transferId,
        accepted: false,
      }));
    }
  };

  const handleTransferResponse = async (message: any) => {
    const { transferId, accepted, from } = message;

    if (!accepted) {
      setTransfers(prev => ({
        ...prev,
        [transferId]: { ...prev[transferId], status: 'cancelled' },
      }));
      return;
    }

    setTransfers(prev => ({
      ...prev,
      [transferId]: { ...prev[transferId], status: 'transferring' },
    }));

    const connection = createPeerConnection(transferId, from);
    const dataChannel = connection.createDataChannel('fileTransfer', { ordered: true });
    setupDataChannel(dataChannel, transferId, from);

    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'offer',
          target: from,
          transferId,
          offer,
        }));
      }
    } catch (error) {
      console.error('Error creating offer', error);
      setTransfers(prev => ({
        ...prev,
        [transferId]: { ...prev[transferId], status: 'failed' },
      }));
      return;
    }

    const startSending = () => {
      const transfer = transfers[transferId];
      if (!transfer?.file) {
        setTransfers(prev => {
          const current = prev[transferId];
          if (!current?.file) return prev;
          sendFileChunks(current.file, dataChannel, transferId);
          return prev;
        });
        return;
      }

      sendFileChunks(transfer.file, dataChannel, transferId);
    };

    if (dataChannel.readyState === 'open') {
      startSending();
    } else {
      dataChannel.onopen = startSending;
    }
  };

  const sendFileChunks = (
    file: File,
    dataChannel: RTCDataChannel,
    transferId: string,
  ) => {
    const chunkSize = 16_384;
    let offset = 0;

    const failTransfer = (error: unknown) => {
      console.error('Error sending data', error);
      setTransfers(prev => {
        const transfer = prev[transferId];
        if (!transfer) return prev;
        return {
          ...prev,
          [transferId]: { ...transfer, status: 'failed' },
        };
      });
      closePeerConnection(transferId);
    };

    const readSlice = (start: number) => {
      const reader = new FileReader();
      const slice = file.slice(start, Math.min(start + chunkSize, file.size));

      reader.onerror = () => failTransfer(reader.error ?? new Error('Failed to read file chunk'));
      reader.onload = event => {
        if (dataChannel.readyState !== 'open') {
          failTransfer(new Error('Data channel closed before transfer completed'));
          return;
        }

        const result = event.target?.result;
        if (!(result instanceof ArrayBuffer)) {
          failTransfer(new TypeError('FileReader returned a non-binary result'));
          return;
        }

        try {
          dataChannel.send(result);
          offset += result.byteLength;

          const progress = file.size === 0
            ? 100
            : Math.round((offset / file.size) * 100);
          updateTransferProgress(transferId, progress);

          if (offset >= file.size) return;

          if (dataChannel.bufferedAmount > chunkSize * 64) {
            const drainListener = () => {
              dataChannel.removeEventListener('bufferedamountlow', drainListener);
              readSlice(offset);
            };
            dataChannel.addEventListener('bufferedamountlow', drainListener);
          } else {
            window.setTimeout(() => readSlice(offset), 0);
          }
        } catch (error) {
          failTransfer(error);
        }
      };

      reader.readAsArrayBuffer(slice);
    };

    dataChannel.bufferedAmountLowThreshold = chunkSize * 16;

    if (file.size === 0) {
      updateTransferProgress(transferId, 100);
      return;
    }

    readSlice(0);
  };

  const connectWebSocket = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      console.log('Connected to signaling server');
      const defaultName = `Device-${Math.floor(Math.random() * 10000)}`;
      setMyName(defaultName);
      ws.send(JSON.stringify({
        type: 'update-info',
        name: defaultName,
        deviceType: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
      }));
    };

    ws.onmessage = async event => {
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
          await handleTransferResponse(message);
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
      window.setTimeout(connectWebSocket, 3000);
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connectWebSocket();
    return () => {
      wsRef.current?.close();
      Object.keys(peerConnectionsRef.current).forEach(closePeerConnection);
    };
  }, [connectWebSocket]);

  const removeTransfer = (transferId: string) => {
    setTransfers(prev => {
      const newTransfers = { ...prev };
      delete newTransfers[transferId];
      return newTransfers;
    });
  };

  const updateMyInfo = (name: string) => {
    setMyName(name);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'update-info',
        name,
        deviceType: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
      }));
    }
  };

  return {
    peers: peers.filter(peer => peer.id !== myId),
    myId,
    myName,
    updateMyInfo,
    transfers: Object.values(transfers) as Transfer[],
    incomingRequest,
    sendFile,
    acceptTransfer,
    rejectTransfer,
    cancelTransfer,
    removeTransfer,
  };
}
