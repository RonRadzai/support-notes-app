import React, { useState, useRef } from 'react';

export function ScreenshotZone({ files, onFilesChange }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const handlePaste = (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const blobs = items.filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
    if (blobs.length > 0) {
      e.preventDefault();
      onFilesChange([...files, ...blobs]);
    }
  };

  const addFiles = (fileList) => {
    const images = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    if (images.length) onFilesChange([...files, ...images]);
  };

  return (
    <div className="field">
      <label>Screenshots</label>
      <div
        tabIndex={0}
        className={`screenshot-zone${dragging ? ' dragging' : ''}`}
        onPaste={handlePaste}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
      >
        {files.length === 0 ? (
          <div className="screenshot-zone-empty">
            <span className="screenshot-zone-hint">Click here, then press Ctrl+V to paste, or drag and drop</span>
            <button type="button" className="screenshot-browse-btn"
              onClick={e => { e.stopPropagation(); inputRef.current.click(); }}>
              Browse files
            </button>
          </div>
        ) : (
          <div className="screenshot-pending">
            {files.map((file, i) => (
              <div key={i} className="screenshot-thumb-wrap">
                <img src={URL.createObjectURL(file)} alt="" className="screenshot-thumb" />
                <button type="button" className="screenshot-remove"
                  onClick={e => { e.stopPropagation(); onFilesChange(files.filter((_, j) => j !== i)); }}>×</button>
              </div>
            ))}
            <button type="button" className="screenshot-add-more"
              onClick={e => { e.stopPropagation(); inputRef.current.click(); }}>+</button>
          </div>
        )}
      </div>
      <input ref={inputRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
        onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
    </div>
  );
}
