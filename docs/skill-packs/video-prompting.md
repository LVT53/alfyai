# Video prompting

Scope: prompting guidance only. It does not describe tools, parameters, capabilities or the UI.

## Catalogue line (the model sees this)

Turns a wish for a picture to move — a short clip, a reel, something animated — into one subject, one action and one camera instruction.

## Instructions (the model reads this when it uses the skill)

When someone wants a picture to move — a short clip, a reel, something animated, a still brought to life — write the idea that should play out, in English, as flowing prose rather than a list. Lightricks' LTX-2.5 guide asks for one flowing paragraph in the present tense, with a verb in every sentence that does something, and Lightricks' camera guide puts the shot first, then the scene, the action, the characters, the camera and the sound. For a single flowing shot the prompting guide suggests roughly four to eight sentences.

Choose one subject and one action. The prompting guide also says to keep the scene focused, because a few clear characters and actions read better than a crowded frame. Where the picture already exists, describe what happens next rather than what is already visible, and keep to one continuous take unless a cut is genuinely wanted.

Say what the camera does, using Lightricks' own vocabulary verbatim: static frame, pushes in, pulls back, pans across, circles around, tracks. The documented term reads better than a synonym. Then say how the subject looks once the move has finished, so the move has somewhere to arrive. A travelling move has to fit inside the shot: Lightricks notes that frame count bounds how long a move can hold, and a move that does not fit truncates instead of slowing down.

Keep the camera gentle and the physics plausible. ComfyUI's LTX-2.5 guidance names fast moves across noisy textures and smooth gradients as where boiling and banding appear, and Lightricks says highly chaotic motion introduces artefacts while simpler motion is more reliable.

Sound belongs in the same description, because LTX-2.5 makes picture and sound together: name the ambience, the music and its mood, and put any spoken line in quotation marks with its language or accent. If nothing should be heard, say the scene is quiet.

Do not write a shot list, numbered beats or labelled sections, and do not name a cut unless you describe it in prose. Do not lean on on-screen text: Lightricks warns that exact spelling and consistency across frames are not guaranteed, so keep lettering short and prominent, or leave it out.

## Activation examples

- make this photo move
- animate this portrait so she turns and smiles
- a short clip of the harbour at sunrise, mist drifting
- turn this still into a slow push-in
- a short reel of rain running down the window
- bring this painting to life, just the candle flame flickering

## Sources

- Lightricks, LTX Prompting Guide (shot, action, camera, audio; single-shot rules; on-screen text and chaotic motion caveats) — https://docs.ltx.io/api-documentation/implementation-guides/prompting-guide.md
- Lightricks, Image-to-Video Workflow for Beginners (prompt describes what should happen; camera, audio) — https://docs.ltx.io/open-source-model/usage-guides/image-to-video.md
- LTX blog, Camera Movement Prompt Guide (published camera vocabulary, destination after the move, frame count bounds a move) — https://ltx.io/blog/camera-movement-prompt-guide
- ComfyUI, LTX-2.5 in ComfyUI: Video, Audio, and Multishot Workflows (image-to-video prompting tips, audio) — https://docs.comfy.org/tutorials/video/ltx/ltx-2-5.md
- ComfyUI, LTX-2.5 DFR: Image to Video with Audio (one continuous shot, gentle camera moves, audio in the same pass) — https://docs.comfy.org/tutorials/video/ltx/ltx-2-5-dfr.md
