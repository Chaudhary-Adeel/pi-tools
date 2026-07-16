import { useState, useEffect } from 'react'
import { useStore } from '../../store/useStore'

interface FileNode {
  name: string
  path: string
  isDir: boolean
  children?: FileNode[]
}

async function scanDir(dirPath: string): Promise<FileNode[]> {
  // This would ideally be an IPC call, but for simplicity we use a sendMessage approach
  // In production, add a files:list IPC handler
  const result: FileNode[] = []
  // Use the existing chat to send a glob_files command
  return result
}

// Hardcoded common project structure for demo — in production, use IPC
function buildDemoTree(projectPath: string): FileNode[] {
  return [
    {
      name: 'src',
      path: `${projectPath}/src`,
      isDir: true,
      children: [
        { name: 'App.tsx', path: `${projectPath}/src/App.tsx`, isDir: false },
        { name: 'main.tsx', path: `${projectPath}/src/main.tsx`, isDir: false },
        {
          name: 'components',
          path: `${projectPath}/src/components`,
          isDir: true,
          children: [
            { name: 'ChatPanel.tsx', path: `${projectPath}/src/components/Chat/ChatPanel.tsx`, isDir: false },
            { name: 'InputBar.tsx', path: `${projectPath}/src/components/InputBar.tsx`, isDir: false },
            { name: 'TitleBar.tsx', path: `${projectPath}/src/components/TitleBar.tsx`, isDir: false },
          ],
        },
        {
          name: 'store',
          path: `${projectPath}/src/store`,
          isDir: true,
          children: [
            { name: 'useStore.ts', path: `${projectPath}/src/store/useStore.ts`, isDir: false },
          ],
        },
      ],
    },
    {
      name: 'electron',
      path: `${projectPath}/electron`,
      isDir: true,
      children: [
        { name: 'main.ts', path: `${projectPath}/electron/main.ts`, isDir: false },
        { name: 'preload.ts', path: `${projectPath}/electron/preload.ts`, isDir: false },
        { name: 'ipc-handlers.ts', path: `${projectPath}/electron/ipc-handlers.ts`, isDir: false },
        { name: 'pi-process.ts', path: `${projectPath}/electron/pi-process.ts`, isDir: false },
      ],
    },
    { name: 'package.json', path: `${projectPath}/package.json`, isDir: false },
  ]
}

interface Props {
  onFileSelect: (path: string) => void
}

export default function FileTree({ onFileSelect }: Props) {
  const projectPath = useStore((s) => s.projectPath)
  const [tree, setTree] = useState<FileNode[]>([])

  useEffect(() => {
    if (projectPath) {
      setTree(buildDemoTree(projectPath))
    }
  }, [projectPath])

  if (!projectPath) {
    return (
      <div className="panel-empty">
        <p>No project open.</p>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-section">
        <div className="panel-section-title">📁 Files</div>
      </div>
      <div className="panel-section">
        <TreeNodeList nodes={tree} onSelect={onFileSelect} level={0} />
      </div>
    </div>
  )
}

function TreeNodeList({ nodes, onSelect, level }: { nodes: FileNode[]; onSelect: (p: string) => void; level: number }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  return (
    <ul className="file-tree">
      {nodes.map((node) => {
        const isOpen = expanded.has(node.path)
        return (
          <li key={node.path} style={{ paddingLeft: level * 14 }}>
            {node.isDir ? (
              <>
                <div
                  className="file-tree-item file-tree-dir"
                  onClick={() => {
                    setExpanded((prev) => {
                      const next = new Set(prev)
                      if (next.has(node.path)) next.delete(node.path)
                      else next.add(node.path)
                      return next
                    })
                  }}
                >
                  <span className="file-tree-chevron">{isOpen ? '▼' : '▶'}</span>
                  <span className="file-tree-icon">📁</span>
                  <span className="file-tree-name">{node.name}</span>
                </div>
                {isOpen && node.children && (
                  <TreeNodeList nodes={node.children} onSelect={onSelect} level={level + 1} />
                )}
              </>
            ) : (
              <div
                className="file-tree-item file-tree-file"
                onClick={() => onSelect(node.path)}
              >
                <span className="file-tree-chevron" style={{ visibility: 'hidden' }}>▶</span>
                <span className="file-tree-icon">📄</span>
                <span className="file-tree-name">{node.name}</span>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
