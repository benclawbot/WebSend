import React, { useRef, useState } from 'react';
import { useWebRTC, Peer, Transfer } from './hooks/useWebRTC';
import { Monitor, Smartphone, FileUp, FileDown, Check, X, Edit2, Loader2, Wifi } from 'lucide-react';

export default function App() {
  const {
    peers,
    myId,
    myName,
    updateMyInfo,
    transfers,
    incomingRequest,
    sendFile,
    acceptTransfer,
    rejectTransfer,
    cancelTransfer,
    removeTransfer
  } = useWebRTC();

  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);

  const handleEditName = () => {
    setEditNameValue(myName);
    setIsEditingName(true);
  };

  const saveName = () => {
    if (editNameValue.trim()) {
      updateMyInfo(editNameValue.trim());
    }
    setIsEditingName(false);
  };

  const handlePeerClick = (peerId: string) => {
    setSelectedPeer(peerId);
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && selectedPeer) {
      sendFile(file, selectedPeer);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    setSelectedPeer(null);
  };

  const formatBytes = (bytes: number, decimals = 2) => {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  };

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans selection:bg-indigo-100 selection:text-indigo-900">
      {/* Header */}
      <header className="bg-white border-b border-neutral-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white">
              <Wifi size={20} />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">WebSend</h1>
          </div>
          
          <div className="flex items-center gap-3 text-sm">
            <span className="text-neutral-500 hidden sm:inline-block">My Device:</span>
            {isEditingName ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editNameValue}
                  onChange={(e) => setEditNameValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveName()}
                  className="px-2 py-1 border border-neutral-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm w-32 sm:w-48"
                  autoFocus
                />
                <button onClick={saveName} className="text-indigo-600 hover:text-indigo-700 p-1">
                  <Check size={16} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-neutral-100 px-3 py-1.5 rounded-full">
                <span className="font-medium">{myName}</span>
                <button onClick={handleEditName} className="text-neutral-400 hover:text-neutral-600">
                  <Edit2 size={14} />
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        
        {/* Nearby Devices */}
        <section>
          <h2 className="text-lg font-medium mb-4 flex items-center gap-2">
            Nearby Devices
            <span className="bg-neutral-200 text-neutral-600 text-xs font-bold px-2 py-0.5 rounded-full">
              {peers.length}
            </span>
          </h2>
          
          {peers.length === 0 ? (
            <div className="bg-white border border-neutral-200 border-dashed rounded-2xl p-12 text-center">
              <div className="w-16 h-16 bg-neutral-100 rounded-full flex items-center justify-center mx-auto mb-4 text-neutral-400">
                <Loader2 size={24} className="animate-spin" />
              </div>
              <h3 className="text-neutral-900 font-medium mb-1">Looking for devices...</h3>
              <p className="text-neutral-500 text-sm">Make sure other devices are on the same network and have WebSend open.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {peers.map(peer => (
                <button
                  key={peer.id}
                  onClick={() => handlePeerClick(peer.id)}
                  className="bg-white border border-neutral-200 rounded-2xl p-5 flex flex-col items-center gap-3 hover:border-indigo-300 hover:shadow-md transition-all group text-left w-full"
                >
                  <div className="w-14 h-14 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center group-hover:scale-110 transition-transform">
                    {peer.deviceType === 'mobile' ? <Smartphone size={28} /> : <Monitor size={28} />}
                  </div>
                  <div className="text-center">
                    <div className="font-medium text-neutral-900">{peer.name}</div>
                    <div className="text-xs text-neutral-500 capitalize">{peer.deviceType}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Active Transfers */}
        {transfers.length > 0 && (
          <section>
            <h2 className="text-lg font-medium mb-4">Transfers</h2>
            <div className="bg-white border border-neutral-200 rounded-2xl overflow-hidden">
              <ul className="divide-y divide-neutral-100">
                {transfers.map(transfer => (
                  <li key={transfer.id} className="p-4 sm:px-6 flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                      transfer.direction === 'send' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'
                    }`}>
                      {transfer.direction === 'send' ? <FileUp size={20} /> : <FileDown size={20} />}
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-baseline mb-1">
                        <h4 className="text-sm font-medium text-neutral-900 truncate pr-4">{transfer.fileName}</h4>
                        <span className="text-xs text-neutral-500 shrink-0">{formatBytes(transfer.fileSize)}</span>
                      </div>
                      
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-2 bg-neutral-100 rounded-full overflow-hidden">
                          <div 
                            className={`h-full rounded-full transition-all duration-300 ${
                              transfer.status === 'failed' || transfer.status === 'cancelled' ? 'bg-red-500' :
                              transfer.status === 'completed' ? 'bg-emerald-500' : 'bg-indigo-500'
                            }`}
                            style={{ width: `${transfer.progress}%` }}
                          />
                        </div>
                        <span className="text-xs font-medium w-8 text-right text-neutral-600">
                          {transfer.progress}%
                        </span>
                      </div>
                      
                      <div className="text-xs text-neutral-500 mt-1 capitalize flex items-center gap-1">
                        {transfer.status === 'pending' && <span className="text-amber-600">Waiting for response...</span>}
                        {transfer.status === 'transferring' && <span className="text-indigo-600">Transferring...</span>}
                        {transfer.status === 'completed' && <span className="text-emerald-600">Completed</span>}
                        {(transfer.status === 'failed' || transfer.status === 'cancelled') && <span className="text-red-600">Cancelled</span>}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 ml-4">
                      {(transfer.status === 'pending' || transfer.status === 'transferring') && (
                        <button
                          onClick={() => cancelTransfer(transfer.id)}
                          className="p-1.5 text-neutral-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                          title="Cancel transfer"
                        >
                          <X size={18} />
                        </button>
                      )}
                      {(transfer.status === 'completed' || transfer.status === 'failed' || transfer.status === 'cancelled') && (
                        <button
                          onClick={() => removeTransfer(transfer.id)}
                          className="p-1.5 text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 rounded-md transition-colors"
                          title="Remove from list"
                        >
                          <X size={18} />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </main>

      {/* Hidden File Input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Incoming Request Modal */}
      {incomingRequest && (
        <div className="fixed inset-0 bg-neutral-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl shadow-xl max-w-sm w-full p-6 animate-in fade-in zoom-in-95 duration-200">
            <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center mx-auto mb-4">
              <FileDown size={32} />
            </div>
            <h3 className="text-xl font-semibold text-center mb-2">Incoming File</h3>
            <p className="text-center text-neutral-600 mb-6 text-sm">
              <span className="font-medium text-neutral-900">{peers.find(p => p.id === incomingRequest.targetPeerId)?.name || 'Someone'}</span> wants to send you:
            </p>
            
            <div className="bg-neutral-50 rounded-xl p-4 mb-6 flex items-center gap-3 border border-neutral-100">
              <div className="w-10 h-10 bg-white rounded-lg border border-neutral-200 flex items-center justify-center shrink-0">
                <FileUp size={20} className="text-neutral-400" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm truncate">{incomingRequest.fileName}</div>
                <div className="text-xs text-neutral-500">{formatBytes(incomingRequest.fileSize)}</div>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => rejectTransfer(incomingRequest.id)}
                className="flex-1 py-2.5 px-4 rounded-xl border border-neutral-200 text-neutral-700 font-medium hover:bg-neutral-50 transition-colors flex items-center justify-center gap-2"
              >
                <X size={18} /> Decline
              </button>
              <button
                onClick={() => acceptTransfer(incomingRequest.id)}
                className="flex-1 py-2.5 px-4 rounded-xl bg-indigo-600 text-white font-medium hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2 shadow-sm shadow-indigo-200"
              >
                <Check size={18} /> Accept
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
