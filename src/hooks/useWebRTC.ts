import { useCallback, useEffect, useRef, useState } from 'react';

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
  downloadUrl?: string;
  error?: string;
}

type IncomingChunk = ArrayBuffer | ArrayBufferView | Blob;

type DataControlMessage = {
  websend: 1;
  type: 'progress' | 'complete' | 'cancel' | 'error';
  transferId: string;
  progress?: number;
  message?: string;
};

type SignalMessage = Record<string, unknown> & {
  type?: string;
  transferId?: string;
  from?: string;
  target?: string;
};

const CHUNK_SIZE = 16_384;
const HIGH_WATER_MARK = 512 * 1024;
const LOW_WATER_MARK = 64 * 1024;
const REQUEST_TIMEOUT_MS = 2 * 60_000;
const TRANSFER_TIMEOUT_MS = 3 * 60_000;
const DISCONNECTED_GRACE_MS = 15_000;
const MAX_INCOMING_QUEUE = 10;

const isTerminal = (status: Transfer['status']) =>
  status === 'completed' || status === 'failed' || status === 'cancelled';

const getStoredValue = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const setStoredValue = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private browsing modes.
  }
};

const createId = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

export function useWebRTC() {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [myId, setMyId] = useState<string | null>(null);
  const [myName, setMyName] = useState('');
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});
  const [incomingRequest, setIncomingRequest] = useState<Transfer | null>(null);

  const transfersRef = useRef<Record<string, Transfer>>({});
  const incomingQueueRef = useRef<Transfer[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({});
  const dataChannelsRef = useRef<Record<string, RTCDataChannel>>({});
  const receiveBuffersRef = useRef<Record<string, ArrayBuffer[]>>({});
  const receivedSizesRef = useRef<Record<string, number>>({});
  const receiveChainsRef = useRef<Record<string, Promise<void>>>({});
  const pendingIceCandidatesRef = useRef<Record<string, RTCIceCandidateInit[]>>({});
  const transferTimersRef = useRef<Record<string, number>>({});
  const timeoutRefreshRef = useRef<Record<string, number>>({});
  const lastReportedProgressRef = useRef<Record<string, number>>({});
  const disconnectTimersRef = useRef<Record<string, number>>({});
  const reconnectTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const messageHandlerRef = useRef<(message: SignalMessage) => Promise<void>>(async () => {});
  const deviceIdRef = useRef(getStoredValue('websend-device-id') || createId());
  const deviceNameRef = useRef(getStoredValue('websend-device-name') || `Device-${Math.floor(Math.random() * 10_000)}`);

  const publishTransfers = (next: Record<string, Transfer>) => {
    transfersRef.current = next;
    setTransfers(next);
  };

  const addTransfer = (transfer: Transfer) => {
    publishTransfers({ ...transfersRef.current, [transfer.id]: transfer });
  };

  const patchTransfer = (transferId: string, patch: Partial<Transfer>) => {
    const current = transfersRef.current[transferId];
    if (!current) return null;
    const updated = { ...current, ...patch };
    publishTransfers({ ...transfersRef.current, [transferId]: updated });
    return updated;
  };

  const clearTransferTimer = (transferId: string) => {
    const timer = transferTimersRef.current[transferId];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete transferTimersRef.current[transferId];
      delete timeoutRefreshRef.current[transferId];
    }
  };

  const scheduleTransferTimeout = (
    transferId: string,
    timeoutMs: number,
    message: string,
    force = false,
  ) => {
    const now = Date.now();
    if (
      !force &&
      transferTimersRef.current[transferId] !== undefined &&
      now - (timeoutRefreshRef.current[transferId] ?? 0) < 5_000
    ) return;

    clearTransferTimer(transferId);
    timeoutRefreshRef.current[transferId] = now;
    transferTimersRef.current[transferId] = window.setTimeout(() => {
      const transfer = transfersRef.current[transferId];
      if (transfer && !isTerminal(transfer.status)) {
        failTransfer(transferId, message, false);
      }
    }, timeoutMs);
  };

  const clearDisconnectTimer = (transferId: string) => {
    const timer = disconnectTimersRef.current[transferId];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete disconnectTimersRef.current[transferId];
    }
  };

  const clearReceiveState = (transferId: string) => {
    delete receiveBuffersRef.current[transferId];
    delete receivedSizesRef.current[transferId];
    delete receiveChainsRef.current[transferId];
    delete lastReportedProgressRef.current[transferId];
  };

  const closePeerConnection = (transferId: string) => {
    clearDisconnectTimer(transferId);

    const channel = dataChannelsRef.current[transferId];
    if (channel && channel.readyState !== 'closed') {
      channel.onmessage = null;
      channel.onopen = null;
      channel.onerror = null;
      channel.onclose = null;
      channel.close();
    }
    delete dataChannelsRef.current[transferId];

    const connection = peerConnectionsRef.current[transferId];
    if (connection) {
      connection.onicecandidate = null;
      connection.ondatachannel = null;
      connection.onconnectionstatechange = null;
      connection.oniceconnectionstatechange = null;
      connection.close();
    }
    delete peerConnectionsRef.current[transferId];
    delete pendingIceCandidatesRef.current[transferId];
  };

  const failTransfer = (
    transferId: string,
    message: string,
    notifyPeer = true,
  ) => {
    const transfer = transfersRef.current[transferId];
    if (!transfer || isTerminal(transfer.status)) return;

    patchTransfer(transferId, { status: 'failed', error: message });
    clearTransferTimer(transferId);

    const channel = dataChannelsRef.current[transferId];
    if (notifyPeer && channel?.readyState === 'open') {
      try {
        channel.send(JSON.stringify({
          websend: 1,
          type: 'error',
          transferId,
          message,
        } satisfies DataControlMessage));
      } catch {
        // The connection is already failing; cleanup below is authoritative.
      }
    }

    closePeerConnection(transferId);
    clearReceiveState(transferId);
  };

  const toArrayBuffer = async (data: IncomingChunk): Promise<ArrayBuffer> => {
    if (data instanceof ArrayBuffer) return data;
    if (data instanceof Blob) return data.arrayBuffer();
    if (ArrayBuffer.isView(data)) {
      return data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer;
    }
    throw new TypeError('Unsupported WebRTC data channel payload');
  };

  const createDownloadUrl = (transfer: Transfer, chunks: ArrayBuffer[]) => {
    if (transfer.downloadUrl) {
      URL.revokeObjectURL(transfer.downloadUrl);
    }
    const blob = new Blob(chunks, {
      type: transfer.fileType || 'application/octet-stream',
    });
    return URL.createObjectURL(blob);
  };

  const sendSignal = (message: SignalMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  };

  const waitForChannelDrain = (
    channel: RTCDataChannel,
    maxBufferedAmount = LOW_WATER_MARK,
    timeoutMs = 30_000,
  ) => new Promise<void>((resolve, reject) => {
    if (channel.readyState !== 'open') {
      reject(new Error('Data channel is not open'));
      return;
    }
    if (channel.bufferedAmount <= maxBufferedAmount) {
      resolve();
      return;
    }

    channel.bufferedAmountLowThreshold = maxBufferedAmount;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (channel.readyState !== 'open') {
        window.clearInterval(timer);
        reject(new Error('Data channel closed while waiting for backpressure'));
        return;
      }
      if (channel.bufferedAmount <= maxBufferedAmount) {
        window.clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(timer);
        reject(new Error('Timed out waiting for the data channel buffer to drain'));
      }
    }, 50);
  });

  const parseDataControlMessage = (value: string): DataControlMessage | null => {
    try {
      const parsed = JSON.parse(value) as Partial<DataControlMessage>;
      if (
        parsed.websend === 1 &&
        typeof parsed.type === 'string' &&
        typeof parsed.transferId === 'string'
      ) {
        return parsed as DataControlMessage;
      }
    } catch {
      // A string payload from another implementation is ignored safely.
    }
    return null;
  };

  const sendDataControl = (
    channel: RTCDataChannel,
    message: DataControlMessage,
  ) => {
    if (channel.readyState !== 'open') return false;
    channel.send(JSON.stringify(message));
    return true;
  };

  const handleDataControl = (
    channel: RTCDataChannel,
    message: DataControlMessage,
  ) => {
    const transfer = transfersRef.current[message.transferId];
    if (!transfer) return;

    if (message.type === 'progress' && transfer.direction === 'send') {
      const progress = Math.max(0, Math.min(message.progress ?? 0, 99));
      patchTransfer(message.transferId, { progress });
      scheduleTransferTimeout(
        message.transferId,
        TRANSFER_TIMEOUT_MS,
        'Transfer stalled before the receiver confirmed completion',
      );
      return;
    }

    if (message.type === 'complete' && transfer.direction === 'send') {
      patchTransfer(message.transferId, {
        status: 'completed',
        progress: 100,
        error: undefined,
      });
      clearTransferTimer(message.transferId);
      window.setTimeout(() => closePeerConnection(message.transferId), 150);
      return;
    }

    if (message.type === 'cancel') {
      patchTransfer(message.transferId, {
        status: 'cancelled',
        error: 'Cancelled by the other device',
      });
      clearTransferTimer(message.transferId);
      closePeerConnection(message.transferId);
      clearReceiveState(message.transferId);
      return;
    }

    if (message.type === 'error') {
      failTransfer(
        message.transferId,
        message.message || 'The other device reported a transfer error',
        false,
      );
      return;
    }

    if (channel.readyState !== 'open') {
      failTransfer(message.transferId, 'Data channel closed unexpectedly', false);
    }
  };

  const completeReceivedTransfer = async (
    transfer: Transfer,
    channel: RTCDataChannel,
    chunks: ArrayBuffer[],
  ) => {
    const downloadUrl = createDownloadUrl(transfer, chunks);
    patchTransfer(transfer.id, {
      status: 'completed',
      progress: 100,
      downloadUrl,
      error: undefined,
    });
    clearTransferTimer(transfer.id);
    clearReceiveState(transfer.id);

    sendDataControl(channel, {
      websend: 1,
      type: 'complete',
      transferId: transfer.id,
    });

    try {
      await waitForChannelDrain(channel, 0, 5_000);
    } catch {
      // The completion frame was queued before this wait; cleanup can continue.
    }
    window.setTimeout(() => closePeerConnection(transfer.id), 150);
  };

  const handleBinaryChunk = async (
    transferId: string,
    targetPeerId: string,
    channel: RTCDataChannel,
    data: IncomingChunk,
  ) => {
    const transfer = transfersRef.current[transferId];
    if (!transfer || transfer.direction !== 'receive' || isTerminal(transfer.status)) return;

    const chunk = await toArrayBuffer(data);
    const chunks = receiveBuffersRef.current[transferId] ?? [];
    const previousSize = receivedSizesRef.current[transferId] ?? 0;
    const currentSize = previousSize + chunk.byteLength;

    if (currentSize > transfer.fileSize) {
      failTransfer(
        transferId,
        `Received more bytes than expected (${currentSize}/${transfer.fileSize})`,
      );
      return;
    }

    chunks.push(chunk);
    receiveBuffersRef.current[transferId] = chunks;
    receivedSizesRef.current[transferId] = currentSize;

    const progress = transfer.fileSize === 0
      ? 100
      : Math.round((currentSize / transfer.fileSize) * 100);
    patchTransfer(transferId, { progress });
    scheduleTransferTimeout(
      transferId,
      TRANSFER_TIMEOUT_MS,
      'Transfer stalled before all bytes were received',
    );

    const lastReportedProgress = lastReportedProgressRef.current[transferId] ?? -1;
    if (progress >= lastReportedProgress + 2 || currentSize === transfer.fileSize) {
      lastReportedProgressRef.current[transferId] = progress;
      sendDataControl(channel, {
        websend: 1,
        type: 'progress',
        transferId,
        progress: Math.min(progress, 99),
      });
    }

    if (currentSize === transfer.fileSize) {
      await completeReceivedTransfer(transfer, channel, chunks);
    }
  };

  const setupDataChannel = (
    channel: RTCDataChannel,
    transferId: string,
    targetPeerId: string,
  ) => {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;

    channel.onmessage = event => {
      const previous = receiveChainsRef.current[transferId] ?? Promise.resolve();
      const next = previous.then(async () => {
        if (typeof event.data === 'string') {
          const control = parseDataControlMessage(event.data);
          if (control) handleDataControl(channel, control);
          return;
        }
        await handleBinaryChunk(
          transferId,
          targetPeerId,
          channel,
          event.data as IncomingChunk,
        );
      });

      receiveChainsRef.current[transferId] = next.catch(error => {
        failTransfer(
          transferId,
          error instanceof Error ? error.message : 'Failed to process incoming data',
        );
      });
    };

    channel.onerror = () => {
      failTransfer(transferId, 'The WebRTC data channel reported an error', false);
    };

    channel.onclose = () => {
      const transfer = transfersRef.current[transferId];
      if (transfer && !isTerminal(transfer.status)) {
        failTransfer(transferId, 'The data channel closed before completion', false);
      }
    };

    dataChannelsRef.current[transferId] = channel;
  };

  const flushPendingIceCandidates = async (transferId: string) => {
    const connection = peerConnectionsRef.current[transferId];
    if (!connection?.remoteDescription) return;

    const pending = pendingIceCandidatesRef.current[transferId] ?? [];
    delete pendingIceCandidatesRef.current[transferId];
    for (const candidate of pending) {
      await connection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  };

  const createPeerConnection = (transferId: string, targetPeerId: string) => {
    const existing = peerConnectionsRef.current[transferId];
    if (existing) return existing;

    const connection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    connection.onicecandidate = event => {
      if (event.candidate) {
        sendSignal({
          type: 'ice-candidate',
          target: targetPeerId,
          transferId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    connection.ondatachannel = event => {
      setupDataChannel(event.channel, transferId, targetPeerId);
    };

    const updateConnectionHealth = () => {
      const state = connection.connectionState;
      if (state === 'connected') {
        clearDisconnectTimer(transferId);
        scheduleTransferTimeout(
          transferId,
          TRANSFER_TIMEOUT_MS,
          'Transfer timed out due to inactivity',
        );
      } else if (state === 'failed') {
        failTransfer(transferId, 'Unable to establish a peer-to-peer connection', false);
      } else if (state === 'disconnected') {
        clearDisconnectTimer(transferId);
        disconnectTimersRef.current[transferId] = window.setTimeout(() => {
          if (connection.connectionState === 'disconnected') {
            failTransfer(transferId, 'Peer connection was lost', false);
          }
        }, DISCONNECTED_GRACE_MS);
      }
    };

    connection.onconnectionstatechange = updateConnectionHealth;
    connection.oniceconnectionstatechange = () => {
      if (connection.iceConnectionState === 'failed') {
        failTransfer(transferId, 'ICE negotiation failed', false);
      }
    };

    peerConnectionsRef.current[transferId] = connection;
    return connection;
  };

  const handleOffer = async (message: SignalMessage) => {
    if (
      typeof message.transferId !== 'string' ||
      typeof message.from !== 'string' ||
      !message.offer
    ) return;

    const connection = createPeerConnection(message.transferId, message.from);
    try {
      await connection.setRemoteDescription(message.offer as RTCSessionDescriptionInit);
      await flushPendingIceCandidates(message.transferId);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);

      if (!sendSignal({
        type: 'answer',
        target: message.from,
        transferId: message.transferId,
        answer,
      })) {
        failTransfer(message.transferId, 'Signaling connection was lost while answering');
      }
    } catch (error) {
      failTransfer(
        message.transferId,
        error instanceof Error ? error.message : 'Failed to process WebRTC offer',
      );
    }
  };

  const handleAnswer = async (message: SignalMessage) => {
    if (typeof message.transferId !== 'string' || !message.answer) return;
    const connection = peerConnectionsRef.current[message.transferId];
    if (!connection) return;

    try {
      await connection.setRemoteDescription(message.answer as RTCSessionDescriptionInit);
      await flushPendingIceCandidates(message.transferId);
    } catch (error) {
      failTransfer(
        message.transferId,
        error instanceof Error ? error.message : 'Failed to process WebRTC answer',
      );
    }
  };

  const handleIceCandidate = async (message: SignalMessage) => {
    if (typeof message.transferId !== 'string' || !message.candidate) return;
    const candidate = message.candidate as RTCIceCandidateInit;
    const connection = peerConnectionsRef.current[message.transferId];

    if (!connection || !connection.remoteDescription) {
      const pending = pendingIceCandidatesRef.current[message.transferId] ?? [];
      pending.push(candidate);
      pendingIceCandidatesRef.current[message.transferId] = pending;
      return;
    }

    try {
      await connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      failTransfer(
        message.transferId,
        error instanceof Error ? error.message : 'Failed to add an ICE candidate',
      );
    }
  };

  const showNextIncomingRequest = () => {
    setIncomingRequest(incomingQueueRef.current[0] ?? null);
  };

  const removeIncomingRequest = (transferId: string) => {
    incomingQueueRef.current = incomingQueueRef.current.filter(
      request => request.id !== transferId,
    );
    showNextIncomingRequest();
  };

  const handleTransferRequest = (message: SignalMessage) => {
    if (
      typeof message.transferId !== 'string' ||
      typeof message.from !== 'string' ||
      typeof message.fileName !== 'string' ||
      typeof message.fileSize !== 'number' ||
      !Number.isFinite(message.fileSize) ||
      message.fileSize < 0 ||
      message.fileSize > Number.MAX_SAFE_INTEGER
    ) return;

    if (incomingQueueRef.current.some(request => request.id === message.transferId)) return;

    if (incomingQueueRef.current.length >= MAX_INCOMING_QUEUE) {
      sendSignal({
        type: 'transfer-response',
        target: message.from,
        transferId: message.transferId,
        accepted: false,
        reason: 'Receiver is busy',
      });
      return;
    }

    const request: Transfer = {
      id: message.transferId,
      file: null,
      fileName: message.fileName,
      fileSize: message.fileSize,
      fileType: typeof message.fileType === 'string'
        ? message.fileType
        : 'application/octet-stream',
      progress: 0,
      status: 'pending',
      direction: 'receive',
      targetPeerId: message.from,
    };

    incomingQueueRef.current = [...incomingQueueRef.current, request];
    showNextIncomingRequest();
  };

  const sendFile = async (file: File, targetPeerId: string) => {
    if (!sendSignal({ type: 'ping' })) {
      throw new Error('WebSend is reconnecting. Try again when the device list returns.');
    }

    const transferId = createId();
    const transfer: Transfer = {
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
    addTransfer(transfer);

    const sent = sendSignal({
      type: 'transfer-request',
      target: targetPeerId,
      transferId,
      fileName: transfer.fileName,
      fileSize: transfer.fileSize,
      fileType: transfer.fileType,
    });

    if (!sent) {
      failTransfer(transferId, 'Unable to send the transfer request', false);
      throw new Error('Unable to send the transfer request');
    }

    scheduleTransferTimeout(
      transferId,
      REQUEST_TIMEOUT_MS,
      'The other device did not answer the transfer request',
      true,
    );
  };

  const acceptTransfer = async (transferId: string) => {
    const request = incomingQueueRef.current.find(item => item.id === transferId);
    if (!request) return;

    removeIncomingRequest(transferId);
    receiveBuffersRef.current[transferId] = [];
    receivedSizesRef.current[transferId] = 0;
    addTransfer({ ...request, status: 'transferring' });

    if (request.fileSize === 0) {
      const downloadUrl = createDownloadUrl(request, []);
      patchTransfer(transferId, {
        status: 'completed',
        progress: 100,
        downloadUrl,
      });
    } else {
      scheduleTransferTimeout(
        transferId,
        TRANSFER_TIMEOUT_MS,
        'The sender did not establish a data connection',
        true,
      );
    }

    if (!sendSignal({
      type: 'transfer-response',
      target: request.targetPeerId,
      transferId,
      accepted: true,
    })) {
      failTransfer(transferId, 'Signaling connection was lost before acceptance was sent');
    }
  };

  const rejectTransfer = (transferId: string) => {
    const request = incomingQueueRef.current.find(item => item.id === transferId);
    if (!request) return;
    removeIncomingRequest(transferId);
    sendSignal({
      type: 'transfer-response',
      target: request.targetPeerId,
      transferId,
      accepted: false,
      reason: 'Declined by receiver',
    });
  };

  const sendFileChunks = async (
    file: File,
    channel: RTCDataChannel,
    transferId: string,
  ) => {
    if (file.size === 0) {
      patchTransfer(transferId, { status: 'completed', progress: 100 });
      clearTransferTimer(transferId);
      closePeerConnection(transferId);
      return;
    }

    try {
      let offset = 0;
      while (offset < file.size) {
        const transfer = transfersRef.current[transferId];
        if (!transfer || transfer.status === 'cancelled' || transfer.status === 'failed') return;
        if (channel.readyState !== 'open') {
          throw new Error('Data channel closed before the file finished sending');
        }
        if (channel.bufferedAmount > HIGH_WATER_MARK) {
          await waitForChannelDrain(channel);
        }

        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunk = await file.slice(offset, end).arrayBuffer();
        channel.send(chunk);
        offset += chunk.byteLength;

        const queuedProgress = Math.round((offset / file.size) * 100);
        patchTransfer(transferId, { progress: Math.min(queuedProgress, 99) });
        scheduleTransferTimeout(
          transferId,
          TRANSFER_TIMEOUT_MS,
          'The receiver did not confirm transfer completion',
        );
      }
    } catch (error) {
      failTransfer(
        transferId,
        error instanceof Error ? error.message : 'Error while sending file data',
      );
    }
  };

  const handleTransferResponse = async (message: SignalMessage) => {
    if (
      typeof message.transferId !== 'string' ||
      typeof message.from !== 'string' ||
      typeof message.accepted !== 'boolean'
    ) return;

    const transferId = message.transferId;
    const senderId = message.from;
    const transfer = transfersRef.current[transferId];
    if (!transfer || transfer.direction !== 'send') return;
    clearTransferTimer(transferId);

    if (!message.accepted) {
      patchTransfer(message.transferId, {
        status: 'cancelled',
        error: typeof message.reason === 'string' ? message.reason : 'Declined by receiver',
      });
      return;
    }

    if (!transfer.file || transfer.file.size === 0) {
      patchTransfer(transferId, { status: 'completed', progress: 100 });
      return;
    }

    patchTransfer(transferId, { status: 'transferring', error: undefined });
    const connection = createPeerConnection(transferId, senderId);
    const channel = connection.createDataChannel('fileTransfer', { ordered: true });
    setupDataChannel(channel, transferId, senderId);
    channel.onopen = () => {
      void sendFileChunks(transfer.file as File, channel, transferId);
    };

    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      if (!sendSignal({
        type: 'offer',
        target: senderId,
        transferId,
        offer,
      })) {
        failTransfer(transferId, 'Signaling connection was lost while sending the offer');
      }
    } catch (error) {
      failTransfer(
        transferId,
        error instanceof Error ? error.message : 'Failed to create a WebRTC offer',
      );
    }
  };

  const cancelTransfer = (transferId: string) => {
    const transfer = transfersRef.current[transferId];
    if (!transfer || isTerminal(transfer.status)) return;

    const channel = dataChannelsRef.current[transferId];
    if (channel?.readyState === 'open') {
      sendDataControl(channel, {
        websend: 1,
        type: 'cancel',
        transferId,
      });
    } else {
      sendSignal({
        type: 'transfer-cancel',
        target: transfer.targetPeerId,
        transferId,
      });
    }

    patchTransfer(transferId, { status: 'cancelled', error: 'Cancelled' });
    clearTransferTimer(transferId);
    closePeerConnection(transferId);
    clearReceiveState(transferId);
  };

  const handleRemoteCancel = (transferId: string) => {
    if (incomingQueueRef.current.some(request => request.id === transferId)) {
      removeIncomingRequest(transferId);
    }

    const transfer = transfersRef.current[transferId];
    if (!transfer || isTerminal(transfer.status)) return;
    patchTransfer(transferId, {
      status: 'cancelled',
      error: 'Cancelled by the other device',
    });
    clearTransferTimer(transferId);
    closePeerConnection(transferId);
    clearReceiveState(transferId);
  };

  const completeTransferLegacy = (transferId: string) => {
    const transfer = transfersRef.current[transferId];
    if (!transfer || isTerminal(transfer.status)) return;
    patchTransfer(transferId, { status: 'completed', progress: 100 });
    clearTransferTimer(transferId);
    closePeerConnection(transferId);
  };

  messageHandlerRef.current = async message => {
    switch (message.type) {
      case 'welcome':
        if (typeof message.id === 'string') setMyId(message.id);
        break;
      case 'peers':
        if (Array.isArray(message.peers)) setPeers(message.peers as Peer[]);
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
      case 'transfer-complete':
        if (typeof message.transferId === 'string') completeTransferLegacy(message.transferId);
        break;
      case 'transfer-cancel':
        if (typeof message.transferId === 'string') handleRemoteCancel(message.transferId);
        break;
      case 'delivery-error':
        if (typeof message.transferId === 'string') {
          failTransfer(
            message.transferId,
            typeof message.reason === 'string' ? message.reason : 'The target device is unavailable',
            false,
          );
        }
        break;
      case 'pong':
      case 'ping':
        break;
    }
  };

  const connectWebSocket = useCallback(() => {
    if (!mountedRef.current) return;
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${window.location.host}/ws`);
    url.searchParams.set('deviceId', deviceIdRef.current);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      if (wsRef.current !== ws) return;
      setStoredValue('websend-device-id', deviceIdRef.current);
      setStoredValue('websend-device-name', deviceNameRef.current);
      setMyName(deviceNameRef.current);
      ws.send(JSON.stringify({
        type: 'update-info',
        name: deviceNameRef.current,
        deviceType: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
      }));
    });

    ws.addEventListener('message', event => {
      if (wsRef.current !== ws || typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as SignalMessage;
        void messageHandlerRef.current(message);
      } catch (error) {
        console.error('Unable to parse signaling message', error);
      }
    });

    ws.addEventListener('close', () => {
      if (wsRef.current === ws) wsRef.current = null;
      setPeers([]);

      for (const transfer of Object.values(transfersRef.current)) {
        if (transfer.status === 'pending' && !peerConnectionsRef.current[transfer.id]) {
          failTransfer(transfer.id, 'Signaling connection was interrupted', false);
        }
      }

      if (mountedRef.current) {
        reconnectTimerRef.current = window.setTimeout(connectWebSocket, 3_000);
      }
    });

    ws.addEventListener('error', () => {
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connectWebSocket();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
      for (const transfer of Object.values(transfersRef.current)) {
        if (transfer.downloadUrl) URL.revokeObjectURL(transfer.downloadUrl);
      }
      for (const transferId of Object.keys(peerConnectionsRef.current)) {
        closePeerConnection(transferId);
      }
      for (const timer of Object.values(transferTimersRef.current)) {
        window.clearTimeout(timer);
      }
    };
  }, [connectWebSocket]);

  const removeTransfer = (transferId: string) => {
    const transfer = transfersRef.current[transferId];
    if (transfer?.downloadUrl) URL.revokeObjectURL(transfer.downloadUrl);
    clearTransferTimer(transferId);
    closePeerConnection(transferId);
    clearReceiveState(transferId);
    const next = { ...transfersRef.current };
    delete next[transferId];
    publishTransfers(next);
  };

  const updateMyInfo = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    deviceNameRef.current = trimmed;
    setStoredValue('websend-device-name', trimmed);
    setMyName(trimmed);
    sendSignal({
      type: 'update-info',
      name: trimmed,
      deviceType: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
    });
  };

  return {
    peers: peers.filter(peer => peer.id !== myId),
    myId,
    myName,
    updateMyInfo,
    transfers: Object.values(transfersRef.current),
    incomingRequest,
    sendFile,
    acceptTransfer,
    rejectTransfer,
    cancelTransfer,
    removeTransfer,
  };
}
