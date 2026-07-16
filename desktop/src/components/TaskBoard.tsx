import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'

interface TaskItem {
  id: number
  status: 'pending' | 'in_progress' | 'completed'
  subject: string
  notes?: string
}

const COLUMNS = [
  { key: 'pending' as const, label: 'Backlog', icon: '📋' },
  { key: 'in_progress' as const, label: 'In Progress', icon: '🔄' },
  { key: 'completed' as const, label: 'Done', icon: '✅' },
]

export default function TaskBoard() {
  const projectPath = useStore((s) => s.projectPath)
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!projectPath || !window.electronAPI) return
    setLoading(true)
    window.electronAPI.readTasks().then((t) => {
      setTasks(t as TaskItem[])
      setLoading(false)
    })
  }, [projectPath])

  const moveTask = async (id: number, newStatus: TaskItem['status']) => {
    const updated = tasks.map((t) =>
      t.id === id ? { ...t, status: newStatus } : t
    )
    setTasks(updated)
    if (window.electronAPI) {
      await window.electronAPI.writeTasks(updated)
    }
  }

  if (!projectPath) {
    return (
      <div className="panel-empty">
        <p>No project open.</p>
        <p className="panel-hint">Open a project to see the task board.</p>
      </div>
    )
  }

  if (loading) {
    return <div className="panel"><p className="panel-hint">Loading tasks…</p></div>
  }

  return (
    <div className="panel">
      <div className="panel-section">
        <div className="panel-section-title">✅ Task Board</div>
        <p className="panel-hint">
          From <code>.pi/tasks.json</code>. Drag cards to move between columns.
        </p>
      </div>

      <div className="task-board">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.key)
          return (
            <div
              key={col.key}
              className="task-column"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const id = Number(e.dataTransfer.getData('task-id'))
                if (id) moveTask(id, col.key)
              }}
            >
              <div className="task-column-header">
                <span>{col.icon}</span>
                <span>{col.label}</span>
                <span className="panel-count">{colTasks.length}</span>
              </div>
              <div className="task-column-body">
                {colTasks.map((task) => (
                  <div
                    key={task.id}
                    className="task-card"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('task-id', String(task.id))
                    }}
                  >
                    <div className="task-card-id">#{task.id}</div>
                    <div className="task-card-title">{task.subject}</div>
                    {task.notes && (
                      <div className="task-card-notes">{task.notes}</div>
                    )}
                  </div>
                ))}
                {colTasks.length === 0 && (
                  <div className="task-column-empty">Drop tasks here</div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="panel-actions" style={{ marginTop: 8 }}>
        <button
          className="btn-secondary btn-sm"
          onClick={() => window.electronAPI?.sendMessage('/tasks')}
        >
          /tasks — Refresh
        </button>
      </div>
    </div>
  )
}
