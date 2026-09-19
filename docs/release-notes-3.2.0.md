# BB Visual Novel Engine 3.2.0 — черновик / draft

Не опубликовано. Целевая версия — 3.2.0; дата выпуска будет указана после финальной ручной проверки. Подготовлено для VNE-TEST. Релиз отложен до завершения ручной проверки новых портретов. Manifest пока 3.1.0 Release. Ниже — текст для будущего GitHub Release.

## Русский

### Подключения и генерация

- Единый выбор подключения для вариантов, описаний персонажей и черт: текущее подключение SillyTavern, профиль Connection Manager или своё API. Профиль не переключает основное подключение чата.
- Форматы Auto, JSON Schema, JSON mode для своего API и «Только инструкции». Auto своего API может перейти к более простому формату при явном отказе провайдера поддерживать текущий формат.
- Тайм-аут, отмена, понятные ошибки и общий лимит дополнительных запросов. Резервная основная модель применяется только при разрешённом и подходящем сбое.
- Настраиваемый лимит токенов ответа своего API. Уточнена ошибка обрезанного ответа.
- Защита от поздних результатов после смены чата, персоны, сообщения, свайпа или отключения вариантов.

### Настройка ответов и языки

- Английские служебные промпты, независимый выбор русского/английского интерфейса и языка новых результатов. Старые игровые записи не переводятся.
- Постоянные пожелания к вариантам с сохранением и очисткой. Разовая подсказка приоритетнее при противоречии.
- Выбор 1–100 последних сообщений для блока истории вариантов; по умолчанию 10. Это не общий бюджет контекста Tavern и не лимит ответа.
- Сохранены вставка реплики для редактирования и автоотправка без предпросмотра. Интеграция Scene Director сохранена, новые режимы прогноза не добавлялись.

### HUD, отношения и память

- Поиск персонажей, сортировки и компактные карточки. Фильтрация сохраняет открытые редакторы и их черновики.
- Расшифровка баллов: исходные значения, поправки и фактические изменения с учётом пределов шкал и импорта.
- Редактирование воспоминаний и черт, скрытие записей и отмена последних 20 правок каждой записи. Правки текста не меняют баллы отношений или журнал событий.
- Исправлена потеря импортированного архива воспоминаний при пересчёте.

### Портреты

- Мастерская портрета из редактора карточки: ручной промпт или английская сборка по описанию, совпадающей карточке, лору и сцене.
- Отдельное подключение изображений: OpenAI Images, OpenAI Chat, Gemini, Naistera; общий стиль и до четырёх референсов внешности/стиля без гардероба.
- Предпросмотр, применение через обычное кадрирование, отмена, тайм-аут и защита от смены контекста. При ошибке референсы не отбрасываются.

### Снимки и интерфейс

- Проверка снимка до импорта, сводка замены, статус и время импорта, подтверждение удаления импортированной основы. Повторный импорт сохраняет первоначальную точку восстановления.
- Настройки собраны в семь раскрывающихся разделов с иконками, цветовыми акцентами и анимациями. Исправлены переполнения кнопок и раскладка редакторов.
- Генератор вариантов можно отключить независимо от отношений и памяти. Панель плавно скрывается; компактная кнопка VN в ряду инструментов ввода возвращает её без нового запроса.
- Безопасное отображение данных подключения и диагностика без фрагментов ответов по умолчанию.
- Обновлены README на двух языках, changelog и ручной чек-лист.

## English

### Connections and generation

- One connection choice for options, character descriptions and traits: the current SillyTavern connection, a Connection Manager profile, or Custom API. Profiles do not switch the main chat connection.
- Auto, JSON Schema, Custom API JSON mode, and instructions-only output. Custom API Auto can fall back to a simpler format when the provider explicitly rejects the current format.
- Timeouts, cancellation, clearer errors and a shared additional-request budget. Optional fallback to the main model is limited to eligible failures.
- Configurable Custom API output token limit and clearer truncated-response errors.
- Stale results are discarded after chat, persona, message, swipe or options-enabled state changes.

### Reply preferences and languages

- English service prompts, independent Russian/English UI and new-output language settings. Existing story records are not translated.
- Persistent option preferences with saving and clearing. One-time guidance takes precedence in a conflict.
- Choose 1–100 recent messages for the option history block, defaulting to 10. This is not a total Tavern context budget or output limit.
- Both edit-before-sending and immediate auto-send remain available. Scene Director integration is retained; no new forecast modes were added.

### HUD, relationships and memory

- Character search, sorting and compact cards. Filtering preserves existing editors and their drafts.
- Relationship score breakdown showing starting values, adjustments and effective changes, including scale bounds and imported baselines.
- Edit memories and traits, hide entries and undo the last 20 edits per entry. Text edits do not alter relationship scores or event logs.
- Fixed imported archived memories being lost during recalculation.

### Portraits

- Character portrait workshop: manual prompts or English prompt building from the description, matching card, lore and scene.
- Separate image connection: OpenAI Images, OpenAI Chat, Gemini and Naistera; shared style and up to four appearance/style references, without wardrobe controls.
- Preview, existing crop workflow, cancellation, timeout and context guards. Failed requests never silently discard references.

### Snapshots and interface

- Pre-import validation, replacement preview, import status/time and confirmation before removing an imported baseline. Repeated imports preserve the original recovery point.
- Seven collapsible settings sections with icons, subtle color accents and animations. Fixed overflowing buttons and editor layouts.
- Disable option generation independently of relationships and memory. The panel slides away; a compact VN button in the input toolbar restores it without a new request.
- Safe rendering of connection data; response excerpts are excluded from diagnostics by default.
- Updated bilingual READMEs, changelog and manual checklist.

## Состояние проверки / Verification status

164 автоматических тестов проходят с подменёнными API и границами интерфейса. Пользователь сообщил о прохождении предыдущего ручного списка, кроме раздела 7 «Форматы и ошибки». Живые сервисы изображений и визуальный вид мастерской ещё не проверены. Финальный проход ожидается; перечень проверенных моделей и пропусков нужно заполнить в [чек-листе](manual-testing.md). Интеграция сверена с установленным SillyTavern 1.18.0; универсальная совместимость не заявляется.

164 automated tests pass using mocked APIs and UI boundaries. The user reported completing the previous manual checklist except section 7, Formats and errors. Live image providers and workshop layout have not yet been verified. Final manual verification is pending; tested models and skipped cases must be recorded in the [checklist](manual-testing.md). Integration was checked against the installed SillyTavern 1.18.0 source; universal compatibility is not claimed.

## Действия после финального подтверждения

- [ ] Исправить найденные проблемы и повторить затронутые проверки, если потребуется.
- [ ] Установить версию 3.2.0 в manifest, обновить вводные README и перенести Unreleased в датированный раздел 3.2.0 changelog.
- [ ] Проверить итоговый diff и состояние тестовой ветки.
- [ ] Перенести согласованные изменения в main, создать тег и GitHub Release с этим текстом только после решения пользователя о выпуске.

Это список будущих действий, а не отметка об их выполнении. Перед публикацией убрать служебные блоки черновика и обновить статус проверки.
