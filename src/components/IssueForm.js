import React from 'react';
import { autoResize, screenshotUrl } from '../utils';
import { ScreenshotZone } from './ScreenshotZone';

export function IssueForm({
  data, onChange, platforms,
  screenshots, onScreenshotsChange,
  existingPaths = [], onRemoveExistingPath,
  sessionNotes, onSessionNotesChange,
  resolutionRef,
  showPlatformCustomize = false, onCustomizePlatforms,
}) {
  const set = (field, value) => onChange({ ...data, [field]: value });
  const orderNums = data.order_number ? data.order_number.split(',') : [''];
  return (
    <>
      {onSessionNotesChange !== undefined && (
        <div className="field">
          <label>Session Notes</label>
          <textarea className="auto-expand" value={sessionNotes || ''}
            ref={el => autoResize(el)}
            onChange={e => onSessionNotesChange(e.target.value)}
            onInput={e => autoResize(e.target)} />
        </div>
      )}
      <div className="field field-half">
        <label>Platform <span className="req">*</span></label>
        <select value={data.platform || platforms[0]?.name || ''} onChange={e => set('platform', e.target.value)}>
          {platforms.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
        </select>
        {showPlatformCustomize && (
          <button type="button" className="platform-customize-link" onClick={onCustomizePlatforms}>
            + Customize platform list
          </button>
        )}
      </div>
      <div className="form-row">
        <div className="field">
          <label>Order Number</label>
          {orderNums.map((num, numIdx, arr) => (
            <div key={numIdx} className="order-num-row">
              <input type="text" value={num}
                onChange={e => {
                  const nums = [...arr]; nums[numIdx] = e.target.value;
                  set('order_number', nums.join(','));
                }} />
              {arr.length > 1 && (
                <button type="button" className="remove-order-btn" onClick={() => {
                  const nums = arr.filter((_, i) => i !== numIdx);
                  set('order_number', nums.join(','));
                }}>×</button>
              )}
            </div>
          ))}
          <button type="button" className="add-order-btn" onClick={() => {
            const nums = data.order_number ? data.order_number.split(',') : [''];
            set('order_number', [...nums, ''].join(','));
          }}>+ Add order number</button>
        </div>
        <div className="field field-zendesk">
          <label>Zendesk Ticket #</label>
          <input type="text" inputMode="numeric" pattern="[0-9]*" maxLength="8"
            value={data.zendesk_ticket || ''}
            onChange={e => {
              const raw = e.target.value;
              const urlMatch = raw.match(/tickets\/(\d+)/);
              set('zendesk_ticket', urlMatch ? urlMatch[1] : raw.replace(/\D/g, ''));
            }} />
        </div>
      </div>
      <div className="field">
        <label>Issue Description <span className="req">*</span></label>
        <textarea required className="auto-expand description-field" value={data.description || ''}
          ref={el => autoResize(el)}
          onChange={e => set('description', e.target.value)}
          onInput={e => autoResize(e.target)} />
      </div>
      <div className="status-actions">
        <button type="button"
          className={`status-btn flag-btn${data.status === 'Flagged for Review' ? ' active' : ''}`}
          onClick={() => set('status', data.status === 'Flagged for Review' ? 'Pending' : 'Flagged for Review')}>
          Flag for Review
        </button>
        <button type="button"
          className={`status-btn resolved-btn${data.status === 'Solved' ? ' active' : ''}`}
          onClick={() => set('status', data.status === 'Solved' ? 'Pending' : 'Solved')}>
          Resolved
        </button>
      </div>
      <div className={`field${data.status !== 'Solved' ? ' field-dimmed' : ''}`}>
        <label>Resolution Notes</label>
        <textarea className="auto-expand" value={data.resolution || ''}
          ref={el => { if (resolutionRef) resolutionRef.current = el; autoResize(el); }}
          onChange={e => set('resolution', e.target.value)}
          onInput={e => autoResize(e.target)} />
      </div>
      {existingPaths.length > 0 && (
        <div className="field">
          <label>Existing Screenshots</label>
          <div className="screenshot-pending">
            {existingPaths.map((p, i) => (
              <div key={i} className="screenshot-thumb-wrap">
                <img src={screenshotUrl(p)} alt="" className="screenshot-thumb" />
                <button type="button" className="screenshot-remove"
                  onClick={() => onRemoveExistingPath(p)}>×</button>
              </div>
            ))}
          </div>
        </div>
      )}
      <ScreenshotZone files={screenshots} onFilesChange={onScreenshotsChange} />
    </>
  );
}
