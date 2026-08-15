import { useEffect, useRef, useState } from 'react';
import { OUTPUT_SIZE, fitStage, baseScale, rescaleForStage, cropRect } from '../cropMath';
import '../styles/PhotoCropper.css';

// Cropper de foto de perfil. Permite arrastar e dar zoom numa imagem dentro de um
// stage circular, e devolve o recorte enquadrado como um JPEG 320×320 via
// `onCrop(dataUrl)` — a mesma assinatura do All_OS.
//
// A geometria vive em `cropMath.js` (módulo puro, testável). Aqui ficam só os
// eventos, o estado e o canvas.
//
// A foto de CLIENTE não usa este componente: ela precisa de `{icon, full}` para
// `api.setFreeplayPhoto`, e o AdminFreeplay usa o <PhotoPicker> (recorte central).
const currentStage = () => fitStage(typeof window === 'undefined' ? NaN : window.innerWidth);

export default function PhotoCropper({ onCrop, onCancel, initialImage }) {
  const [image, setImage] = useState(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [stageSize, setStageSize] = useState(currentStage);
  const dragStartRef = useRef(null);
  const fileInputRef = useRef(null);

  // Girar o celular muda a largura disponível. `scale` e `offset` estão em pixels
  // do stage, então precisam acompanhar na mesma proporção — senão o recorte salvo
  // sairia diferente do que o usuário enquadrou na tela.
  //
  // O tamanho anterior vive num ref (e não no updater do setState) porque o
  // StrictMode do React invoca o updater duas vezes, o que aplicaria o fator dobrado.
  const stageRef = useRef(stageSize);
  useEffect(() => {
    function onResize() {
      const next = currentStage();
      const prev = stageRef.current;
      if (next === prev) return;
      stageRef.current = next;
      // `rescaleForStage` é a especificação (e o que os testes exercitam); aqui
      // ela é aplicada campo a campo porque `scale` e `offset` são states separados.
      const { scale: s2, offset: o2 } = rescaleForStage({ scale, offset }, prev, next);
      setStageSize(next);
      setScale(s2);
      setOffset(o2);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // `scale`/`offset` entram nas deps: o handler os lê para reescalar.
  }, [scale, offset]);

  useEffect(() => {
    if (initialImage) loadImageFromSrc(initialImage);
  }, [initialImage]);

  function loadImageFromSrc(src) {
    const img = new Image();
    img.onload = () => {
      setImage(img);
      setScale(baseScale(img.width, img.height, stageSize));
      setOffset({ x: 0, y: 0 });
    };
    img.onerror = () => setError('Não foi possível carregar a imagem.');
    img.src = src;
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      setError('Use um PNG ou JPG.');
      return;
    }
    setError('');
    const reader = new FileReader();
    reader.onload = () => loadImageFromSrc(reader.result);
    reader.readAsDataURL(file);
  }

  function handleMouseDown(e) {
    if (!image) return;
    setDragging(true);
    dragStartRef.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
  }
  function handleMouseMove(e) {
    if (!dragging || !dragStartRef.current) return;
    setOffset({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  }
  function handleMouseUp() {
    setDragging(false);
    dragStartRef.current = null;
  }

  function handleTouchStart(e) {
    if (!image) return;
    const t = e.touches[0];
    setDragging(true);
    dragStartRef.current = { x: t.clientX - offset.x, y: t.clientY - offset.y };
  }
  function handleTouchMove(e) {
    if (!dragging || !dragStartRef.current) return;
    const t = e.touches[0];
    setOffset({
      x: t.clientX - dragStartRef.current.x,
      y: t.clientY - dragStartRef.current.y,
    });
  }

  // Recorte que o usuário enquadrou (o que está visível no stage → OUTPUT_SIZE).
  function handleSave() {
    if (!image) return;
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');
    // Fundo branco: PNG com transparência viraria preto no JPEG.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    const { dx, dy, dw, dh } = cropRect({
      imageWidth: image.width, imageHeight: image.height, scale, offset, stageSize,
    });
    ctx.drawImage(image, dx, dy, dw, dh);

    onCrop(canvas.toDataURL('image/jpeg', 0.9));
  }

  return (
    <div className="cropper">
      {!image && (
        <div className="cropper-empty">
          <p>Selecione uma imagem (PNG ou JPG). Depois arraste e use o zoom para enquadrar.</p>
          <button type="button" className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>
            Escolher arquivo
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleFile}
            style={{ display: 'none' }}
          />
        </div>
      )}

      {image && (
        <>
          <div
            className="cropper-stage"
            style={{ width: stageSize, height: stageSize }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleMouseUp}
          >
            <img
              src={image.src}
              alt="preview"
              draggable={false}
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})`,
                transformOrigin: 'center center',
                userSelect: 'none',
                pointerEvents: 'none',
                maxWidth: 'none',
              }}
            />
            <div className="cropper-mask" />
          </div>

          <div className="cropper-controls">
            <label className="cropper-zoom-label">Zoom</label>
            <input
              type="range"
              min="0.1"
              max="3"
              step="0.01"
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
            />
            <button type="button" className="btn btn-outline btn-sm" onClick={() => fileInputRef.current?.click()}>
              Trocar imagem
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleFile}
              style={{ display: 'none' }}
            />
          </div>
        </>
      )}

      {error && <div className="alert error" style={{ marginTop: 10 }}>{error}</div>}

      <div className="cropper-actions">
        {onCancel && (
          <button type="button" className="btn btn-outline" onClick={onCancel}>
            Cancelar
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!image}>
          Usar esta foto
        </button>
      </div>
    </div>
  );
}
