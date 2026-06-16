import { useRef, useState } from 'react';
import { Upload as UploadIcon, Image as ImageIcon } from 'lucide-react';

interface UploadBoxProps {
  onFileSelected: (file: File) => void;
}

export default function UploadBox({ onFileSelected }: UploadBoxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setFileName(file.name);
    setPreviewUrl(URL.createObjectURL(file));
    onFileSelected(file);
  }

  return (
    <div
      className="upload-box"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        handleFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
      {previewUrl ? (
        <img src={previewUrl} alt={fileName ?? 'preview'} className="upload-preview" />
      ) : (
        <div className="upload-placeholder">
          <UploadIcon size={32} />
          <p>Click or drag a screenshot here</p>
        </div>
      )}
      {fileName && (
        <p className="upload-filename">
          <ImageIcon size={16} /> {fileName}
        </p>
      )}
    </div>
  );
}
