import { useState, useEffect } from 'react';

// Avatar do cliente. Usa a foto enviada pelo admin (iconUrl / fullUrl); sem
// foto, cai nas iniciais do nome.
function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const a = parts[0] ? parts[0][0] : '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase() || '?';
}

export function PatientAvatar({ name, iconUrl, size = 46, className = '' }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  if (!iconUrl || failed) {
    return (
      <span
        className={`patient-avatar patient-avatar-fallback ${className}`}
        style={{ ...style, fontSize: Math.round(size * 0.4) }}
        aria-hidden="true"
      >
        {initials(name)}
      </span>
    );
  }
  return (
    <img
      className={`patient-avatar ${className}`}
      style={style}
      src={iconUrl}
      alt={name || 'cliente'}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function PatientAvatarButton({ name, iconUrl, fullUrl, size = 42, className = '' }) {
  const [open, setOpen] = useState(false);
  if (!name) return null;
  const hasPhoto = !!(iconUrl || fullUrl);
  return (
    <>
      <button
        type="button"
        className={`patient-avatar-btn ${className}`}
        onClick={() => hasPhoto && setOpen(true)}
        title={hasPhoto ? `Ver foto de ${name}` : name}
        aria-label={hasPhoto ? `Ver foto de ${name}` : name}
        style={{ cursor: hasPhoto ? 'pointer' : 'default' }}
      >
        <PatientAvatar name={name} iconUrl={iconUrl} size={size} />
      </button>
      {open && <PatientPhotoModal name={name} fullUrl={fullUrl || iconUrl} onClose={() => setOpen(false)} />}
    </>
  );
}

function PatientPhotoModal({ name, fullUrl, onClose }) {
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="patient-photo-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Foto de ${name}`}>
      <div className="patient-photo-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="patient-photo-close" onClick={onClose} aria-label="Fechar">×</button>
        {fullUrl && !imgFailed
          ? <img src={fullUrl} alt={name} onError={() => setImgFailed(true)} />
          : <div className="patient-photo-noimg">Sem foto disponível</div>}
        <div className="patient-photo-caption">{name}</div>
      </div>
    </div>
  );
}

export default PatientAvatar;
