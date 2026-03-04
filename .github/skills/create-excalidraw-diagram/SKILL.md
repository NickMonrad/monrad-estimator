---
name: create-excalidraw-diagram
description: Use this skill when asked to create or update an Excalidraw diagram. Generates valid .excalidraw JSON files that can be opened in the Excalidraw editor or VS Code extension.
---

## When to Use
Use when the user asks to:
- "create an excalidraw diagram"
- "make an excalidraw"
- "I want a whiteboard diagram"
- "create a hand-drawn style diagram"
- "update the .excalidraw file"

## Process

1. **Understand what to diagram** — system architecture, flow, or conceptual model
2. **Create the `.excalidraw` file** with valid JSON structure
3. **Position elements logically** — left to right or top to bottom for flows
4. **Group related elements** visually using background rectangles

## Excalidraw JSON Template

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "copilot-generated",
  "elements": [
    {
      "id": "box-1",
      "type": "rectangle",
      "x": 100, "y": 100,
      "width": 160, "height": 60,
      "strokeColor": "#1e1e2e",
      "backgroundColor": "#e2e8f0",
      "fillStyle": "solid",
      "roughness": 1,
      "opacity": 100,
      "roundness": {"type": 3}
    },
    {
      "id": "label-1",
      "type": "text",
      "x": 130, "y": 120,
      "text": "My Component",
      "fontSize": 16,
      "fontFamily": 1,
      "textAlign": "center",
      "strokeColor": "#1e1e2e"
    },
    {
      "id": "arrow-1",
      "type": "arrow",
      "x": 260, "y": 130,
      "points": [[0,0],[80,0]],
      "strokeColor": "#1e1e2e",
      "roughness": 1,
      "startBinding": {"elementId": "box-1", "gap": 5, "focus": 0},
      "endBinding": {"elementId": "box-2", "gap": 5, "focus": 0}
    }
  ],
  "appState": {
    "viewBackgroundColor": "#ffffff",
    "gridSize": null
  }
}
```

## Colour Palette
| Purpose | Hex |
|---|---|
| Services/boxes | `#e2e8f0` |
| External services | `#fef3c7` |
| Databases | `#dcfce7` |
| Warnings/issues | `#fee2e2` |
| Arrows | `#1e1e2e` |

## Rules
- Save the file as `docs/<name>.excalidraw`
- Mention in your response how to open it (VS Code Excalidraw extension, or excalidraw.com)
- Keep elements well-spaced (min 40px gap between boxes)
- Use `roughness: 1` for the classic hand-drawn feel
