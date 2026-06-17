import { useRef, useState } from 'react';
import { Upload as UploadIcon, Camera, Image as ImageIcon, X } from 'lucide-react';

interface UploadBoxProps {
  onFileSelected: (file: File) => void;
}

export default function UploadBox({ onFileSelected }: UploadBoxProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFileName(file.name);
    setPreviewUrl(URL.createObjectURL(file));
    onFileSelected(file);
  }

  function clear(e: React.MouseEvent) {
    e.stopPropagation();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setFileName(null);
    if (fileRef.current) fileRef.current.value = '';
    if (cameraRef.current) cameraRef.current.value = '';
  }

  return (
    <div
      className="upload-box"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        handleFiles(e.dataTransfer.files);
      }}
    >
      {/* Hidden file inputs — never clicked directly by the user */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />

      {previewUrl ? (
        <div className="upload-preview-wrap">
          <img src={previewUrl} alt={fileName ?? 'preview'} className="upload-preview" />
          <div className="upload-preview-footer">
            <span className="upload-filename">
              <ImageIcon size={14} /> {fileName}
            </span>
            <button type="button" className="upload-clear" onClick={clear} aria-label="Remove image">
              <X size={14} /> Change
            </button>
          </div>
        </div>
      ) : (
        <div className="upload-sources">
          <button
            type="button"
            className="upload-source-btn"
            onClick={() => fileRef.current?.click()}
          >
            <UploadIcon size={28} />
            <span>Upload file</span>
            <span className="upload-source-hint">screenshot, PDF, or image</span>
          </button>

          <div className="upload-source-divider" aria-hidden>or</div>

          <button
            type="button"
            className="upload-source-btn"
            onClick={() => cameraRef.current?.click()}
          >
            <Camera size={28} />
            <span>Take a photo</span>
            <span className="upload-source-hint">point camera at paper or screen</span>
          </button>
        </div>
      )}
    </div>
  );
}
