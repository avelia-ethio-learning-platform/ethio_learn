# Exam-proctoring face-detection assets

Served locally so proctoring makes **no third-party calls** during an exam.

| File | Source |
|---|---|
| `wasm/vision_wasm_internal.{js,wasm}` | copied from `node_modules/@mediapipe/tasks-vision/wasm/` |
| `blaze_face_short_range.tflite` | https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite |

To refresh after upgrading `@mediapipe/tasks-vision`:

```bash
cp web/node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.* web/public/mediapipe/wasm/
```
