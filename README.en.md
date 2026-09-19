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

Expand a character card and open **How relationships add up** to see the starting chat or snapshot value, adjustments, effective changes, and totals for trust and romance. Net changes respect scale limits and active swipes; zero can mean that opposite events cancelled out.

## Character navigation

Above the cards, search by name, sort by trust (highest/lowest), romance, or name, and enable compact cards. Searching hides cards without deleting characters or clearing editor drafts. Sort and compact preferences persist; search resets when the chat or persona changes. Panel totals cover all characters, while the search counter shows matches.

## Memory and trait editor

Expand a character card, open **Memory and trait editor**, select an entry, and save its revised text. Current soft and deep memories, archived memories, and traits are available. Traits use “Name: description” (up to 240 characters); memories allow up to 2000 characters.

Delete hides an entry from memory supplied to the model while preserving its source event, scores, and log. Deleted entries remain listed for undo. Undo entry change restores up to 20 previous changes to the selected entry, including after a page reload.

Edits belong to the persona and source entry of the active swipe or imported baseline. Changing scenes cancels pending actions. Normal recalculation still determines available entries: the editor does not automatically recover memories displaced from bounded memory. Deleting a trait does not undo its past crystallization or move consumed memories out of the archive. Exports contain the edited visible state without undo history.

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

**Remove imported baseline** restores the baseline saved before the first import and recalculates the current chat history. It does not roll chat messages back in time. Repeated imports retain the original recovery point until the baseline is cleared.

VNE schema version 1 and the old bare data object containing `characters` are supported. Unknown versions, other extensions' files, invalid field types, and files larger than 20 MiB are rejected before changing the baseline. Nesting and record counts are also bounded. Select the file again if the chat or persona changes during confirmation. Snapshot v2 from the third-party fork is not imported automatically.

Settings show the active import and its time; older imports without a timestamp display “time unknown”. Removing the baseline requires confirmation, explaining recalculation and recovery availability. Switching the chat, persona, or imported baseline during confirmation cancels removal.

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

172 automated checks run real extension modules with mocked APIs and UI boundaries. The user confirmed the previous manual pass except section 7, Formats and errors. The [final checklist](docs/manual-testing.md) is pending. [Draft 3.2.0 release notes](docs/release-notes-3.2.0.md) are prepared; the release is not published.

```sh
node --experimental-vm-modules --test tests/generation-context.test.mjs tests/snapshot.test.mjs
```

[Work plan](plan.md) · [Extended fork review](docs/fork-review.md) (Russian)

## Screenshot

An earlier version; the test branch may look different.

<img width="942" height="236" alt="BB VNE options" src="https://github.com/user-attachments/assets/90d3f105-93a5-4a94-8e5b-c1a4e1bd0c93" />

### Persistent option preferences

VNE settings can store preferences for option style and content (up to 4000 characters). They apply to future option generations across all chats; existing options are unchanged. One-time guidance takes precedence in a conflict. Required output format, language and length still apply, and Scene Director context is passed as before. Preferences are not added to profile or trait generation. “Clear preferences” removes them from future requests.

### Option context size

Under “Language and replies”, “Messages in option context” selects the latest 1–100 messages (default: 10). This counts chat entries, not pairs of turns; shorter chats use all available entries. The latest reply also remains the immediate scene anchor. Changes apply to the next generation and do not delete history.

This controls VNE’s history block, not total input tokens or the output limit. Persona, author’s note and summary still use macro substitution; Scene Director context is retained. Character profiles, memories and relationships are not separately copied into this block. The main connection may receive them through Tavern context, VNE injection or the {{bb_vn}} macro. Connection profiles and Custom API receive the assembled prompt; they do not automatically inherit all Tavern context. This setting does not cap extra preset or macro content.

### Disabling options

“Turn off” inside “VN Actions” smoothly hides the panel, leaving a small “VN” button to restore it. You can also re-enable it in VNE settings → “Gameplay” → “VN options”. This is a global setting saved across reloads. The current request is cancelled and queued auto-generation is cleared; relationships, memory and profile/trait generation remain available. Saved options are kept. Re-enabling restores the panel without a new request; auto-generation resumes on the next character reply.

### Portrait generation (VNE-TEST)

Click **Create** beside the avatar in the character editor. Configure the separate connection under **VNE settings → Images**. Use manual or source-based prompts, shared style and references, then preview and crop before saving. [RU/EN guide](docs/portraits.md). Release is deferred until this feature passes manual verification.

## Author

[BruniikBron: Lo-Fi & Mods](https://bblofi.online/) · [Telegram](https://t.me/Brun11kBr0n)
