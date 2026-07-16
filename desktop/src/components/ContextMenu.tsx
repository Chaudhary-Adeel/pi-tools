import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  menu: { label: string; action: () => void; disabled?: boolean; danger?: boolean }[]
}

export default function ContextMenu({ children, menu }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const handler = (e: MouseEvent) => {
      e.preventDefault()

      // Remove any existing context menu
      document.querySelector('.context-menu')?.remove()

      const ctxMenu = document.createElement('div')
      ctxMenu.className = 'context-menu'
      ctxMenu.style.left = `${e.clientX}px`
      ctxMenu.style.top = `${e.clientY}px`

      for (const item of menu) {
        const btn = document.createElement('button')
        btn.className = 'context-menu-item'
        btn.textContent = item.label
        if (item.danger) btn.classList.add('context-menu-item--danger')
        btn.disabled = item.disabled ?? false
        btn.onclick = () => {
          item.action()
          ctxMenu.remove()
        }
        ctxMenu.appendChild(btn)
      }

      document.body.appendChild(ctxMenu)

      // Close on outside click
      const close = (ev: MouseEvent) => {
        if (!ctxMenu.contains(ev.target as Node)) {
          ctxMenu.remove()
          document.removeEventListener('click', close)
        }
      }
      setTimeout(() => document.addEventListener('click', close), 0)
    }

    el.addEventListener('contextmenu', handler)
    return () => el.removeEventListener('contextmenu', handler)
  }, [menu])

  return <div ref={ref}>{children}</div>
}
