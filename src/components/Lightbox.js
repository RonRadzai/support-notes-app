import React, { useState, useEffect } from 'react';

export function Lightbox({ src, filename, onClose }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const copyImage = async () => {
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      } else {
        throw new Error('Clipboard API unavailable');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error('Copy failed', e);
      alert('Copy failed. Use right-click "Copy image" instead.');
    }
  };

  const downloadImage = () => {
    const a = document.createElement('a');
    a.href = src;
    a.download = filename || 'screenshot.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="lightbox-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="lightbox-actions" onClick={e => e.stopPropagation()}>
        <button className="lightbox-btn" onClick={copyImage} title="Copy image to clipboard">
          {copied ? 'Copied ✓' : 'Copy image'}
        </button>
        <button className="lightbox-btn" onClick={downloadImage} title="Download image">
          Download
        </button>
        <button className="lightbox-btn lightbox-close" onClick={onClose} title="Close (Esc)" aria-label="Close">×</button>
      </div>
      <img src={src} alt={filename || 'Screenshot'} className="lightbox-image" onClick={e => e.stopPropagation()} />
    </div>
  );
}
