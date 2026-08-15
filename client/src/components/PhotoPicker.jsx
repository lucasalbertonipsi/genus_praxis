import { useRef, useState } from 'react';

// Seletor de foto de cliente. Lê um arquivo de imagem e gera, no navegador via
// canvas, dois JPEGs: `full` (imagem inteira, até 1200px) e `icon` (quadrado
// 400×400, recorte central). Devolve { iconDataUrl, fullDataUrl } via onChange.
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function drawFull(img, max = 1200) {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.85);
}

function drawIcon(img, size = 400) {
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  c.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.85);
}

export default function PhotoPicker({ currentUrl, onChange, onClear }) {
  const inputRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function handleFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { setErr('Selecione um arquivo de imagem.'); return; }
    setErr('');
    setBusy(true);
    try {
      const img = await loadImage(file);
      const iconDataUrl = drawIcon(img);
      const fullDataUrl = drawFull(img);
      setPreview(iconDataUrl);
      onChange({ iconDataUrl, fullDataUrl });
    } catch {
      setErr('Não foi possível processar a imagem.');
    } finally {
      setBusy(false);
    }
  }

  function handleClear() {
    setPreview(null);
    onClear();
  }

  const shown = preview || currentUrl;

  return (
    <div className="photo-picker">
      <div className="photo-picker-preview">
        {shown ? <img src={shown} alt="Foto do cliente" /> : <span className="photo-picker-empty">sem foto</span>}
      </div>
      <div className="photo-picker-actions">
        <button type="button" className="btn btn-outline btn-sm" onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? 'Processando…' : (shown ? 'Trocar foto' : 'Escolher foto')}
        </button>
        {shown && <button type="button" className="btn btn-ghost btn-sm" onClick={handleClear}>Remover</button>}
        <input ref={inputRef} type="file" accept="image/*" onChange={handleFile} style={{ display: 'none' }} />
      </div>
      {err && <div className="alert error" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}
