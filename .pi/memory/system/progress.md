---
description: "Current task progress, checklist, decisions, and next steps"
priority: 0
type: "progress"
---
# Add /memory command and memory maps package

## Status: Done

## Checklist
- [x] Design memory footprint computation (memory-map.ts)
- [x] Build /memory slash command with TUI dashboard
- [x] Build memory_map tool (agent-callable)
- [x] Wire into index.ts + prompt
- [x] Add Ctrl+M shortcut hint
- [x] Test syntax validity
- [x] Update project progress.md

## Open Decisions
1. Should memory_map be an extension tool or a skill? → Decided: extension tool (faster, always available)
2. Should Ctrl+M directly open the dashboard or just notify? → Decided: notify (shortcuts can't run commands directly)

## Next Steps
- Test in live pi session with /memory
- Test agent calling memory_map tool
- Consider adding memory compaction recommendations
- Add memory search capability for large learning libraries
