# Model Placeholder

Replace `scene.glb` in this folder with your Blender export.

## Blender export tips

- Export format: glTF Binary (`.glb`)
- Apply transforms before export (location/rotation/scale)
- Include textures inside the `.glb`
- If using Draco compression, keep decoder path in `js/app.js` unchanged

The demo attempts to load `./models/scene.glb` at startup. If loading fails, a fallback mesh is shown.
