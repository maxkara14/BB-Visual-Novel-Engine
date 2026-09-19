# История изменений / Changelog

[Русский](#русский) · [English](#english) · [README RU](README.md) · [README EN](README.en.md)

## Русский

### Unreleased — VNE-TEST (подготовка 3.2.0)

[Черновик выпуска 3.2.0 RU/EN](docs/release-notes-3.2.0.md) · [Финальный чек-лист](docs/manual-testing.md). Релиз отложен до проверки портретов.

- Добавлена [генерация портретов](docs/portraits.md): ручной промпт, сборка внешности, четыре транспорта изображений, референсы, общий стиль, предпросмотр и кадрирование. Живые провайдеры и внешний вид ожидают ручной проверки.

- Добавлено независимое отключение панели вариантов с сохранением отношений и памяти; повторное включение компактной кнопкой VN или через настройки «Игра», с анимацией перехода.

- Добавлен выбор 1–100 последних сообщений для контекста вариантов; по умолчанию 10.

- Настройки собраны в семь компактных раскрывающихся разделов по примеру Enhance Gen.

- Добавлены сохраняемые пожелания к вариантам, очистка и приоритет разовой подсказки; интерфейс RU/EN.

- Добавлены поиск персонажей, сортировка и сохраняемый компактный вид без сброса редакторов при фильтрации.

- Добавлен редактор воспоминаний и черт с удалением и отменой до 20 правок записи, без изменения баллов и журнала. Исправлена потеря архива импортированного снимка при пересчёте.

- Добавлены статус и время импорта, понятные действия со снимками и подтверждение удаления основы с защитой от смены контекста.

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

Проверки: 164 автоматических тестов с подменёнными API и границами интерфейса. Интеграция сверена с исходниками SillyTavern 1.18.0. Пользователь подтвердил предыдущий ручной проход, кроме пункта 7 «Форматы и ошибки»; финальная проверка ещё ожидается.

### 2026-07-23 — исправление снимков

- События после импорта, включая повторные генерации свайпов и ручные отладочные записи ниже границы импорта, учитываются с сохранением импортированной базы.
- Время отладочных записей в журнале соответствует времени события.

Источник: [d1cda86](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/d1cda86). Отдельный номер релиза этому исправлению не присваивался.

### 3.1.0 — 2026-04-28

- Влияние событий на дружбу и романтику разделено на независимые шкалы.

Источник: [78557dc](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/78557dc), включая версию в manifest. Более ранняя история здесь не реконструирована.

## English

### Unreleased — VNE-TEST (3.2.0 preparation)

- Added the [portrait workshop](docs/portraits.md): manual and source-based prompts, four image transports, references, shared style, preview and crop. Release is deferred pending live-provider and visual verification.

[Draft 3.2.0 release notes RU/EN](docs/release-notes-3.2.0.md) · [Final checklist](docs/manual-testing.md). Not released yet.

- Added independent disabling of the option panel while keeping relationships and memory; re-enable with a compact VN button or in Gameplay settings, with animated transitions.

- Added a choice of 1–100 recent messages for option context; defaults to 10.

- Organized settings into seven compact collapsible sections, following Enhance Gen.

- Added persistent option preferences, clearing and one-time guidance precedence, with RU/EN controls.

- Added character search, sorting, and persistent compact cards while preserving editor drafts during filtering.

- Added memory and trait editing, deletion, and up to 20 undo steps per entry without changing scores or logs. Fixed imported archived memories being lost during recalculation.

- Added import status and time, clearer snapshot actions, and baseline removal confirmation guarded against context changes.

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

Verification: 164 automated tests with mocked APIs and UI boundaries. Integration was checked against SillyTavern 1.18.0 source. The user confirmed the previous manual pass except section 7, Formats and errors; final verification is pending.

### 2026-07-23 — snapshot fix

- Events after import, including regenerated swipes and manual debug entries below the import cutoff, are replayed while retaining the imported baseline.
- Debug entries in the log use the actual event time.

Source: [d1cda86](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/d1cda86). No separate release number was assigned to this fix.

### 3.1.0 — 2026-04-28

- Split event impact on friendship and romance into independent scales.

Source: [78557dc](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/78557dc), including its manifest version. Earlier release history has not been reconstructed here.
