# BB Visual Novel Engine

[Русский](README.md) · **English** · [Changelog](CHANGELOG.md)

A SillyTavern extension with visual novel action choices, character relationships, memories, and a sidebar HUD.

> This page describes **VNE-TEST**. The new features have not been merged into `main`. The manifest still says `3.1.0 Release`; test branch changes are listed under Unreleased.

## Quick start

1. In SillyTavern, open **Extensions → Install extension** and enter `https://github.com/maxkara14/BB-Visual-Novel-Engine`. A standard installation uses the default branch; the features on this page require a `VNE-TEST` checkout.
2. Reload the page and open **BB Visual Novel Engine** settings.
3. Under **Generation connection**, choose the current SillyTavern connection, a saved Connection Manager profile, or Custom API. The same connection generates response options, character descriptions, and traits.
4. Choose the interface language and the language of new responses. Reload after changing the interface language.
5. Open a chat, wait for a character response, and click **VN actions**.

Leave the response format on **Auto**. You normally do not need to change **Advanced** settings.

## Choosing actions

VNE requests three distinct options. Each button shows an intent and, when enabled, a tone and a short forecast. If the model produces only two usable options, VNE can show them with a notification.

- **Immediate sending disabled:** the selected reply appears in the input field. Read, edit, and send it yourself.
- **Immediate sending enabled:** the selected reply is sent immediately. This is a blind-choice, “hard mode” style of play. Immediate sending is enabled by default.

You can reroll, add a preference through **Guidance**, show options automatically, and choose one of three response lengths. A late generation result is discarded if its chat, persona, or source message has changed.

## Relationships and memory

- A sidebar with character cards, avatars, and descriptions.
- Separate trust and romance scales, each with adjustable event impact values.
- Recent memories, unforgettable events, and a memory archive.
- Permanent personality traits created from deep memories.
- A relationship log and event diary.
- Character renaming, hiding, restoration, and a platonic mode.

You can disable relationship tracking while keeping action generation. The `{{bb_vn}}` macro allows manual placement of the tracker instructions.

## Connections and languages

| Setting | Behavior |
| --- | --- |
| Current SillyTavern connection | Uses the main chat model for extension generation. |
| Connection Manager profile | Uses the profile's model and settings without switching the main chat connection. Connection Manager must be enabled. |
| Custom API | A direct OpenAI-compatible connection with a URL, key, and model. Connect loads models through `/models`. |
| Interface language | Auto / Русский / English. Auto follows SillyTavern, then the browser. Other interface languages fall back to English. |
| Language of new responses | Match the chat / Русский / English. Independent of interface language. |

All service instructions are written in English. Output language controls new replies, option labels, profiles, traits, and human-readable relationship fields. Existing names and story records are not translated automatically. See [language notes](docs/languages.md) (Russian).

Fallback to the main model after a Custom API failure is a separate, disabled-by-default setting. Cancellation, invalid credentials, quota errors, and provider blocks do not trigger fallback.

## Advanced settings

JSON is the internal packaging for option labels and replies. You do not need to understand it to play.

| Mode | Use |
| --- | --- |
| Auto | Recommended. Main connections and profiles use prompt instructions. Custom API starts with a schema and simplifies only after a confirmed compatibility error. |
| JSON Schema | Explicit structured output. Requires support from the connection and model. |
| JSON mode | Only for direct Custom API connections supporting `json_object`. |
| Prompt instructions only | Asks the model to produce JSON without a special API parameter. |

The per-request timeout defaults to 120 seconds and supports 15–600 seconds. Option generation allows three additional requests by default, configurable from 0 to 5. Format retries, model fallback, repair, missing options, and tone diversity share this budget.

Custom API has a **Response token limit** under Advanced: `0` preserves the previous automatic budget (at least 4000); manual values range from 256 to 131072. The value is sent as `max_tokens` for each options, description, or trait request. Main connections and profiles keep their own limits. Models may support a lower maximum. Reasoning may share the budget with the final text.

## Data storage

Settings, connection selection, and the Custom API key are stored in SillyTavern extension settings. Story data lives in chat and message metadata, scoped to the active persona and swipes.

A snapshot contains relationships, memories, traits, profiles and avatars, the log, and the diary. Connection settings and the API key are not included. Remember that snapshots contain story records and descriptions when sharing them.

## Snapshots: transfer and recovery

1. Click **Export** to save the active persona's current baseline as JSON.
2. Select the intended persona in the destination chat and click **Import**.
3. Review the filename, source and active personas, format, and record counts. Confirm the replacement.

Import **replaces** the active persona's baseline; it does not merge it. Chat messages are not replaced. Events before the import point are not added to the snapshot again. New events and marked regenerated events continue to count.

**Clear snapshot baseline** restores the baseline saved before the first import and recalculates the current chat history. It does not roll chat messages back in time. Repeated imports retain the original recovery point until the baseline is cleared.

VNE schema version 1 and the old bare data object containing `characters` are supported. Unknown versions, other extensions' files, invalid field types, and files larger than 20 MiB are rejected before changing the baseline. Nesting and record counts are also bounded. Select the file again if the chat or persona changes during confirmation. Snapshot v2 from the third-party fork is not imported automatically.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No profiles | Enable Connection Manager and click Refresh profiles. |
| Deleted profile | Select an existing profile. VNE does not silently substitute another model. |
| Invalid key / access denied | Check the URL, API key, and model access. |
| Quota or rate limit | Check provider limits and retry later. |
| Timeout | Check model availability; increase the timeout if needed. |
| Unsupported JSON | Return to Auto or select Prompt instructions only. |
| Empty or truncated response | Choose a shorter response or check model token limits. Empty responses are not sent for pointless repair. |
| Rejected snapshot | Check the VNE v1 format, structure, and file size. The original baseline remains intact. |

Detailed diagnostics are disabled by default. Enabling them can put model response excerpts in the console; review those excerpts before publishing a report.

## Compatibility and verification

Integration was checked against the source of the local **SillyTavern 1.18.0** installation, including Connection Manager and structured-output parameters. This does not guarantee support for every version, model, or provider.

Automated checks run real extension modules with mocked APIs and UI boundaries. Live providers and visual browser behavior were not tested for this series of changes.

```sh
node --experimental-vm-modules --test tests/generation-context.test.mjs tests/snapshot.test.mjs
```

[Work plan](plan.md) · [Extended fork review](docs/fork-review.md) (Russian)

## Screenshot

An earlier version; the test branch may look different.

<img width="942" height="236" alt="BB VNE options" src="https://github.com/user-attachments/assets/90d3f105-93a5-4a94-8e5b-c1a4e1bd0c93" />

## Author

[BruniikBron: Lo-Fi & Mods](https://bblofi.online/) · [Telegram](https://t.me/Brun11kBr0n)
