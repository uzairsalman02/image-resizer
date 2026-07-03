import React, { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { preload, removeBackground as removeImageBackground } from '@imgly/background-removal';
import imageCompression from 'browser-image-compression';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import './styles.css';

const backgroundOptions = {
  transparent: { label: 'Transparent', value: null },
  white: { label: 'White', value: '#ffffff' },
  skyBlue: { label: 'Sky Blue', value: '#87CEEB' },
  custom: { label: 'Custom Color', value: null },
};

const acceptedTypes = ['image/jpeg', 'image/png', 'image/webp'];
const largeImageLimitBytes = 5 * 1024 * 1024;
const removalTimeoutMs = 60_000;
const removalInputMaxSize = 1200;

function bytesToKb(bytes) {
  return bytes / 1024;
}

function formatKb(bytes) {
  if (!bytes && bytes !== 0) return '-';
  return `${bytesToKb(bytes).toFixed(1)} KB`;
}

function outputExtension(type) {
  if (type === 'image/png') return 'png';
  return 'jpg';
}

function cleanFileName(name, type) {
  const base = name.replace(/\.[^/.]+$/, '');
  return `${base}-resized.${outputExtension(type)}`;
}

async function loadImage(source) {
  const url = URL.createObjectURL(source);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not create resized image.'));
      },
      type,
      quality,
    );
  });
}

async function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function createBackgroundRemovalInput(file) {
  const image = await loadImage(file);
  const scale = Math.min(
    1,
    removalInputMaxSize / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height),
  );
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: true });
  canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  // Background removal is the heaviest browser step, so it gets a temporary
  // 1200px max copy. The final user-selected resize still happens later.
  const blob = await canvasToBlob(canvas, 'image/png', 0.92);
  return new File([blob], `${file.name.replace(/\.[^/.]+$/, '')}-ai-input.png`, {
    type: 'image/png',
  });
}

function getSelectedBackgroundColor(backgroundMode, customColor) {
  if (backgroundMode === 'custom') return customColor;
  return backgroundOptions[backgroundMode]?.value || null;
}

async function applyBackgroundToCanvas(source, backgroundMode, customColor) {
  const image = await loadImage(source);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: true });
  const backgroundColor = getSelectedBackgroundColor(backgroundMode, customColor);
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;

  // Transparent keeps the alpha channel from background removal. Color options fill
  // the empty pixels first, then draw the foreground image on top.
  if (backgroundColor) {
    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function resizeCanvas(sourceCanvas, width, height) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: true });
  canvas.width = width;
  canvas.height = height;
  context.drawImage(sourceCanvas, 0, 0, width, height);
  return canvas;
}

async function compressCanvasImage(canvas, file, targetKb, keepsTransparency) {
  const targetBytes = targetKb * 1024;
  const outputType = keepsTransparency ? 'image/png' : 'image/jpeg';

  let low = 0.08;
  let high = 0.95;
  let bestUnderTarget = null;
  let smallest = null;

  // Binary-search image quality so each file gets as close as possible below the requested KB.
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const quality = (low + high) / 2;
    const canvasBlob = await canvasToBlob(canvas, outputType, quality);
    const compressedFile = await imageCompression(
      new File([canvasBlob], cleanFileName(file.name, outputType), { type: outputType }),
      {
        maxSizeMB: targetKb / 1024,
        maxWidthOrHeight: Math.max(canvas.width, canvas.height),
        initialQuality: quality,
        alwaysKeepResolution: true,
        useWebWorker: true,
        fileType: outputType,
      },
    );

    const result = {
      blob: compressedFile,
      size: compressedFile.size,
      quality,
      type: outputType,
    };

    if (!smallest || result.size < smallest.size) smallest = result;

    if (compressedFile.size <= targetBytes) {
      bestUnderTarget = result;
      low = quality;
    } else {
      high = quality;
    }
  }

  const finalResult = bestUnderTarget || smallest;
  const isOverTarget = finalResult.size > targetBytes;
  const strongLoss = finalResult.quality < 0.28;
  const warning = isOverTarget
    ? 'Could not reach the target size at this resolution.'
    : strongLoss
      ? 'Reached target, but quality may be noticeably reduced.'
      : '';

  return {
    ...finalResult,
    warning,
    isOverTarget,
    strongLoss,
    url: URL.createObjectURL(finalResult.blob),
    fileName: cleanFileName(file.name, finalResult.type),
  };
}

function App() {
  const [width, setWidth] = useState(600);
  const [height, setHeight] = useState(800);
  const [targetKb, setTargetKb] = useState(25);
  const [removeBackground, setRemoveBackground] = useState(false);
  const [background, setBackground] = useState('transparent');
  const [customColor, setCustomColor] = useState('#f8d66d');
  const [allowLargeRemoval, setAllowLargeRemoval] = useState(false);
  const [items, setItems] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef(null);
  const modelReadyRef = useRef(false);

  const completedItems = useMemo(
    () => items.filter((item) => item.result),
    [items],
  );
  const hasLargeImages = useMemo(
    () => items.some((item) => item.file?.size > largeImageLimitBytes),
    [items],
  );

  function addFiles(files) {
    const validFiles = files.filter((file) => acceptedTypes.includes(file.type));
    if (!validFiles.length) return;

    const queuedItems = validFiles.map((file) => ({
      id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
      file,
      name: file.name,
      originalSize: file.size,
      newSize: null,
      status: 'Waiting',
      warning: '',
      result: null,
    }));

    setItems((current) => [...queuedItems, ...current]);
    if (!validFiles.some((file) => file.size > largeImageLimitBytes)) {
      setAllowLargeRemoval(false);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function processImages() {
    const itemsToProcess = items.filter((item) => item.file);
    if (!itemsToProcess.length) return;
    if (removeBackground && hasLargeImages && !allowLargeRemoval) return;

    setIsProcessing(true);
    setItems((current) =>
      current.map((item) => {
        if (!item.file) return item;
        if (item.result?.url) URL.revokeObjectURL(item.result.url);
        return {
          ...item,
          newSize: null,
          status: 'Waiting',
          warning: '',
          result: null,
        };
      }),
    );

    for (const queuedItem of itemsToProcess) {
      try {
        let source = queuedItem.file;
        let removalWarning = '';
        let keepsTransparency = queuedItem.file.type === 'image/png';

        if (removeBackground) {
          setItems((current) =>
            current.map((item) =>
              item.id === queuedItem.id ? { ...item, status: 'Loading AI model' } : item,
            ),
          );

          try {
            if (!modelReadyRef.current) {
              await preload();
              modelReadyRef.current = true;
            }

            setItems((current) =>
              current.map((item) =>
                item.id === queuedItem.id ? { ...item, status: 'Removing background' } : item,
              ),
            );

            const removalInput = await createBackgroundRemovalInput(queuedItem.file);
            // @imgly/background-removal runs in the browser. The selected image is
            // processed locally and returns a PNG blob with transparent background.
            source = await withTimeout(
              removeImageBackground(removalInput),
              removalTimeoutMs,
              'Background removal timed out',
            );
            keepsTransparency = background === 'transparent';
          } catch (error) {
            const isTimeout = error.message === 'Background removal timed out';
            setItems((current) =>
              current.map((item) =>
                item.id === queuedItem.id
                  ? { ...item, status: isTimeout ? 'Timed out' : 'Using original image' }
                  : item,
              ),
            );
            removalWarning = isTimeout
              ? 'Background removal timed out after 60 seconds. Using original image instead.'
              : `Background removal failed: ${error.message || 'Could not remove background'}. Using original image instead.`;
            keepsTransparency = queuedItem.file.type === 'image/png';
            source = queuedItem.file;
            await new Promise((resolve) => window.setTimeout(resolve, 200));
            setItems((current) =>
              current.map((item) =>
                item.id === queuedItem.id ? { ...item, status: 'Using original image' } : item,
              ),
            );
          }
        }

        const backgroundCanvas = removeBackground
          ? await applyBackgroundToCanvas(source, background, customColor)
          : await applyBackgroundToCanvas(source, 'transparent', customColor);

        setItems((current) =>
          current.map((item) =>
            item.id === queuedItem.id ? { ...item, status: 'Resizing' } : item,
          ),
        );
        const resizedCanvas = await resizeCanvas(backgroundCanvas, Number(width), Number(height));

        setItems((current) =>
          current.map((item) =>
            item.id === queuedItem.id ? { ...item, status: 'Compressing' } : item,
          ),
        );
        const result = await compressCanvasImage(
          resizedCanvas,
          queuedItem.file,
          Number(targetKb),
          removeBackground ? keepsTransparency && background === 'transparent' : keepsTransparency,
        );
        const warning = [removalWarning, result.warning].filter(Boolean).join(' ');

        setItems((current) =>
          current.map((item) =>
            item.id === queuedItem.id
              ? {
                  ...item,
                  status: 'Done',
                  newSize: result.size,
                  warning,
                  result,
                }
              : item,
          ),
        );
      } catch (error) {
        setItems((current) =>
          current.map((item) =>
            item.id === queuedItem.id
              ? { ...item, status: 'Failed', warning: error.message || 'Processing failed.' }
              : item,
          ),
        );
      }
    }

    setIsProcessing(false);
  }

  async function downloadAll() {
    const zip = new JSZip();
    completedItems.forEach((item) => {
      zip.file(item.result.fileName, item.result.blob);
    });
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    saveAs(zipBlob, 'image-resizer-files.zip');
  }

  function clearList() {
    items.forEach((item) => {
      if (item.result?.url) URL.revokeObjectURL(item.result.url);
    });
    setItems([]);
    setAllowLargeRemoval(false);
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Client-side classroom tool</p>
          <h1>Image Resizer</h1>
          <p className="intro">
            Resize and compress JPG, PNG, and WebP files in your browser. Images stay on this device.
          </p>
        </div>
      </section>

      <section className="workspace" aria-label="Image resizing controls">
        <div className="controls-panel">
          <label className="upload-zone">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={(event) => addFiles(Array.from(event.target.files || []))}
            />
            <span className="upload-title">Choose images</span>
            <span className="upload-copy">Select multiple JPG, PNG, or WebP files</span>
          </label>

          <div className="control-grid">
            <label>
              Width
              <input
                type="number"
                min="1"
                value={width}
                onChange={(event) => setWidth(event.target.value)}
              />
            </label>
            <label>
              Height
              <input
                type="number"
                min="1"
                value={height}
                onChange={(event) => setHeight(event.target.value)}
              />
            </label>
            <label>
              Target KB
              <input
                type="number"
                min="1"
                value={targetKb}
                onChange={(event) => setTargetKb(event.target.value)}
              />
            </label>
          </div>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={removeBackground}
              onChange={(event) => setRemoveBackground(event.target.checked)}
            />
            Remove background
          </label>

          {removeBackground && (
            <>
              <p className="info-note">
                Background removal runs in your browser and may be slow on mobile or low-end devices.
              </p>
              {hasLargeImages && (
                <label className="large-warning">
                  <input
                    type="checkbox"
                    checked={allowLargeRemoval}
                    onChange={(event) => setAllowLargeRemoval(event.target.checked)}
                  />
                  Large images may take too long. Resize first or continue anyway.
                </label>
              )}
              <fieldset className="background-group">
                <legend>Background after removal</legend>
                {Object.entries(backgroundOptions).map(([key, option]) => (
                  <label key={key} className="radio-row">
                    <input
                      type="radio"
                      name="background"
                      value={key}
                      checked={background === key}
                      onChange={() => setBackground(key)}
                    />
                    <span
                      className={`swatch ${key}`}
                      style={key === 'custom' ? { background: customColor } : undefined}
                      aria-hidden="true"
                    />
                    {option.label}
                  </label>
                ))}
                {background === 'custom' && (
                  <label className="color-picker-row">
                    Pick color
                    <input
                      type="color"
                      value={customColor}
                      onChange={(event) => setCustomColor(event.target.value)}
                    />
                  </label>
                )}
              </fieldset>
            </>
          )}

          <div className="action-row">
            <button
              type="button"
              onClick={processImages}
              disabled={!items.length || isProcessing || (removeBackground && hasLargeImages && !allowLargeRemoval)}
            >
              {isProcessing ? 'Processing...' : 'Process Images'}
            </button>
            <button type="button" onClick={downloadAll} disabled={!completedItems.length}>
              Download All as ZIP
            </button>
            <button type="button" className="secondary" onClick={clearList} disabled={!items.length}>
              Clear
            </button>
          </div>
        </div>

        <div className="preview-panel">
          <div className="panel-heading">
            <h2>Preview list</h2>
            <span>{isProcessing ? 'Working...' : `${items.length} image${items.length === 1 ? '' : 's'}`}</span>
          </div>

          {items.length === 0 ? (
            <div className="empty-state">
              <p>Uploaded images will appear here with file sizes, status, warnings, and download buttons.</p>
            </div>
          ) : (
            <div className="image-list">
              {items.map((item) => (
                <article className="image-row" key={item.id}>
                  <div className="thumb">
                    {item.result?.url ? (
                      <img src={item.result.url} alt={`Preview of ${item.name}`} />
                    ) : (
                      <span>{item.status}</span>
                    )}
                  </div>
                  <div className="image-meta">
                    <h3 title={item.name}>{item.name}</h3>
                    <dl>
                      <div>
                        <dt>Original</dt>
                        <dd>{formatKb(item.originalSize)}</dd>
                      </div>
                      <div>
                        <dt>New</dt>
                        <dd>{formatKb(item.newSize)}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{item.status}</dd>
                      </div>
                    </dl>
                    {item.warning && <p className="warning">{item.warning}</p>}
                  </div>
                  <button
                    type="button"
                    className="download-button"
                    disabled={!item.result}
                    onClick={() => saveAs(item.result.blob, item.result.fileName)}
                  >
                    Download
                  </button>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
      <footer className="footer">
      <p>
        Made with <span className="heart">❤️</span> by{" "}
        <strong>Uzair Salman</strong>
      </p>
      <a
        href="https://github.com/uzairsalman02/image-resizer"
        target="_blank"
        rel="noopener noreferrer"
        className="github-star"
      >
        ⭐ Star on GitHub
      </a>
</footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
