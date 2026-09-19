# Портреты персонажей / Character portraits

## Русский

1. В настройках VNE откройте **Изображения**. Выберите протокол, укажите адрес и ключ, затем нажмите **Подключить** и выберите модель из списка. Стандартный адрес подсказывается для выбранного протокола. В разделе **Профили подключения** можно сохранить настройки под именем и переключаться между ними; «Новый профиль» позволяет сохранить ещё один набор, а сохранение выбранного обновляет его. Общий стиль не входит в профиль. Это отдельное подключение для картинок; текстовые варианты продолжают использовать прежнее подключение.
2. В редакторе персонажа рядом с загрузкой аватара нажмите **Создать**.
3. Напишите **Промпт портрета** вручную либо нажмите **Собрать промпт**. Ручной ввод не вызывает текстовую модель. Сборка использует обычное подключение генерации VNE и возвращает английский промпт.
4. При необходимости задайте общий стиль и раскройте **Референсы**. Можно приложить до четырёх PNG/JPEG/WebP до 10 МиБ каждый, в том числе текущий аватар. Для каждого выберите назначение: внешность или стиль. Референсы существуют только в открытом окне; после закрытия их нужно добавить заново.
5. Нажмите **Сгенерировать портрет**. Посмотрите результат, затем **Использовать**. Изображение попадёт в редактор: настройте кадр и сохраните карточку. Закрытие мастерской не заменяет аватар.

**Источники внешности.** Приоритет у текущего текста описания в редакторе, включая несохранённые изменения. Далее учитываются карточка SillyTavern с совпадающим именем, активный лор и недавние сообщения. Чужая активная карточка не подставляется вместо нужного персонажа. Модель получает инструкцию не выдумывать неизвестные особенности и не переносить чужую внешность; при нехватке сведений уточните промпт вручную. Это инструкция модели, а не гарантия точного сходства.

**Общий стиль** сохраняется для следующих портретов. Настройка языка игровых ответов на английскую сборку промпта не влияет; ручной текст отправляется в написанном вами виде.

| Протокол | Адрес | Референсы |
| --- | --- | --- |
| OpenAI Images | Базовый адрес, например `https://provider.example/v1` | `/images/edits`, multipart; без референсов — `/images/generations` |
| OpenAI Chat | Базовый адрес, например `https://provider.example/v1` | Картинки в сообщении `/chat/completions`; нужна модель, возвращающая изображения |
| Gemini | Корень сервиса или адрес до `/v1beta`; допустим полный `:generateContent` | `inlineData`; официальный домен Google использует `x-goog-api-key`, прокси — Bearer |
| Naistera | Корень сервиса или полный `/api/generate` | `reference_images` и назначения референсов |

Форматы запросов адаптированы из BB Comic Forge; его установка не требуется. Кнопка подключения проверяет доступ к списку моделей без генерации изображения. Для OpenAI используется `/models`, для Gemini — `/v1beta/models` с пагинацией. Список Naistera встроенный, как в Comic Forge: он не подтверждает доступность API. Полученный список не гарантирует поддержку изображений или `/edits` каждой моделью. Если сервис не предоставляет список, доступен пункт «Указать ID вручную…». Размеры, качество и возможность работы с референсами зависят от сервиса и модели. Запросы идут из браузера, поэтому сервис должен разрешать CORS. Отказ работы с референсами показывается как ошибка — автоматического повторения без картинок нет.

Тайм-аут изображений настраивается отдельно (15–600 секунд, по умолчанию 180). Закрытие окна и отмена прекращают ожидание; это не гарантирует отмену обработки или списания у провайдера. Смена чата, персоны, свайпа или редактора блокирует применение старого результата. Готовые изображения получают ту же обработку размера и кадрирования, что загруженные аватары; исходник ограничивается стороной 2200 px. Снимок сохраняет аватар и исходник по существующим правилам, но не настройки подключения и не загруженные референсы.

## English

Configure **VNE settings → Images**, then open a character editor and click **Create** beside the avatar controls. Enter a manual portrait prompt or use **Build prompt**, which uses the regular VNE text connection and returns English. Manual image generation does not call the text model.

The unsaved VNE description takes priority, followed by a matching SillyTavern character card, active lore and recent scene descriptions. The model is instructed to use established visual facts only; review the prompt and supply missing details yourself. Shared art style persists separately. Reply language does not override the English prompt builder.

Expand **References** to add up to four PNG/JPEG/WebP images, up to 10 MiB each, or the current avatar. Mark each as appearance or style. References are temporary and disappear when the workshop closes. The four transports are OpenAI Images, OpenAI Chat, Gemini and Naistera, adapted from Comic Forge without a runtime dependency. Click **Connect**, then select a model. Named connection profiles can be saved and switched without changing the shared style. OpenAI and Gemini discovery checks API access without generating an image; Naistera uses a built-in, explicitly unverified list. Manual IDs remain available as a fallback. Model listing does not prove image/edit support; reference support, sizes and quality depend on the service. Direct browser requests require CORS. Failed reference requests are never silently retried without images.

Generate, inspect the preview, then click **Use portrait**, adjust the crop and save the character. Closing without applying leaves the old avatar intact. Cancelling or changing the chat, persona, swipe or editor prevents stale results from being applied. The image timeout is 15–600 seconds (default 180); cancellation stops waiting but may not stop provider processing or billing. Images use the existing avatar resize/crop pipeline (source maximum side: 2200 px). Snapshots contain the saved avatar and source, not image connection credentials or temporary references.

Live-provider and visual verification remains part of the [manual checklist](manual-testing.md).
