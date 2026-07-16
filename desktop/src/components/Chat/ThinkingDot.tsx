export default function ThinkingDot() {
  return (
    <div className="thinking" aria-label="Pi is thinking">
      <span className="thinking-dot" style={{ animationDelay: '0ms' }} />
      <span className="thinking-dot" style={{ animationDelay: '160ms' }} />
      <span className="thinking-dot" style={{ animationDelay: '320ms' }} />
    </div>
  )
}
