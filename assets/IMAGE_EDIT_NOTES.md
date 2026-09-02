# Dawson image edits

## Fast Money question-reading portrait

- Final asset: `public/assets/dawson-fast-reading.png`.
- Mode: built-in image editor; supplied Richard-and-contestant screenshot used as the edit target. The timed-play composition uses this pose, while the first-reveal embrace asset remains separate.
- Final prompt: Use case: background-extraction. Asset type: photographic host cutout for the existing Fast Money game screen. Image 1 is the EDIT TARGET. Preserve Richard Dawson on the LEFT exactly in his question-reading pose, looking down at the white question card, dark suit, white shirt, hair and face, and his hands and card. Remove the woman, the entire stage background, the microphone belonging to the woman, all broadcast captions, logos and the number 15 timer. Restore the obscured lower jacket naturally. Improve clarity and resolution while preserving his recognizable original face and pose; do not invent a new person or modernize clothing. Frame only Richard from head to upper thighs in a vertical portrait, with his card extending to the right and a little margin around his silhouette. Use a completely flat solid blue-gray background #6e90a5 that matches the game's set, no shadows or texture on the background. No transparency checkerboard. No lettering, numbers, border or other people. One clean photographic asset, not a game mockup.

These assets were produced with the built-in image editor from the supplied references. Originals remain unchanged. These are AI-assisted reconstructions, not recovered original broadcast masters.

- public/assets/richard-dawson-isolated.png: original portrait isolated on a maroon backdrop. The editor did not produce true alpha transparency; two checkerboard variants were rejected. The game uses the clean maroon version.
- public/assets/dawson-stage-enhanced.png: 1464 × 1075 reconstruction from the 805 × 591 stage screenshot.
- public/assets/dawson-faceoff.png: restored faceoff reference with side contestants removed, leaving Richard and the historic podium; live contestant photos are rendered separately.

## Final portrait prompt

Use case: precise-object-edit / background extraction. Edit the original Richard Dawson photo. Remove the entire old set background, the woman, the circular logo, all lettering and overlays. Isolate only Richard Dawson preserving his exact original face, hair, expression, dark three-piece suit, pose, boutonniere, glasses and watch chain. Replace everything behind him with a perfectly flat SOLID DARK MAROON color #4d0d08, to seamlessly match the game introduction backdrop. It is crucial that this is an opaque flat maroon background, NOT a checkerboard, not grey and white squares, not a grid, not gradients and not transparency. Preserve original body framing and add a small maroon margin around the silhouette. A single photographic portrait with clean silhouette and completely plain maroon surround. No new text, no restyling.

## Stage prompt

Use case: precise-object-edit. Asset type: high-resolution background for the existing Richard Dawson-era Family Feud home game. Image 1 is the EDIT TARGET, a low-resolution historical stage screenshot. Enhance/restore this exact image for display on a large TV: high resolution, clean lines, reduced compression/blocking, legible physical construction, realistic vintage colors and materials. Preserve the exact camera angle, entire framing, positions and proportions of orange wall, blue oval board, score wings, stairs, pale blue floor, family podiums, people, flowers and side scenery. Keep the same roughly 805:591 aspect ratio. Do not redesign the set, move the people or architecture, add anything, modernize it, or change its period. Preserve top score 186, left 153, right 190 and DOUBLE side labels. Original small board labels need not invent new words. Remove the small camera/search UI icon in the lower-left as a screenshot overlay, restoring the floor there. Aim for at least 2048px wide. A single restored stage image, not a collage.

## Faceoff prompt

Use case: precise-object-edit. Asset type: background of a live game faceoff screen. Image 1 is the edit target, the supplied Richard Dawson Family Feud faceoff photograph. Restore it as a sharp, higher-resolution photographic image. Keep Richard Dawson at center holding the question card, his dark suit, face identity, downwards gaze, and the exact historic blue studded oval backdrop, bronze oval edge, black-and-cream stepped faceoff podium and two microphones. Remove ONLY the contestants on left and right, filling their spaces naturally with continuation of the blue studded backdrop and set floor. Keep the black stepped podium fully intact and at the same position. The game will overlay real player portraits in those cleared left and right areas. Preserve framing, perspective, camera angle, and 585:445 landscape aspect ratio. No new people, no text, no added logos. Remove the TV channel overlay upper right. This is a background scene, not a UI mockup; no player cards or software controls baked in.



## Fast Money first-reveal composition

- `public/assets/dawson-fast-reveal.png`: AI-assisted Richard Dawson pose based on the supplied arm-around-contestant reference. Richard is at right in a gray suit, with his arm extended toward the guest area at left. The generated checkerboard background was rejected; the final edit uses a solid black studio backdrop. The live contestant photo is composited separately, with a clipped foreground copy of Richard’s arm. Player photos are not sent for image generation for this layout.
- Generation specification: preserve Richard Dawson’s recognizable face, hairstyle, gray suit, and friendly standing pose from the reference; isolate him on the right with his leftward arm in the original shoulder-embrace position, leaving the guest space empty. No lettering, interface, or additional people. Follow-up edit replaces the checkerboard with pure black while preserving the host and pose.
- Mode: reference image edit, followed by background correction. Final generated source: `generated_images/exec-2a5cb255-c10b-41ca-ad05-266c8640573e.png` in the task workspace; shipped asset path above.
- `public/assets/faceoff-walkup.mp3`: user-supplied “Screen Recording 2026-09-01 224017.mp3,” trimmed from 0.48 seconds for 6.55 seconds, re-encoded as MP3. Played at 30% volume under the faceoff invitation; stopped on speech completion/cancellation.
