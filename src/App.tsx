import React, { type ChangeEvent, useRef, useState } from 'react';
import { useWebRTC } from './hooks/useWebRTC';
import { BrowserFile, createTarArchive } from './utils/createTarArchive';
import {
  Check,
  Download,
  Edit2,
  ExternalLink,
  FileDown,
  Files,
  FileUp,
  FolderUp,
  Loader2,
  Monitor,
  Smartphone,
  Wifi,
  X,
} from 'lucide-react';

export default function App() {
  const {
    peers,
    myName,
    updateMyInfo,
    transfers,
    incomingRequest,
    sendFile,
    acceptTransfer,
    rejectTransfer,
    cancelTransfer,
    removeTransfer,
  } = useWebRTC();

  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState('');
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);
  const [isPreparingSelection, setIsPreparingSelection] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const handleEditName = () => {
    setEditNameValue(myName);
    setIsEditingName(true);
  };

  const saveName = () => {
    if (editNameValue.trim()) updateMyInfo(editNameValue.trim());
    setIsEditingName(false);
  };

  const handlePeerClick = (peerId: string) => {
    setSelectionError(null);
    setSelectedPeer(peerId);
  };

  const handleSelectionChange = async (
    event: ChangeEvent<HTMLInputElement>,
    isFolder: boolean,
  ) => {
    const input = event.currentTarget;
    const selectedFiles = Array.from(input.files ?? []) as BrowserFile[];
    const targetPeerId = selectedPeer;
    input.value = '';

    if (!targetPeerId || selectedFiles.length === 0) return;
    setSelectionError(null);
    setIsPreparingSelection(true);

    try {
      if (!isFolder && selectedFiles.length === 1) {
        await sendFile(selectedFiles[0], targetPeerId);
      } else {
        const rootFolder = selectedFiles[0]?.webkitRelativePath?.split('/')[0];
        const archiveName = isFolder && rootFolder
          ? rootFolder
          : `websend-files-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        const archive = await createTarArchive(selectedFiles, archiveName);
        await sendFile(archive, targetPeerId);
      }
      setSelectedPeer(null);
    } catch (error) {
      console.error('Unable to prepare selected files', error);
      setSelectionError(
        error instanceof Error ? error.message : 'Unable to prepare the selected files',
      );
    } finally {
      setIsPreparingSelection(false);
    }
  };

  const configureFolderInput = (input: HTMLInputElement | null) => {
    folderInputRef.current = input;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  };

  const formatBytes = (bytes: number, decimals = 2) => {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  };

  const selectedPeerName = peers.find(peer => peer.id === selectedPeer)?.name;

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans selection:bg-indigo-100 selection:text-indigo-900">
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
                  onChange={event => setEditNameValue(event.target.value)}
                  onKeyDown={event => event.key === 'Enter' && saveName()}
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
        {selectionError && (
          <div className="flex items-start justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{selectionError}</span>
            <button onClick={() => setSelectionError(null)} aria-label="Dismiss error">
              <X size={16} />
            </button>
          </div>
        )}

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
                        {transfer.downloadUrl ? (
                          <a
                            href={transfer.downloadUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm font-medium text-indigo-700 hover:text-indigo-800 hover:underline truncate pr-4 flex items-center gap-1.5"
                            title={`Open ${transfer.fileName}`}
                          >
                            <span className="truncate">{transfer.fileName}</span>
                            <ExternalLink size={13} className="shrink-0" />
                          </a>
                        ) : (
                          <h4 className="text-sm font-medium text-neutral-900 truncate pr-4">{transfer.fileName}</h4>
                        )}
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

                      <div className="text-xs text-neutral-500 mt-1 flex items-center gap-1">
                        {transfer.status === 'pending' && <span className="text-amber-600">Waiting for response...</span>}
                        {transfer.status === 'transferring' && <span className="text-indigo-600">Transferring...</span>}
                        {transfer.status === 'completed' && transfer.downloadUrl && <span className="text-emerald-600">Ready to open</span>}
                        {transfer.status === 'completed' && !transfer.downloadUrl && <span className="text-emerald-600">Completed</span>}
                        {transfer.status === 'failed' && <span className="text-red-600">Failed{transfer.error ? `: ${transfer.error}` : ''}</span>}
                        {transfer.status === 'cancelled' && <span className="text-red-600">Cancelled{transfer.error ? `: ${transfer.error}` : ''}</span>}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 ml-2">
                      {transfer.downloadUrl && (
                        <>
                          <a
                            href={transfer.downloadUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="p-1.5 text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 rounded-md transition-colors"
                            title="Open file"
                            aria-label={`Open ${transfer.fileName}`}
                          >
                            <ExternalLink size={18} />
                          </a>
                          <a
                            href={transfer.downloadUrl}
                            download={transfer.fileName}
                            className="p-1.5 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-md transition-colors"
                            title="Save file"
                            aria-label={`Save ${transfer.fileName}`}
                          >
                            <Download size={18} />
                          </a>
                        </>
                      )}
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

      <input
        type="file"
        ref={filesInputRef}
        multiple
        onChange={event => void handleSelectionChange(event, false)}
        className="hidden"
      />
      <input
        type="file"
        ref={configureFolderInput}
        multiple
        onChange={event => void handleSelectionChange(event, true)}
        className="hidden"
      />

      {selectedPeer && (
        <div className="fixed inset-0 bg-neutral-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl shadow-xl max-w-md w-full p-6">
            <div className="flex items-start justify-between gap-4 mb-5">
              <div>
                <h3 className="text-xl font-semibold">Send to {selectedPeerName || 'device'}</h3>
                <p className="text-sm text-neutral-500 mt-1">Choose individual files or a complete folder.</p>
              </div>
              <button
                onClick={() => !isPreparingSelection && setSelectedPeer(null)}
                className="p-1.5 text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 rounded-lg"
                aria-label="Close selection dialog"
                disabled={isPreparingSelection}
              >
                <X size={18} />
              </button>
            </div>

            {isPreparingSelection ? (
              <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-8 text-center">
                <Loader2 className="animate-spin mx-auto mb-3 text-indigo-600" size={28} />
                <div className="font-medium">Preparing archive...</div>
                <p className="text-sm text-neutral-500 mt-1">Folder structure is preserved without loading every file into memory.</p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 gap-3">
                <button
                  onClick={() => filesInputRef.current?.click()}
                  className="rounded-2xl border border-neutral-200 p-5 text-left hover:border-indigo-300 hover:bg-indigo-50/50 transition-colors"
                >
                  <Files className="text-indigo-600 mb-3" size={28} />
                  <div className="font-semibold">Select files</div>
                  <p className="text-sm text-neutral-500 mt-1">Choose one or several files.</p>
                </button>
                <button
                  onClick={() => folderInputRef.current?.click()}
                  className="rounded-2xl border border-neutral-200 p-5 text-left hover:border-indigo-300 hover:bg-indigo-50/50 transition-colors"
                >
                  <FolderUp className="text-indigo-600 mb-3" size={28} />
                  <div className="font-semibold">Select folder</div>
                  <p className="text-sm text-neutral-500 mt-1">Preserve its complete structure in a TAR archive.</p>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {incomingRequest && (
        <div className="fixed inset-0 bg-neutral-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl shadow-xl max-w-sm w-full p-6 animate-in fade-in zoom-in-95 duration-200">
            <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center mx-auto mb-4">
              <FileDown size={32} />
            </div>
            <h3 className="text-xl font-semibold text-center mb-2">Incoming transfer</h3>
            <p className="text-center text-neutral-600 mb-6 text-sm">
              <span className="font-medium text-neutral-900">{peers.find(peer => peer.id === incomingRequest.targetPeerId)?.name || 'Someone'}</span> wants to send you:
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
                onClick={() => void acceptTransfer(incomingRequest.id)}
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
