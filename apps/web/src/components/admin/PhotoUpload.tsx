import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus } from "lucide-react";

interface PhotoUploadProps {
  currentPhotoURL?: string;
  file?: File | null;
  onFileSelect: (file: File | null) => void;
}

export function PhotoUpload({
  currentPhotoURL,
  onFileSelect,
  file: controlledFile,
}: PhotoUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const file = controlledFile === undefined ? selectedFile : controlledFile;
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    if (!selected) return;
    setSelectedFile(selected);
    onFileSelect(selected);
  };

  const displayURL = preview || currentPhotoURL;

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        aria-label={displayURL ? "Change profile photo" : "Add profile photo"}
        title={displayURL ? "Change profile photo" : "Add profile photo"}
        className="relative w-20 h-20 rounded-full bg-board-bg border-2 border-dashed border-board-border hover:border-fire-500/50 transition-all duration-200 flex items-center justify-center overflow-hidden group"
      >
        {displayURL ? (
          <>
            <img
              src={displayURL}
              alt="Preview"
              className="w-full h-full object-cover rounded-full"
            />
            {/* Hover overlay */}
            <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/35 opacity-100 transition-opacity duration-150 [@media(hover:hover)]:bg-black/50 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100">
              <Camera className="w-5 h-5 text-white" />
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-1">
            <ImagePlus className="w-6 h-6 text-board-muted group-hover:text-fire-500 transition-colors duration-150" />
          </div>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        aria-label="Choose crew profile photo"
        accept="image/*"
        onChange={handleChange}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="min-h-11 min-w-11 rounded-lg px-3 text-sm text-fire-500/70 hover:text-fire-500 transition-colors"
      >
        {displayURL ? "Change photo" : "Upload photo"}
      </button>
    </div>
  );
}
