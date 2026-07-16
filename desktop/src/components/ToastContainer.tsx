import { useToastStore } from '../store/toastStore'

const ICONS: Record<string, string> = {
  info: 'ℹ️',
  success: '✅',
  error: '❌',
  warning: '⚠️',
}

export default function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const remove = useToastStore((s) => s.removeToast)

  if (toasts.length === 0) return null

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.type}`} onClick={() => remove(t.id)}>
          <span>{ICONS[t.type]}</span>
          <span style={{ fontSize: 13 }}>{t.message}</span>
        </div>
      ))}
    </div>
  )
}
