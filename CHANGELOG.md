# История изменений / Changelog

[Русский](#русский) · [English](#english) · [README RU](README.md) · [README EN](README.en.md)

## Русский

### Unreleased — VNE-TEST

- Добавлена расшифровка доверия и романтики в карточке: основа, поправки, фактические изменения и итог, включая импорт и пределы шкал.

- Добавлен настраиваемый лимит токенов ответа своего API; уточнена ошибка ограничения длины.

Изменения 17–18 сентября 2026 года. Пока только в тестовой ветке, без нового номера релиза. В manifest сохранено `3.1.0 Release`.

- Генерация защищена от смены чата, персоны, сообщения и свайпа: устаревшие результаты не применяются.
- Добавлены тайм-аут, изолированная отмена и понятные ошибки. Резервная основная модель включается отдельной настройкой.
- Одно подключение для вариантов, описаний персонажей и черт: основное, профиль Connection Manager или своё API. Профиль не переключает подключение чата.
- Добавлена совместимость с моделями без строгой схемы JSON, проверка вариантов и общий лимит дополнительных запросов. Технические настройки находятся в разделе «Дополнительно».
- Служебные промпты переведены на английский. Язык интерфейса и язык новых результатов выбираются независимо; старые игровые записи не переводятся.
- Сохранены оба режима: вставка выбранного ответа для редактирования и немедленная автоотправка без предпросмотра.
- Импорт снимка проверяется до применения и показывает сводку замены. Поддерживаются v1 и старый объект данных; лимит файла — 20 МиБ. Повторный импорт сохраняет первоначальную точку восстановления.
- Названия моделей и данные API выводятся безопасно; подробные фрагменты ответов скрыты из диагностики по умолчанию.
- Добавлены русское и английское руководства, история изменений и автоматические проверки. Изучение Extended-форка и выбранные идеи описаны в [отдельной заметке](docs/fork-review.md).

Проверки: 112 автоматических тестов с подменёнными API и границами интерфейса. Интеграция сверена с исходниками SillyTavern 1.18.0; живые провайдеры и браузер не проверялись.

### 2026-07-23 — исправление снимков

- События после импорта, включая повторные генерации свайпов и ручные отладочные записи ниже границы импорта, учитываются с сохранением импортированной базы.
- Время отладочных записей в журнале соответствует времени события.

Источник: [d1cda86](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/d1cda86). Отдельный номер релиза этому исправлению не присваивался.

### 3.1.0 — 2026-04-28

- Влияние событий на дружбу и романтику разделено на независимые шкалы.

Источник: [78557dc](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/78557dc), включая версию в manifest. Более ранняя история здесь не реконструирована.

## English

### Unreleased — VNE-TEST

- Added a character-card breakdown of trust and romance: baseline, adjustments, effective changes, and totals, including snapshots and scale limits.

- Added a configurable Custom API response token limit and clarified length-limit errors.

Changes from September 17–18, 2026. Available on the test branch only, without a new release number. The manifest still says `3.1.0 Release`.

- Generation discards stale results after chat, persona, message, or swipe changes.
- Added request timeouts, isolated cancellation, and clearer errors. Fallback to the main model requires a separate setting.
- One connection generates options, character descriptions, and traits: the main connection, a Connection Manager profile, or Custom API. Using a profile does not switch the chat connection.
- Added support for models without strict JSON schemas, option validation, and a shared additional-request budget. Technical controls are grouped under Advanced.
- Service prompts are now English. Interface and new-output languages can be selected independently; existing story records are not translated.
- Both choice modes remain available: insert the selected reply for editing, or send it immediately without a preview.
- Snapshot imports are validated before application and show a replacement summary. Version 1 and legacy bare data objects are supported, with a 20 MiB file limit. Repeated imports preserve the original recovery point.
- Model names and API data are rendered safely; detailed response excerpts are excluded from diagnostics by default.
- Added Russian and English guides, a changelog, and automated checks. The Extended fork review and selected ideas are recorded in a [separate note](docs/fork-review.md) (Russian).

Verification: 112 automated tests with mocked APIs and UI boundaries. Integration was checked against SillyTavern 1.18.0 source; live providers and browser behavior were not tested.

### 2026-07-23 — snapshot fix

- Events after import, including regenerated swipes and manual debug entries below the import cutoff, are replayed while retaining the imported baseline.
- Debug entries in the log use the actual event time.

Source: [d1cda86](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/d1cda86). No separate release number was assigned to this fix.

### 3.1.0 — 2026-04-28

- Split event impact on friendship and romance into independent scales.

Source: [78557dc](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/78557dc), including its manifest version. Earlier release history has not been reconstructed here.
