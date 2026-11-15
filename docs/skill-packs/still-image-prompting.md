# Still image prompting

Scope: prompting guidance only. It does not describe tools, parameters, capabilities or the UI.

## Catalogue line (the model sees this)

Turns a request for a photo, portrait, scene, poster, product shot or illustration into the description a picture model reads best, in the right order.

## Instructions (the model reads this when it uses the skill)

When someone asks for a picture — a photo, a portrait, a scene, a poster, a product shot, an illustration — write the description that should become the picture. MiniMax says H3-Image expects a detailed English description of the whole image, and Alibaba's text-to-image prompt guide, the one its Qwen-Image reference points to, orders a prompt as subject, setting, style, camera, atmosphere, detail. Both are written out as prose about the whole frame.

Open with the subject and what it is doing, then the setting, then the light, then the camera. Name the kind of picture in the first sentence — "a photograph", "a watercolour", "a flat vector illustration".

Say how much of the frame the subject fills (extreme close-up, close-up, medium shot, long shot) and from where it is seen (eye level, low angle, bird's-eye). For a photographic look, name the lens and mean it: a wide lens exaggerates perspective and stretches what is near, a telephoto compresses the background, and a wider aperture narrows depth of field so the subject stands clear.

Describe light by direction and by quality. Hard light comes from a small or distant source and gives abrupt shadows and visible texture; soft light comes from a large or close source and gives gradual shadows. Then describe materials as that light catches them — brushed steel, wet stone, worn cotton — instead of praising them.

Neither model takes a negative prompt: MiniMax runs H3-Image without one, and Alibaba's guide says the qwen-image-2.1 series does not accept one. Put the absence into the same positive sentence — "an empty street, no cars".

Spend the words on the frame rather than on "8k" or "masterpiece": MiniMax documents an effective H3-Image prompt budget of about 4,096 tokens, and every pad word comes out of the description.

When changing a picture, ask for one change and say what must stay: "Replace the blue mug with a white one; keep the table, the light and the framing unchanged." When more than one picture is in play, say which one you mean, naming them <image1>, <image2> in the order they were given. For several changes, give them one at a time rather than crowding one sentence. For several people, say who stands where and how large each is, and keep the faces you care about large — Alibaba's own example exclusion list names "lack of facial detail", "distorted limbs" and "malformed fingers" as the failure modes. Qwen-Image is documented as strong with text inside the picture, and Qwen-Image-Edit as supporting Simplified Chinese and English, so quote wording exactly and write the prompt itself in English.

## Activation examples

- take a photo of a fisherman mending nets at dawn
- make a poster for a jazz night at our bar
- turn this picture into a watercolour
- a portrait of my dog, close-up, soft window light
- product shot of this bottle on a white sweep
- illustrate a cover for a children's book about a fox

## Sources

- MiniMax-H3-Image model card — https://huggingface.co/MiniMaxAI/MiniMax-H3-Image
- MiniMax-H3-Image: 16 MP text to image and image editing in ComfyUI — https://docs.comfy.org/tutorials/image/minimax/minimax-h3-image
- MiniMax-H3-Image Text-to-Image API (4,096-token effective prompt) — https://platform.minimax.io/docs/api-reference/image-generation-h3-generations
- MiniMax-H3-Image Image Edit API (replace one thing, keep the background) — https://platform.minimax.io/docs/api-reference/image-generation-h3-edits
- Qwen-Image API reference (text rendering, prompt guidance, limits) — https://www.alibabacloud.com/help/en/model-studio/qwen-image-api
- Qwen-Image Edit guide (editing instructions, no negative prompt on 2.1, language support) — https://www.alibabacloud.com/help/en/model-studio/qwen-image-edit-guide
- Alibaba Cloud Model Studio text-to-image prompt guide (prompt order and vocabulary) — https://www.alibabacloud.com/help/en/model-studio/text-to-image-prompt
- Cambridge in Colour, Understanding Camera Lenses (focal length, perspective, aperture, depth of field) — https://www.cambridgeincolour.com/tutorials/camera-lenses.htm
- Cambridge in Colour, Introduction to Portrait Lighting (direction and apparent size of light) — https://www.cambridgeincolour.com/tutorials/portrait-lighting.htm
