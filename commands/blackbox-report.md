---
name: blackbox-report
description: Open the newest local Blackbox recording in the browser
---

# Open the newest Blackbox recording

Find the newest session folder under `.blackbox/sessions` in this workspace. Use the folder's modified time. Do not open the files inside it.

Open that folder's `report.html` in the default browser:

- macOS: `open <path>`
- Windows: `start <path>`
- Linux: `xdg-open <path>`

Reply with only the session id and the report path.

Do not read the recording. Do not summarize it. Do not open `events.jsonl`, `session.json`, or `report.html` in the editor.
