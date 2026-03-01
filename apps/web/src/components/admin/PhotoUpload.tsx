import { useRef, useState } from "react";
import { Camera, ImagePlus } from "lucide-react";

interface PhotoUploadProps {
  currentPhotoURL?: string;
  onFileSelect: (file: File | null) => void;
}

export function PhotoUpload({ currentPhotoURL, onFileSelect }: PhotoUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    onFileSelect(file);
    if (file) {
      const url = URL.createObjectURL(file);
      setPreview(url);
    } else {
      setPreview(null);
    }
  };

  const displayURL = preview || currentPhotoURL;

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
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
            <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150">
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
        accept="image/*"
        onChange={handleChange}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="text-[11px] text-fire-500/70 hover:text-fire-500 transition-colors"
      >
        {displayURL ? "Change photo" : "Upload photo"}
      </button>
    </div>
  );
}
