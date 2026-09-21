# 🎬 BB Visual Novel Engine

[Русский](README.md) · **English** · [Changelog](CHANGELOG.md) · [Portraits](docs/portraits.md#english)

Turn your roleplay chat into a visual novel: choose your actions, follow relationships and keep the moments that matter.

## ✨ Features

| Feature | What it offers |
| --- | --- |
| 🎬 **VN Actions** | Three ways to continue a scene, with different tones and short outcome hints |
| 💞 **Relationships** | Separate trust and romance scores, change history and score breakdowns |
| 📖 **Character memory** | Memories, lasting personality traits and an event diary |
| 👤 **Character cards** | Avatars, descriptions, search, sorting and compact view |
| 🖼️ **Portraits and gallery** | Generation with references, cropping, saved variations, downloads and copying |
| 💾 **Snapshots** | Export and import the active persona's relationships and memory |
| 🌐 **Two languages** | Russian and English UI with a separate language choice for new replies |

## 📦 Installation

1. In SillyTavern, open **Extensions → Install extension**.
2. Paste: `https://github.com/maxkara14/BB-Visual-Novel-Engine`.
3. Reload the page and open **BB Visual Novel Engine** settings.
4. Choose a generation connection and open a chat.

After updates, use **Ctrl+F5** if needed.

## 🎮 How to play

After a character replies, click **VN Actions** and choose a continuation.

- **Auto-send off:** the reply appears in the input box. Read it, edit it and send it yourself.
- **Auto-send on:** the reply is sent immediately, without a preview. This is enabled by default.

Use the request button to guide the next generation. Persistent preferences and reply length are available in settings. Choose how much history options use, from 1 to 100 messages.

You can disable the action panel while keeping relationships and memory. The small **VN** button beside the input box brings it back. Scene Director context is included when used.

## 💞 Relationships and characters

The side panel contains character cards, a log and a diary. Expand a card to see memories and how trust and romance scores are calculated.

Search, sorting and compact view help navigate a growing cast. **Hidden · N** opens a list with individual and bulk restore. Hiding does not erase events: restoring a character recalculates relationships from stored history.

Edit a character's name, avatar and description. **From template** builds a description from available sources; customize the shared instructions under **Language and replies → Character description prompt**.

The **memory and trait editor** lets you edit text and hide entries with undo. These edits do not change relationship scores or original events.

## 🖼️ Portraits and gallery

Click **Portraits** beside the avatar in the character editor.

**Create:** write a prompt or build one from the description and scene. Add a shared art style and up to four appearance or style references. Preview the result, adjust the crop and save the card.

**Gallery:** new generations are saved per chat, persona and character, even if you do not apply them. Choose another portrait, download its original or copy the image.

Images use a separate connection: **OpenAI Images, OpenAI Chat, Gemini or Naistera**, with model selection and saved profiles. Image generation and reference support depend on the service and model.

[Read the portrait guide →](docs/portraits.md#english)

## ⚙️ Connections and languages

Choose one source for options, character descriptions and traits:

| Source | How it works |
| --- | --- |
| **Current SillyTavern connection** | Uses the main model |
| **Connection Manager profile** | Uses a saved profile without switching the chat connection |
| **Custom API** | Connects using a URL, key and model |

Usually, leave the response format on **Auto**. If the model does not support Schema, choose **Prompt instructions only**. For truncated replies, check the token limit; Custom API exposes it in advanced settings.

Interface language and the language of new replies are independent. Existing descriptions and memories are not translated automatically. Reload after changing the interface language.

## 💾 Moving your story

Export saves the active persona's relationships, memories, traits, descriptions and avatars. Import **replaces the relationship baseline** instead of adding two sets together. Chat messages remain intact.

**Remove imported baseline** restores the baseline from before the first import and recalculates the current chat history. It does not roll back messages.

The portrait gallery is stored separately: moving it requires chat metadata and SillyTavern image files. Removing a gallery entry does not delete its disk file.

## 🔗 Author

[BruniikBron: Lo-Fi & Mods](https://bblofi.online/) · [Telegram](https://t.me/Brun11kBr0n)
