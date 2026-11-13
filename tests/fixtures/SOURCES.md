# Test & demo model sources

User-provided models in `models/` (originals, unchanged). `public/samples` is a symlink to `models/`, so the UI serves the same files. Retrieval date: copied from `models/` on 2026-11-14.

| File | Source / author | License | SHA-256 | Watertight? | Applicable checks |
|---|---|---|---|---|---|
| Fox.glb | Khronos glTF-Sample-Assets, Fox — PixelMannen / @tomkranis / AsoboStudio+@scurest (https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Fox/glTF-Binary/Fox.glb) | CC0 + CC BY 4.0 (attribution per README) | `d97044e701822bac5a62696459b27d7b375aada5de8574ed4362edbba94771f7` | yes (576 tris) | import, analysis, full print/assembly E2E |
| Lantern.glb | Khronos glTF-Sample-Assets, Lantern (https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Lantern/glTF-Binary/Lantern.glb) | CC0 | `a79458c4b02d695187a952f23a63b8bf278e7bc3d316a3c2a314f2d6974181f1` | partial (3 of 17 components open) | import-only / negative diagnostics |
| m1.glb | user-provided; generator tag 'Tripo' (AI-generated); original URL/author not recorded | unknown — do not redistribute until confirmed | `d4da450daec11694eafaf16fc47b0702a429f300424448016a8d6c3c59be7381` | after winding repair | full print/assembly E2E |
| prototype-kit-animal-bison.glb | codelove prototype kit (https://models.codelove.in/library/prototype-kit/animal-bison.glb) | CC0 | `e88fb8762f3dc51ccbdabe10d12454c9d02db862dac75bef8141135fb4d4d44d` | partial (4 of 11 open) | import, diagnostics |
| prototype-kit-figurine.glb | codelove prototype kit (https://models.codelove.in/library/prototype-kit/figurine.glb) | CC0 | `e5835b41623301f8537dde0932af8b0cec7c0120beeac51c9369720e378dbd76` | yes (6 closed boxes) | import, fits-whole decision |
| woman_seated_v16.glb | user-provided; generator tag 'Sketchfab-0.13.0'; original URL/author not recorded | unknown — confirm before publishing | `68d3db0d93052e53766dbbec931b229ae16e2afa5b745c53c6f8ec9294d48228` | yes (Manifold accepts; 138 pinched edges) | full print/assembly E2E |

Not included: SlicerTestModels STL/3MF fixtures (user decided `models/` is enough). STL/3MF import code exists but is exercised only through the re-import of our own exports.
